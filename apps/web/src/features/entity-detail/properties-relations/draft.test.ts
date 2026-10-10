import type { PropertyDefinition } from '@orbis/shared';
import { describe, expect, test } from 'vitest';
import type { EffectiveRegistry } from '../../../lib/registry/labels';
import { acceptRemote, buildPatch, editField, keepLocal, observeDraft, startDraft } from './draft';
import { context, entity, field, numberDef, registry, textDef } from './test-fixtures';
import type { Context, Entity } from './types';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing registry fixture');
  return value;
}

const reg = (def: PropertyDefinition): EffectiveRegistry => ({
  ...registry,
  properties: [...registry.properties.filter((p) => p.id !== def.id), def],
});
const begin = (def = textDef, source = entity) =>
  startDraft(source, reg(def), { kind: 'values' }, context);
const raw = (raw: string) => ({ kind: 'raw', raw }) as const;
const remote = (props: Entity['props']): Entity => ({ ...entity, props });
const blocked = (result: ReturnType<typeof buildPatch>, id: string) => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors[id]).toEqual(expect.any(String));
};

describe('minimal draft patches', () => {
  test('only touched fields, latest raw and no full entity snapshots in patch', () => {
    const second = field({ kind: 'text' }, 'user/other');
    const r = { ...registry, properties: [...registry.properties, second] };
    const source = remote({ ...entity.props, 'user/other': 'Другой' });
    let draft = startDraft(source, r, { kind: 'values' }, context);
    expect(draft.fields).toEqual({});
    draft = editField(editField(draft, textDef.id, raw('Первое')), textDef.id, raw('Последнее'));
    expect(buildPatch(draft, r, context)).toEqual({
      ok: true,
      patch: { props: { [textDef.id]: 'Последнее' } },
    });
    expect(source.props[textDef.id]).toBe('Было');
  });
  test('untouched draft has an empty patch so attach defaults stay on server', () => {
    expect(buildPatch(begin(), registry, context)).toEqual({ ok: true, patch: {} });
  });
  test('invalid raw is an error, never unset', () => {
    const draft = editField(begin(numberDef), textDef.id, raw('1e-'));
    blocked(buildPatch(draft, reg(numberDef), context), textDef.id);
    expect(draft.fields[textDef.id]?.input).toEqual(raw('1e-'));
  });
  test.each([false, 0, [], null, ''])('keeps explicit value %j', (value) => {
    // Typed values are left to the server schema; no falsey omission/defaulting.
    expect(
      buildPatch(editField(begin(), textDef.id, { kind: 'value', value }), registry, context),
    ).toEqual({ ok: true, patch: { props: { [textDef.id]: value } } });
  });
  test('unset is explicit and preserves unrelated values', () => {
    expect(
      buildPatch(editField(begin(), textDef.id, { kind: 'unset' }), registry, context),
    ).toEqual({ ok: true, patch: { unset: [textDef.id] } });
  });
  test('ordered ref arrays retain unavailable IDs and duplicates', () => {
    const def = field({ kind: 'ref', cardinality: 'many' });
    const ids = ['archived-id', 'missing-id', 'archived-id'];
    expect(
      buildPatch(editField(begin(def), def.id, { kind: 'value', value: ids }), reg(def), context),
    ).toEqual({ ok: true, patch: { props: { [def.id]: ids } } });
  });
});

