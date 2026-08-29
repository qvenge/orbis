// apps/server/src/registry/deltas.test.ts
// Дельты владельца (§А3-2) и трёхстороннее слияние (§А3-3) — чистые проверки, без БД:
// вход обеих функций это готовые определения и строки дельт, и живая база к ответу ничего
// не добавляет. Их наблюдаемость СКВОЗЬ реестр (attach_*-тул, форма) — в `cache.test.ts`.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS, BUILTIN_PROPERTY_META, type PropertyDefinition } from '@orbis/shared';
import { ExecError } from '../errors';
import {
  applyDeltas,
  previewMergeConflicts,
  RELAXABLE_REQUIRED_PROPERTY_IDS,
  type RegistryDeltaRow,
  relaxWhitelistViolations,
  type SystemDefinitions,
  threeWayMerge,
} from './deltas';
import type { RegistrySnapshot } from './load';

const OWNER = '11111111-1111-4111-8111-111111111111';

/** Снимок «как из БД»: встроенные определения плюс подменённые для пробы строки. */
function snapshotWith(overrides: PropertyDefinition[] = []): RegistrySnapshot {
  const properties = new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p]));
  for (const p of overrides) properties.set(p.id, p);
  return {
    properties,
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(),
    ownerVersion: 1,
    systemVersion: 1,
  };
}

/** Есть ли такое определение вовсе: `undefined` тут — дефект фикстуры, а не ветка пробы. */
function required(def: PropertyDefinition | undefined): PropertyDefinition {
  if (def === undefined) throw new Error('в снимке нет ожидаемого встроенного свойства');
  return def;
}

function systemOf(snapshot: RegistrySnapshot): SystemDefinitions {
  return { properties: snapshot.properties, aspects: snapshot.aspects };
}

function row(
  targetKind: RegistryDeltaRow['targetKind'],
  targetId: string,
  delta: unknown,
): RegistryDeltaRow {
  return { id: 'd1', ownerId: OWNER, targetKind, targetId, baseVersion: 1, delta };
}

/** Код отказа и его ПРИЧИНА: коды реформы закрыты (errors.ts), причина едет в details. */
function refusal(fn: () => unknown): { code: string; reason: string } {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof ExecError)) throw e;
    return { code: e.code, reason: (e.details as { reason?: string }).reason ?? '' };
  }
  throw new Error('ожидался отказ, его не было');
}

/** Свойство `select` для проб вариантов: своё, чтобы не зависеть от состава встроенных. */
function selectProperty(
  options: { key: string; label: string; rank: number }[],
): PropertyDefinition {
  return {
    id: 'user/mood',
    ownerId: OWNER,
    key: 'user/mood',
    label: { ru: 'Настроение' },
    description: { ru: 'Как прошёл день' },
    type: {
      kind: 'select',
      options: options.map((o) => ({ key: o.key, label: { ru: o.label }, rank: o.rank })),
    },
    status: 'active',
    storage: 'props',
    scope: null,
    mergedInto: null,
    module: null,
    rank: 900,
    flags: {},
  };
}

