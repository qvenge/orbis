/**
 * ЭТАЛОННЫЕ ДЕКЛАРАЦИИ ПОДПИСОК (§Б5-6 Agenda, §Б5-4 Budget) — НОРМАТИВ, а не снимок вывода: каждое поле
 * написано от спеки, а не срисовано с сида. Их читают форма (`subscription-type.test.ts`), валидатор
 * (`subscriptions/registry.test.ts`) и дельты (`registry/deltas.test.ts`) — один эталон на трёх, потому что
 * три копии «законной декларации» разъехались бы на первом же новом поле, и разъезд увидел бы не тест, а
 * владелец. Встроенным сидом эти литералы НЕ являются (сид Agenda кладёт задача 6, Budget — задача 9):
 * здесь они правятся свободно, там — с пересевом.
 *
 * ПОЛЯ С УМОЛЧАНИЕМ ПИШУТСЯ ЯВНО (`params`, `prefer`, `sortBy`, `limit`, `alive`, `materialize`), и это не
 * дублирование схемы: объявленный тип фикстуры — РАЗОБРАННАЯ форма (`AgendaSubscription` = выход
 * `agendaSubscriptionSchema`), в которой этих полей нет только у входа. Эталон, которому нужен `parse`,
 * чтобы стать собой, перестал бы годиться на роль литерала для трёх сьютов сразу.
 */
import type { AgendaSubscription, BudgetSubscription } from './subscription-type';

/**
 * Повестка (§Б5-6): окно ближайших дней по слоту `moment` плюс просроченное по двум датам.
 * `where` секции просроченного — членство в наборе `open` контракта завершаемости, а не перечисление
 * классов: состав «незакрытого» объявлен контрактом один раз (Р-И-11).
 */
export const AGENDA_DEF: AgendaSubscription = {
  engine: 'agenda',
  params: ['window_from', 'window_to'],
  show: {
    contract: 'orbis/when',
    slot: 'moment',
    window: { from: { ctx: '$today' }, to: { param: 'window_to' } },
    prefer: [],
    sortBy: 'asc',
    limit: 200,
  },
  overdue: {
    contract: 'orbis/when',
    slots: ['deadline', 'moment'],
    before: { ctx: '$today' },
    where: { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }] },
    prefer: [],
    limit: 200,
  },
  hide: { contract: 'orbis/recurrence', set: 'templates' },
};

/**
 * Обзор бюджета (§Б5-4): конверты периода, четыре ведомости, два списка и правило переноса.
 *
 * `effective_limit` написан как `limit + if(has(carryover), carryover, "0")` (Р-К-13), а не
 * `limit + carryover`: перенос НЕобязателен, а арифметика над отсутствующим — отказ при сохранении
 * (§Б3-4), и единственный способ сделать её тотальной — явная защита `has`.
 *
 * `daily_pace` вне активной фазы — `{const:null}`: величина объявлена необязательной там, где темп не
 * имеет смысла, а не считается нулём (нуль читался бы как «тратить нечего»).
 */
