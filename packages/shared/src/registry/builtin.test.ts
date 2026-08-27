// Содержимое встроенных реестров новой формы против НОРМАТИВА — таблицы §А8 спеки
// «Реформа свойств» (строки 216–369), §А4-3 (роли) и §Б1-2 (контракты).
//
// Снимок §А8 ниже переписан из спеки РУКАМИ и не выведен из реализации: реализация,
// разошедшаяся с ним, красит тест. Второй слой проверки — сегодняшние zod-схемы
// (`schemas/aspects.ts`): из них берутся порядок полей, обязательность и порядок enum,
// поэтому «перевод» доказывается против живого кода, а не против самого себя.
import { expect, test } from 'bun:test';
import type { z } from 'zod';
import { BUILTIN_ASPECT_META } from '../aspect-registry';
import {
  type AspectId,
  BUILTIN_ASPECT_IDS,
  HIERARCHICAL_ROLE_IDS,
  RELATION_ROLE_IDS,
} from '../constants';
import { ASPECT_SCHEMAS } from '../schemas/aspects';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import { BUILTIN_PROPERTY_META, CORE_PROPERTY_IDS } from './builtin-properties';
import { BUILTIN_RELATION_ROLE_META } from './builtin-roles';
import { CONTRACT_IDS_V1 } from './contract-ids';

/** Строка таблицы §А8: [поле аспекта сегодня (null — свойство заведено реформой), id свойства, Req]. */
type Row = readonly [string | null, string, boolean];

/** Снимок §А8 в порядке строк таблицы — он же нормативный порядок `properties[]` аспекта. */
const A8: Record<AspectId, readonly Row[]> = {
  'orbis/schedule': [
    ['start_at', 'orbis/start_at', true],
    ['end_at', 'orbis/end_at', false],
    ['duration_min', 'orbis/duration_min', false],
    ['all_day', 'orbis/all_day', false],
    ['recurrence', 'orbis/recurrence', false],
    ['location', 'orbis/location', false],
    ['timezone', 'orbis/timezone', false],
  ],
  'orbis/task': [
    ['status', 'orbis/task_status', true],
    ['priority', 'orbis/priority', false],
    ['due_date', 'orbis/due_date', false],
    ['completed_at', 'orbis/completed_at', false],
    ['effort_min', 'orbis/effort_min', false],
    ['waiting_for', 'orbis/waiting_for', false],
  ],
  'orbis/financial': [
    ['amount', 'orbis/amount', true],
    ['currency', 'orbis/currency', false],
    ['direction', 'orbis/direction', true],
    ['category_ref', 'orbis/finance_category', true],
    ['occurred_on', 'orbis/occurred_on', false],
    ['planned', 'orbis/planned', false],
    ['recurring', 'orbis/recurring', false],
    ['payment_method', 'orbis/payment_method', false],
    ['counterparty', 'orbis/counterparty', false],
    ['bank_txn_id', 'orbis/bank_txn_id', false],
  ],
  'orbis/note': [
    ['content_type', 'orbis/content_type', false],
    ['pinned', 'orbis/pinned', false],
  ],
  'orbis/budget': [
    ['category_ref', 'orbis/finance_category', true],
    ['limit', 'orbis/limit', true],
    ['currency', 'orbis/currency', false],
    ['period_start', 'orbis/period_start', true],
    ['period_end', 'orbis/period_end', true],
    ['carryover', 'orbis/carryover', false],
  ],
  'orbis/category': [
    ['icon', 'orbis/icon', false],
    ['color', 'orbis/color', false],
    ['aliases', 'orbis/aliases', false],
    ['spend_class', 'orbis/spend_class', false],
  ],
  'orbis/memory': [
    ['kind', 'orbis/memory_kind', true],
    ['scope', 'orbis/rule_scope', false],
    [null, 'orbis/rule_pattern', false],
    [null, 'orbis/rule_target', false],
  ],
  'orbis/goal': [
    ['progress_source', 'orbis/progress_source', true],
    ['target_value', 'orbis/target_value', true],
    ['current_value', 'orbis/current_value', false],
    ['unit', 'orbis/unit', false],
  ],
  'orbis/project': [['stage', 'orbis/project_stage', true]],
  'orbis/repo': [
    ['url', 'orbis/repo_url', true],
    ['default_branch', 'orbis/default_branch', true],
  ],
  'orbis/assignment': [
    ['executor', 'orbis/executor', true],
    ['grant_id', 'orbis/grant', false],
    ['assignee', 'orbis/assignee', false],
    ['may_close', 'orbis/may_close', false],
  ],
  'orbis/agent-run': [
    ['grant_id', 'orbis/grant', false],
    ['routine_id', 'orbis/run_routine', false],
    ['bucket', 'orbis/run_bucket', false],
    ['attempt', 'orbis/run_attempt', false],
    ['fail_note', 'orbis/fail_note', false],
    ['proposal', 'orbis/run_proposal', false],
    ['undecided', 'orbis/undecided', false],
    ['outcome', 'orbis/run_outcome', true],
    ['started_at', 'orbis/run_started_at', true],
    ['finished_at', 'orbis/run_finished_at', false],
    ['last_step_at', 'orbis/last_step_at', true],
    ['step_count', 'orbis/step_count', true],
    ['steps', 'orbis/run_steps', true],
    ['session_url', 'orbis/session_url', false],
    ['report', 'orbis/run_report', false],
    ['checkpoint', 'orbis/run_checkpoint', false],
    ['reply', 'orbis/run_reply', false],
    ['usage', 'orbis/run_usage', false],
    ['abandon_note', 'orbis/abandon_note', false],
  ],
  'orbis/routine': [
    ['stage', 'orbis/routine_stage', true],
    ['at', 'orbis/routine_at', true],
    ['days', 'orbis/routine_days', false],
    ['mode', 'orbis/routine_mode', true],
    ['allowed_tools', 'orbis/allowed_tools', false],
  ],
};

