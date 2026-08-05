// apps/server/src/goals/progress.test.ts
// Интеграционные тесты расчёта прогресса цели (01 §11.3, задача E2) против живой БД:
// агрегат считает SQL под RLS-identity владельца, поэтому подделать движок нечем —
// сущности готовятся ЧЕРЕЗ роутер (единственный путь мутаций), читается — как в бою.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GoalAspect } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import * as schema from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { queryContext } from '../query/context';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { computeGoalProgress } from './progress';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

/** Категория-ссылка финансовых сущностей: uuid, существования executor не требует. */
const CATEGORY_REF = '019e4466-bbbb-7e07-b5d4-64be9721da51';

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

type Caller = ReturnType<typeof callerFor>;

function income(amount: string, tags: string[], occurredOn = '2026-07-04') {
  return {
    tags,
    aspects: {
      'orbis/financial': {
        amount,
        direction: 'income',
        category_ref: CATEGORY_REF,
        occurred_on: occurredOn,
      },
    },
  };
}

async function createIncome(caller: Caller, title: string, amount: string, tags: string[]) {
  return caller.entity.create({ input: { title, ...income(amount, tags) }, source: 'ui' });
}

/** Расчёт как в бою: под identity владельца, контекст компиляции — тот же queryContext. */
function progressOf(user: string, goal: GoalAspect, thisEntityId: string | null = null) {
  return withIdentity(db, user, async (tx) => {
    const cctx = await queryContext(tx, user, thisEntityId);
    return computeGoalProgress(tx, cctx, goal);
  });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('computeGoalProgress: агрегаты §11.3', () => {
  test('aggregate=sum складывает поле по отобранным сущностям', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await createIncome(caller, 'Отложил в мае', '100000.00', ['savings']);
    await createIncome(caller, 'Отложил в июне', '50000.00', ['savings']);
    // Мимо выборки: другой тег и другое направление — доказывают, что фильтр работает
    await createIncome(caller, 'Зарплата', '400000.00', ['salary']);
    await caller.entity.create({
      input: {
        title: 'Продукты',
        tags: ['savings'],
        aspects: {
          'orbis/financial': {
            amount: '3000.00',
            direction: 'expense',
            category_ref: CATEGORY_REF,
            occurred_on: '2026-07-04',
          },
        },
      },
      source: 'ui',
    });

    const p = await progressOf(user, {
      progress_source: {
        query: 'aspect=orbis/financial, direction=income, tags=savings',
        aggregate: 'sum',
        field: 'amount',
      },
      target_value: '300000.00',
    });

    expect(p.current).toBe('150000.00');
    expect(p.target).toBe('300000.00');
    expect(p.unsupported).toBeUndefined();
  });

  test('aggregate=count считает сущности, а не поле', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    for (const title of ['Хоббит', 'Дюна', 'Сиддхартха']) {
      await caller.entity.create({
        input: { title, tags: ['book'], aspects: { 'orbis/note': {} } },
        source: 'ui',
      });
    }
    await caller.entity.create({
      input: { title: 'Не книга', tags: ['idea'], aspects: { 'orbis/note': {} } },
      source: 'ui',
    });

    const p = await progressOf(user, {
      progress_source: { query: 'aspect=orbis/note, tags=book', aggregate: 'count' },
      target_value: '24',
    });

    expect(p.current).toBe('3');
    expect(p.target).toBe('24');
    expect(p.unsupported).toBeUndefined();
  });

  test('aggregate=latest берёт значение поля у последней по updated_at, а не по созданию', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    // Массивов чисел во встроенных аспектах нет, поэтому «последнее измерение»
    // моделируется реальным числовым полем — orbis/financial.amount (взносы по кредиту).
    const first = await createIncome(caller, 'Взнос 1', '82.5', ['loan']);
    await createIncome(caller, 'Взнос 2', '81.0', ['loan']);
    await createIncome(caller, 'Взнос 3', '80.5', ['loan']);
    // Правка ПЕРВОЙ сущности делает её последней по updated_at: если бы порядок брался
    // из created_at или из физического порядка строк, ответ был бы 80.5.
    await caller.entity.update({ id: first.id, title: 'Взнос 1 (уточнён)' });

    const goal: GoalAspect = {
      progress_source: {
        query: 'aspect=orbis/financial, tags=loan',
        aggregate: 'latest',
        field: 'amount',
      },
      target_value: '100',
    };
    const p = await progressOf(user, goal);

    expect(p.current).toBe('82.5');
    expect(p.unsupported).toBeUndefined();

    // Пустая выборка у latest — тоже ноль, а не отказ
    const empty = await progressOf(user, {
      ...goal,
      progress_source: { ...goal.progress_source, query: 'aspect=orbis/financial, tags=nothing' },
    } as GoalAspect);
    expect(empty.current).toBe('0');
    expect(empty.unsupported).toBeUndefined();
  });

  test('пустая выборка даёт 0, а не ошибку (§6.4: пустота ≠ ошибка)', async () => {
    const user = freshUserId();
    const p = await progressOf(user, {
      progress_source: {
        query: 'aspect=orbis/financial, direction=income, tags=savings',
        aggregate: 'sum',
        field: 'amount',
      },
      target_value: '300000.00',
    });

    expect(p.current).toBe('0');
    expect(p.target).toBe('300000.00');
    expect(p.unsupported).toBeUndefined();
  });

  test('перевыполненная цель отдаёт значение как есть, не подрезая его целью', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await createIncome(caller, 'Премия', '150000.00', ['savings']);

    const p = await progressOf(user, {
      progress_source: {
        query: 'aspect=orbis/financial, tags=savings',
        aggregate: 'sum',
        field: 'amount',
      },
      target_value: '100000.00',
    });

    // Перевыполнение — не отказ и не потолок: клиент сам решает, что рисовать полосой,
    // а сервер отдаёт достигнутое как есть (150 000 при цели 100 000).
    expect(p.current).toBe('150000.00');
    expect(p.target).toBe('100000.00');
    expect(p.unsupported).toBeUndefined();
  });
});

