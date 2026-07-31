// apps/server/src/perf.test.ts
// Перф-гейт слайса 3 (D21): шесть горячих серверных операций на объёме «граф владельца
// через год» — 2000 сущностей, 1000 транзакций, 12 конвертов. Тест роняет CI, числа
// печатаются всегда (см. measureMedian), так что дрейф виден и на зелёном прогоне.
//
// Что этот гейт НЕ проверяет: он не измеряет абсолютную скорость раннера и не заменяет
// точечный замер backlinks в executor/relations.test.ts. Он ловит грубую регрессию —
// потерянный индекс, N+1, случайный seq scan, — поэтому пороги заданы кратно измеренному.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../test/helpers';
import { appRouter } from './router';
import { seedCategoryId } from './seed/onboarding';
import { measureMedian, perfHubId, seedPerfFixture } from './test/perf';
import { createCallerFactory } from './trpc';

requireEnv();

const { db, client } = appDb();
const user = freshUserId();
const caller = createCallerFactory(appRouter)({
  actorUserId: user,
  actorKind: 'owner',
  db,
  clientVersion: null,
});

/**
 * Пороги, мс. Рядом с каждым — верхняя граница медиан, измеренных локально при калибровке
 * 2026-07-31 (Apple Silicon, локальный Supabase; семь прогонов, из них один — в составе
 * полного `bun run test`, где серверный сьют идёт параллельно web и конкурирует за CPU).
 *
 * Запас минимум ×3, а не ×2: раннер `ubuntu-latest` общий и заметно медленнее машины
 * разработчика, а гейт, мигающий красным на ровном месте, перестают читать. Где абсолютное
 * число мало (десятки мс), запас взят больше: там медиану делает постоянная накладная —
 * соединение, tRPC-слой, `set_config` для RLS, — и она на медленном раннере растёт
 * пропорционально сильнее, чем сама работа с данными.
 *
 * Перекалибровка. Числа печатаются всегда (D21), поэтому реальные медианы CI видны в логе
 * первого же зелёного прогона: если они окажутся сильно ниже порогов — пороги подтянуть,
 * чтобы гейт снова ловил разы, а не десятки раз.
 */
const BUDGETS_MS: Record<string, number> = {
  'entity.query:list50': 60, // локально ≤ 14 мс (×4.3)
  'entity.count:badge': 60, // локально ≤ 11 мс (×5.5)
  'budget.overview': 300, // локально ≤ 76 мс (×3.9)
  'agenda:horizon': 120, // локально ≤ 27 мс (×4.4)
  'entity.backlinks': 120, // локально ≤ 26 мс (×4.6)
  'fastpath:create': 150, // локально ≤ 34 мс (×4.4)
};

// Состав detail-чтения — ровно тот, что уходит с экрана сущности
// (apps/web/src/features/entity-detail/useEntityDetail.ts, DETAIL_INCLUDE).
const DETAIL_INCLUDE = ['body', 'relations', 'backlinks', 'thread'] as const;

// Горизонт Agenda — дословно AGENDA_DAYS_QUERY клиента
// (apps/web/src/features/agenda/useAgenda.ts): мерить надо то, что реально уходит.
const AGENDA_DAYS_QUERY =
  'aspect=orbis/schedule, start_at=today|next_7d, sortBy=start_at:asc, limit=200';

// «Сегодня» в таймзоне сида — той же, по которой сервер резолвит today/next_7d и месяц
// бюджета. Считать по локальной таймзоне машины нельзя: под UTC-раннером CI дата на
// границе суток разойдётся с датой фикстуры и запросы попадут мимо засеянного окна.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
const month = today.slice(0, 7);

beforeAll(async () => {
  await truncateAll();
  const t0 = performance.now();
  await seedPerfFixture(db, user);
  console.log(`perf: seed ${(performance.now() - t0).toFixed(0)}ms`);
});

afterAll(async () => {
  await client.end();
});