/** Поля, которые §А8 УДАЛЯЕТ, а не переводит: свойства у них нет по решению спеки. */
const DROPPED: Partial<Record<AspectId, readonly string[]>> = {
  'orbis/agent-run': ['project_id'], // денормализация, заменённая parent_project/root_project
};

/** Свойства §А8, у которых нет аспекта-носителя: вычисляемые «Новые свойства реформы». */
const FREE_DOMAIN_IDS = ['orbis/parent_project', 'orbis/root_project'] as const;

const SHAPES = ASPECT_SCHEMAS as unknown as Record<AspectId, z.ZodObject<z.ZodRawShape>>;
const byId = new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p]));
const defsById = new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a]));
const metaById = new Map(BUILTIN_ASPECT_META.map((m) => [m.id, m]));

/** Распаковка enum сквозь optional/array: порядок вариантов — норматив сортировки (`compile-ast.ts`). */
function enumValues(schema: z.ZodTypeAny): readonly string[] {
  let node = schema;
  for (let i = 0; i < 8; i += 1) {
    const def = node._def as {
      typeName: string;
      innerType?: z.ZodTypeAny;
      type?: z.ZodTypeAny;
      values?: readonly string[];
    };
    if (def.values !== undefined) return def.values;
    const inner = def.innerType ?? def.type;
    if (inner === undefined) break;
    node = inner;
  }
  throw new Error('поле не enum — снимок SELECTS разошёлся со схемой');
}