describe('remote values and explicit conflict resolution', () => {
  test('remote untouched fields stay latest, touched raw stays local', () => {
    const draft = editField(begin(), textDef.id, raw('Моё'));
    const latest = remote({ [textDef.id]: 'Чужое', 'user/other': 'Свежий' });
    const observed = observeDraft(draft, latest, registry, context);
    expect(observed.latestEntity.props['user/other']).toBe('Свежий');
    expect(observed.fields[textDef.id]?.input).toEqual(raw('Моё'));
    expect(observed.fields[textDef.id]?.conflict).toBe(true);
    blocked(buildPatch(observed, registry, context), textDef.id);
    const kept = keepLocal(observed, textDef.id);
    expect(kept.fields[textDef.id]?.baseline).toEqual({ present: true, value: 'Чужое' });
    expect(buildPatch(kept, registry, context)).toEqual({
      ok: true,
      patch: { props: { [textDef.id]: 'Моё' } },
    });
    const accepted = acceptRemote(observed, textDef.id);
    expect(accepted.fields).toEqual({});
    expect(accepted.latestEntity.props[textDef.id]).toBe('Чужое');
    expect(buildPatch(accepted, registry, context)).toEqual({ ok: true, patch: {} });
  });
  test('ordinary typing does not implicitly acknowledge a conflict', () => {
    const changed = observeDraft(
      editField(begin(), textDef.id, raw('Моё')),
      remote({ [textDef.id]: 'Чужое' }),
      registry,
      context,
    );
    blocked(
      buildPatch(editField(changed, textDef.id, raw('Ещё моё')), registry, context),
      textDef.id,
    );
  });
  test('other entity ID leaves the identical draft object', () => {
    const draft = editField(begin(), textDef.id, raw('Моё'));
    expect(
      observeDraft(
        draft,
        { ...entity, id: 'other' },
        { ...registry, version: 'new' },
        { ...context, readOnly: true },
      ),
    ).toBe(draft);
  });
  test.each([null, '', [], 0, false])('absence differs from present %j', (value) => {
    const draft = editField(begin(textDef, remote({})), textDef.id, raw('Моё'));
    expect(draft.fields[textDef.id]?.baseline).toEqual({ present: false, value: undefined });
    expect(
      observeDraft(draft, remote({ [textDef.id]: value }), registry, context).fields[textDef.id]
        ?.conflict,
    ).toBe(true);
  });
  test('present null differs from remote absence', () => {
    const draft = editField(begin(textDef, remote({ [textDef.id]: null })), textDef.id, {
      kind: 'unset',
    });
    expect(observeDraft(draft, remote({}), registry, context).fields[textDef.id]?.conflict).toBe(
      true,
    );
  });
  test('JSON equality ignores object key order but keeps ordered arrays', () => {
    const source = remote({ [textDef.id]: { a: [1, { x: null, y: false }], b: 2 } });
    const draft = editField(begin(textDef, source), textDef.id, raw('Моё'));
    const equal = remote({ [textDef.id]: { b: 2, a: [1, { y: false, x: null }] } });
    expect(observeDraft(draft, equal, registry, context).fields[textDef.id]?.conflict).toBe(false);
    const reordered = remote({ [textDef.id]: { a: [{ x: null, y: false }, 1], b: 2 } });
    expect(observeDraft(draft, reordered, registry, context).fields[textDef.id]?.conflict).toBe(
      true,
    );
  });
  test('conflict stays until explicit decision even if remote returns to baseline', () => {
    const first = observeDraft(
      editField(begin(), textDef.id, raw('Моё')),
      remote({ [textDef.id]: 'Чужое' }),
      registry,
      context,
    );
    expect(observeDraft(first, entity, registry, context).fields[textDef.id]?.conflict).toBe(true);
  });
});

describe('definition changes never guess a new raw interpretation', () => {
  test.each([
    { ...numberDef, type: { kind: 'date' } },
    { ...numberDef, status: 'deprecated' },
    { ...numberDef, flags: { model_writable: false } },
    { ...numberDef, module: 'finance' },
    { ...numberDef, mergedInto: 'user/replacement' },
    { ...numberDef, storage: 'core' },
  ] as PropertyDefinition[])('semantic metadata change blocks before and after observe: %j', (changed) => {
    const draft = editField(begin(numberDef), numberDef.id, raw('12'));
    blocked(buildPatch(draft, reg(changed), context), numberDef.id);
    const observed = observeDraft(draft, entity, reg(changed), context);
    expect(observed.fields[numberDef.id]?.metadataChanged).toBe(true);
    expect(observed.fields[numberDef.id]?.input).toEqual(raw('12'));
    blocked(buildPatch(keepLocal(observed, numberDef.id), reg(changed), context), numberDef.id);
    // Reset is explicit; merely typing with the new metadata cannot reinterpret the old control.
    blocked(
      buildPatch(editField(observed, numberDef.id, raw('2026-10-11')), reg(changed), context),
      numberDef.id,
    );
  });
  test('label/rank and registry version update without a block', () => {
    const draft = editField(begin(numberDef), numberDef.id, raw('12'));
    const changed = {
      ...reg(numberDef),
      version: 'new',
      properties: reg(numberDef).properties.map((p) =>
        p.id === numberDef.id ? { ...p, label: { ru: 'Новая подпись' }, rank: 7 } : p,
      ),
    };
    const observed = observeDraft(draft, entity, changed, context);
    expect(observed.registryVersion).toBe('new');
    expect(observed.fields[numberDef.id]?.metadataChanged).toBe(false);
    expect(buildPatch(observed, changed, context)).toEqual({
      ok: true,
      patch: { props: { [numberDef.id]: 12 } },
    });
  });
  test('accept remote then new input establishes the new definition explicitly', () => {
    const draft = editField(begin(numberDef), numberDef.id, raw('12'));
    const next = reg(field({ kind: 'date' }));
    const observed = observeDraft(draft, entity, next, context);
    const reset = editField(acceptRemote(observed, textDef.id), textDef.id, raw('2026-10-11'));
    expect(buildPatch(reset, next, context)).toEqual({
      ok: true,
      patch: { props: { [textDef.id]: '2026-10-11' } },
    });
  });
  test('removed or unknown definition never permits set or clear', () => {
    for (const input of [raw('Моё'), { kind: 'unset' } as const]) {
      const draft = editField(begin(), textDef.id, input);
      blocked(buildPatch(draft, { ...registry, properties: [] }, context), textDef.id);
      blocked(buildPatch(editField(begin(), 'missing', input), registry, context), 'missing');
    }
  });
});

