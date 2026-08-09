// apps/server/src/perf.test.ts
// Перф-гейт слайса 3 (D21): семь горячих серверных операций на объёме «граф владельца
// через год» — 2000 сущностей (задачи/события/заметки), 1000 транзакций, 12 конвертов.
// В таблице `entities` это 3031 строка: к перечисленному добавляются 12 категорий и
// 5 smart lists онбординга, хаб связей и цель. К последнему замеру строк 3037 — сторож
// фикстуры и пять прогонов `fastpath:create` дописывают по своей транзакции. Тест роняет
// CI, числа печатаются всегда (см. measureMedian), так что дрейф виден и на зелёном прогоне.
//
// Что этот гейт НЕ проверяет: он не измеряет абсолютную скорость раннера и не заменяет
// точечный замер backlinks в executor/relations.test.ts. Пороги заданы кратно измеренному,
// поэтому порогом он ловит регрессию В РАЗЫ — N+1, чтение всего графа вместо страницы.
// Потерянный индекс порогом ловится не везде: на дешёвых операциях (entity.query:list50,
// entity.count:badge — единицы-десятки мс при пороге 60) seq scan по трём тысячам строк
// фикстуры стоит слишком мало, чтобы его пробить. Такое видно по печатаемым медианам
// `perf: …`, а не по красному прогону, — за тем они и печатаются всегда (D21).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../test/helpers';
import { appRouter } from './router';
import {
  measureMedian,
  perfEnvelopeCategoryId,
  perfGoalId,
  perfHubId,
  seedPerfFixture,
} from './test/perf';
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
 * Пороги, мс. В комментарии рядом с каждым — ДВА числа: медиана калибровки, по которой порог
 * когда-то выбран, и ХУДШАЯ медиана, наблюдённая с тех пор где угодно (CI или локально), с
 * фактическим запасом до порога. Второе число и есть правда о запасе; первое — история.
 * Калибровки: шесть первых строк — 2026-07-31 (Apple Silicon, локальный Supabase, одиннадцать
 * прогонов, из них три в составе полного `bun run test`). `goal.progress` — 2026-08-09: пять
 * изолированных прогонов (24.0 / 24.6 / 25.0 / 25.4 / 26.0) и один под конкурентной
 * нагрузкой (39.6); ещё два изолированных прогона позже дали 21.0 и 28.9, то есть свой
 * калибровочный максимум эта строка перекрыла так же, как шесть старших.
 *
 * ЦЕЛЬ запаса — минимум ×3, а не ×2: раннер `ubuntu-latest` общий и заметно медленнее машины
 * разработчика, а гейт, мигающий красным на ровном месте, перестают читать. Где абсолютное
 * число мало (десятки мс), запас брали больше: там медиану делает постоянная накладная —
 * соединение, tRPC-слой, `set_config` для RLS, — и она на медленном раннере растёт
 * пропорционально сильнее, чем сама работа с данными.
 *
 * ФАКТ: цель не держится, и это измерено, а не предположено.
 * - CI, семь прогонов `ubuntu-latest` (2026-08-03…2026-08-09): пять медиан из шести вышли за
 *   свой калибровочный максимум (`list50` 20.2 при «≤ 15», `badge` 17.4 при «≤ 13», `agenda`
 *   40.2 при «≤ 27», `backlinks` 27.9 при «≤ 26», `fastpath` 44.2 при «≤ 34»); под своим
 *   числом остался только `budget.overview` (74.8 при «≤ 76»). Разброс между прогонами
 *   доходит до ×4 (`badge`: 4.3…17.4 мс).
 * - Повторная локальная калибровка 2026-08-09, изолированными прогонами: за свой максимум
 *   вышли ВСЕ шесть — 16.8 / 15.2 / 106.4 / 32.0 / 27.1 / 37.2 в порядке таблицы. Отсюда и
 *   106.4 у `budget.overview`: своего худшего числа он дождался именно здесь.
 * - Она же под конкурентной нагрузкой (полный `bun run test` — та форма, в которой гейт
 *   идёт на CI): 17.9 / 15.8 / 98.7 / 51.1 / 32.5 / 44.6. Хуже изолированного везде, КРОМЕ
 *   `budget.overview` (98.7 против 106.4) — «под нагрузкой всегда хуже» неверно: разброс
 *   между прогонами перекрывает вклад соседей по CPU.
 * - Худший фактический запас — ×2.35 (`agenda` 51.1 мс) при цели ×3: недобор 22 %. Следом
 *   идут ×2.8 (`budget.overview` 106.4) и ×2.97 (`list50` 20.2 на CI).
 *
 * Отсюда прямая поправка к тому, что стояло здесь раньше: «типичное значение ниже, то есть
 * реальный запас больше указанного» — неверно, запас обычно МЕНЬШЕ.
 *
 * Сами пороги при этом НЕ подняты: ни один из них ни разу не сработал ложно, а поднимать
 * порог по разбросу раннера значит ослаблять гейт ради тишины. Числа печатаются всегда (D21),
 * так что решение о перекалибровке принимается по строкам `perf: …` из CI — и вниз тоже: если
 * медианы окажутся сильно ниже порогов, пороги подтянуть, чтобы гейт снова ловил разы.
 *
 * Правило поддержки: увидел медиану хуже записанной в комментарии — замени число в
 * комментарии, а не молчи. Комментарий обязан стареть вместе с раннером, иначе он снова
 * станет тем, чем был: обещанием, которого никто не проверял.
 */