test('73 доменных свойства + 4 core; id/key уникальны; у всех label.ru/en и description.ru/en', () => {
  const domain = BUILTIN_PROPERTY_META.filter((p) => p.storage === 'props');
  const core = BUILTIN_PROPERTY_META.filter((p) => p.storage === 'core');
  // Счёт §А8: 73 поля − 3 слияния − 1 удаление + 4 новых = 73; core в счёт словаря не входят.
  expect(domain.length).toBe(73);
  expect(core.map((p) => p.id)).toEqual([...CORE_PROPERTY_IDS]);
  expect(BUILTIN_PROPERTY_META.length).toBe(77);

  // Состав доменного словаря = все id таблицы §А8 плюс два вычисляемых свойства реформы.
  const fromA8 = new Set<string>();
  for (const rows of Object.values(A8)) for (const [, id] of rows) fromA8.add(id);
  for (const id of FREE_DOMAIN_IDS) fromA8.add(id);
  expect([...domain.map((p) => p.id)].sort()).toEqual([...fromA8].sort());
  // `orbis/project_id` §А8 удаляет — заводить его нельзя.
  expect(byId.has('orbis/project_id')).toBe(false);
  // `orbis/date` и `orbis/weight` в v1 НЕ сеются: свойство без потребителя — сирота (§А8).
  expect(byId.has('orbis/date')).toBe(false);
  expect(byId.has('orbis/weight')).toBe(false);

  expect(byId.size).toBe(BUILTIN_PROPERTY_META.length); // id уникальны
  expect(new Set(BUILTIN_PROPERTY_META.map((p) => p.key)).size).toBe(BUILTIN_PROPERTY_META.length);
  expect(new Set(BUILTIN_PROPERTY_META.map((p) => p.rank)).size).toBe(BUILTIN_PROPERTY_META.length);

  for (const p of BUILTIN_PROPERTY_META) {
    expect(p.ownerId).toBeNull(); // встроенное = owner_id IS NULL (§А2-1)
    expect(p.key).toBe(p.id); // у встроенных key изначально = id (§А2-1)
    expect(p.status).toBe('active');
    expect(p.mergedInto).toBeNull();
    // Обе локали у обеих подписей: description обязателен (Р4) — носитель смысла для AI.
    for (const text of [p.label, p.description]) {
      expect((text.ru ?? '').length).toBeGreaterThan(0);
      expect((text.en ?? '').length).toBeGreaterThan(0);
    }
    // description — фраза смысла, а не пересказ типа.
    expect(p.description.ru).not.toBe(p.label.ru);
  }

  // Флаги §А8: служебные пишет сервер, кэш правила модель не правит.
  expect(byId.get('orbis/carryover')?.flags.system_writable).toBe(true);
  expect(byId.get('orbis/bank_txn_id')?.flags.system_writable).toBe(true);
  const runOwn = (A8['orbis/agent-run'] ?? [])
    .map(([, id]) => id)
    .filter((id) => id !== 'orbis/grant');
  for (const id of runOwn) expect(byId.get(id)?.flags.system_writable).toBe(true);
  expect(byId.get('orbis/current_value')?.flags.model_writable).toBe(false);
  for (const id of FREE_DOMAIN_IDS) {
    expect(byId.get(id)?.flags.model_writable).toBe(false);
    expect(byId.get(id)?.flags.computed).toEqual({ rule: 'nearest_ancestor' });
    expect(byId.get(id)?.type.kind).toBe('ref');
  }
  // §А1-3: core-проекции адресуются реестром, а хранятся колонкой.
  expect(byId.get('orbis/archived')?.type.kind).toBe('boolean');
  expect(byId.get('orbis/title')?.type.kind).toBe('text');
  expect(byId.get('orbis/created_at')?.type.kind).toBe('timestamp');
  expect(byId.get('orbis/updated_at')?.type.kind).toBe('timestamp');

  // Каждое доменное свойство либо носится аспектом, либо названо свободным (§А8, Р9).
  const carried = new Set<string>();
  for (const rows of Object.values(A8)) for (const [, id] of rows) carried.add(id);
  for (const p of domain) {
    expect(carried.has(p.id) || (FREE_DOMAIN_IDS as readonly string[]).includes(p.id)).toBe(true);
  }
});

