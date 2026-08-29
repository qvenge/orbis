import type { Entity } from '../schemas/entity';

/**
 * Общие фикстуры сущностей — единый вход для будущих golden-тестов
 * «грамматика → SQL» (PRD 01 §6.2) и контрактных тестов `src/contracts/`.
 *
 * Состав: задачи с разными status/priority/due_date, заметка, финансовые записи.
 * Форма — НОВАЯ правда §А1-1: значения плоско в `props` по id свойства, `aspects` —
 * список навешенного. Старая карта `{аспект: {поле: значение}}` снята Задачей 13c вместе
 * с уходом `aspectsMap` из wire-формы; перевод сделан ТОЙ ЖЕ функцией, которой его делает
 * сервер (`legacyAspectsToProps`, `registry/legacy-field-map.ts`), — второго перевода
 * одних и тех же полей в репозитории нет.
 * Каждая фикстура обязана проходить `entitySchema` — см. `fixtures.test.ts`.
 */

/** Владелец всех фикстур. */
export const FIXTURE_OWNER_ID = '019e0a11-2c00-7a4e-8b3f-3f6a1c9d0e01';

/** Категория-сущность «Еда» (target для category_ref; PRD 01 §3.5). */
export const FIXTURE_CATEGORY_FOOD_ID = '019d48ea-4188-765d-8e96-93a0ad9c262a';
/** Категория-сущность «Одежда» (PRD 01 §2.4). */
export const FIXTURE_CATEGORY_CLOTHES_ID = '019d48ea-2e00-7a52-876a-c301529b0456';
/** Категория-сущность «Доход». */
export const FIXTURE_CATEGORY_INCOME_ID = '019d48ea-5100-7b31-9c22-40d1a2e37f88';
/** Категория-сущность «Спорт». */
export const FIXTURE_CATEGORY_SPORT_ID = '019d48ea-6a00-7c42-8d17-51e2b3f48a99';