describe('computeGoalProgress: изоляция владельца', () => {
  test('цель не считает чужие сущности — ни в sum, ни в count, ни через entity.get', async () => {
    const me = freshUserId();
    const other = freshUserId();
    // Чужие сущности подобраны так, чтобы ЛЮБАЯ утечка была видна в ответе: суммы и
    // счётчики отличаются на порядки. Скомпилированный SQL owner-фильтра не содержит
    // вовсе (compile.ts §инварианты) — изоляцию целиком даёт identity транзакции
    // (set_config + SET LOCAL ROLE authenticated) и RLS поверх неё, и на новом пути
    // расчёта это не запиннено больше ничем.
    //
    // Пробой прилагаю честно: если подменить переданную транзакцию на свежую из пула
    // (вероятный будущий рефактор «убрать вложенность»), на нашем стенде расчёт упадёт
    // с permission denied — базовая роль DSN `orbis_app` не имеет прав на entities и
    // aspect_definitions без SET LOCAL ROLE, то есть отказывает закрыто, а не течёт.
    // Утечка становится настоящей, если процесс поднимут под ролью с правами на
    // таблицы (админ-DSN — он в репозитории есть) или роли выдадут гранты. Тест
    // сторожит сам инвариант, а не одну его реализацию.
    await createIncome(callerFor(other), 'Чужой доход', '999999.00', ['savings']);
    await createIncome(callerFor(other), 'Ещё чужой', '888888.00', ['savings']);
    await createIncome(callerFor(me), 'Мой доход', '100.00', ['savings']);

    const source = { query: 'aspect=orbis/financial, tags=savings' } as const;
    const sum = await progressOf(me, {
      progress_source: { ...source, aggregate: 'sum', field: 'amount' },
      target_value: '1000.00',
    });
    expect(sum.current).toBe('100.00');

    const count = await progressOf(me, {
      progress_source: { ...source, aggregate: 'count' },
      target_value: '10',
    });
    expect(count.current).toBe('1');

    const latest = await progressOf(me, {
      progress_source: { ...source, aggregate: 'latest', field: 'amount' },
      target_value: '1000.00',
    });
    expect(latest.current).toBe('100.00');

    // Тот же путь, но через боевой роутер целиком
    const goal = await callerFor(me).entity.create({
      input: {
        title: 'Накопить',
        tags: [],
        aspects: {
          'orbis/goal': {
            progress_source: { ...source, aggregate: 'sum', field: 'amount' },
            target_value: '1000.00',
          },
        },
      },
      source: 'ui',
    });
    const got = await callerFor(me).entity.get({ id: goal.id });
    expect(got.goalProgress?.current).toBe('100.00');
  });
});