// Сторож фикстуры. Быстрый запрос по пустой выдаче — тоже быстрый: если засеянные данные
// перестанут попадать под запросы гейта (сменилась грамматика, поехали даты, отвалилась
// привязка к конвертам), пороги продолжат выполняться, и гейт будет зелёным, ничего не
// меряя. Границы намеренно грубые — это проверка «не пусто», а не второй пин фикстуры.
test('фикстура наполнена: гейт меряет данные, а не пустой граф', async () => {
  const list = await caller.entity.query({
    query: 'aspect=orbis/task, status=!done, sortBy=updated_at:desc, limit=50',
  });
  expect(list).toHaveLength(50);

  const badge = await caller.entity.count({ query: 'aspect=orbis/task, status=inbox' });
  expect(badge.count).toBeGreaterThan(100);

  const overview = await caller.budget.overview({ month });
  expect(overview.envelopes.length).toBeGreaterThanOrEqual(10);
  // spent > 0 хотя бы у одного конверта: транзакции реально привязаны бюджет-хуком
  expect(overview.envelopes.some((e) => e.spent !== '0.00')).toBe(true);

  const agenda = await caller.entity.query({ query: AGENDA_DAYS_QUERY });
  expect(agenda.length).toBeGreaterThan(100);

  const detail = await caller.entity.get({ id: perfHubId(user), include: [...DETAIL_INCLUDE] });
  // Потолок секции «Связанное» — 100 (entity-read.ts): обратных ссылок засеяно больше,
  // значит меряется полная выдача с усечением, как на живом detail-экране.
  expect(detail.backlinks).toHaveLength(100);
  expect(detail.backlinksTruncated).toBe(true);
}, 60_000);

test('перф-бюджеты серверных операций', async () => {
  const results: [string, number][] = [
    [
      'entity.query:list50',
      await measureMedian('entity.query:list50', 7, () =>
        caller.entity.query({
          query: 'aspect=orbis/task, status=!done, sortBy=updated_at:desc, limit=50',
        }),
      ),
    ],
    [
      'entity.count:badge',
      await measureMedian('entity.count:badge', 7, () =>
        caller.entity.count({ query: 'aspect=orbis/task, status=inbox' }),
      ),
    ],
    [
      'budget.overview',
      await measureMedian('budget.overview', 5, () => caller.budget.overview({ month })),
    ],
    [
      'agenda:horizon',
      await measureMedian('agenda:horizon', 5, () =>
        caller.entity.query({ query: AGENDA_DAYS_QUERY }),
      ),
    ],
    [
      'entity.backlinks',
      await measureMedian('entity.backlinks', 7, () =>
        caller.entity.get({ id: perfHubId(user), include: [...DETAIL_INCLUDE] }),
      ),
    ],
    [
      // Вход — форма, которую отдаёт parseFastPath на «кофе 340» (packages/shared/src/
      // fast-path): те же поля аспекта, тот же source. Стоимость здесь — не вставка строки,
      // а бюджет-хук: селектор конверта плюс привязка тем же tx.
      'fastpath:create',
      await measureMedian('fastpath:create', 5, () =>
        caller.entity.create({
          input: {
            id: newId(),
            title: 'кофе 340',
            tags: [],
            aspects: {
              'orbis/financial': {
                amount: '340.00',
                direction: 'expense',
                currency: 'RUB',
                category_ref: seedCategoryId(user, 'food'),
                occurred_on: today,
              },
            },
          },
          source: 'fast_path',
        }),
      ),
    ],
  ];

  // Сначала — что измерено ровно то, для чего заведены пороги. Без этой сверки опечатка
  // в ключе делает порог недостижимым (`ms > undefined` — всегда false), и гейт зеленеет
  // навсегда, ничего не проверяя: молчаливо мёртвый гейт хуже отсутствующего.
  expect(results.map(([key]) => key).sort()).toEqual(Object.keys(BUDGETS_MS).sort());

  // Список нарушителей, а не первый упавший: по красному CI должно быть видно ВСЁ,
  // что просело, — иначе разбор идёт по одной операции за прогон.
  const over = results.filter(([key, ms]) => ms > (BUDGETS_MS[key] as number));
  expect(over.map(([key, ms]) => `${key}=${ms.toFixed(0)}ms`)).toEqual([]);
}, 120_000);