const BUDGETS_MS: Record<string, number> = {
  // калибровка → худшее наблюдённое (фактический запас)
  'entity.query:list50': 60, // ≤ 15 → 20.2 (×2.97)
  'entity.count:badge': 60, // ≤ 13 → 17.4 (×3.4)
  'budget.overview': 300, // ≤ 76 → 106.4 (×2.8)
  'agenda:horizon': 120, // ≤ 27 → 51.1 (×2.35)
  'entity.backlinks': 120, // ≤ 26 → 32.5 (×3.7)
  'fastpath:create': 150, // ≤ 34 → 44.6 (×3.4)
  'goal.progress': 120, // ≤ 26 → 39.6 (×3.0)
};

// Входы семи операций — ОДИН экземпляр на сторожа и на гейт. Дублировать литералы нельзя:
// гарантия сторожа держится ровно на том, что он проверяет непустоту ТОГО ЖЕ запроса,
// который меряет гейт, а текстовое совпадение двух копий ничем не подпирается — правка в
// одном месте без правки в другом возвращает дефект, ради которого сторож и написан.

// Список Browser'а: страница на 50 незакрытых задач.
const LIST50_QUERY = 'aspect=orbis/task, status=!done, sortBy=updated_at:desc, limit=50';

// Бейдж smart list «Inbox» (02-core-os §3.3): count без limit.
const BADGE_QUERY = 'aspect=orbis/task, status=inbox';

// Горизонт Agenda — дословно AGENDA_DAYS_QUERY клиента
// (apps/web/src/features/agenda/useAgenda.ts): мерить надо то, что реально уходит.
const AGENDA_DAYS_QUERY =
  'aspect=orbis/schedule, start_at=today|next_7d, sortBy=start_at:asc, limit=200';

// Состав detail-чтения — ровно тот, что уходит с экрана сущности
// (apps/web/src/features/entity-detail/useEntityDetail.ts, DETAIL_INCLUDE).
const DETAIL_INCLUDE = ['body', 'relations', 'backlinks', 'thread'] as const;

// Седьмая операция — чтение ЦЕЛИ: тот же detail-путь плюс расчёт прогресса
// (goals/progress.ts). Читается тем же include, что уходит с экрана сущности: цель на
// живом detail открывается как любая другая сущность, и мерить её лабораторным срезом
// (include: []) значило бы мерить не то, что ходит. Обратных ссылок и треда у цели в
// фикстуре нет, поэтому вклад include мал — стоимость строки делает агрегат.
//
// Заведена она НЕ ради дельты «цель дороже обычной сущности»: та уже запинена точнее
// любого мс-порога — goals/progress.test.ts считает запросы драйвера (ровно 6 на обычную
// сущность и 10 на цель), — а между прогонами CI медианы этого гейта расходятся до ×4
// (`entity.count:badge`: 4.3…17.4 мс на семи проверенных прогонах), и разницу в единицы
// миллисекунд порогом не поймать в принципе. Смысл строки в другом: у goal-пути не было
// перф-покрытия ВООБЩЕ — в засеянном объёме не было ни одной цели, а `compileSum` не
// исполняла ни одна операция гейта.
//
// Что этот порог ловит: регрессию, стоимость которой растёт с числом строк выборки, — N+1
// на агрегате, чтение всего графа вместо выборки. Чего НЕ ловит: потерянный индекс. Выборка
// источника — треть таблицы (966 расходов при 3037 сущностях — счёт на момент этого замера,
// разложен в шапке файла), а на такой
// селективности индекс не берётся и сейчас; здесь работает та же оговорка, что в шапке
// файла про list50/badge, и по той же причине — цена seq scan на этом объёме мала.

