import { ROLE_INSTANCE_OF, RULE_NEAREST_ANCESTOR } from '../constants';
import type { RuleDefinitionInput } from './rule-type';

/**
 * Системные строки каталога правил (§Б4-1). `id` каждой — ПРЕЖНИЙ код инварианта: движок кладёт
 * его в `details.invariant` (Р-К-1), и близнецы, читавшие `invariant: 'financial_requires_occurred_on'`,
 * продолжают читать то же самое — без второго словаря «правило → старое имя».
 *
 * Значения — форма ВХОДА (`RuleDefinitionInput`): `enabled` и `undo` схема доводит умолчаниями,
 * но `undo` у C-правил написан ЯВНО, потому что отнесение к откату — решение по ЭКЗЕМПЛЯРУ
 * (Р-И-2), а не умолчание: прежний код этого инварианта (`assertFinancial`, снят задачей 4) шёл и
 * под откатом, в отличие от соседей по стадии 4, — строка обязана сказать это словами.
 */
export const RULE_FINANCIAL_REQUIRES_OCCURRED_ON: RuleDefinitionInput = {
  id: 'financial_requires_occurred_on',
  template: 'requires_when',
  undo: 'check',
  when: { op: 'not', args: [{ op: '=', args: [{ prop: 'orbis/recurring' }, { const: true }] }] },
  params: { property: 'orbis/occurred_on' },
};

/**
 * «`recurring: true` законен только у шаблона либо у экземпляра» (§3.3). Принадлежность
 * шаблону выражена КЛАССОМ контракта `orbis/recurrence` (В-1 §4-В): привязка `orbis/schedule`
 * относит наличие `orbis/recurrence` к классу `template`, а отсутствие — к `instance`
 * (`builtin-aspects.ts`, привязка `orbis/recurrence`), и та же проверка «аспект несёт расписание»
 * получается по построению — у записи без `orbis/schedule` привязки нет и класса нет (Р9). «По
 * построению» — у ВСТРОЕННЫХ аспектов: аспект владельца, реализующий `orbis/recurrence` со слотом
 * `template_marker` и картой `present → template`, тоже делает запись шаблоном и легитимирует
 * `recurring` без `orbis/schedule` — по §4-В это законно (шаблон — класс контракта, а не аспект).
 */
export const RULE_FINANCIAL_RECURRING_REQUIRES_RECURRENCE: RuleDefinitionInput = {
  id: 'financial_recurring_requires_recurrence',
  template: 'forbidden_when',
  undo: 'check',
  when: {
    op: 'and',
    args: [
      { op: '=', args: [{ prop: 'orbis/recurring' }, { const: true }] },
      {
        op: 'not',
        args: [
          {
            op: 'in',
            args: [{ class: { contract: 'orbis/recurrence' } }, { const: ['template'] }],
          },
        ],
      },
      { op: 'not', args: [{ has_relation: { role: 'instance-of' } }] },
    ],
  },
  params: { property: 'orbis/recurring' },
};

/**
 * Вход слота `status` контракта завершаемости в класс `done` ⇒ штамп записи в `orbis/completed_at`;
 * уход — снять. Значение — `{prop:'orbis/updated_at'}` (Р-И-3/Р-К-2): «момент ЭТОЙ записи» уже
 * выразим core-проекцией, и заводить ради него недетерминированный `$now` §Б3-2 запрещает.
 */
export const RULE_TASK_COMPLETED_AT: RuleDefinitionInput = {
  id: 'task_completed_at',
  template: 'on_enter_class',
  params: {
    enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
    set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
    on_leave: { unset: ['orbis/completed_at'] },
  },
};

/**
 * Уникальность конверта (03-budget §2.1) — СТРОКА каталога, а не код Финансов.
 *
 * `id` = прежний код отказа (Р-К-1): `details.invariant` движка равен id правила, поэтому близнецы
 * бюджета продолжают сверять то же слово, а владелец, заведший своё правило, получит своё.
 * `undo: 'check'` — отнесение по ЭКЗЕМПЛЯРУ (Р-И-2), и это СМЕНА поведения по слову владельца (16.09,
 * В-П-1а): снятый код уникальности под внутренним откатом не звался, и откат удаления конверта при уже
 * созданном дубле давал бы два живых конверта на одну категорию и период. Для денег строже: откат при
 * дубле отклоняется `INVARIANT duplicate_envelope`, владелец сначала убирает новый конверт. Из трёх
 * «льготных» инвариантов (прежний код каждого под откатом не звался) строгим становится только этот:
 * грант и субъект прогона под откатом не проверяются и дальше (§А7-2 ревизии 5 — их строки `skip`).
 * Четвёрка — тот же порядок, что был в коде: она же читается `dropStaleCarryover` как «идентичность».
 */
export const RULE_ENVELOPE_UNIQUE: RuleDefinitionInput = {
  id: 'duplicate_envelope',
  template: 'unique_among',
  undo: 'check',
  params: {
    properties: [
      'orbis/finance_category',
      'orbis/currency',
      'orbis/period_start',
      'orbis/period_end',
    ],
  },
};

/**
 * Параметры движка предков (`executor/ancestors.ts`). Id совпадает с `RULE_NEAREST_ANCESTOR`
 * (`constants.ts:146`): это же имя стоит во `flags.computed.rule` обоих вычисляемых свойств и в
 * системной строке журнала «пересчитано N по правилу X» — с этой строкой оба адреса впервые
 * указывают на СУЩЕСТВУЮЩУЮ запись реестра, а не на слово.
 */
