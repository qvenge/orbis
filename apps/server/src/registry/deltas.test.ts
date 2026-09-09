// apps/server/src/registry/deltas.test.ts
// Дельты владельца (§А3-2) и трёхстороннее слияние (§А3-3) — чистые проверки, без БД:
// вход обеих функций это готовые определения и строки дельт, и живая база к ответу ничего
// не добавляет. Их наблюдаемость СКВОЗЬ реестр (attach_*-тул, форма) — в `cache.test.ts`.
import { describe, expect, test } from 'bun:test';
import {
  AGENDA_DEF,
  BUDGET_DEF,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  type PropertyDefinition,
} from '@orbis/shared';
import { ExecError } from '../errors';
import {
  applyDeltas,
  baseSystemFor,
  type ContractDelta,
  previewMergeConflicts,
  RELAXABLE_REQUIRED_PROPERTY_IDS,
  type RegistryDeltaRow,
  relaxWhitelistViolations,
  type SubscriptionDelta,
  type SystemDefinitions,
  threeWayMerge,
  UNKNOWN_PREV_SYSTEM,
} from './deltas';
import type { RegistrySnapshot, SubscriptionRow } from './load';
import { driftConflictDecidable } from './merge-conflict';

const OWNER = '11111111-1111-4111-8111-111111111111';

/** Снимок «как из БД»: встроенные определения плюс подменённые для пробы строки. */
function snapshotWith(overrides: PropertyDefinition[] = []): RegistrySnapshot {
  const properties = new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p]));
  for (const p of overrides) properties.set(p.id, p);
  return {
    properties,
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
    subscriptions: new Map(),
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
  return {
    properties: snapshot.properties,
    aspects: snapshot.aspects,
    contracts: snapshot.contracts,
    subscriptions: snapshot.subscriptions,
  };
}