export const BUDGET_DEF: BudgetSubscription = {
  engine: 'budget',
  currency_rule: 'owner_default_if_absent',
  params: ['period_start', 'period_end', 'horizon_end'],
  sources: {
    movement: { contract: 'orbis/money-movement', counted_set: 'facts' },
    envelope: {
      contract: 'orbis/envelope',
      binding_role: 'envelope-binding',
      selector: {
        match: ['category', 'currency', 'period'],
        tie_break: ['shorter_period', 'later_start', 'min_id'],
      },
    },
  },
  // Фаза меряется «сегодня» ПРОТИВ СОБСТВЕННОГО периода конверта, а не против границ запрошенного
  // месяца: оракул (`budget/aggregates.ts`, `phaseOf`) сравнивает `today` с `periodStart`/`periodEnd`
  // САМОГО конверта, и у произвольного конверта внутри месяца (§2.9) две мерки дают разные ответы.
  // `active` — ОСТАТОК, и потому `{const:true}`: две прочие фазы называют условие, а активной
  // становится всё, что ими не отобрано (порядок разбора — забота движка, §Б5-6).
  phases: {
    upcoming: { op: '<', args: [{ ctx: '$today' }, { slot: 'period_start' }] },
    closed: { op: '>', args: [{ ctx: '$today' }, { slot: 'period_end' }] },
    active: { const: true },
  },
  aggregates: {
    spent: {
      kind: 'sum',
      over: 'movement',
      of: { slot: 'amount' },
      bound_via: 'envelope-binding',
      alive: false,
      scope: 'envelope',
      window: 'envelope_period',
      currency: 'same_as_envelope',
      where: {
        op: 'in',
        args: [{ class: { contract: 'orbis/money-movement' } }, { const: 'outflow' }],
      },
      materialize: true,
    },
    effective_limit: {
      kind: 'formula',
      scope: 'envelope',
      expr: {
        op: '+',
        args: [
          { slot: 'limit' },
          { op: 'if', args: [{ has: 'carryover' }, { slot: 'carryover' }, { const: '0' }] },
        ],
      },
    },
    remaining: {
      kind: 'formula',
      scope: 'envelope',
      expr: { op: '-', args: [{ agg: 'effective_limit' }, { agg: 'spent' }] },
    },
    daily_pace: {
      kind: 'formula',
      scope: 'envelope',
      expr: {
        op: 'if',
        args: [
          { phase: 'active' },
          {
            op: '/',
            args: [
              { agg: 'remaining' },
              // Конец периода — СЛОТ конверта, а не параметр запроса: оракул делит на
              // `daysInclusive(today, raw.periodEnd)`, и у конверта, не совпадающего с месяцем,
              // параметр дал бы другое число дней.
              { days_inclusive: [{ ctx: '$today' }, { slot: 'period_end' }] },
            ],
          },
          { const: null },
        ],
      },
    },
  },
  rollup: {
    role: 'category-parent',
    mode: 'same_currency_only',
    applies_to: ['spent', 'effective_limit', 'remaining'],
  },
  // Порог — СТРОКА (§Б3-5): дробное JSON-число потеряло бы хвост ещё до чекера. Пропускается ровно
  // одна фаза — `upcoming` (§2.9а и `countAlerts` оракула): у закрытого конверта перерасход показать
  // надо, иначе бейдж молчал бы ровно там, где уже поздно что-то менять.
  alerts: { warn_at: '0.85', on_raw: true, skip_phases: ['upcoming'], inclusive: true },
  lists: {
    // Оба списка — ПЛАНОВЫЕ движения (§Б5-4 «списки: planned=true ∧ окно»); разводит их ребро
    // порождения: у материализованного экземпляра повторения оно есть, у ручного плана — нет.
    // Без `planned = true` сюда попал бы экземпляр, проведённый `postDue` сегодня (он уже факт,
    // `planned=false`, дата = сегодня), — а оракул (`aggregates.ts`, `comingRows`) его не берёт.
    coming_up: {
      over: 'movement',
      counted_set: 'outflow',
      requires_relation: { role: 'instance-of', side: 'source' },
      window: { from: { ctx: '$today' }, to: { param: 'horizon_end' } },
      where: { op: '=', args: [{ slot: 'planned' }, { const: true }] },
      order_by: [{ slot: 'date' }, { core: 'id' }],
    },
    planned: {
      over: 'movement',
      counted_set: 'outflow',
      excludes_relation: { role: 'instance-of', side: 'source' },
      where: { op: '=', args: [{ slot: 'planned' }, { const: true }] },
      order_by: [{ slot: 'date' }, { core: 'title' }],
    },
  },
  cards: {
    order_by: [
      { deref: { slot: 'category', read: 'orbis/title' } },
      { slot: 'period_start' },
      { core: 'id' },
    ],
  },
  rollover: { source: 'exact_calendar_month', carry: { agg: 'remaining' } },
};
