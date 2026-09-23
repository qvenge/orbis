/**
 * СЛОВАРЬ ФИКСТУР ПРАВИЛ (§С8-25, половина «валидатор») и одиннадцать правил §Б4-5 каноном (§С8-26).
 *
 * Здесь только ФОРМЫ и ОБЪЯВЛЕННЫЕ вердикты — исполняет их валидатор задачи 1 (`registry/rules.ts`),
 * ровно как `EXPR_FIXTURES` исполняет `expr/check.ts`. Довод тот же: вердикт, написанный внутри
 * теста, читается как «что получилось», а вердикт, объявленный данными, — как «что обязано быть».
 *
 * НОСИТЕЛИ — ВСТРОЕННЫЕ строки реестра, а не сид приёмки: фикстура формы не должна тянуть за собой
 * мир §С8-26, иначе словарь перестал бы быть данными и стал бы сборкой.
 *
 * `code` вердикта — строковый союз имён (Р-К-53): `ExecErrorCode` живёт на сервере, а shared про
 * сервер не знает.
 */
import { DEREF_IN_CONSTRAINT, EXPR_TYPE, type ExprCheckCode } from '../expr/codes';
import {
  RULE_TEMPLATES,
  type RuleCarrier,
  type RuleDefinitionInput,
  type RuleTemplate,
} from './rule-type';

export type RuleFixtureCode =
  | ExprCheckCode
  | 'RULE_CONFLICT'
  | 'UNIQUE_ON_MANY'
  | 'REGISTRY_CYCLE'
  | 'VALIDATION';

export interface RuleFixture {
  name: string;
  carrier: RuleCarrier;
  /** `unknown`, а не `RuleDefinitionInput`: половина негативов — формы, которые схема обязана
   *  ОТВЕРГНУТЬ, и обещать им разобранный тип значило бы отменить проверку типом. */
  rule: unknown;
  /** `reason` — уточнение внутри `VALIDATION` (словарь причин валидатора задачи 1). */
  verdict: { ok: true } | { ok: false; code: RuleFixtureCode; reason?: string };
}

const pos = (name: string, carrier: RuleCarrier, rule: unknown): RuleFixture => ({
  name,
  carrier,
  rule,
  verdict: { ok: true },
});
const neg = (
  name: string,
  carrier: RuleCarrier,
  rule: unknown,
  code: RuleFixtureCode,
  reason?: string,
): RuleFixture => ({
  name,
  carrier,
  rule,
  verdict: reason === undefined ? { ok: false, code } : { ok: false, code, reason },
});
const ASPECT = (id: string): RuleCarrier => ({ kind: 'aspect', id });
const ROLE = (id: string): RuleCarrier => ({ kind: 'role', id });
const PROPERTY = (id: string): RuleCarrier => ({ kind: 'property', id });

/** «Не повторяющаяся операция» — тот же предикат, что у системной строки задачи 14. */
const NOT_RECURRING = {
  op: 'not',
  args: [{ op: '=', args: [{ prop: 'orbis/recurring' }, { const: true }] }],
};
const IS_RECURRING = { op: '=', args: [{ prop: 'orbis/recurring' }, { const: true }] };
const ENTER_DONE = { contract: 'orbis/completable', slot: 'status', in: ['done'] };
const MATERIALIZE_PARAMS = {
  horizon_days: 60,
  retro_days: 7,
  trigger_properties: ['orbis/start_at', 'orbis/recurrence'],
  inherit: { 'orbis/schedule': ['orbis/start_at', 'orbis/all_day'] },
  own: { 'orbis/start_at': 'instance_date' },
  origin_role: 'instance-of',
};
/** Чтение чужой записи из области ПРАВИЛА ЗАПИСИ — единственная форма кода `DEREF_IN_CONSTRAINT`. */
const DEREF_CATEGORY_TITLE = {
  op: '=',
  args: [{ deref: { prop: 'orbis/finance_category', read: 'orbis/title' } }, { const: 'Еда' }],
};

/**
 * По две строки на каждый из двенадцати шаблонов §Б4-3: позитив и негатив, называющий ОДНУ порчу
 * позитива. Одна порча, а не три: вердикт обязан читаться как ответ на один вопрос.
 */