describe('applyDeltas: система ⊕ дельта (§А3-2)', () => {
  test('без дельт снимок возвращается ТЕМ ЖЕ объектом — сложение с нулём не копирует', () => {
    const snapshot = snapshotWith();
    expect(applyDeltas(snapshot, [])).toBe(snapshot);
  });

  test('дельта свойства переопределяет подпись и смысл встроенного, остальное не трогает', () => {
    const before = required(snapshotWith().properties.get('orbis/priority'));
    const after = required(
      applyDeltas(snapshotWith(), [
        row('property', 'orbis/priority', { label: { ru: 'Важность' } }),
      ]).properties.get('orbis/priority'),
    );
    expect(after.label.ru).toBe('Важность');
    // Тип, key и статус — не предмет дельты (§А3-2): на них стоят данные и адреса Q-AST.
    expect(after.key).toBe(before.key);
    expect(after.type).toEqual(before.type);
    expect(after.status).toBe(before.status);
  });

  test('дельта аспекта: скрытое свойство ИСЧЕЗАЕТ из состава, добавленное появляется', () => {
    const snapshot = applyDeltas(snapshotWith(), [
      row('aspect', 'orbis/task', {
        properties: {
          hide: ['orbis/effort_min'],
          add: [{ propertyId: 'orbis/aliases', required: false, rank: 50 }],
        },
      }),
    ]);
    const ids = snapshot.aspects.get('orbis/task')?.properties.map((r) => r.propertyId) ?? [];
    expect(ids).not.toContain('orbis/effort_min');
    expect(ids).toContain('orbis/aliases');
    // Встроенное определение НЕ мутировано: снимок кладётся в кеш и живёт дольше вызова.
    expect(
      BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/task')?.properties.map((r) => r.propertyId),
    ).toContain('orbis/effort_min');
  });

  test('дельта аспекта: подпись, смысл и иконка едут поверх системных', () => {
    const aspect = applyDeltas(snapshotWith(), [
      row('aspect', 'orbis/task', {
        label: { ru: 'Дело' },
        description: { ru: 'Своё описание' },
        icon: '🔥',
      }),
    ]).aspects.get('orbis/task');
    expect(aspect?.label.ru).toBe('Дело');
    expect(aspect?.description.ru).toBe('Своё описание');
    expect(aspect?.viewConfig.icon).toBe('🔥');
    // keyFields — не предмет дельты, они остаются системными
    expect(aspect?.viewConfig.keyFields).toEqual([
      'orbis/task_status',
      'orbis/due_date',
      'orbis/priority',
    ]);
  });

  test('`rank` дельты меняет ПОРЯДОК полей аспекта — состав формы наблюдаем по нему', () => {
    const ids = applyDeltas(snapshotWith(), [
      row('aspect', 'orbis/task', { properties: { rank: { 'orbis/due_date': -1 } } }),
    ])
      .aspects.get('orbis/task')
      ?.properties.map((r) => r.propertyId);
    expect(ids?.[0]).toBe('orbis/due_date');
  });

  test('relaxRequired: свойство белого списка снимает обязательность', () => {
    // `orbis/due_date` в системном определении необязателен — ослабление ставится ЯВНО,
    // чтобы проба била в тот же путь, что и на свойстве, ставшем обязательным.
    const snapshot = snapshotWith();
    const task = snapshot.aspects.get('orbis/task');
    if (task === undefined) throw new Error('нет встроенного orbis/task');
    snapshot.aspects.set('orbis/task', {
      ...task,
      properties: task.properties.map((r) =>
        r.propertyId === 'orbis/due_date' ? { ...r, required: true } : r,
      ),
    });
    const after = applyDeltas(snapshot, [
      row('aspect', 'orbis/task', { properties: { relaxRequired: ['orbis/due_date'] } }),
    ]);
    expect(
      after.aspects.get('orbis/task')?.properties.find((r) => r.propertyId === 'orbis/due_date')
        ?.required,
    ).toBe(false);
  });

  test('relaxRequired вне белого списка — VALIDATION: `orbis/finance_category` не ослабляется', () => {
    expect(
      refusal(() =>
        applyDeltas(snapshotWith(), [
          row('aspect', 'orbis/financial', {
            properties: { relaxRequired: ['orbis/finance_category'] },
          }),
        ]),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'REQUIRED_NOT_RELAXABLE' });
  });

  test('SCOPE_DUPLICATE (§А3-4): свойство со scope на тот же аспект нельзя добавить дельтой', () => {
    const scoped: PropertyDefinition = {
      ...(snapshotWith().properties.get('orbis/aliases') as PropertyDefinition),
      scope: { filter: { and: [{ aspect: 'orbis/task' }, { tag: 'x' }] } },
    };
    expect(
      refusal(() =>
        applyDeltas(snapshotWith([scoped]), [
          row('aspect', 'orbis/task', {
            properties: { add: [{ propertyId: 'orbis/aliases', required: false, rank: 5 }] },
          }),
        ]),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'SCOPE_DUPLICATE' });
  });

  test('scope, называющий ДРУГОЙ аспект, добавлению не мешает — правило про пару, не про поле', () => {
    const scoped: PropertyDefinition = {
      ...(snapshotWith().properties.get('orbis/aliases') as PropertyDefinition),
      scope: { filter: { aspect: 'orbis/note' } },
    };
    const ids = applyDeltas(snapshotWith([scoped]), [
      row('aspect', 'orbis/task', {
        properties: { add: [{ propertyId: 'orbis/aliases', required: false, rank: 5 }] },
      }),
    ])
      .aspects.get('orbis/task')
      ?.properties.map((r) => r.propertyId);
    expect(ids).toContain('orbis/aliases');
  });

  test('добавление свойства, УЖЕ входящего в аспект, — VALIDATION (иначе обход белого списка)', () => {
    expect(
      refusal(() =>
        applyDeltas(snapshotWith(), [
          row('aspect', 'orbis/task', {
            properties: { add: [{ propertyId: 'orbis/task_status', required: false, rank: 1 }] },
          }),
        ]),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'DELTA_PROPERTY_PRESENT' });
  });

  test('добавленные варианты select едут в ТИП свойства и сортируются по rank', () => {
    const property = selectProperty([{ key: 'good', label: 'Хорошо', rank: 1 }]);
    const after = applyDeltas(snapshotWith([property]), [
      row('aspect', 'orbis/note', {
        selectOptions: {
          'user/mood': { add: [{ key: 'meh', label: { ru: 'Так себе' }, rank: 0 }] },
        },
      }),
    ]).properties.get('user/mood');
    if (after?.type.kind !== 'select') throw new Error('тип свойства перестал быть select');
    expect(after.type.options.map((o) => o.key)).toEqual(['meh', 'good']);
  });

  test('вариант с занятым key — VALIDATION: молчаливой перезаписи значений не бывает', () => {
    const property = selectProperty([{ key: 'good', label: 'Хорошо', rank: 1 }]);
    expect(
      refusal(() =>
        applyDeltas(snapshotWith([property]), [
          row('aspect', 'orbis/note', {
            selectOptions: {
              'user/mood': { add: [{ key: 'good', label: { ru: 'Отлично' }, rank: 2 }] },
            },
          }),
        ]),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'DELTA_OPTION_PRESENT' });
  });

  test('варианты у не-select свойства — VALIDATION, а не тихо ничего', () => {
    expect(
      refusal(() =>
        applyDeltas(snapshotWith(), [
          row('aspect', 'orbis/task', {
            selectOptions: {
              'orbis/effort_min': { add: [{ key: 'x', label: { ru: 'Икс' }, rank: 1 }] },
            },
          }),
        ]),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'DELTA_OPTION_NOT_SELECT' });
  });

  test('дельта неизвестной формы — VALIDATION, а не молча применённая половина', () => {
    expect(
      refusal(() => applyDeltas(snapshotWith(), [row('aspect', 'orbis/task', { типы: 'да' })])),
    ).toEqual({ code: 'VALIDATION', reason: 'DELTA_MALFORMED' });
  });

  test('цель части Б (контракт) — VALIDATION: реестры срезом А созданы пустыми', () => {
    expect(
      refusal(() => applyDeltas(snapshotWith(), [row('contract', 'orbis/completable', {})])),
    ).toEqual({ code: 'VALIDATION', reason: 'DELTA_TARGET_UNSUPPORTED' });
  });

  test('дельта на определение, которого нет (выключенный модуль), пропускается без отказа', () => {
    const before = snapshotWith();
    const after = applyDeltas(before, [row('aspect', 'user/нет-такого', { label: { ru: 'Х' } })]);
    expect(after.aspects.size).toBe(before.aspects.size);
  });
});