test('каждый property_id BUILTIN_ASPECT_DEFS существует; required и порядок rank — по §А8', () => {
  // Страж полноты (замена aspect-registry.test.ts:30-34): забытый аспект — молчаливая пропажа.
  expect([...BUILTIN_ASPECT_DEFS.map((a) => a.id)].sort()).toEqual([...BUILTIN_ASPECT_IDS].sort());
  expect(BUILTIN_ASPECT_DEFS.length).toBe(13);
  expect(new Set(BUILTIN_ASPECT_DEFS.map((a) => a.rank)).size).toBe(13);

  for (const aspectId of BUILTIN_ASPECT_IDS) {
    const rows = A8[aspectId];
    const def = defsById.get(aspectId);
    expect(def).toBeDefined();
    if (def === undefined) continue;

    // Снимок §А8 сверен с ЖИВОЙ zod-схемой: порядок полей и обязательность — оттуда.
    const shape = SHAPES[aspectId].shape;
    const dropped = DROPPED[aspectId] ?? [];
    expect(Object.keys(shape).filter((k) => !dropped.includes(k))).toEqual(
      rows.filter(([field]) => field !== null).map(([field]) => field as string),
    );
    for (const [field, propertyId, required] of rows) {
      if (field === null) continue;
      const zodField = shape[field];
      expect(
        `${aspectId}.${field}: required=${zodField !== undefined && !zodField.isOptional()}`,
      ).toBe(`${aspectId}.${field}: required=${required}`);
      expect(byId.has(propertyId)).toBe(true);
    }

    // Реализация: те же id в том же порядке, та же обязательность, rank = порядок строк.
    expect(def.properties.map((p) => p.propertyId)).toEqual(rows.map(([, id]) => id));
    expect(def.properties.map((p) => p.required)).toEqual(rows.map(([, , req]) => req));
    expect(def.properties.map((p) => p.rank)).toEqual(rows.map((_, i) => i + 1));
    for (const ref of def.properties) expect(byId.has(ref.propertyId)).toBe(true);
    // §Б2: привязки — часть Б, в срезе А поле пустует.
    expect(def.implements).toEqual([]);
  }

  // Служебность §А3-1/Р-П-5: колонка реестра, а не список в коде.
  expect(BUILTIN_ASPECT_DEFS.filter((a) => a.service).map((a) => a.id)).toEqual([
    'orbis/agent-run',
  ]);
  // Модули §Б8-2: ядро и ядро-исполнитель — module NULL.
  expect(Object.fromEntries(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a.module]))).toEqual({
    'orbis/schedule': 'planner',
    'orbis/task': 'planner',
    'orbis/financial': 'finance',
    'orbis/note': null,
    'orbis/budget': 'finance',
    'orbis/category': 'finance',
    'orbis/memory': 'memory',
    'orbis/goal': 'goals',
    'orbis/project': 'ade',
    'orbis/repo': 'ade',
    'orbis/assignment': null,
    'orbis/agent-run': null,
    'orbis/routine': null,
  });
});

test('слияния: finance_category и currency у financial И budget; grant у assignment и agent-run', () => {
  const carriers = (propertyId: string) =>
    BUILTIN_ASPECT_DEFS.filter((a) => a.properties.some((p) => p.propertyId === propertyId))
      .map((a) => a.id)
      .sort();
  expect(carriers('orbis/finance_category')).toEqual(['orbis/budget', 'orbis/financial']);
  expect(carriers('orbis/currency')).toEqual(['orbis/budget', 'orbis/financial']);
  expect(carriers('orbis/grant')).toEqual(['orbis/agent-run', 'orbis/assignment']);
  // Слияние — ОДНА запись словаря на два аспекта, а не две одинаковых.
  for (const id of ['orbis/finance_category', 'orbis/currency', 'orbis/grant']) {
    expect(BUILTIN_PROPERTY_META.filter((p) => p.id === id).length).toBe(1);
  }
  // §А8: id называет смысл, суффикс `_ref` упразднён (В1).
  expect(BUILTIN_PROPERTY_META.filter((p) => p.id.endsWith('_ref'))).toEqual([]);
  expect(byId.get('orbis/grant')?.type.kind).toBe('grant');
  // Цель ссылки — Q-AST целиком (§А6-1 «target?: Q-AST | Q-AST[]»), а не голый узел фильтра:
  // форму сузила Задача 8 вместе с каноном §А5-7.
  expect(byId.get('orbis/finance_category')?.type).toEqual({
    kind: 'ref',
    target: { filter: { aspect: 'orbis/category' } },
  });
});