function row(
  targetKind: RegistryDeltaRow['targetKind'],
  targetId: string,
  delta: unknown,
  baseVersion = 1,
): RegistryDeltaRow {
  return { id: 'd1', ownerId: OWNER, targetKind, targetId, baseVersion, delta };
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

  test('цели без тулов записи (relation_role, action) — VALIDATION', () => {
    for (const kind of ['relation_role', 'action'] as const) {
      expect(refusal(() => applyDeltas(snapshotWith(), [row(kind, 'subitem', {})]))).toEqual({
        code: 'VALIDATION',
        reason: 'DELTA_TARGET_UNSUPPORTED',
      });
    }
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
      previewMergeConflicts(
        prev,
        systemOf(nextSnapshot),
        [
          row('aspect', 'orbis/task', { properties: { hide: ['orbis/effort_min'] } }),
          row('property', 'orbis/priority', { label: { ru: 'Важность' } }),
        ],
        1,
      ).map((c) => c.kind),
    ).toEqual(['hidden-required']);
  });

  test('система завела набор с тем же именем — set-merge, пользовательский снят', () => {
    const prev = systemOf(snapshotWith());
    const c = prev.contracts.get('orbis/completable');
    if (c === undefined || c.kind !== 'slots') throw new Error('нет встроенного orbis/completable');
    const next = {
      ...prev,
      contracts: new Map(prev.contracts).set('orbis/completable', {
        ...c,
        sets: { ...c.sets, my_open: ['active'] },
      }),
    };
    const m = threeWayMerge(
      prev,
      next,
      row('contract', 'orbis/completable', {
        setsDelta: { my_open: ['active'], mine2: ['done'] },
      }),
    );
    expect(m.conflicts.map((x) => x.kind)).toEqual(['set-merge']);
    expect(Object.keys((m.merged as ContractDelta).setsDelta)).toEqual(['mine2']);
  });

  test('обновление сняло класс — set-merge, и слитая дельта ПРИМЕНИМА', () => {
    // Владелец записал набор из класса `cancelled` (законно), релиз переименовал класс в
    // `dropped`. Слияние обязано убрать снятый класс: иначе `applyDeltas` отказывает
    // `DELTA_SET_UNKNOWN_CLASS` на КАЖДОМ чтении реестра — владелец заперт снаружи графа, и
    // починить дельту нечем (`contract_sets_delta_remove` идёт через `execute`, а тот берёт
    // снимок первым делом). Инвариант шапки: ошибаться слияние вправе только в сторону лишнего
    // конфликта, никогда — в сторону НЕПРИМЕНИМОЙ дельты.
    const prev = systemOf(snapshotWith());
    const c = prev.contracts.get('orbis/completable');
    if (c === undefined || c.kind !== 'slots') throw new Error('нет встроенного orbis/completable');
    const nextSnapshot: RegistrySnapshot = {
      ...snapshotWith(),
      contracts: new Map(prev.contracts).set('orbis/completable', {
        ...c,
        classes: c.classes.map((x) => (x.key === 'cancelled' ? { ...x, key: 'dropped' } : x)),
        sets: { closed: ['done', 'dropped'], open: ['active'] },
      }),
    };
    const m = threeWayMerge(
      prev,
      systemOf(nextSnapshot),
      row('contract', 'orbis/completable', {
        setsDelta: { my_closed: ['cancelled'], my_open: ['active'] },
      }),
    );
    expect(m.conflicts.map((x) => x.kind)).toEqual(['set-merge']);
    // Набор, оставшийся без единого класса, снимается целиком: пустой массив схемой не выразим.
    expect(Object.keys((m.merged as ContractDelta).setsDelta)).toEqual(['my_open']);
    expect(() =>
      applyDeltas(nextSnapshot, [row('contract', 'orbis/completable', m.merged)]),
    ).not.toThrow();
  });

  test('контракт стал словарём фактов — набор снимается тем же конфликтом (DELTA_SET_ON_FACTS)', () => {
    const prev = systemOf(snapshotWith());
    const c = prev.contracts.get('orbis/completable');
    if (c === undefined || c.kind !== 'slots') throw new Error('нет встроенного orbis/completable');
    const facts = prev.contracts.get('orbis/sensitivity');
    if (facts === undefined || facts.kind !== 'facts') throw new Error('нет словаря фактов');
    const nextSnapshot: RegistrySnapshot = {
      ...snapshotWith(),
      contracts: new Map(prev.contracts).set('orbis/completable', {
        ...facts,
        id: 'orbis/completable',
      }),
    };
    const m = threeWayMerge(
      prev,
      systemOf(nextSnapshot),
      row('contract', 'orbis/completable', { setsDelta: { my_open: ['active'] } }),
    );
    expect(m.conflicts.map((x) => x.kind)).toEqual(['set-merge']);
    expect(Object.keys((m.merged as ContractDelta).setsDelta)).toEqual([]);
    expect(() =>
      applyDeltas(nextSnapshot, [row('contract', 'orbis/completable', m.merged)]),
    ).not.toThrow();
  });

  test('дельта подписки устаревшей формы — слияние СБРАСЫВАЕТ её на системную, а не роняет пересев', () => {
    // Дельта подписки — ПОЛНАЯ копия декларации под `.strict()`, и первое ломающее изменение
    // схемы (обязательное поле, удаление/переименование, сужение enum) делает записанную дельту
    // неразбираемой. `parseDelta` стоял ПЕРВОЙ строкой ветки, то есть `threeWayMerge` бросал
    // `DELTA_MALFORMED` уже ПОСЛЕ бампа версии: сид красный, версия поднята, а владелец заперт на
    // каждом вызове MCP (`dispatchTool` берёт снимок первым действием).
    const stale = JSON.parse(JSON.stringify(BUDGET_DEF)) as Record<string, unknown>;
    delete (stale.alerts as Record<string, unknown>).inclusive;
    const sys = (definition: unknown): SystemDefinitions => ({
      properties: new Map(),
      aspects: new Map(),
      contracts: new Map(),
      subscriptions: new Map([
        [
          'orbis/budget-overview',
          {
            id: 'orbis/budget-overview',
            ownerId: null,
            surface: 'finance/budget-overview',
            definition,
            module: 'finance',
            rank: 20,
          } as SubscriptionRow,
        ],
      ]),
    });
    const r = threeWayMerge(
      sys(BUDGET_DEF),
      sys(BUDGET_DEF),
      row('subscription', 'orbis/budget-overview', { definition: stale }, 7),
    );
    expect(r.conflicts.map((c) => c.kind)).toEqual(['subscription-rebased']);
    expect(r.merged).toEqual({ definition: BUDGET_DEF });
  });

  test('системная декларация подписки изменилась под живой дельтой — subscription-rebased', () => {
    const prev = systemOf(snapshotWith());
    const sub = (limit: number): SubscriptionRow => ({
      id: 'orbis/agenda',
      ownerId: null,
      surface: 'planner/agenda',
      definition: { ...AGENDA_DEF, show: { ...AGENDA_DEF.show, limit } },
      module: null,
      rank: 1,
    });
    const m = threeWayMerge(
      { ...prev, subscriptions: new Map([['orbis/agenda', sub(200)]]) },
      { ...prev, subscriptions: new Map([['orbis/agenda', sub(100)]]) },
      row('subscription', 'orbis/agenda', { definition: sub(50).definition }),
    );
    expect(m.conflicts.map((x) => x.kind)).toEqual(['subscription-rebased']);
    const merged = (m.merged as SubscriptionDelta).definition;
    expect(merged.engine === 'agenda' ? merged.show.limit : null).toBe(50);
  });

  test('новые рода конфликта единиц пачки не заводят — решать пока нечем', () => {
    expect(
      driftConflictDecidable([
        {
          kind: 'set-merge',
          targetKind: 'contract',
          targetId: 'orbis/completable',
          detail: '',
        },
      ]),
    ).toEqual([]);
  });

  const moodSystems = (theirsKey: string, theirsLabel: string) => ({
    prev: systemOf(snapshotWith([selectProperty([{ key: 'good', label: 'Хорошо', rank: 1 }])])),
    next: systemOf(
      snapshotWith([
        selectProperty([
          { key: 'good', label: 'Хорошо', rank: 1 },
          { key: theirsKey, label: theirsLabel, rank: 2 },
        ]),
      ]),
    ),
  });
  const moodDelta = {
    selectOptions: { 'user/mood': { add: [{ key: 'meh', label: { ru: 'Так себе' }, rank: 5 }] } },
    classMap: {
      'user/mood': [
        { contract: 'orbis/completable', slot: 'status', variant: 'meh', class: 'active' },
      ],
    },
  };

  test('снятый по совпавшему ключу вариант УНОСИТ своё отнесение', () => {
    // Иначе `applyDeltas` назначила бы класс варианту, которого в дельте больше нет.
    const { prev, next } = moodSystems('meh', 'Средне');
    const { merged, conflicts } = threeWayMerge(prev, next, row('aspect', 'orbis/note', moodDelta));
    expect(conflicts.map((c) => c.kind)).toEqual(['variant-merge']);
    expect(merged).toEqual({});
  });
  test('вариант, оставленный рядом с похожим, отнесение СОХРАНЯЕТ', () => {
    const { prev, next } = moodSystems('so-so', 'так себе');
    expect(threeWayMerge(prev, next, row('aspect', 'orbis/note', moodDelta)).merged).toEqual(
      moodDelta,
    );
  });
});

