// Стенд §С8-30 — мир заглушки исполнителя (перенос `.superpowers/probe/p3/world.ts` на форму
// данных после реформы свойств: значения плоско по key в `props`, аспекты — списком).
//
// Зачем настоящий мир, а не `{count: 0}`: половина приёмочных критериев («не выдумывай uuid»,
// «правь найденное, а не создавай второе», «категория — настоящая») проверяема ТОЛЬКО если в
// мире есть что найти. Пустой мир круга 2 пробы 2026-08-06 уже давал ложное несхождение.
//
// Мир ДЕТЕРМИНИРОВАННЫЙ и одинаковый для обоих вариантов канала и обеих моделей: любое
// расхождение результатов — расхождение каналов, а не данных. Поэтому он живёт в памяти
// заглушки, а не в БД владельца пробы: БД нужна стенду только затем, чтобы собрать канал
// ровно тем кодом, что в проде (`variants.ts`).
import type { BudgetStatusResult } from '@orbis/shared';

export const CAT_TRANSPORT = '11111111-1111-4111-8111-111111111111';
export const CAT_INSURANCE = '22222222-2222-4222-8222-222222222222';
export const CAT_FOOD = '33333333-3333-4333-8333-333333333333';
export const TASK_GIFT = '44444444-4444-4444-8444-444444444444';
/** Категория без класса трат — её модель обязана назвать, а не включить в расчёт молча. */
export const CAT_OTHER = '55555555-5555-4555-8555-555555555555';

/**
 * Момент, от которого стенд считает «сегодня»: вторник 2026-08-25, день пробы П3. Даты мира
 * (срок подарка 28.08, бюджет августа, перенос на 05.09) заданы от него, а канал получает его
 * штатной секцией даты (`todaySectionFor` через `clock`) — прежний стенд дописывал дату хвостом
 * сам, потому что в проде её тогда не было (§Б7-6-1 её завёл).
 */
export const PROBE_NOW = new Date('2026-08-25T09:00:00.000Z');
export const probeClock = (): Date => PROBE_NOW;

/** Сущность мира в той форме, в какой её видит исполнитель: значения по id свойства. */
export interface WorldEntity {
  id: string;
  title: string;
  body: string;
  tags: string[];
  props: Record<string, unknown>;
  aspects: string[];
}

function category(id: string, title: string, aliases: string[], spendClass?: string): WorldEntity {
  return {
    id,
    title,
    body: '',
    tags: ['category'],
    props: {
      'orbis/aliases': aliases,
      ...(spendClass !== undefined && { 'orbis/spend_class': spendClass }),
    },
    aspects: ['orbis/category'],
  };
}

/** Базовый мир; `extra` — сущности, которые нужны каналу (триггер рутины). */
export function seedWorld(extra: readonly WorldEntity[] = []): Map<string, WorldEntity> {
  const rows: WorldEntity[] = [
    category(CAT_TRANSPORT, 'Транспорт', ['такси', 'taxi', 'транспорт'], 'discretionary'),
    category(CAT_INSURANCE, 'Страхование', ['страховка', 'insurance'], 'fixed'),
    category(CAT_FOOD, 'Еда', ['еда', 'продукты'], 'discretionary'),
    category(CAT_OTHER, 'Прочее', ['прочее']),
    {
      id: TASK_GIFT,
      title: 'Купить подарок маме',
      body: '',
      tags: [],
      props: { 'orbis/task_status': 'planned', 'orbis/due_date': '2026-08-28' },
      aspects: ['orbis/task'],
    },
    ...extra,
  ];
  // structuredClone: прогон мутирует мир, а базовые строки обязаны быть одинаковыми у каждого.
  return new Map(rows.map((r) => [r.id, structuredClone(r)]));
}

// ---------------------------------------------------------------------------
// Триггер канала рутины
// ---------------------------------------------------------------------------

/**
 * Инструменты рутины-триггера: режим `act` с белым списком ровно того, что нужно завести рутину.
 * В `propose` рутине не видны `attach_*` (`routineToolAllowed`), и сценарий мерил бы не канал, а
 * отсутствие тула.
 */
export const TRIGGER_ALLOWED_TOOLS = ['entity_create', 'entity_update', 'attach_orbis_routine'];

export const TRIGGER_TITLE = 'Заявки владельца из чата';

/**
 * Значения рутины-триггера — её собственное расписание и права. Режим `act` здесь — ЕЁ режим,
 * а не образец для заводимой: сценарий `routine-propose` проверяет ровно то, что модель
 * не переносит его на новую рутину без прямой просьбы владельца.
 */