test('select-варианты: ASCII key, порядок rank = порядок enum в schemas/aspects.ts', () => {
  const selects: readonly (readonly [AspectId, string, string])[] = [
    ['orbis/task', 'status', 'orbis/task_status'],
    ['orbis/task', 'priority', 'orbis/priority'],
    ['orbis/financial', 'direction', 'orbis/direction'],
    ['orbis/note', 'content_type', 'orbis/content_type'],
    ['orbis/category', 'spend_class', 'orbis/spend_class'],
    ['orbis/memory', 'kind', 'orbis/memory_kind'],
    ['orbis/project', 'stage', 'orbis/project_stage'],
    ['orbis/assignment', 'executor', 'orbis/executor'],
    ['orbis/agent-run', 'outcome', 'orbis/run_outcome'],
    ['orbis/routine', 'stage', 'orbis/routine_stage'],
    ['orbis/routine', 'days', 'orbis/routine_days'],
    ['orbis/routine', 'mode', 'orbis/routine_mode'],
  ];
  // Все select-свойства реестра названы здесь — новый select без сверки не проедет.
  expect(
    BUILTIN_PROPERTY_META.filter((p) => p.type.kind === 'select')
      .map((p) => p.id)
      .sort(),
  ).toEqual([...new Set(selects.map(([, , id]) => id))].sort());

  for (const [aspectId, field, propertyId] of selects) {
    const type = byId.get(propertyId)?.type;
    expect(type?.kind).toBe('select');
    if (type?.kind !== 'select') continue;
    const zodField = SHAPES[aspectId].shape[field];
    expect(zodField).toBeDefined();
    if (zodField === undefined) continue;
    const expected = enumValues(zodField);
    // Порядок вариантов — норматив: по нему сортируются смарт-листы (`compile-ast.ts`, sortItem).
    expect(`${propertyId}: ${type.options.map((o) => o.key).join(',')}`).toBe(
      `${propertyId}: ${expected.join(',')}`,
    );
    expect(type.options.map((o) => o.rank)).toEqual(expected.map((_, i) => i + 1));
    for (const option of type.options) {
      expect(option.key).toMatch(/^[a-z][a-z0-9_-]*$/); // ASCII-слаг, хранится в данных (Р3)
      expect((option.label.ru ?? '').length).toBeGreaterThan(0);
      expect((option.label.en ?? '').length).toBeGreaterThan(0);
    }
  }
  // Разные enum — разные факты (Р11): три жизненных цикла не сливаются в один select.
  expect(byId.get('orbis/task_status')?.id).not.toBe(byId.get('orbis/project_stage')?.id);
  expect(byId.get('orbis/routine_days')?.type).toMatchObject({ cardinality: 'many', minItems: 1 });
});

test('роли: 11 id, иерархия, target_max_incoming конверта, acyclic, created_by system', () => {
  expect([...RELATION_ROLE_IDS]).toEqual([
    'subitem',
    'ticket',
    'run',
    'envelope-binding',
    'category-parent',
    'dependency',
    'mention',
    'instance-of',
    'ref',
    'alternative-of',
    'supersedes',
  ]);
  expect(BUILTIN_RELATION_ROLE_META.map((r) => r.id)).toEqual([...RELATION_ROLE_IDS]);
  expect(BUILTIN_RELATION_ROLE_META.length).toBe(11);
  expect(BUILTIN_RELATION_ROLE_META.map((r) => r.rank)).toEqual(
    RELATION_ROLE_IDS.map((_, i) => i + 1),
  );

  const roleById = new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r]));
  // Иерархия §А4-3: envelope-binding в неё НЕ входит (конверт не родитель транзакции).
  expect(BUILTIN_RELATION_ROLE_META.filter((r) => r.hierarchical).map((r) => r.id)).toEqual([
    ...HIERARCHICAL_ROLE_IDS,
  ]);
  expect([...HIERARCHICAL_ROLE_IDS]).toEqual(['subitem', 'ticket', 'run', 'category-parent']);
  expect(roleById.get('envelope-binding')?.hierarchical).toBe(false);

  expect(roleById.get('envelope-binding')?.constraints.target_max_incoming).toBe(1);
  expect(
    BUILTIN_RELATION_ROLE_META.filter((r) => r.constraints.acyclic === true).map((r) => r.id),
  ).toEqual(['category-parent', 'dependency']);
  expect(
    BUILTIN_RELATION_ROLE_META.filter((r) => r.constraints.created_by === 'system').map(
      (r) => r.id,
    ),
  ).toEqual(['run', 'envelope-binding', 'instance-of', 'ref']);

  for (const role of BUILTIN_RELATION_ROLE_META) {
    expect(role.ownerId).toBeNull();
    expect(role.key).toBe(role.id);
    expect(role.symmetric).toBe(false); // named-future Ч10-С2
    for (const text of [role.label, role.description, role.sourceLabel, role.targetLabel]) {
      expect((text.ru ?? '').length).toBeGreaterThan(0);
      expect((text.en ?? '').length).toBeGreaterThan(0);
    }
  }
  // РП-5: у instance-of source — ШАБЛОН, target — экземпляр (как сегодня derived_from).
  expect(roleById.get('instance-of')?.sourceLabel.ru).toBe('Шаблон');
  expect(roleById.get('instance-of')?.targetLabel.ru).toBe('Экземпляр');
  // Ч10-С3: стороны конверта подписаны реестром, а не кодом UI.
  expect(roleById.get('envelope-binding')?.sourceLabel.ru).toBe('Конверт');
  expect(roleById.get('envelope-binding')?.targetLabel.ru).toBe('Транзакция');
});