describe('computeGoalProgress: честные отказы вместо падения (§12 п.6, fail-soft)', () => {
  test('поле внутри JSONB-массива не поддерживается — честный флаг, а не тихий ноль', async () => {
    const user = freshUserId();
    const p = await progressOf(user, {
      // Запрос валиден, аспект существует — отказ ровно про поле внутри массива
      progress_source: {
        query: 'aspect=orbis/category',
        aggregate: 'sum',
        field: 'aliases[].weight',
      },
      target_value: '100',
    });

    expect(p.unsupported).toBe('array_field');
    expect(p.current).toBe('0');
    expect(p.target).toBe('100');
  });

  test('опечатка в поле отличима от массива: invalid_field, а не array_field', async () => {
    const user = freshUserId();
    const typo = await progressOf(user, {
      progress_source: {
        query: 'aspect=orbis/financial, direction=income',
        aggregate: 'sum',
        field: 'amountt',
      },
      target_value: '100',
    });
    expect(typo.unsupported).toBe('invalid_field');

    // Нечисловое поле — тот же класс отказа, но не падение
    const text = await progressOf(user, {
      progress_source: {
        query: 'aspect=orbis/financial, direction=income',
        aggregate: 'sum',
        field: 'counterparty',
      },
      target_value: '100',
    });
    expect(text.unsupported).toBe('invalid_field');

    // latest требует тот же числовой тип, что и sum
    const latestText = await progressOf(user, {
      progress_source: {
        query: 'aspect=orbis/financial, direction=income',
        aggregate: 'latest',
        field: 'counterparty',
      },
      target_value: '100',
    });
    expect(latestText.unsupported).toBe('invalid_field');
  });

  test('неразбираемый и нескомпилируемый query — invalid_query, расчёт не падает', async () => {
    const user = freshUserId();
    const broken = await progressOf(user, {
      progress_source: { query: 'aspect=orbis/financial, %%%', aggregate: 'count' },
      target_value: '10',
    });
    expect(broken.unsupported).toBe('invalid_query');
    expect(broken.current).toBe('0');

    // `this` вне контекста сущности — структурная ошибка компиляции, тоже мягкая
    const noThis = await progressOf(user, {
      progress_source: { query: 'children_of=this', aggregate: 'count' },
      target_value: '10',
    });
    expect(noThis.unsupported).toBe('invalid_query');
  });
});

