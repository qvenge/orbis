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

/** Ключ — id строки-носителя; сиды берут `BUILTIN_RULES_BY_CARRIER[id] ?? []`. */
export const BUILTIN_RULES_BY_CARRIER: Readonly<Record<string, readonly RuleDefinitionInput[]>> = {
  'orbis/financial': [
    RULE_FINANCIAL_REQUIRES_OCCURRED_ON,
    RULE_FINANCIAL_RECURRING_REQUIRES_RECURRENCE,
  ],
  'orbis/task': [RULE_TASK_COMPLETED_AT],
};