/**
 * ОТСТАВШИЙ `base_version` (Important-1 гейт-ревью): снимок БД описывает ОДНУ системную
 * версию, и дельте, писавшейся против другой, он стороной «до» не годится. Путь достижим
 * штатно — упавший или убитый посреди цикла сид оставляет часть строк неслитыми, и
 * следующий прогон видит для них `prev == next`, то есть «система не менялась».
 */
describe('база слияния выбирается по base_version (§А3-3)', () => {
  test('версия совпала — база это снимок БД; не совпала — пустая база', () => {
    const prev = systemOf(snapshotWith());
    expect(baseSystemFor(prev, row('aspect', 'orbis/task', {}, 7), 7)).toBe(prev);
    expect(baseSystemFor(prev, row('aspect', 'orbis/task', {}, 6), 7)).toBe(UNKNOWN_PREV_SYSTEM);
    // Забегание вперёд (дельта опирается на версию новее снимка) — тоже «неизвестно»:
    // правило про СОВПАДЕНИЕ, а не про «не старше».
    expect(baseSystemFor(prev, row('aspect', 'orbis/task', {}, 8), 7)).toBe(UNKNOWN_PREV_SYSTEM);
  });

  test('prev == next и отставшая дельта: скрытие ОБЯЗАТЕЛЬНОГО свойства доложено конфликтом', () => {
    // Ровно проба ревьюера: обе стороны системы одинаковы, `orbis/task_status` обязателен
    // и сейчас, и «тогда». С точной базой перехода нет — и не должно быть; с отставшей
    // базой молчать нельзя: состояния, против которого писали дельту, не сохранено нигде.
    const system = systemOf(snapshotWith());
    const hide = { properties: { hide: ['orbis/task_status'] } };

    const exact = threeWayMerge(system, system, row('aspect', 'orbis/task', hide, 7));
    expect(exact.conflicts).toEqual([]);
    expect(exact.merged).toEqual(hide);

    const stale = threeWayMerge(
      baseSystemFor(system, row('aspect', 'orbis/task', hide, 1), 7),
      system,
      row('aspect', 'orbis/task', hide, 1),
    );
    expect(stale.conflicts.map((c) => c.kind)).toEqual(['hidden-required']);
    expect(stale.conflicts[0]?.propertyId).toBe('orbis/task_status');
    // Скрытие снято — обязательное поле вернулось в состав аспекта.
    expect(stale.merged).toEqual({});
  });

  test('отставшая дельта: свой вариант select рядом с системным — конфликт даже без дрейфа', () => {
    const system = systemOf(
      snapshotWith([
        selectProperty([
          { key: 'good', label: 'Хорошо', rank: 1 },
          { key: 'meh', label: 'Так себе', rank: 2 },
        ]),
      ]),
    );
    // Ключ СВОБОДЕН, а подпись совпадает с системным вариантом `meh` («Так себе»): именно
    // здесь база и решает, считать ли системный вариант новым. Ключ занятый проверяется
    // отдельно — он снимает свой вариант при любой базе (тест ниже).
    const delta = {
      selectOptions: {
        'user/mood': { add: [{ key: 'so-so', label: { ru: 'так себе' }, rank: 5 }] },
      },
    };
    expect(threeWayMerge(system, system, row('aspect', 'orbis/note', delta, 7)).conflicts).toEqual(
      [],
    );
    const stale = row('aspect', 'orbis/note', delta, 1);
    const merged = threeWayMerge(baseSystemFor(system, stale, 7), system, stale);
    expect(merged.conflicts.map((c) => c.kind)).toEqual(['variant-merge']);
    // Оба варианта остаются — ключи разные, применению это не мешает.
    expect(merged.merged).toEqual(delta);
  });

  /**
   * ЗАНЯТЫЙ КЛЮЧ СИЛЬНЕЕ ПОХОЖЕЙ ПОДПИСИ (ре-ревью фикс-раунда 1, Important-A).
   *
   * Вход подобран так, что поиск «похожего» ошибается: старый вариант совпадает по ПОДПИСИ
   * и стоит в списке РАНЬШЕ нового, совпавшего по КЛЮЧУ. Пока проверка ключа шла внутри
   * поиска похожего, широкая база переворачивала вердикт с «снять свой вариант» на
   * «оставить оба», и дельта становилась НЕПРИМЕНИМОЙ: `applyDeltas` отказывал
   * `DELTA_OPTION_PRESENT` на каждом чтении, а `base_version` к тому моменту уже переехал —
   * повторный пересев расхождения не видел и молчал.
   */
  test('свой вариант с занятым ключом снимается при ЛЮБОЙ базе, даже когда раньше стоит похожий по подписи', () => {
    const withReview = selectProperty([{ key: 'review', label: 'На проверке', rank: 1 }]);
    const withBoth = selectProperty([
      { key: 'review', label: 'На проверке', rank: 1 },
      { key: 'in_review', label: 'В ревью', rank: 2 },
    ]);
    const prev = systemOf(snapshotWith([withReview]));
    const next = systemOf(snapshotWith([withBoth]));
    // Ключ совпадает с НОВЫМ системным вариантом, подпись — со СТАРЫМ (регистр не в счёт).
    const delta = {
      selectOptions: {
        'user/mood': { add: [{ key: 'in_review', label: { ru: 'на проверке' }, rank: 9 }] },
      },
    };
    const staleRow = row('aspect', 'orbis/note', delta, 1);

    for (const [name, base] of [
      ['точная база', prev],
      ['пустая база', baseSystemFor(prev, staleRow, 7)],
    ] as const) {
      const { merged, conflicts } = threeWayMerge(base, next, staleRow);
      expect(
        conflicts.map((c) => c.kind),
        name,
      ).toEqual(['variant-merge']);
      expect(conflicts[0]?.detail, name).toContain('с тем же ключом');
      // Вердикт один и тот же при обеих базах: свой вариант снят.
      expect(merged, name).toEqual({});
      // И слитая дельта ПРИМЕНИМА — ради этого всё и делается.
      expect(() =>
        applyDeltas(snapshotWith([withBoth]), [row('aspect', 'orbis/note', merged)]),
      ).not.toThrow();
    }
    // Контроль, что проба не вырождена: пустая база действительно шире точной —
    // «похожий по подписи» на другом ключе при ней конфликтует, при точной нет.
    const otherKey = {
      selectOptions: {
        'user/mood': { add: [{ key: 'checking', label: { ru: 'на проверке' }, rank: 9 }] },
      },
    };
    expect(threeWayMerge(prev, next, row('aspect', 'orbis/note', otherKey, 7)).conflicts).toEqual(
      [],
    );
    expect(
      threeWayMerge(UNKNOWN_PREV_SYSTEM, next, row('aspect', 'orbis/note', otherKey, 1)).conflicts
        .length,
    ).toBe(1);
  });

  test('ключ, занятый СТАРЫМ системным вариантом, тоже снимается — иначе дельта неприменима', () => {
    // Точная база, вариант не «свежий»: раньше такая дельта проходила слияние молча и
    // ложилась обратно в базу неприменимой.
    const system = systemOf(
      snapshotWith([selectProperty([{ key: 'good', label: 'Хорошо', rank: 1 }])]),
    );
    const delta = {
      selectOptions: { 'user/mood': { add: [{ key: 'good', label: { ru: 'Отлично' }, rank: 9 }] } },
    };
    const { merged, conflicts } = threeWayMerge(
      system,
      system,
      row('aspect', 'orbis/note', delta, 7),
    );
    expect(conflicts.map((c) => c.kind)).toEqual(['variant-merge']);
    expect(merged).toEqual({});
  });

  test('предпросмотр отставшую дельту тоже не пропускает', () => {
    const system = systemOf(snapshotWith());
    const stale = row('aspect', 'orbis/task', { properties: { hide: ['orbis/task_status'] } }, 1);
    expect(previewMergeConflicts(system, system, [stale], 7).map((c) => c.kind)).toEqual([
      'hidden-required',
    ]);
    // Та же дельта с актуальной базой конфликтов не даёт — правило про базу, не про поле.
    expect(previewMergeConflicts(system, system, [{ ...stale, baseVersion: 7 }], 7)).toEqual([]);
  });
});