describe('current Context is independent of registry version and observations', () => {
  const def = { ...textDef, module: 'finance' } as PropertyDefinition;
  const r = reg(def);
  const contexts: Context[] = [
    { ...context, disabledExtensions: ['finance'] },
    { ...context, readOnly: true },
    { ...context, archived: true },
  ];
  test.each(contexts)('blocks set/unset before observe and preserves raw: %j', (off) => {
    for (const input of [raw('Сохранить мой ввод'), { kind: 'unset' } as const]) {
      const draft = editField(
        startDraft(entity, r, { kind: 'values' }, context),
        textDef.id,
        input,
      );
      blocked(buildPatch(draft, r, off), textDef.id);
      const observed = observeDraft(draft, entity, r, off);
      expect(observed.fields[textDef.id]?.input).toEqual(input);
      expect(observed.fields[textDef.id]?.baseline).toEqual(draft.fields[textDef.id]?.baseline);
      expect(observed.fields[textDef.id]?.accessReason).toEqual(expect.any(String));
      expect(observed.fields[textDef.id]?.metadataChanged).toBe(false);
      expect(observed.observedContext).toEqual(off);
      expect(observed.observedContext).not.toBe(off);
      expect(observed.observedContext.disabledExtensions).not.toBe(off.disabledExtensions);
      blocked(buildPatch(observed, r, off), textDef.id);
      const restored = observeDraft(observed, entity, r, context);
      expect(restored.fields[textDef.id]?.accessReason).toBeUndefined();
      expect(buildPatch(restored, r, context).ok).toBe(true);
    }
  });
  test('restoring context does not erase separate conflict or metadata block', () => {
    let draft = editField(
      startDraft(entity, r, { kind: 'values' }, context),
      textDef.id,
      raw('Моё'),
    );
    draft = observeDraft(draft, remote({ [textDef.id]: 'Чужое' }), r, {
      ...context,
      disabledExtensions: ['finance'],
    });
    draft = observeDraft(draft, draft.latestEntity, r, context);
    expect(draft.fields[textDef.id]?.accessReason).toBeUndefined();
    blocked(buildPatch(draft, r, context), textDef.id);
  });
});

