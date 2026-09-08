/**
 * ЭТАЛОННЫЕ ДЕКЛАРАЦИИ ПОДПИСОК (§Б5-6 Agenda, §Б5-4 Budget) — НОРМАТИВ, а не снимок вывода: каждое поле
 * написано от спеки, а не срисовано с сида. Их читают форма (`subscription-type.test.ts`), валидатор
 * (`subscriptions/registry.test.ts`) и дельты (`registry/deltas.test.ts`) — один эталон на трёх, потому что
 * три копии «законной декларации» разъехались бы на первом же новом поле, и разъезд увидел бы не тест, а
 * владелец. `AGENDA_DEF` — ОН ЖЕ ВСТРОЕННЫЙ СИД (Ф-Б1-27): `BUILTIN_SUBSCRIPTION_DEFS` ссылается на этот
 * литерал, а не несёт копию, поэтому правка здесь требует пересева (`bun run db:prepare`) и уезжает
 * владельцу. С задачи 9 то же верно и для `BUDGET_DEF`: он — сид `orbis/budget-overview`.
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
 * Правый операнд `in` — ИМЯ НАБОРА контракта (Р-И-11), а не перечисление классов: у встроенных
 * деклараций набор уже назван контрактом, и перечисление дублировало бы его состав. Перечисление
 * (`{const:['outflow']}`) законно и остаётся для деклараций владельца.
 */
const OUTFLOW = {
  op: 'in',
  args: [{ class: { contract: 'orbis/money-movement' } }, { const: 'outflow' }],
} as const;