describe('дельта контракта setsDelta и подписки definition: apply/parse/threeWayMerge', () => {
  test('пользовательский набор добавляется, встроенные не меняются (§Б5-2)', () => {
    const c = applyDeltas(snapshotWith(), [
      row('contract', 'orbis/completable', { setsDelta: { my_open: ['active'] } }),
    ]).contracts.get('orbis/completable');
    expect(Object.keys(c?.sets ?? {}).sort()).toEqual(['closed', 'my_open', 'open']);
    expect((c?.sets as Record<string, unknown>).closed).toEqual(['done', 'cancelled']);
  });
  test('имя, занятое встроенным набором, — DELTA_SET_BUILTIN', () => {
    expect(
      refusal(() =>
        applyDeltas(snapshotWith(), [
          row('contract', 'orbis/completable', { setsDelta: { closed: ['active'] } }),
        ]),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'DELTA_SET_BUILTIN' });
  });
  // Имя класса в дельте — СЛАГ (`SLOT_KEY_RE`, §1.7), поэтому «которого нет» пишется законной
  // формой: кириллица отвергалась бы схемой как DELTA_MALFORMED, и проверка «нет такого класса»
  // не дошла бы до кода вовсе.
  test('класс, которого у контракта нет, — DELTA_SET_UNKNOWN_CLASS', () => {
    expect(
      refusal(() =>
        applyDeltas(snapshotWith(), [
          row('contract', 'orbis/completable', { setsDelta: { my: ['net_takogo'] } }),
        ]),
      ).reason,
    ).toBe('DELTA_SET_UNKNOWN_CLASS');
  });
  test('дельта подписки заменяет декларацию целиком; чужой движок — DELTA_ENGINE_MISMATCH', () => {
    const base = snapshotWith();
    base.subscriptions.set('orbis/agenda', {
      id: 'orbis/agenda',
      ownerId: null,
      surface: 'planner/agenda',
      definition: AGENDA_DEF,
      module: null,
      rank: 1,
    });
    const changed = { ...AGENDA_DEF, show: { ...AGENDA_DEF.show, limit: 50 } };
    const after = applyDeltas(base, [
      row('subscription', 'orbis/agenda', { definition: changed }),
    ]).subscriptions.get('orbis/agenda')?.definition;
    // Сужение по движку, а не каст: союз декларации разводится ровно тем полем, которым его
    // разводит схема, и вопрос «а той ли ветки нам подсунули замену» здесь тоже проверяется.
    expect(after?.engine === 'agenda' ? after.show.limit : null).toBe(50);
    expect(
      refusal(() =>
        applyDeltas(base, [row('subscription', 'orbis/agenda', { definition: BUDGET_DEF })]),
      ).reason,
    ).toBe('DELTA_ENGINE_MISMATCH');
  });
  test('дельта на подписку, которой нет (модуль выключен), пропускается без отказа', () => {
    expect(
      applyDeltas(snapshotWith(), [row('subscription', 'user/нет', { definition: AGENDA_DEF })])
        .subscriptions.size,
    ).toBe(0);
  });
});