describe('selected attach/role definitions', () => {
  const aspect = required(registry.aspects.find((a) => a.id === 'orbis/task'));
  const role = required(registry.roles.find((r) => r.constraints.created_by === 'any'));
  test('selected aspect semantic change blocks until explicit selection starts a new draft', () => {
    const draft = startDraft(entity, registry, { kind: 'attach', aspectId: aspect.id }, context);
    const r = {
      ...registry,
      aspects: registry.aspects.map((a) => (a.id === aspect.id ? { ...a, properties: [] } : a)),
    };
    blocked(buildPatch(draft, r, context), '$editor');
    const observed = observeDraft(draft, entity, r, context);
    expect(observed.editorMetadataChanged).toBe(true);
    blocked(buildPatch(observed, r, context), '$editor');
    expect(buildPatch(startDraft(entity, r, draft.editor, context), r, context).ok).toBe(true);
  });
  test('selected role contract change blocks before and after observe', () => {
    const draft = startDraft(
      entity,
      registry,
      { kind: 'relation', roleId: role.id, side: 'target' },
      context,
    );
    const r = {
      ...registry,
      roles: registry.roles.map((a) =>
        a.id === role.id
          ? { ...a, constraints: { ...a.constraints, created_by: 'system' as const } }
          : a,
      ),
    };
    blocked(buildPatch(draft, r, context), '$editor');
    expect(observeDraft(draft, entity, r, context).editorMetadataChanged).toBe(true);
  });
  test.each([
    { kind: 'attach', aspectId: aspect.id } as const,
    { kind: 'relation', roleId: role.id, side: 'source' } as const,
  ])('current restrictions also apply to empty drafts %j', (editor) => {
    const draft = startDraft(entity, registry, editor, context);
    for (const off of [
      { ...context, readOnly: true },
      { ...context, archived: true },
    ]) {
      blocked(buildPatch(draft, registry, off), '$editor');
      expect(observeDraft(draft, entity, registry, off).editorAccessReason).toEqual(
        expect.any(String),
      );
    }
  });
  test('role module mask never becomes a role write gate', () => {
    const r = {
      ...registry,
      roles: registry.roles.map((a) =>
        a.id === role.id ? { ...a, module: 'finance' as const } : a,
      ),
    };
    const draft = startDraft(
      entity,
      r,
      { kind: 'relation', roleId: role.id, side: 'source' },
      context,
    );
    expect(buildPatch(draft, r, { ...context, disabledExtensions: ['finance'] }).ok).toBe(true);
  });
});

describe('assignment special authority stays limited to its group', () => {
  test.each([
    'orbis/executor',
    'orbis/grant',
    'orbis/may_close',
    'orbis/assignee',
  ])('%s permits coherent special set/unset but denies generic writes', (id) => {
    for (const input of [{ kind: 'value', value: 'human' } as const, { kind: 'unset' } as const]) {
      const generic = editField(begin(), id, input);
      blocked(buildPatch(generic, registry, context), id);
      const special = editField(
        startDraft(entity, registry, { kind: 'assignment' }, context),
        id,
        input,
      );
      expect(buildPatch(special, registry, context).ok).toBe(true);
      for (const off of [
        { ...context, readOnly: true },
        { ...context, archived: true },
      ])
        blocked(buildPatch(special, registry, off), id);
    }
  });
  test('special assignment editor is not a universal permission override', () => {
    const draft = editField(
      startDraft(entity, registry, { kind: 'assignment' }, context),
      textDef.id,
      raw('Моё'),
    );
    blocked(buildPatch(draft, registry, context), textDef.id);
  });
  test('assignment flags and masks remain prior gates; deprecated set denied but coherent clear allowed', () => {
    const base = required(registry.properties.find((p) => p.id === 'orbis/executor'));
    for (const def of [
      { ...base, module: 'finance' as const },
      { ...base, flags: { model_writable: false } },
    ]) {
      const r = reg(def);
      const draft = editField(startDraft(entity, r, { kind: 'assignment' }, context), def.id, {
        kind: 'unset',
      });
      blocked(buildPatch(draft, r, { ...context, disabledExtensions: ['finance'] }), def.id);
    }
    const def = { ...base, status: 'deprecated' as const };
    const r = reg(def);
    const draft = startDraft(entity, r, { kind: 'assignment' }, context);
    blocked(
      buildPatch(editField(draft, def.id, { kind: 'value', value: 'human' }), r, context),
      def.id,
    );
    expect(buildPatch(editField(draft, def.id, { kind: 'unset' }), r, context).ok).toBe(true);
  });
});