/**
 * Обзор бюджета (§Б5-4): конверты периода, шесть ведомостей, два списка и правило переноса.
 *
 * `effective_limit` написан как `limit + if(has(carryover), carryover, "0")` (Р-К-13), а не
 * `limit + carryover`: перенос НЕобязателен, а арифметика над отсутствующим — отказ при сохранении
 * (§Б3-4), и единственный способ сделать её тотальной — явная защита `has`.
 *
 * `daily_pace` вне активной фазы — `{const:null}`: величина объявлена необязательной там, где темп не
 * имеет смысла, а не считается нулём (нуль читался бы как «тратить нечего»).
 *
 * ЧТО ЗАДАЧА 9 ПОПРАВИЛА В НОРМАТИВЕ, когда он впервые поехал в движок и на сверку §С8-15 с оракулом
 * (`budget/aggregates.ts`, `computeOverview`) — норматив один, второй декларации не заводится:
 *  — дописаны ведомости `period_balance` (§2.5, П2 №2 — второе окно и второе правило валюты) и
 *    `unbudgeted` (§2.3 шаг 5, П2 №5 — «живой конверт» через `unbound_via` + `alive`); без них Overview
 *    остался бы без баланса периода и без списка трат без конверта;
 *  — `spent.materialize` переведён в `false`: кэш ведомости — §Б5-5 и задача 11, а `true` до неё
 *    означал бы обещание хранилища, которого ещё нет;
 *  — `rollup.applies_to` сокращён до `['spent','effective_limit']`: оракул агрегирует по дереву ровно
 *    две величины, а `remaining` пересчитывает ИЗ НИХ (`statusOf`). Суммировать его третьим значило бы
 *    объявить производную величину независимой — на первой же несогласованной правке формулы карточка
 *    родителя перестала бы сходиться со своими слагаемыми;
 *  — списки переведены с `outflow` + собственного `planned = true` на набор `plans` (зеркало `facts` по
 *    слоту `planned`), а сторона ребра `instance-of` исправлена с `source` на `target`: ЭКЗЕМПЛЯР —
 *    цель ребра порождения, источник — шаблон, и при `source` в `coming_up` попадали бы шаблоны, а
 *    `planned` наоборот выбрасывал бы ручные покупки;
 *  — `coming_up` перестал фильтровать направление: §Б5-4 у списков его не требует («`planned=true` ∧
 *    окно»), а оракул (`comingRows`) не фильтрует — предстоящее поступление владелец обязан видеть;
 *  — `planned` получил `where` с отсечением шаблонов повторения (`not class(recurrence) in templates`):
 *    оракул режет их `notRecurringTemplateSql`, а ребра `instance-of` у шаблона нет, и
 *    `excludes_relation` его не отсекает;
 *  — порядок `planned` переведён на `[date, id]` (был `[date, title]`): у оракула ключ —
 *    `occurred_on\0id`, и два одноимённых плана одного дня разошлись бы порядком.
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
      where: OUTFLOW,
      // Кэш ведомости — §Б5-5 и задача 11: `true` до неё обещал бы хранилище, которого нет.
      materialize: false,
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
      // Охрана `remaining >= "0"` — ПО ОРАКУЛУ (`statusOf` в `budget/aggregates.ts`, 03-budget §2.9б):
      // на перерасходе темп не показывается ВОВСЕ. Спека §Б5-4 пишет формулу без охраны, и без неё
      // сверка §С8-15 «ноль расхождений» задачи 9 покраснела бы на первом же перерасходе: конверт
      // 1000/1500 дал бы «−29.41 в день» там, где оракул молчит. Эталон сверки — оракул (рулинг
      // Ф-Б1-34); ОВ-Б1-2 — эррата спеки за владельцем.
      expr: {
        op: 'if',
        args: [
          {
            op: 'and',
            args: [{ phase: 'active' }, { op: '>=', args: [{ agg: 'remaining' }, { const: '0' }] }],
          },
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
    // П2 №2: ВТОРОЕ окно (месяц целиком, а не период конверта) и ВТОРОЕ правило валюты
    // (`owner_default_only`) — из-за них `currency_rule` перестаёт быть один на подписку.
    // Ключ группировки — слот-статус `direction`, и движок сводит его варианты в КЛАССЫ:
    // `expense` встроенного аспекта и `out` аспекта владельца обязаны попасть в одну строку
    // баланса, иначе §С8-18 разошёлся бы прямо на итоге месяца.
    period_balance: {
      kind: 'sum',
      over: 'movement',
      of: { slot: 'amount' },
      alive: false,
      scope: 'period',
      group_by: { slot: 'direction' },
      window: 'period',
      currency: 'owner_default_only',
      materialize: false,
    },
    // П2 №5: «живой конверт» — часть ДЕКЛАРАЦИИ (`unbound_via` + `alive: true`), а не дописка
    // движка: трата, привязанная к архивному конверту, обязана вернуться в Unbudgeted, иначе
    // владелец, убравший конверт, теряет её из виду совсем.
    unbudgeted: {
      kind: 'sum',
      over: 'movement',
      of: { slot: 'amount' },
      unbound_via: 'envelope-binding',
      alive: true,
      scope: 'period',
      group_by: { slot: 'category' },
      window: 'period',
      currency: 'owner_default_only',
      where: OUTFLOW,
      materialize: false,
    },
  },
  // Дерево агрегирует ровно две величины: `remaining` — их разность, и суммировать её третьей
  // значило бы объявить производное независимым (см. докблок выше).
  rollup: {
    role: 'category-parent',
    mode: 'same_currency_only',
    applies_to: ['spent', 'effective_limit'],
  },
  // Порог — СТРОКА (§Б3-5): дробное JSON-число потеряло бы хвост ещё до чекера. Пропускается ровно
  // одна фаза — `upcoming` (§2.9а и `countAlerts` оракула): у закрытого конверта перерасход показать
  // надо, иначе бейдж молчал бы ровно там, где уже поздно что-то менять.
  alerts: { warn_at: '0.85', on_raw: true, skip_phases: ['upcoming'], inclusive: true },
  lists: {
    // Оба списка — ПЛАНОВЫЕ движения (набор `plans` контракта денег: §Б5-4 «списки: planned=true
    // ∧ окно»); разводит их ребро порождения: у материализованного экземпляра повторения оно
    // есть, у ручного плана — нет. Без набора `plans` сюда попал бы экземпляр, проведённый
    // `postDue` сегодня (он уже факт, `planned=false`, дата = сегодня), — а оракул
    // (`aggregates.ts`, `comingRows`) его не берёт.
    //
    // `side: 'target'` — не вкус: у ребра `instance-of` ИСТОЧНИК это шаблон, а ЦЕЛЬ — экземпляр
    // (`recurring/materialize.ts`), и сторона `source` собрала бы в Coming up шаблоны.
    coming_up: {
      over: 'movement',
      counted_set: 'plans',
      requires_relation: { role: 'instance-of', side: 'target' },
      window: { from: { ctx: '$today' }, to: { param: 'horizon_end' } },
      order_by: [{ slot: 'date' }, { core: 'id' }],
    },
    // Ручные планы — БЕЗ окна (список намерений, а не агрегат периода) и только расходы;
    // шаблон повторения ребра `instance-of` не имеет, поэтому `excludes_relation` его не
    // отсекает — отсекает `where` (оракул делает это `notRecurringTemplateSql`).
    planned: {
      over: 'movement',
      counted_set: 'plans',
      excludes_relation: { role: 'instance-of', side: 'target' },
      where: {
        op: 'and',
        args: [
          OUTFLOW,
          {
            op: 'not',
            args: [
              {
                op: 'in',
                args: [{ class: { contract: 'orbis/recurrence' } }, { const: 'templates' }],
              },
            ],
          },
        ],
      },
      order_by: [{ slot: 'date' }, { core: 'id' }],
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