describe('карта классов дельты (§Б2-2)', () => {
  const CLASS_MAP_DELTA = {
    selectOptions: {
      'orbis/task_status': { add: [{ key: 'in_review', label: { ru: 'На ревью' }, rank: 45 }] },
    },
    classMap: {
      'orbis/task_status': [
        { contract: 'orbis/completable', slot: 'status', variant: 'in_review', class: 'active' },
      ],
    },
  };
  const completableOf = (s: RegistrySnapshot, aspectId: string) =>
    s.aspects.get(aspectId)?.implements.find((b) => b.contract === 'orbis/completable');

  test('classMap разбирается схемой рядом с selectOptions', () => {
    expect(() =>
      applyDeltas(snapshotWith(), [row('aspect', 'orbis/task', CLASS_MAP_DELTA)]),
    ).not.toThrow();
  });
  test('поле вне закрытой формы по-прежнему DELTA_MALFORMED — .strict() не ослаблен', () => {
    expect(
      refusal(() =>
        applyDeltas(snapshotWith(), [row('aspect', 'orbis/task', { classMapping: {} })]),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'DELTA_MALFORMED' });
  });

  const expectActive = (s: RegistrySnapshot, aspectId: string) =>
    expect(completableOf(s, aspectId)?.value_map).toContainEqual({
      slot: 'status',
      variant: 'in_review',
      class: 'active',
    });

  test('отнесение дописывается в value_map привязки', () => {
    expectActive(
      applyDeltas(snapshotWith(), [row('aspect', 'orbis/task', CLASS_MAP_DELTA)]),
      'orbis/task',
    );
  });
  test('привязка ищется ПО СЛОТУ, а не по цели дельты: дельта на note доносит класс до task', () => {
    // Вариант приезжает в ТИП свойства и виден всем носителям; отнесение обязано быть таким же
    // общим, иначе `class=` находит запись через один аспект и теряет через другой.
    expectActive(
      applyDeltas(snapshotWith(), [row('aspect', 'orbis/note', CLASS_MAP_DELTA)]),
      'orbis/task',
    );
  });
  test('отнесение, переопределяющее СИСТЕМНОЕ, не дописывается (§Б2-4: только дополнять)', () => {
    const after = applyDeltas(snapshotWith(), [
      row('aspect', 'orbis/task', {
        classMap: {
          'orbis/task_status': [
            { contract: 'orbis/completable', slot: 'status', variant: 'done', class: 'active' },
          ],
        },
      }),
    ]);
    expect(
      completableOf(after, 'orbis/task')?.value_map.filter((m) => m.variant === 'done'),
    ).toEqual([{ slot: 'status', variant: 'done', class: 'done' }]);
  });
});