test('все 13 keyFields, tagMappings и ai_instructions перенесены и равны aspect-registry.ts', () => {
  expect(BUILTIN_ASPECT_META.length).toBe(13);
  // Р-16: списков keyFields ровно 13 — orbis/note (aspect-registry.ts:61) в их числе.
  expect(BUILTIN_ASPECT_META.filter((m) => m.viewConfig.keyFields.length > 0).length).toBe(13);
  expect(metaById.get('orbis/note')?.viewConfig.keyFields).toEqual(['content_type', 'pinned']);

  for (const aspectId of BUILTIN_ASPECT_IDS) {
    const meta = metaById.get(aspectId);
    const def = defsById.get(aspectId);
    expect(meta).toBeDefined();
    expect(def).toBeDefined();
    if (meta === undefined || def === undefined) continue;

    // Старое имя поля → id свойства по снимку §А8.
    const toId = new Map((A8[aspectId] ?? []).map(([field, id]) => [field, id]));
    const expectedKeyFields = meta.viewConfig.keyFields.map((f) => {
      const id = toId.get(f);
      if (id === undefined) throw new Error(`${aspectId}: keyField ${f} не переведён`);
      return id;
    });
    expect(`${aspectId}: ${def.viewConfig.keyFields.join(',')}`).toBe(
      `${aspectId}: ${expectedKeyFields.join(',')}`,
    );
    expect(def.viewConfig.icon).toBe(meta.icon);
    expect(def.tagMappings).toEqual(meta.tagMappings);
    expect(def.aiInstructions).toBe(meta.aiInstructions);
    expect(def.key).toBe(def.id); // у встроенных key = id; имя тула attach_* — из key
    expect(def.ownerId).toBeNull();
    expect(def.label.en).toBe(meta.name);
    expect(def.description.ru).toBe(meta.description);
    expect((def.label.ru ?? '').length).toBeGreaterThan(0);
    expect((def.description.en ?? '').length).toBeGreaterThan(0);
  }
});

test('CONTRACT_IDS_V1 — ровно 8 id §Б1-2', () => {
  expect([...CONTRACT_IDS_V1]).toEqual([
    'orbis/completable',
    'orbis/when',
    'orbis/recurrence',
    'orbis/sensitivity',
    'orbis/money-movement',
    'orbis/envelope',
    'orbis/progress',
    'orbis/categorizable',
  ]);
  expect(new Set(CONTRACT_IDS_V1).size).toBe(8);
  // `orbis/rule_scope` обязан принимать контракт уже в срезе А (§А8, РП-6) — отсюда шим.
  const scope = byId.get('orbis/rule_scope');
  expect(scope?.type).toEqual({ kind: 'registry_ref', target: 'contract' });
  expect(CONTRACT_IDS_V1).toContain('orbis/money-movement');
});

/** Паттерн слота расписания рутины — сегодня `aspects.ts:229`, в реестре конфиг `text`. */
const RUN_BUCKET_PATTERN = '^(\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d|manual:\\S+)$';

/**
 * Колонки «Тип (В8)» и «модуль» таблицы §А8, свойство за свойством. Ключи конфига в подписи
 * отсортированы: нормативен состав ограничений, а не порядок, в котором они записаны.
 * Именно здесь ловится потеря границы — в том числе шести `minLength`, которые §А8 теряет
 * молча, а план (РП-8/Р-17) сохраняет.
 */