export const RULE_FIXTURES: readonly RuleFixture[] = [
  // requires_when
  pos(
    'requires_when: дата операции обязательна, пока движение не повторяющееся',
    ASPECT('orbis/financial'),
    {
      id: 'fx_requires_occurred_on',
      template: 'requires_when',
      when: NOT_RECURRING,
      params: { property: 'orbis/occurred_on' },
    },
  ),
  neg(
    'requires_when: требуемого свойства нет в реестре',
    ASPECT('orbis/financial'),
    {
      id: 'fx_requires_unknown',
      template: 'requires_when',
      when: NOT_RECURRING,
      params: { property: 'orbis/нет-такого' },
    },
    'VALIDATION',
    'RULE_UNKNOWN_PROPERTY',
  ),
  // forbidden_when
  pos(
    'forbidden_when: повторяющемуся движению признак повторения запрещён без шаблона',
    ASPECT('orbis/financial'),
    {
      id: 'fx_forbidden_recurring',
      template: 'forbidden_when',
      when: IS_RECURRING,
      params: { property: 'orbis/recurring' },
    },
  ),
  neg(
    'forbidden_when: when не булево — условие правила обязано решать «да/нет»',
    ASPECT('orbis/financial'),
    {
      id: 'fx_forbidden_not_boolean',
      template: 'forbidden_when',
      when: { prop: 'orbis/amount' },
      params: { property: 'orbis/recurring' },
    },
    EXPR_TYPE,
  ),
  // on_enter_class
  pos('on_enter_class: вход в класс done проставляет отметку завершения', ASPECT('orbis/task'), {
    id: 'fx_task_completed_at',
    template: 'on_enter_class',
    params: {
      enter: ENTER_DONE,
      set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
    },
  }),
  neg(
    'on_enter_class: слота statuz у контракта нет — опечатка адреса события',
    ASPECT('orbis/task'),
    {
      id: 'fx_task_unknown_slot',
      template: 'on_enter_class',
      params: {
        enter: { contract: 'orbis/completable', slot: 'statuz', in: ['done'] },
        set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
      },
    },
    'VALIDATION',
    'RULE_UNKNOWN_CONTRACT_SLOT',
  ),
  // default
  pos('default: валюта конверта — из параметра движка', ASPECT('orbis/budget'), {
    id: 'fx_envelope_currency',
    template: 'default',
    params: { property: 'orbis/currency', value: { param: 'default_currency' } },
  }),
  neg(
    'default: текст в позиции decimal — значение не того рода, что свойство',
    ASPECT('orbis/budget'),
    {
      id: 'fx_default_value_type',
      template: 'default',
      params: { property: 'orbis/limit', value: { const: 'без лимита' } },
    },
    'VALIDATION',
    'RULE_VALUE_TYPE',
  ),
  // unique_among
  pos(
    'unique_among: конверт уникален четвёркой «категория, валюта, период»',
    ASPECT('orbis/budget'),
    {
      id: 'fx_duplicate_envelope',
      template: 'unique_among',
      params: {
        properties: [
          'orbis/finance_category',
          'orbis/currency',
          'orbis/period_start',
          'orbis/period_end',
        ],
      },
    },
  ),
  neg(
    'unique_among: свойство-список — «уникальность» множества значений неопределена',
    ASPECT('orbis/category'),
    {
      id: 'fx_unique_on_many',
      template: 'unique_among',
      params: { properties: ['orbis/aliases'] },
    },
    'UNIQUE_ON_MANY',
  ),
  neg(
    'unique_among: с условием when — вердикт зависел бы от порядка записей (рулинг 12-3)',
    ASPECT('orbis/budget'),
    {
      id: 'fx_unique_with_when',
      template: 'unique_among',
      when: NOT_RECURRING,
      params: { properties: ['orbis/period_start'] },
    },
    'VALIDATION',
    'RULE_WHEN_UNSUPPORTED',
  ),
  // target_max_incoming
  pos('target_max_incoming: метка каталога на роли привязки к конверту', ROLE('envelope-binding'), {
    id: 'fx_envelope_binding_max',
    template: 'target_max_incoming',
    params: {},
  }),
  neg(
    'target_max_incoming: положен на аспект — ролевое ограничение носителя не знает',
    ASPECT('orbis/budget'),
    { id: 'fx_max_incoming_on_aspect', template: 'target_max_incoming', params: {} },
    'VALIDATION',
    'RULE_TEMPLATE_CARRIER',
  ),
  // acyclic
  pos('acyclic: метка каталога на роли зависимости', ROLE('dependency'), {
    id: 'fx_dependency_acyclic',
    template: 'acyclic',
    params: {},
  }),
  neg(
    'acyclic: положен на свойство — ацикличность бывает у рёбер, а не у значений',
    PROPERTY('orbis/parent_project'),
    { id: 'fx_acyclic_on_property', template: 'acyclic', params: {} },
    'VALIDATION',
    'RULE_TEMPLATE_CARRIER',
  ),
  // mirror_relation
  pos('mirror_relation: ребро ссылки зеркалит свойство-источник', ROLE('ref'), {
    id: 'fx_mirror_ref',
    template: 'mirror_relation',
    params: { meta_key: 'property', skip_computed: true },
  }),
  neg(
    'mirror_relation: без meta_key зеркалить нечем',
    ROLE('ref'),
    { id: 'fx_mirror_no_meta', template: 'mirror_relation', params: { skip_computed: true } },
    'VALIDATION',
    'RULE_MALFORMED',
  ),
  // nearest_ancestor
  pos('nearest_ancestor: ближайший проект и корень дерева', ASPECT('orbis/project'), {
    id: 'fx_nearest_project',
    template: 'nearest_ancestor',
    params: {
      targets: { parent: 'orbis/parent_project', root: 'orbis/root_project' },
      depth_cap: 32,
    },
  }),
  neg(
    'nearest_ancestor: кап глубины 0 — обход не сделал бы ни шага',
    ASPECT('orbis/project'),
    {
      id: 'fx_nearest_zero_cap',
      template: 'nearest_ancestor',
      params: {
        targets: { parent: 'orbis/parent_project', root: 'orbis/root_project' },
        depth_cap: 0,
      },
    },
    'VALIDATION',
    'RULE_MALFORMED',
  ),
  // materialize
  pos('materialize: экземпляры расписания на горизонт вперёд', ASPECT('orbis/schedule'), {
    id: 'fx_materialize_schedule',
    template: 'materialize',
    params: MATERIALIZE_PARAMS,
  }),
  neg(
    'materialize: пустой список триггеров — пересчитывать не на что',
    ASPECT('orbis/schedule'),
    {
      id: 'fx_materialize_no_triggers',
      template: 'materialize',
      params: { ...MATERIALIZE_PARAMS, trigger_properties: [] },
    },
    'VALIDATION',
    'RULE_MALFORMED',
  ),
  // rollover
  pos('rollover: остаток месяца переносится опубликованной величиной', ASPECT('orbis/budget'), {
    id: 'fx_rollover_remaining',
    template: 'rollover',
    params: { source: 'exact_calendar_month', carry: { agg: 'remaining' } },
  }),
  neg(
    'rollover: переносимая величина не опубликована конвертом',
    ASPECT('orbis/budget'),
    {
      id: 'fx_rollover_unpublished',
      template: 'rollover',
      params: { source: 'exact_calendar_month', carry: { agg: 'spend' } },
    },
    'VALIDATION',
    'RULE_ROLLOVER_AGG_UNPUBLISHED',
  ),
  // assign_level
  // `when` позитива написан формой, которая в языке E УЖЕ ЕСТЬ (`$sensitivity`): позитивы этого
  // словаря пиннятся разбором схемы, а `$touched` §Б4-5 приезжает в E задачей 15 — до неё он
  // живёт только в `ASSIGN_LEVEL_RULES` ниже, где схемой никто не разбирает.
  pos('assign_level: внешнее письмо от рутины — показать владельцу', ASPECT('orbis/task'), {
    id: 'fx_assign_show_external',
    template: 'assign_level',
    params: {},
    level: 'show',
    actor: 'routine',
    when: { op: 'in', args: [{ const: 'external' }, { ctx: '$sensitivity' }] },
  }),
  neg(
    'assign_level: понижение до silent без актора — правило без адресата',
    ASPECT('orbis/task'),
    {
      id: 'fx_assign_lowering_unscoped',
      template: 'assign_level',
      params: {},
      level: 'silent',
      when: { op: 'in', args: [{ const: 'external' }, { ctx: '$sensitivity' }] },
    },
    'VALIDATION',
    'RULE_LOWERING_UNSCOPED',
  ),
  // ─── две ИМЕННЫЕ фикстуры сверх шаблонов: коды §С1-2, формой не выражаемые ───
  neg(
    'код DEREF_IN_CONSTRAINT: правило записи читает чужую запись',
    ASPECT('orbis/financial'),
    {
      id: 'fx_deref_in_constraint',
      template: 'requires_when',
      when: DEREF_CATEGORY_TITLE,
      params: { property: 'orbis/occurred_on' },
    },
    DEREF_IN_CONSTRAINT,
  ),
  // ПАРА правил, а не одно: `RULE_CONFLICT` — свойство пары писателей, и одного правила на входе
  // валидатору мало. Поэтому `rule` здесь массив, и в счёт форм такая фикстура не идёт.
  neg(
    'код RULE_CONFLICT: два включённых on_enter_class одного ключа события',
    ASPECT('orbis/task'),
    [
      {
        id: 'fx_conflict_first',
        template: 'on_enter_class',
        params: {
          enter: ENTER_DONE,
          set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
        },
      },
      {
        // Второе правило пары — ТАКОЕ ЖЕ законное, как первое: момент записи — core-проекция
        // `orbis/updated_at` (Р-К-2), а не `$today` — тот дал бы date в позиции timestamp, и пара
        // называла бы конфликт только в одном порядке проверки (второе отказало бы RULE_VALUE_TYPE).
        id: 'fx_conflict_second',
        template: 'on_enter_class',
        params: {
          enter: ENTER_DONE,
          set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
        },
      },
    ],
    'RULE_CONFLICT',
  ),
];