describe('draft lifecycle edge regressions', () => {
  test('editing again retains the first baseline until explicit keepLocal', () => {
    const draft = editField(begin(), textDef.id, raw('Первое'));
    const observed = observeDraft(draft, remote({ [textDef.id]: 'Второе' }), registry, context);
    const edited = editField(observed, textDef.id, raw('Последнее'));
    expect(edited.fields[textDef.id]?.baseline).toEqual({ present: true, value: 'Было' });
    const acknowledged = keepLocal(edited, textDef.id);
    const again = observeDraft(acknowledged, remote({ [textDef.id]: 'Третье' }), registry, context);
    expect(again.fields[textDef.id]?.conflict).toBe(true);
    expect(again.fields[textDef.id]?.input).toEqual(raw('Последнее'));
  });
  test('dropping one touched field keeps only the other in the patch', () => {
    const other = field({ kind: 'text' }, 'user/other');
    const r = { ...registry, properties: [...registry.properties, other] };
    let draft = startDraft(entity, r, { kind: 'values' }, context);
    draft = editField(editField(draft, textDef.id, raw('Моё')), other.id, raw('Другое'));
    expect(buildPatch(acceptRemote(draft, textDef.id), r, context)).toEqual({
      ok: true,
      patch: { props: { [other.id]: 'Другое' } },
    });
  });
  test('generic deprecated and unsupported fields can explicitly clear but cannot set', () => {
    for (const def of [{ ...textDef, status: 'deprecated' as const }, field({ kind: 'json' })]) {
      const draft = begin(def);
      expect(buildPatch(editField(draft, def.id, { kind: 'unset' }), reg(def), context)).toEqual({
        ok: true,
        patch: { unset: [def.id] },
      });
      blocked(
        buildPatch(editField(draft, def.id, { kind: 'value', value: null }), reg(def), context),
        def.id,
      );
    }
  });
  test('current mask also blocks an empty selected aspect draft', () => {
    const aspect = required(registry.aspects.find((a) => a.id === 'orbis/task'));
    const r = {
      ...registry,
      aspects: registry.aspects.map((a) =>
        a.id === aspect.id ? { ...a, module: 'finance' as const } : a,
      ),
    };
    const draft = startDraft(entity, r, { kind: 'attach', aspectId: aspect.id }, context);
    const off: Context = { ...context, disabledExtensions: ['finance'] };
    blocked(buildPatch(draft, r, off), '$editor');
    expect(observeDraft(draft, entity, r, off).editorMetadataChanged).toBe(false);
    expect(observeDraft(draft, entity, r, off).editorAccessReason).toBe('Расширение выключено');
  });
  test('selected label/rank changes do not demand re-selection', () => {
    const aspect = required(registry.aspects.find((a) => a.id === 'orbis/task'));
    const role = required(registry.roles.find((r) => r.constraints.created_by === 'any'));
    const r = {
      ...registry,
      version: 'renamed',
      aspects: registry.aspects.map((a) => ({ ...a, label: { ru: 'Аспект' }, rank: 20 })),
      roles: registry.roles.map((a) => ({ ...a, label: { ru: 'Роль' }, rank: 20 })),
    };
    for (const editor of [
      { kind: 'attach', aspectId: aspect.id } as const,
      { kind: 'relation', roleId: role.id, side: 'target' } as const,
    ]) {
      const observed = observeDraft(
        startDraft(entity, registry, editor, context),
        entity,
        r,
        context,
      );
      expect(observed.editorMetadataChanged).toBe(false);
      expect(buildPatch(observed, r, context).ok).toBe(true);
    }
  });
  test('missing selected definitions and special attach route cannot submit even an empty patch', () => {
    for (const editor of [
      { kind: 'attach', aspectId: 'missing' } as const,
      { kind: 'attach', aspectId: 'orbis/assignment' } as const,
      { kind: 'relation', roleId: 'missing', side: 'source' } as const,
    ])
      blocked(
        buildPatch(startDraft(entity, registry, editor, context), registry, context),
        '$editor',
      );
  });
  test('observed metadata restriction persists when context is restored or old metadata returns', () => {
    const draft = editField(begin(numberDef), textDef.id, raw('12'));
    const changed = reg(field({ kind: 'date' }));
    let observed = observeDraft(draft, entity, changed, { ...context, readOnly: true });
    observed = observeDraft(observed, entity, reg(numberDef), context);
    expect(observed.fields[textDef.id]?.accessReason).toBeUndefined();
    expect(observed.fields[textDef.id]?.metadataChanged).toBe(true);
    blocked(buildPatch(observed, reg(numberDef), context), textDef.id);
  });
  test('JSON baseline is a snapshot, not a mutable alias of saved arrays', () => {
    const saved = { items: ['old'] };
    const source = remote({ [textDef.id]: saved });
    const draft = editField(begin(textDef, source), textDef.id, raw('Моё'));
    saved.items.push('new');
    expect(draft.fields[textDef.id]?.baseline.value).toEqual({ items: ['old'] });
    expect(observeDraft(draft, source, registry, context).fields[textDef.id]?.conflict).toBe(true);
  });
});