export const queryFixtures: Entity[] = [
  {
    // Задача: in_progress / high / срок сегодня-около — для status=, priority=, due_date=today.
    id: '019eb2f4-1a00-7b6e-9c01-5d2f8a3b4c10',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Написать отчёт по проекту',
    emoji: '📝',
    body: 'Черновик к вечеру, финал после ревью.',
    bodyRefs: [],
    tags: ['task', 'work'],
    props: {
      'orbis/task_status': 'in_progress',
      'orbis/priority': 'high',
      'orbis/due_date': '2026-07-03',
      'orbis/effort_min': 120,
    },
    aspects: ['orbis/task'],
    queryRefs: [],
    createdAt: '2026-06-28T09:15:00Z',
    updatedAt: '2026-07-02T18:40:00Z',
    archived: false,
  },
  {
    // Сквозной пример PRD 01 §2.4: задача + расписание + planned-расход в одной сущности.
    id: '019ea8b1-4778-7f3d-9a5c-6a521fa1cc24',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Купить кроссовки',
    emoji: '👟',
    body: 'К субботней пробежке. Модель выбрана в [[entity:019e4466-1000-7e07-b5d4-64be9721da51|Wishlist: бег]].',
    bodyRefs: ['019e4466-1000-7e07-b5d4-64be9721da51'],
    tags: ['task', 'expense', 'running'],
    props: {
      'orbis/task_status': 'planned',
      'orbis/priority': 'medium',
      'orbis/due_date': '2026-07-11',
      'orbis/start_at': '2026-07-11T00:00:00+03:00',
      'orbis/all_day': true,
      'orbis/timezone': 'Europe/Moscow',
      'orbis/amount': '8000.00',
      'orbis/currency': 'RUB',
      'orbis/direction': 'expense',
      'orbis/finance_category': '019d48ea-2e00-7a52-876a-c301529b0456',
      'orbis/occurred_on': '2026-07-11',
      'orbis/planned': true,
    },
    aspects: ['orbis/task', 'orbis/schedule', 'orbis/financial'],
    queryRefs: [],
    createdAt: '2026-06-08T19:24:11Z',
    updatedAt: '2026-06-08T19:24:11Z',
    archived: false,
  },
  {
    // Задача: inbox без priority и due_date — минимальный orbis/task.
    id: '019eb2f4-3c20-7d15-8e44-7b9c0d1e2f30',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Разобрать входящие письма',
    emoji: null,
    body: '',
    bodyRefs: [],
    tags: ['task'],
    props: {
      'orbis/task_status': 'inbox',
    },
    aspects: ['orbis/task'],
    queryRefs: [],
    createdAt: '2026-07-01T07:02:00Z',
    updatedAt: '2026-07-01T07:02:00Z',
    archived: false,
  },
  {
    // Задача: done / low, completed_at проставлен (PRD 01 §3.2).
    id: '019eb2f4-4d10-70aa-b3c2-8e5f6a7b8c40',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Оплатить интернет',
    emoji: '🌐',
    body: '',
    bodyRefs: [],
    tags: ['task', 'home'],
    props: {
      'orbis/task_status': 'done',
      'orbis/priority': 'low',
      'orbis/due_date': '2026-06-28',
      'orbis/completed_at': '2026-06-28T18:05:00Z',
    },
    aspects: ['orbis/task'],
    queryRefs: [],
    createdAt: '2026-06-20T10:00:00Z',
    updatedAt: '2026-06-28T18:05:00Z',
    archived: false,
  },
  {
    // Задача: waiting с waiting_for и просроченным due_date — для due_date=overdue.
    id: '019eb2f4-5e00-7188-a1d0-9f6a7b8c9d50',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Получить справку из бухгалтерии',
    emoji: null,
    body: 'Запросил 25 июня, обещали до конца месяца.',
    bodyRefs: [],
    tags: ['task', 'work'],
    props: {
      'orbis/task_status': 'waiting',
      'orbis/priority': 'medium',
      'orbis/due_date': '2026-06-30',
      'orbis/waiting_for': 'бухгалтерия',
    },
    aspects: ['orbis/task'],
    queryRefs: [],
    createdAt: '2026-06-25T12:30:00Z',
    updatedAt: '2026-06-30T09:00:00Z',
    archived: false,
  },
  {
    // Задача: cancelled и archived=true — для archived=true|any.
    id: '019eb2f4-6f00-72bb-b2e1-0a1b2c3d4e60',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Старый черновик плана на квартал',
    emoji: null,
    body: 'Заменён новым планом.',
    bodyRefs: [],
    tags: ['task'],
    props: {
      'orbis/task_status': 'cancelled',
      'orbis/priority': 'low',
    },
    aspects: ['orbis/task'],
    queryRefs: [],
    createdAt: '2026-05-02T08:00:00Z',
    updatedAt: '2026-06-15T14:20:00Z',
    archived: true,
  },
  {
    // Заметка: orbis/note — маркер «главное назначение — текст» (PRD 01 §3.4).
    id: '019eb2f4-7a00-73cc-93f2-1b2c3d4e5f70',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Идеи для отпуска',
    emoji: '🏝️',
    body: '- Грузия, сентябрь\n- Алтай, июль\n- Проверить визовые требования',
    bodyRefs: [],
    tags: ['note', 'travel'],
    props: {
      'orbis/content_type': 'markdown',
      'orbis/pinned': true,
    },
    aspects: ['orbis/note'],
    queryRefs: [],
    createdAt: '2026-06-10T21:45:00Z',
    updatedAt: '2026-06-29T22:10:00Z',
    archived: false,
  },
  {
    // Финансовый факт: расход (пример PRD 01 §3.5) — для amount-сравнений и aspect=orbis/financial.
    id: '019eac7a-5980-7fa8-8425-8b14dfcbba25',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Обед',
    emoji: null,
    body: '',
    bodyRefs: [],
    tags: ['expense', 'food'],
    props: {
      'orbis/amount': '340.00',
      'orbis/currency': 'RUB',
      'orbis/direction': 'expense',
      'orbis/finance_category': '019d48ea-4188-765d-8e96-93a0ad9c262a',
      'orbis/occurred_on': '2026-06-13',
      'orbis/planned': false,
      'orbis/payment_method': 'card',
      'orbis/counterparty': 'Кафе у дома',
    },
    aspects: ['orbis/financial'],
    queryRefs: [],
    createdAt: '2026-06-13T13:10:00Z',
    updatedAt: '2026-06-13T13:10:00Z',
    archived: false,
  },
  {
    // Финансовый факт: доход — для direction=income и amount>1000.
    id: '019eb2f4-9c00-75ee-85a4-3d4e5f6a7b90',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Зарплата за июнь',
    emoji: '💰',
    body: '',
    bodyRefs: [],
    tags: ['income'],
    props: {
      'orbis/amount': '150000.00',
      'orbis/currency': 'RUB',
      'orbis/direction': 'income',
      'orbis/finance_category': '019d48ea-5100-7b31-9c22-40d1a2e37f88',
      'orbis/occurred_on': '2026-06-30',
      'orbis/planned': false,
      'orbis/counterparty': 'ООО «Ромашка»',
    },
    aspects: ['orbis/financial'],
    queryRefs: [],
    createdAt: '2026-06-30T10:00:00Z',
    updatedAt: '2026-06-30T10:00:00Z',
    archived: false,
  },
  {
    // Planned-расход в границе диапазона — для amount=500..2000 (включительно).
    id: '019eb2f4-ad00-76ff-96b5-4e5f6a7b8ca0',
    ownerId: FIXTURE_OWNER_ID,
    title: 'Абонемент в бассейн',
    emoji: '🏊',
    body: '',
    bodyRefs: [],
    tags: ['expense', 'health'],
    props: {
      'orbis/amount': '2000.00',
      'orbis/currency': 'RUB',
      'orbis/direction': 'expense',
      'orbis/finance_category': '019d48ea-6a00-7c42-8d17-51e2b3f48a99',
      'orbis/occurred_on': '2026-07-10',
      'orbis/planned': true,
    },
    aspects: ['orbis/financial'],
    queryRefs: [],
    createdAt: '2026-07-01T16:00:00Z',
    updatedAt: '2026-07-01T16:00:00Z',
    archived: false,
  },
];