/** Сколько позитивов и негативов пришлось на каждый шаблон — мерка полноты §С8-25. */
export function ruleFormsOf(
  f: readonly RuleFixture[],
): ReadonlyMap<RuleTemplate, { positive: number; negative: number }> {
  const out = new Map<RuleTemplate, { positive: number; negative: number }>(
    RULE_TEMPLATES.map((t) => [t, { positive: 0, negative: 0 }]),
  );
  for (const x of f) {
    const cell = out.get((x.rule as { template?: RuleTemplate }).template as RuleTemplate);
    if (cell === undefined) continue; // именные фикстуры кодов — вне счёта форм
    if (x.verdict.ok) cell.positive += 1;
    else cell.negative += 1;
  }
  return out;
}

/**
 * Рутина импорта правила 6 §Б4-5: `ruleActorSchema` принимает `{routine: uuid}` ЛИТЕРАЛОМ, и
 * вывести его из владельца негде. Мир §С8-26 (`test/fixtures/test-seed.ts`, 0d) сеет её с этим id.
 */
export const TEST_IMPORT_ROUTINE_ID = '7b3f1c22-9e64-4a8d-8f1c-2d5a6e0b4471';

const IN_CLASS = (c: string, cls: readonly string[]) => ({
  op: 'in',
  args: [{ class: { contract: c } }, { const: [...cls] }],
});
const IN_FACT = (f: string) => ({ op: 'in', args: [{ const: f }, { ctx: '$sensitivity' }] });
const AL = (n: string, name: string, carrier: RuleCarrier, rule: RuleDefinitionInput) => ({
  n,
  name,
  carrier,
  rule,
});