const A8_TYPES: Record<string, string> = {
  'orbis/start_at': 'timestamp|planner',
  'orbis/end_at': 'timestamp|planner',
  'orbis/duration_min': 'number{integer:true,min:1}|planner',
  'orbis/all_day': 'boolean|planner',
  'orbis/recurrence': 'json{schema:json-schema}|planner',
  'orbis/location': 'text|planner',
  'orbis/timezone': 'text{format:iana-tz}|planner',
  'orbis/task_status': 'select{options:6}|planner',
  'orbis/priority': 'select{options:3}|planner',
  'orbis/due_date': 'date|planner',
  'orbis/completed_at': 'timestamp|planner',
  'orbis/effort_min': 'number{integer:true,min:1}|planner',
  'orbis/waiting_for': 'text|planner',
  'orbis/amount': 'decimal{exclusiveMin:0}|finance',
  'orbis/currency': 'text{format:currency,maxLength:3,minLength:3}|finance',
  'orbis/direction': 'select{options:2}|finance',
  'orbis/finance_category': 'ref{target:{"filter":{"aspect":"orbis/category"}}}|finance',
  'orbis/occurred_on': 'date|finance',
  'orbis/planned': 'boolean{default:false}|finance',
  'orbis/recurring': 'boolean|finance',
  'orbis/payment_method': 'text|finance',
  'orbis/counterparty': 'text|finance',
  'orbis/bank_txn_id': 'text{maxLength:128,minLength:1}|finance',
  'orbis/content_type': 'select{options:3}|core',
  'orbis/pinned': 'boolean|core',
  'orbis/limit': 'decimal{min:0}|finance',
  'orbis/period_start': 'date|finance',
  'orbis/period_end': 'date|finance',
  'orbis/carryover': 'decimal|finance',
  'orbis/icon': 'text|finance',
  'orbis/color': 'text{format:color}|finance',
  'orbis/aliases': 'text{cardinality:many,maxItems:50}|finance',
  'orbis/spend_class': 'select{options:2}|finance',
  'orbis/memory_kind': 'select{options:2}|memory',
  'orbis/rule_scope': 'registry_ref{target:contract}|memory',
  'orbis/rule_pattern': 'text|memory',
  'orbis/rule_target': 'ref{target:{"filter":{"aspect":"orbis/category"}}}|memory',
  'orbis/progress_source': 'json{schema:json-schema}|goals',
  'orbis/target_value': 'decimal{exclusiveMin:0}|goals',
  'orbis/current_value': 'decimal{min:0}|goals',
  'orbis/unit': 'text{minLength:1}|goals',
  'orbis/project_stage': 'select{options:3}|ade',
  'orbis/repo_url': 'text{format:url,maxLength:512,minLength:1}|ade',
  'orbis/default_branch': 'text{maxLength:128,minLength:1}|ade',
  'orbis/executor': 'select{options:2}|core',
  'orbis/grant': 'grant|core',
  'orbis/assignee': 'text{maxLength:200,minLength:1}|core',
  'orbis/may_close': 'boolean{default:false}|core',
  'orbis/run_routine': 'ref{target:{"filter":{"aspect":"orbis/routine"}}}|core',
  'orbis/run_bucket': `text{pattern:${RUN_BUCKET_PATTERN}}|core`,
  'orbis/run_attempt': 'number{integer:true,min:1}|core',
  'orbis/fail_note': 'text{maxLength:2000}|core',
  'orbis/run_proposal': 'json{schema:json-schema}|core',
  'orbis/undecided': 'boolean|core',
  'orbis/run_outcome': 'select{options:7}|core',
  'orbis/run_started_at': 'timestamp|core',
  'orbis/run_finished_at': 'timestamp|core',
  'orbis/last_step_at': 'timestamp|core',
  'orbis/step_count': 'number{integer:true,min:0}|core',
  'orbis/run_steps': 'json{maxItems:500,schema:json-schema}|core',
  'orbis/session_url': 'text{format:url}|core',
  'orbis/run_report': 'text{maxLength:20000}|core',
  'orbis/run_checkpoint': 'json{schema:json-schema}|core',
  'orbis/run_reply': 'json{schema:json-schema}|core',
  'orbis/run_usage': 'json{schema:json-schema}|core',
  'orbis/abandon_note': 'text{maxLength:2000}|core',
  'orbis/routine_stage': 'select{options:2}|core',
  'orbis/routine_at': 'time|core',
  'orbis/routine_days': 'select{cardinality:many,minItems:1,options:7}|core',
  'orbis/routine_mode': 'select{options:2}|core',
  'orbis/allowed_tools': 'text{cardinality:many,maxItems:50,minLength:1}|core',
  'orbis/parent_project': 'ref{target:{"filter":{"aspect":"orbis/project"}}}|ade',
  'orbis/root_project': 'ref{target:{"filter":{"aspect":"orbis/project"}}}|ade',
  'orbis/archived': 'boolean|core',
  'orbis/title': 'text|core',
  'orbis/created_at': 'timestamp|core',
  'orbis/updated_at': 'timestamp|core',
};