describe('computeGoalProgress: отказ САМОГО SQL не роняет чтение', () => {
  test('нечисловое значение в числовом поле — compute_failed, транзакция жива', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const row = await createIncome(caller, 'Взнос', '10.00', ['drift']);
    // Рассинхрон реестра и данных: каталог считает amount числом, а в JSONB текст.
    // Через executor такое не пройдёт (ajv), поэтому пишем админ-DSN мимо него —
    // ровно как это выглядело бы после ручной правки или дрейфа схемы аспекта.
    const admin = adminDb();
    try {
      await admin.db.execute(
        sql`UPDATE entities SET aspects = jsonb_set(aspects, '{orbis/financial,amount}', '"не число"') WHERE id = ${row.id}`,
      );
    } finally {
      await admin.client.end();
    }

    const goal: GoalAspect = {
      progress_source: {
        query: 'aspect=orbis/financial, tags=drift',
        aggregate: 'sum',
        field: 'amount',
      },
      target_value: '100',
    };
    const p = await progressOf(user, goal);
    expect(p.unsupported).toBe('compute_failed');
    expect(p.current).toBe('0');

    // Транзакция после отката к savepoint жива: следующий запрос в НЕЙ ЖЕ проходит.
    // Без savepoint упавший statement перевёл бы её в aborted и убил entity.get.
    const stillReadable = await withIdentity(db, user, async (tx) => {
      const cctx = await queryContext(tx, user, null);
      await computeGoalProgress(tx, cctx, goal);
      const rows = await tx.execute(sql`SELECT count(*)::text AS n FROM entities`);
      return (rows[0] as { n: string }).n;
    });
    expect(stillReadable).toBe('1');
  });

  test('NaN на выходе агрегата — тоже compute_failed, и ловит его ДРУГОЙ catch', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const row = await createIncome(caller, 'Взнос', '10.00', ['nan']);
    // 'NaN' — ЗАКОННОЕ значение numeric в PostgreSQL: каст не падает, падает уже разбор
    // decimal-строки в decRatio. То есть путь идёт мимо SQL-catch и упирается во второй,
    // «долевой». Без него отказ выглядел бы в логе как отказ базы — ярлык один, но
    // диагноз врал бы; тест держит именно разделение — и держит его ТЕКСТОМ ЛОГА, а не
    // ярлыком: ярлык `compute_failed` отдают оба catch'а, и проверка одного лишь ярлыка
    // не заметила бы, если бы второй catch (или сам вызов decRatio, чьё значение никуда
    // не уезжает) однажды исчез как «мёртвый код».
    const admin = adminDb();
    try {
      await admin.db.execute(
        sql`UPDATE entities SET aspects = jsonb_set(aspects, '{orbis/financial,amount}', '"NaN"') WHERE id = ${row.id}`,
      );
    } finally {
      await admin.client.end();
    }

    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    };
    let p: Awaited<ReturnType<typeof progressOf>>;
    try {
      p = await progressOf(user, {
        progress_source: {
          query: 'aspect=orbis/financial, tags=nan',
          aggregate: 'sum',
          field: 'amount',
        },
        target_value: '100',
      });
    } finally {
      console.error = realError;
    }
    expect(p.unsupported).toBe('compute_failed');
    expect(p.current).toBe('0');
    // Лог — «долевой», а не «агрегат не выполнился»: диагноз называет настоящую причину
    expect(logged.some((l) => l.includes('доля не посчиталась'))).toBe(true);
    expect(logged.some((l) => l.includes('агрегат sum не выполнился'))).toBe(false);
  });
});