/**
 * ОДИННАДЦАТЬ ПРАВИЛ §Б4-5 КАНОНОМ (§С8-26) — тринадцатью записями: правила 8 и 10 разложены на
 * два каждое (Р-5, Р-К-76), потому что отбирают их снаружи — по связи и по актору.
 *
 * ЗДЕСЬ ОНИ ЛЕЖАТ ДАННЫМИ, И СХЕМОЙ ИХ НИКТО НЕ РАЗБИРАЕТ. Формы `empty` (правило 6) и `$touched`
 * (правило 11) приезжают в язык E задачей 15 (Р-26, Р-28), и `ruleDefinitionSchema.parse` на всех
 * тринадцати — её дело; до неё пиннится СОСТАВ. Писать правила сейчас в уже существующих формах
 * значило бы подогнать приёмку выразительности под сегодняшний язык, то есть отменить её.
 */
export const ASSIGN_LEVEL_RULES = [
  AL('1', 'семья звонит — молча', ASPECT('test/call'), {
    id: 'al_family_call',
    template: 'assign_level',
    params: {},
    level: 'silent',
    when: {
      op: 'in',
      args: [{ const: 'семья' }, { deref: { prop: 'test/caller', read: 'tags' } }],
    },
  }),
  AL('2', 'предоплата выше договорённой', ASPECT('test/call'), {
    id: 'al_prepayment_over',
    template: 'assign_level',
    params: {},
    level: 'discuss',
    when: {
      op: 'and',
      args: [
        IN_CLASS('orbis/money-movement', ['outflow']),
        {
          op: '>',
          args: [
            { prop: 'orbis/amount' },
            { deref: { prop: 'test/agreement', read: 'orbis/amount' } },
          ],
        },
      ],
    },
  }),
  AL('3', 'крупный расход', ASPECT('orbis/financial'), {
    id: 'al_big_outflow',
    template: 'assign_level',
    params: {},
    level: 'discuss',
    when: {
      op: 'and',
      args: [
        IN_CLASS('orbis/money-movement', ['outflow']),
        { op: '>', args: [{ prop: 'orbis/amount' }, { const: '10000' }] },
      ],
    },
  }),
  AL('4', 'оплачено из конверта', ASPECT('orbis/financial'), {
    id: 'al_from_envelope',
    template: 'assign_level',
    params: {},
    level: 'silent',
    when: {
      op: 'and',
      args: [
        { has_relation: { role: 'envelope-binding' } },
        {
          op: '>=',
          args: [
            { agg_via: { role: 'envelope-binding', name: 'remaining' } },
            { prop: 'orbis/amount' },
          ],
        },
      ],
    },
  }),
  AL('5', 'курьера — к консьержу', ASPECT('test/call'), {
    id: 'al_courier',
    template: 'assign_level',
    params: {},
    level: 'silent',
    when: {
      op: '=',
      args: [{ deref: { prop: 'test/caller', read: 'test/contact_kind' } }, { const: 'courier' }],
    },
  }),
  AL('6', 'банк записал и разметил', ASPECT('orbis/financial'), {
    id: 'al_bank_import',
    template: 'assign_level',
    params: {},
    level: 'silent',
    actor: { routine: TEST_IMPORT_ROUTINE_ID },
    when: {
      op: 'and',
      args: [
        IN_CLASS('orbis/money-movement', ['outflow', 'inflow']),
        { op: 'empty', args: [{ ctx: '$sensitivity' }] },
      ],
    },
  }),
  AL('7', 'письма от твоего имени — покажи', ASPECT('test/call'), {
    id: 'al_external_known',
    template: 'assign_level',
    params: {},
    level: 'show',
    when: {
      op: 'and',
      args: [IN_FACT('external'), { deref: { prop: 'test/caller', read: 'test/known_contact' } }],
    },
  }),
  AL('8a', 'встреча без участников — молча', ASPECT('orbis/schedule'), {
    id: 'al_meeting_solo',
    template: 'assign_level',
    params: {},
    level: 'silent',
    when: { op: 'not', args: [{ has_relation: { role: 'participant' } }] },
  }),
  AL('8b', 'встреча с участниками — покажи', ASPECT('orbis/schedule'), {
    id: 'al_meeting_shared',
    template: 'assign_level',
    params: {},
    level: 'show',
    when: { has_relation: { role: 'participant' } },
  }),
  AL('9', 'бронь в пределах бюджета вечера', ASPECT('orbis/financial'), {
    id: 'al_booking_budget',
    template: 'assign_level',
    params: {},
    level: 'show',
    when: {
      op: 'and',
      args: [
        IN_FACT('external'),
        {
          op: '<=',
          args: [
            { prop: 'orbis/amount' },
            { agg_via: { role: 'envelope-binding', name: 'remaining' } },
          ],
        },
      ],
    },
  }),
  AL('10a', 'снятие замка владельцем — обсудим', ASPECT('orbis/routine'), {
    id: 'al_unlock_owner',
    template: 'assign_level',
    params: {},
    level: 'discuss',
    actor: 'owner',
    when: { op: 'or', args: [IN_FACT('changes_registry'), IN_FACT('grants_autonomy')] },
  }),
  AL('10b', 'снятие замка ИИ — никогда', ASPECT('orbis/routine'), {
    id: 'al_unlock_ai',
    template: 'assign_level',
    params: {},
    level: 'never',
    actor: 'ai',
    when: { op: 'or', args: [IN_FACT('changes_registry'), IN_FACT('grants_autonomy')] },
  }),
  AL('11', 'перенос срока задачи рутиной', ASPECT('orbis/task'), {
    id: 'al_due_moved_by_routine',
    template: 'assign_level',
    params: {},
    level: 'show',
    actor: 'routine',
    when: { op: 'in', args: [{ const: 'orbis/due_date' }, { ctx: '$touched' }] },
  }),
] as const satisfies readonly {
  n: string;
  name: string;
  carrier: RuleCarrier;
  rule: RuleDefinitionInput;
}[];