// «Сегодня» в таймзоне сида — той же, по которой сервер резолвит today/next_7d и месяц
// бюджета. Считать по локальной таймзоне машины нельзя: под UTC-раннером CI дата на
// границе суток разойдётся с датой фикстуры и запросы попадут мимо засеянного окна.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
const month = today.slice(0, 7);

/**
 * Вход fast-path — форма, которую отдаёт parseFastPath на «кофе 340» (packages/shared/src/
 * fast-path): те же поля аспекта, тот же source. Каждый вызов даёт новый id — операция
 * мутирующая, повтор с тем же id ушёл бы в идемпотентный replay и мерил бы не создание.
 *
 * Категория берётся из фикстуры (perfEnvelopeCategoryId), а не литералом: стоимость этой
 * операции — не вставка строки, а бюджет-хук (селектор конверта плюс привязка тем же tx),
 * и без конверта замер съезжает на заметно более дешёвый путь.
 */
function fastPathCreateInput() {
  return {
    input: {
      id: newId(),
      title: 'кофе 340',
      tags: [],
      aspects: {
        'orbis/financial': {
          amount: '340.00',
          direction: 'expense',
          currency: 'RUB',
          category_ref: perfEnvelopeCategoryId(user),
          occurred_on: today,
        },
      },
    },
    source: 'fast_path' as const,
  };
}

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
  const list = await caller.entity.query({ query: LIST50_QUERY });
  expect(list).toHaveLength(50);

  const badge = await caller.entity.count({ query: BADGE_QUERY });
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

  // fast-path: мерить надо ПОЛНЫЙ путь — вставку плюс бюджет-хук. Проверяем не то, что
  // create прошёл (он пройдёт и без конверта), а то, что транзакция реально привязана:
  // связь `parent` от конверта (03-budget §2.3). Без неё замер молча съезжает на более
  // дешёвый путь, и гейт остаётся зелёным при вдвое меньшей работе.
  const txn = await caller.entity.create(fastPathCreateInput());
  const bound = await caller.entity.get({ id: txn.id, include: ['relations'] });
  const parent = (bound.relations ?? []).find(
    (r) => r.relationType === 'parent' && r.targetId === txn.id,
  );
  expect(parent).toBeDefined();
  const envelope = await caller.entity.get({ id: parent?.sourceId ?? '', include: [] });
  expect(Object.keys(envelope.entity.aspects)).toContain('orbis/budget');

  // Цель: мерить надо ПОСЧИТАННЫЙ прогресс. Расчёт fail-soft (goals/progress.ts) — на
  // конфигурационном отказе (`invalid_query`, `invalid_field`, `array_field`) он выходит
  // РАНЬШЕ savepoint и агрегата и возвращает ярлык, а не исключение. Сломанная фикстурная
  // цель дала бы поэтому самый дешёвый из возможных замеров при зелёном гейте — ровно тот
  // дефект, против которого рядом стоят сторожи fast-path и backlinks.
  const goal = await caller.entity.get({ id: perfGoalId(user), include: [...DETAIL_INCLUDE] });
  const progress = goal.goalProgress;
  // Отсутствие поля целиком — тоже отказ, но ДРУГОЙ: так выходит goalProgressFor, когда
  // аспект не прошёл собственную схему. Без этой строки `?.unsupported === undefined`
  // читалось бы как успех ровно там, где расчёт не запускался вовсе.
  expect(progress).toBeDefined();
  expect(progress?.unsupported).toBeUndefined();
  // Пустая выборка источника даёт РОВНО '0' (goals/progress.ts): агрегат в этом случае
  // отработал бы, но по пустому месту, и замер снова был бы не тем, ради которого порог.
  expect(progress?.current).not.toBe('0');
}, 60_000);

test('перф-бюджеты серверных операций', async () => {
  const results: [string, number][] = [
    [
      'entity.query:list50',
      await measureMedian('entity.query:list50', 7, () =>
        caller.entity.query({ query: LIST50_QUERY }),
      ),
    ],
    [
      'entity.count:badge',
      await measureMedian('entity.count:badge', 7, () =>
        caller.entity.count({ query: BADGE_QUERY }),
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
      'fastpath:create',
      await measureMedian('fastpath:create', 5, () => caller.entity.create(fastPathCreateInput())),
    ],
    [
      'goal.progress',
      await measureMedian('goal.progress', 7, () =>
        caller.entity.get({ id: perfGoalId(user), include: [...DETAIL_INCLUDE] }),
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