describe('entity.get: прогресс приезжает с целью и только с ней', () => {
  test('цель получает goalProgress, обычная сущность — нет', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await createIncome(caller, 'Отложил', '75000.00', ['savings']);
    const goal = await caller.entity.create({
      input: {
        title: 'Накопить 300 000 ₽',
        tags: ['goal'],
        aspects: {
          'orbis/goal': {
            progress_source: {
              query: 'aspect=orbis/financial, direction=income, tags=savings',
              aggregate: 'sum',
              field: 'amount',
            },
            target_value: '300000.00',
            unit: '₽',
          },
        },
      },
      source: 'ui',
    });

    const got = await caller.entity.get({ id: goal.id });
    // toEqual, а не пополевые проверки: контракт целиком — две decimal-строки и ничего
    // больше. Готовой доли на проводе нет намеренно (процент клиент считает точно, из
    // этих же строк), и лишнее поле обязано уронить именно этот тест.
    expect(got.goalProgress).toEqual({
      current: '75000.00',
      target: '300000.00',
    });

    const plain = await caller.entity.create({
      input: { title: 'Обычная заметка', tags: [], aspects: { 'orbis/note': {} } },
      source: 'ui',
    });
    const gotPlain = await caller.entity.get({ id: plain.id });
    expect(gotPlain.goalProgress).toBeUndefined();
  });

  test('`this` в источнике прогресса — сама цель (children_of=this считает подзадачи)', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const goal = await caller.entity.create({
      input: {
        title: 'Прочитать 24 книги',
        tags: ['goal'],
        aspects: {
          'orbis/goal': {
            progress_source: { query: 'children_of=this, status=done', aggregate: 'count' },
            target_value: '24',
          },
        },
      },
      source: 'ui',
    });
    for (const [title, status] of [
      ['Хоббит', 'done'],
      ['Дюна', 'done'],
      ['Сиддхартха', 'in_progress'],
    ] as const) {
      const child = await caller.entity.create({
        input: { title, tags: [], aspects: { 'orbis/task': { status } } },
        source: 'ui',
      });
      await caller.relation.create({
        source_id: goal.id,
        target_id: child.id,
        relation_type: 'parent',
      });
    }

    const got = await caller.entity.get({ id: goal.id });
    expect(got.goalProgress?.current).toBe('2');
  });

  test('испорченный источник прогресса не мешает открыть цель', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const goal = await caller.entity.create({
      input: {
        title: 'Цель с мусорным запросом',
        tags: ['goal'],
        aspects: {
          'orbis/goal': {
            progress_source: { query: '%%% не запрос', aggregate: 'count' },
            target_value: '10',
          },
        },
      },
      source: 'ui',
    });

    const got = await caller.entity.get({ id: goal.id });
    expect(got.entity.title).toBe('Цель с мусорным запросом');
    expect(got.goalProgress?.unsupported).toBe('invalid_query');
  });

  test('обычная сущность не платит за расчёт цели ни одним запросом (Р14)', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const plain = await caller.entity.create({
      input: { title: 'Обычная заметка', tags: [], aspects: { 'orbis/note': {} } },
      source: 'ui',
    });
    const goal = await caller.entity.create({
      input: {
        title: 'Цель',
        tags: [],
        aspects: {
          'orbis/goal': {
            progress_source: { query: 'aspect=orbis/note', aggregate: 'count' },
            target_value: '10',
          },
        },
      },
      source: 'ui',
    });

    // Отдельный клиент на ОДНО соединение со счётчиком запросов на уровне драйвера:
    // «расчёт не запускался» доказывается отсутствием его запросов, а не верой в код.
    const seen: string[] = [];
    const counted = postgres(process.env.DATABASE_URL as string, {
      max: 1,
      prepare: process.env.PG_PREPARE !== 'false',
      onnotice: () => {},
      debug: (_c: unknown, q: string) => {
        seen.push(q);
      },
    });
    const countingCaller = createCaller({
      actorUserId: user,
      actorKind: 'owner',
      db: drizzle(counted, { schema }),
      clientVersion: null,
    });
    try {
      // Прогрев: на первом запросе соединение читает служебный каталог типов массивов
      await countingCaller.entity.get({ id: plain.id });

      seen.length = 0;
      await countingCaller.entity.get({ id: plain.id });
      const plainQueries = [...seen];

      seen.length = 0;
      await countingCaller.entity.get({ id: goal.id });
      const goalQueries = [...seen];

      // Каталог полей читается ТОЛЬКО расчётом прогресса — его отсутствие и есть
      // доказательство, что ветка по аспекту не пускает обычную сущность в расчёт.
      expect(plainQueries.some((q) => q.includes('aspect_definitions'))).toBe(false);
      expect(goalQueries.some((q) => q.includes('aspect_definitions'))).toBe(true);
      // Измерено: 6 запросов на обычную сущность (begin + 2 identity + сущность +
      // связи + commit) и 10 на цель (+ каталог, + таймзона, + savepoint, + агрегат).
      expect(plainQueries.length).toBe(6);
      expect(goalQueries.length).toBe(10);
    } finally {
      await counted.end();
    }
  });
});