export const TRIGGER_PROPS: Readonly<Record<string, unknown>> = {
  'orbis/routine_stage': 'active',
  'orbis/routine_at': '08:30',
  'orbis/routine_mode': 'act',
  'orbis/allowed_tools': [...TRIGGER_ALLOWED_TOOLS],
};

/** Тело триггера: реплика сценария дословно, как заявка владельца. */
export function triggerBody(request: string): string {
  return `Владелец оставил заявку в чате. Выполни её так, как выполнил бы в разговоре с ним:\n«${request}»`;
}

export function triggerEntity(id: string, request: string): WorldEntity {
  return {
    id,
    title: TRIGGER_TITLE,
    body: triggerBody(request),
    tags: ['routine'],
    props: structuredClone({ ...TRIGGER_PROPS }),
    aspects: ['orbis/routine'],
  };
}

// ---------------------------------------------------------------------------
// Ответ budget_status — по действующему контракту тула (`budgetStatusResultSchema`)
// ---------------------------------------------------------------------------

const GRAPH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAMP = '2026-08-01T09:00:00.000Z';

function wire(id: string, title: string, props: Record<string, unknown>, aspects: string[]) {
  return {
    id,
    graphId: GRAPH,
    title,
    emoji: null,
    body: '',
    bodyRefs: [],
    tags: [],
    props,
    aspects,
    queryRefs: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    archived: false,
  };
}

function envelope(id: string, cat: string, title: string, a: [string, string, string, string]) {
  const [effectiveLimit, spent, remaining, dailyPace] = a;
  return {
    envelope: wire(id, `Конверт: ${title}`, { 'orbis/finance_category': cat }, ['orbis/budget']),
    category: { id: cat, title, icon: null, color: null },
    spent,
    effectiveLimit,
    remaining,
    dailyPace,
    phase: 'active' as const,
  };
}

/**
 * Числа выбраны так, чтобы у «могу позволить?» был ОДИН правильный ответ: остатки дискреционных
 * конвертов 12 700 + 10 800 = 23 500, минус будущие ОТТОКИ — запланированная страховка 12 000 и
 * расходный инстанс «Интернет» 900 — = 10 600. Будущий доход 180 000 не вычитается; класс
 * «fixed» у страхования и «нет класса» у «Прочего» в расчёт не входят.
 */
export const BUDGET_STATUS: BudgetStatusResult = {
  period: { start: '2026-08-01', end: '2026-08-31' },
  balance: { income: '82600.00', expense: '34600.00', balance: '48000.00' },
  envelopes: [
    envelope('a1111111-1111-4111-8111-111111111111', CAT_FOOD, 'Еда', [
      '40000.00',
      '27300.00',
      '12700.00',
      '1412.00',
    ]),
    envelope('a2222222-2222-4222-8222-222222222222', CAT_TRANSPORT, 'Транспорт', [
      '15000.00',
      '4200.00',
      '10800.00',
      '1200.00',
    ]),
    envelope('a3333333-3333-4333-8333-333333333333', CAT_INSURANCE, 'Страхование', [
      '12000.00',
      '0.00',
      '12000.00',
      '0.00',
    ]),
  ],
  comingUp: [
    {
      entity: wire(
        'b1111111-1111-4111-8111-111111111111',
        'Зарплата',
        { 'orbis/amount': '180000.00', 'orbis/direction': 'income' },
        ['orbis/financial'],
      ),
      occurredOn: '2026-09-05',
      amount: '180000.00',
      direction: 'income',
    },
    {
      entity: wire(
        'b2222222-2222-4222-8222-222222222222',
        'Интернет',
        { 'orbis/amount': '900.00', 'orbis/direction': 'expense' },
        ['orbis/financial'],
      ),
      occurredOn: '2026-08-30',
      amount: '900.00',
      direction: 'expense',
    },
  ],
  planned: [
    {
      entity: wire(
        'b3333333-3333-4333-8333-333333333333',
        'Страховка',
        { 'orbis/amount': '12000.00', 'orbis/direction': 'expense', 'orbis/planned': true },
        ['orbis/financial'],
      ),
      amount: '12000.00',
      categoryTitle: 'Страхование',
    },
  ],
  unbudgeted: [{ category: { id: CAT_OTHER, title: 'Прочее', icon: null }, total: '3100.00' }],
  alertCount: 0,
  categories: [
    { id: CAT_FOOD, title: 'Еда', spendClass: 'discretionary' },
    { id: CAT_TRANSPORT, title: 'Транспорт', spendClass: 'discretionary' },
    { id: CAT_INSURANCE, title: 'Страхование', spendClass: 'fixed' },
    { id: CAT_OTHER, title: 'Прочее', spendClass: null },
  ],
};