describe('белый список ослабления (§А3-2)', () => {
  test('ни одно ослабляемое свойство не обязательно ни в одном ВСТРОЕННОМ аспекте', () => {
    expect(relaxWhitelistViolations()).toEqual([]);
  });

  test('проверка не тавтология: свойство, обязательное у системы, ловится', () => {
    const broken = BUILTIN_ASPECT_DEFS.map((a) =>
      a.id !== 'orbis/task'
        ? a
        : { ...a, properties: [{ propertyId: 'orbis/due_date', required: true, rank: 1 }] },
    );
    expect(relaxWhitelistViolations(broken)).toEqual(['orbis/task/orbis/due_date']);
  });

  test('`orbis/finance_category` в белом списке не стоит, `orbis/due_date` стоит', () => {
    expect(RELAXABLE_REQUIRED_PROPERTY_IDS.has('orbis/finance_category')).toBe(false);
    expect(RELAXABLE_REQUIRED_PROPERTY_IDS.has('orbis/due_date')).toBe(true);
  });
});

describe('threeWayMerge: система поехала под живой дельтой (§А3-3)', () => {
  test('label/description — дельта побеждает МОЛЧА, даже когда система переименовала своё', () => {
    const prev = systemOf(snapshotWith());
    const nextSnapshot = snapshotWith();
    const task = nextSnapshot.aspects.get('orbis/task');
    if (task === undefined) throw new Error('нет встроенного orbis/task');
    nextSnapshot.aspects.set('orbis/task', { ...task, label: { ru: 'Системное новое имя' } });
    const { merged, conflicts } = threeWayMerge(
      prev,
      systemOf(nextSnapshot),
      row('aspect', 'orbis/task', { label: { ru: 'Дело' } }),
    );
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({ label: { ru: 'Дело' } });
  });

  test('система завела вариант с ТЕМ ЖЕ key — конфликт variant-merge, свой вариант снят', () => {
    const prev = systemOf(
      snapshotWith([selectProperty([{ key: 'good', label: 'Хорошо', rank: 1 }])]),
    );
    const next = systemOf(
      snapshotWith([
        selectProperty([
          { key: 'good', label: 'Хорошо', rank: 1 },
          { key: 'meh', label: 'Средне', rank: 2 },
        ]),
      ]),
    );
    const { merged, conflicts } = threeWayMerge(
      prev,
      next,
      row('aspect', 'orbis/note', {
        selectOptions: {
          'user/mood': { add: [{ key: 'meh', label: { ru: 'Так себе' }, rank: 5 }] },
        },
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('variant-merge');
    expect(conflicts[0]?.propertyId).toBe('user/mood');
    // Свой вариант снят — иначе применение упало бы на дубле ключа (DELTA_OPTION_PRESENT).
    expect(merged).toEqual({});
    expect(() =>
      applyDeltas(
        snapshotWith([
          selectProperty([
            { key: 'good', label: 'Хорошо', rank: 1 },
            { key: 'meh', label: 'Средне', rank: 2 },
          ]),
        ]),
        [row('aspect', 'orbis/note', merged)],
      ),
    ).not.toThrow();
  });

  test('система завела ПОХОЖИЙ по подписи вариант с другим key — конфликт, оба остались', () => {
    const prev = systemOf(
      snapshotWith([selectProperty([{ key: 'good', label: 'Хорошо', rank: 1 }])]),
    );
    const next = systemOf(
      snapshotWith([
        selectProperty([
          { key: 'good', label: 'Хорошо', rank: 1 },
          { key: 'so-so', label: 'так себе', rank: 2 },
        ]),
      ]),
    );
    const { merged, conflicts } = threeWayMerge(
      prev,
      next,
      row('aspect', 'orbis/note', {
        selectOptions: {
          'user/mood': { add: [{ key: 'meh', label: { ru: 'Так себе' }, rank: 5 }] },
        },
      }),
    );
    expect(conflicts.map((c) => c.kind)).toEqual(['variant-merge']);
    expect(merged).toEqual({
      selectOptions: { 'user/mood': { add: [{ key: 'meh', label: { ru: 'Так себе' }, rank: 5 }] } },
    });
  });

  test('вариант, который система завела ЕЩЁ ДО дельты, конфликтом не считается', () => {
    // Тот же состав в prev и next: «новых системных вариантов» нет вовсе.
    const both = systemOf(
      snapshotWith([
        selectProperty([
          { key: 'good', label: 'Хорошо', rank: 1 },
          { key: 'meh', label: 'Так себе', rank: 2 },
        ]),
      ]),
    );
    const { conflicts } = threeWayMerge(
      both,
      both,
      row('aspect', 'orbis/note', {
        selectOptions: {
          'user/mood': { add: [{ key: 'other', label: { ru: 'Так себе' }, rank: 5 }] },
        },
      }),
    );
    expect(conflicts).toEqual([]);
  });

  test('скрытое свойство СТАЛО обязательным — конфликт hidden-required, скрытие снято', () => {
    const prev = systemOf(snapshotWith());
    const nextSnapshot = snapshotWith();
    const task = nextSnapshot.aspects.get('orbis/task');
    if (task === undefined) throw new Error('нет встроенного orbis/task');
    nextSnapshot.aspects.set('orbis/task', {
      ...task,
      properties: task.properties.map((r) =>
        r.propertyId === 'orbis/effort_min' ? { ...r, required: true } : r,
      ),
    });
    const { merged, conflicts } = threeWayMerge(
      prev,
      systemOf(nextSnapshot),
      row('aspect', 'orbis/task', { properties: { hide: ['orbis/effort_min'] } }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('hidden-required');
    expect(conflicts[0]?.propertyId).toBe('orbis/effort_min');
    expect(merged).toEqual({});
  });

  test('скрытие НЕобязательного свойства переживает пересев без единого конфликта', () => {
    const both = systemOf(snapshotWith());
    const { merged, conflicts } = threeWayMerge(
      both,
      both,
      row('aspect', 'orbis/task', { properties: { hide: ['orbis/effort_min'] } }),
    );
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({ properties: { hide: ['orbis/effort_min'] } });
  });

  test('система сама добавила свойство, которое добавлял владелец, — своя ссылка снимается молча', () => {
    const prev = systemOf(snapshotWith());
    const nextSnapshot = snapshotWith();
    const task = nextSnapshot.aspects.get('orbis/task');
    if (task === undefined) throw new Error('нет встроенного orbis/task');
    nextSnapshot.aspects.set('orbis/task', {
      ...task,
      properties: [...task.properties, { propertyId: 'orbis/aliases', required: false, rank: 9 }],
    });
    const { merged, conflicts } = threeWayMerge(
      prev,
      systemOf(nextSnapshot),
      row('aspect', 'orbis/task', {
        properties: { add: [{ propertyId: 'orbis/aliases', required: false, rank: 5 }] },
      }),
    );
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({});
  });

  test('дельта свойства конфликтов дать не может: у label/description правило одно', () => {
    const both = systemOf(snapshotWith());
    expect(
      threeWayMerge(both, both, row('property', 'orbis/priority', { label: { ru: 'Важность' } })),
    ).toEqual({ merged: { label: { ru: 'Важность' } }, conflicts: [] });
  });

  test('предпросмотр собирает конфликты всех дельт одним списком', () => {
    const prev = systemOf(snapshotWith());
    const nextSnapshot = snapshotWith();
    const task = nextSnapshot.aspects.get('orbis/task');
    if (task === undefined) throw new Error('нет встроенного orbis/task');
    nextSnapshot.aspects.set('orbis/task', {
      ...task,
      properties: task.properties.map((r) =>
        r.propertyId === 'orbis/effort_min' ? { ...r, required: true } : r,
      ),
    });
    expect(
      previewMergeConflicts(prev, systemOf(nextSnapshot), [
        row('aspect', 'orbis/task', { properties: { hide: ['orbis/effort_min'] } }),
        row('property', 'orbis/priority', { label: { ru: 'Важность' } }),
      ]).map((c) => c.kind),
    ).toEqual(['hidden-required']);
  });
});