export const RULE_NEAREST_ANCESTOR_ROW: RuleDefinitionInput = {
  id: RULE_NEAREST_ANCESTOR,
  template: 'nearest_ancestor',
  undo: 'skip',
  params: {
    targets: { parent: 'orbis/parent_project', root: 'orbis/root_project' },
    depth_cap: 32,
  },
};

/**
 * Параметры движка материализации (`recurring/materialize.ts`), перечни — ЯВНЫЕ (§Б4-3, inv §6 п.3).
 * Значения перенесены из констант движка дословно; их доводы переехали вместе с ними:
 *  - `horizon_days` — горизонт порождения §5.4; `retro_days` — ретро-пол (квартал): без него окно
 *    «2020..today» синхронно материализовало бы годы инстансов (решение B5). Окно ВЕДОМОСТИ бюджета
 *    (`subscriptions/budget.ts`, тоже 14) — другая величина, совпадение случайно (Р-14);
 *  - `trigger_properties` — три, а не два: на `orbis/due_date` стоят «Сегодня» и «Ближайшие 7 дней»;
 *  - `inherit` — закрытые перечни (Р-28): в новой форме «всё, что было» — это ВСЕ `props` строки, и
 *    копирование по остаточному принципу порождало бы инстансы с чужими свойствами. `orbis/recurrence`
 *    не наследуется (инстанс, унёсший правило, сам стал бы шаблоном, §3.3), `orbis/bank_txn_id` — тоже
 *    (тождество ОДНОЙ строки выписки: дедуп импорта счёл бы повтором каждый инстанс);
 *  - `own` — свои значения инстанса (дата инстанса, `planned`, `recurring` — §5.4/§3.3); кладутся на
 *    инстанс, если его аспекты объявляют свойство (РЧ-13-2).
 */
export const RULE_MATERIALIZE: RuleDefinitionInput = {
  id: 'materialize',
  template: 'materialize',
  undo: 'skip',
  params: {
    horizon_days: 14,
    retro_days: 92,
    trigger_properties: ['orbis/start_at', 'orbis/due_date', 'orbis/occurred_on'],
    inherit: {
      'orbis/schedule': [
        'orbis/start_at',
        'orbis/end_at',
        'orbis/duration_min',
        'orbis/all_day',
        'orbis/location',
        'orbis/timezone',
      ],
      'orbis/financial': [
        'orbis/amount',
        'orbis/currency',
        'orbis/direction',
        'orbis/finance_category',
        'orbis/payment_method',
        'orbis/counterparty',
      ],
    },
    own: { 'orbis/occurred_on': 'instance_date', 'orbis/planned': true, 'orbis/recurring': true },
    origin_role: ROLE_INSTANCE_OF,
  },
};

/** Зеркало ссылки (§А6-2): ключ подписи в `meta` ребра и пропуск вычисляемых ссылок (Р-11-2). */
export const RULE_MIRROR_REF: RuleDefinitionInput = {
  id: 'mirror_ref',
  template: 'mirror_relation',
  undo: 'skip',
  params: { meta_key: 'property', skip_computed: true },
};

/** Переход периода (§3.5): параметры переноса. Дом у них теперь один — здесь, а не в схеме подписки (Р-К-9). */
export const RULE_ROLLOVER: RuleDefinitionInput = {
  id: 'budget_rollover',
  template: 'rollover',
  undo: 'skip',
  params: { source: 'exact_calendar_month', carry: { agg: 'remaining' } },
};

// Метки каталога на ролях: ПАРАМЕТРОВ нет — значения живут в `role.constraints` и работают с среза А
// (`executor/relations.ts`). Строка нужна каталогу (§Б4-3 перечисляет двенадцать шаблонов), а второе
// место для значения завело бы ровно ту копию знания, которую реформа снимает (РЧ-13-4).
export const RULE_DEPENDENCY_ACYCLIC: RuleDefinitionInput = {
  id: 'dependency_acyclic',
  template: 'acyclic',
  undo: 'skip',
  params: {},
};
export const RULE_CATEGORY_PARENT_ACYCLIC: RuleDefinitionInput = {
  id: 'category_parent_acyclic',
  template: 'acyclic',
  undo: 'skip',
  params: {},
};
export const RULE_ENVELOPE_BINDING_MAX_INCOMING: RuleDefinitionInput = {
  id: 'envelope_binding_max_incoming',
  template: 'target_max_incoming',
  undo: 'skip',
  params: {},
};

/**
 * Ключ — id строки-носителя; сиды берут `BUILTIN_RULES_BY_CARRIER[id] ?? []`. Аспекты и роли делят
 * одну карту: id роли (`ref`, `dependency`) — слаг без пространства имён, id аспекта — `orbis/…`, и
 * столкнуться им не на чем.
 */
export const BUILTIN_RULES_BY_CARRIER: Readonly<Record<string, readonly RuleDefinitionInput[]>> = {
  'orbis/financial': [
    RULE_FINANCIAL_REQUIRES_OCCURRED_ON,
    RULE_FINANCIAL_RECURRING_REQUIRES_RECURRENCE,
  ],
  'orbis/task': [RULE_TASK_COMPLETED_AT],
  'orbis/budget': [RULE_ENVELOPE_UNIQUE, RULE_ROLLOVER],
  'orbis/project': [RULE_NEAREST_ANCESTOR_ROW],
  'orbis/schedule': [RULE_MATERIALIZE],
  ref: [RULE_MIRROR_REF],
  dependency: [RULE_DEPENDENCY_ACYCLIC],
  'category-parent': [RULE_CATEGORY_PARENT_ACYCLIC],
  'envelope-binding': [RULE_ENVELOPE_BINDING_MAX_INCOMING],
};