test('тип и модуль каждого свойства — по колонкам §А8 (включая шесть minLength РП-8)', () => {
  const signature = (property: (typeof BUILTIN_PROPERTY_META)[number]): string => {
    const { kind, ...config } = property.type as { kind: string } & Record<string, unknown>;
    const parts = Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        if (key === 'options') return `options:${(value as unknown[]).length}`;
        if (key === 'schema') return 'schema:json-schema';
        if (key === 'target')
          return `target:${typeof value === 'string' ? value : JSON.stringify(value)}`;
        return `${key}:${String(value)}`;
      })
      .sort();
    const type = parts.length === 0 ? kind : `${kind}{${parts.join(',')}}`;
    return `${type}|${property.module ?? 'core'}`;
  };

  expect(Object.keys(A8_TYPES).length).toBe(77);
  for (const property of BUILTIN_PROPERTY_META) {
    expect(`${property.id}: ${signature(property)}`).toBe(
      `${property.id}: ${A8_TYPES[property.id] ?? '<нет в снимке §А8>'}`,
    );
  }
  // Шесть полей, где сегодня стоит `min(1)` (РП-8/Р-17), плюс длина валюты §А8.
  const withMinLength = BUILTIN_PROPERTY_META.filter(
    (p) => p.type.kind === 'text' && p.type.minLength !== undefined,
  ).map((p) => p.id);
  expect(withMinLength.sort()).toEqual(
    [
      'orbis/allowed_tools',
      'orbis/assignee',
      'orbis/bank_txn_id',
      'orbis/currency',
      'orbis/default_branch',
      'orbis/repo_url',
      'orbis/unit',
    ].sort(),
  );
});

test('подписи ролей и аспектов — по §А4-3 и переносу из aspect-registry.ts', () => {
  // Роль: иерархия | ограничения | модуль | подпись источника | подпись цели.
  const ROLES: Record<string, string> = {
    subitem: 'h:true|{"created_by":"any"}|core|Родитель|Подпункт',
    ticket: 'h:true|{"created_by":"any","target_contract":"orbis/completable"}|ade|Проект|Тикет',
    run: 'h:true|{"created_by":"system"}|core|Субъект прогона|Прогон',
    'envelope-binding':
      'h:false|{"created_by":"system","target_max_incoming":1}|finance|Конверт|Транзакция',
    'category-parent':
      'h:true|{"acyclic":true,"created_by":"any"}|finance|Родительская категория|Подкатегория',
    dependency:
      'h:false|{"acyclic":true,"created_by":"any"}|core|Блокирующая работа|Заблокированная работа',
    mention: 'h:false|{"created_by":"any"}|core|Упоминает|Упомянуто',
    'instance-of': 'h:false|{"created_by":"system"}|core|Шаблон|Экземпляр',
    ref: 'h:false|{"created_by":"system"}|core|Откуда ссылка|Цель ссылки',
    'alternative-of': 'h:false|{"created_by":"any"}|core|Альтернатива|Исходный вариант',
    supersedes: 'h:false|{"created_by":"any"}|core|Замена|Замещённое',
  };
  expect(Object.keys(ROLES).length).toBe(11);
  for (const role of BUILTIN_RELATION_ROLE_META) {
    const constraints = JSON.stringify(
      Object.fromEntries(Object.entries(role.constraints).sort(([a], [b]) => (a < b ? -1 : 1))),
    );
    const actual = [
      `h:${role.hierarchical}`,
      constraints,
      role.module ?? 'core',
      role.sourceLabel.ru,
      role.targetLabel.ru,
    ].join('|');
    expect(`${role.id}: ${actual}`).toBe(`${role.id}: ${ROLES[role.id] ?? '<нет в снимке §А4-3>'}`);
  }

  // Русская подпись аспекта — единственная часть его четвёрки имён, которой не было в
  // старом реестре (там `name` только по-английски): пиннится значением.
  expect(Object.fromEntries(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a.label.ru]))).toEqual({
    'orbis/schedule': 'Расписание',
    'orbis/task': 'Задача',
    'orbis/financial': 'Финансовая операция',
    'orbis/note': 'Заметка',
    'orbis/budget': 'Конверт бюджета',
    'orbis/category': 'Категория',
    'orbis/memory': 'Память',
    'orbis/goal': 'Цель',
    'orbis/project': 'Проект',
    'orbis/repo': 'Репозиторий',
    'orbis/assignment': 'Исполнитель',
    'orbis/agent-run': 'Прогон агента',
    'orbis/routine': 'Рутина',
  });
});
