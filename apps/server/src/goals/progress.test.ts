// apps/server/src/goals/progress.test.ts
// Интеграционные тесты расчёта прогресса цели (01 §11.3, задача E2) против живой БД:
// агрегат считает SQL под RLS-identity владельца, поэтому подделать движок нечем —
// сущности готовятся ЧЕРЕЗ роутер (единственный путь мутаций), читается — как в бою.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { QueryAst } from '@orbis/shared/query';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  adminDb,
  appDb,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  seedRefTargetRows,
  truncateAll,
} from '../../test/helpers';
import * as schema from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { CompileCtx } from '../query/compile-ast';
import { queryContext } from '../query/context';
import { parseQueryText } from '../query/parse-text';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { computeGoalProgress, type GoalProgressUnsupported, type GoalSource } from './progress';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

/** Категория-ссылка финансовых сущностей: uuid, существования executor не требует. */
/**
 * Категория владельца под ссылку транзакции. С §А6-1 значение `orbis/finance_category`
 * проверяется по множеству `aspect=orbis/category`, то есть цель обязана существовать И
 * принадлежать ТОМУ ЖЕ владельцу; сьют же заводит нового владельца в каждом тесте, а id
 * сущности глобально уникален — одна константа на всех больше не годится. id выводится из
 * владельца, поэтому остаётся детерминированным.
 */
function categoryOf(user: string): string {
  return `019e4466-bbbb-7e07-b5d4-${user.replaceAll('-', '').slice(0, 12)}`;
}

/** Категория владельца в БД: обстановка ссылки, а не предмет проверки (см. `categoryOf`). */
async function ensureCategory(user: string): Promise<string> {
  const id = categoryOf(user);
  await seedRefTargetRows(user, [{ id, aspect: 'orbis/category' }]);
  return id;
}

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

type Caller = ReturnType<typeof callerFor>;

function income(categoryRef: string, amount: string, tags: string[], occurredOn = '2026-07-04') {
  return {
    tags,
    aspects: {
      'orbis/financial': {
        amount,
        direction: 'income',
        category_ref: categoryRef,
        occurred_on: occurredOn,
      },
    },
  };
}

async function createIncome(
  user: string,
  caller: Caller,
  title: string,
  amount: string,
  tags: string[],
) {
  const categoryRef = await ensureCategory(user);
  return caller.entity.create({
    input: { title, ...income(categoryRef, amount, tags) },
    source: 'ui',
  });
}

/**
 * Источник цели, каким его пишут ФИКСТУРЫ: запрос ТЕКСТОМ. Хранится он деревом
 * (§А5-2/Р12), но сверять глазами дерево из десятка узлов невозможно, поэтому текст
 * остаётся языком фикстуры, а разбор делает тест (`toGoalSource`), а не расчёт.
 */
type SourceFixture =
  | { query: string; aggregate: 'count' }
  | { query: string; aggregate: 'sum' | 'latest'; field: string };
type GoalFixture = { progress_source: SourceFixture; target_value: string };

/**
 * Фикстура → источник цели в форме СВОЙСТВ (§А1-1).
 *
 * Неразбираемый текст НЕ роняет фикстуру, а остаётся неразобранным блоком `{text}` — ровно
 * той формой, которую §А5-2 оставляет неразобранному запросу и в которую заворачивает
 * старый текст переходная карта. По ней расчёт обязан ответить `invalid_query`, и тесты
 * отказов ниже ждут именно этого.
 */
function toGoalSource(fx: GoalFixture, ctx: CompileCtx): GoalSource {
  let query: QueryAst | { text: string };
  try {
    query = parseQueryText(fx.progress_source.query, ctx);
  } catch {
    query = { text: fx.progress_source.query };
  }
  return {
    progressSource: { ...fx.progress_source, query } as GoalSource['progressSource'],
    targetValue: fx.target_value,
  };
}

/** Расчёт как в бою: под identity владельца, контекст компиляции — тот же queryContext. */
function progressOf(user: string, goal: GoalFixture, thisEntityId: string | null = null) {
  return withIdentity(db, user, async (tx) => {
    const cctx = await queryContext(tx, user, thisEntityId);
    return computeGoalProgress(tx, cctx, toGoalSource(goal, cctx));
  });
}

/**
 * Цель в графе — через executor НОВОЙ внутренней формой (`props` + список аспектов).
 *
 * Не `caller.entity.create`: контракт ТУЛА (`entityCreateInput`) знает только старую карту
 * аспектов, а она кладёт в `orbis/progress_source` неразобранный блок `{text}` — цель
 * получилась бы заведомо несчитаемой. Перевод тулов и web — Задача 13c; до неё цель новой
 * формы заводится ровно так.
 */
async function createGoal(
  user: string,
  fx: GoalFixture & { title: string; tags?: string[]; unit?: string },
): Promise<{ id: string }> {
  const source = await withIdentity(db, user, async (tx) =>
    toGoalSource(fx, await queryContext(tx, user, null)),
  );
  const r = await execute(db, {
    actorUserId: user,
    actorKind: 'owner',
    source: 'ui',
    operations: [
      {
        tool: 'entity_create',
        input: {
          title: fx.title,
          tags: fx.tags ?? [],
          props: {
            'orbis/progress_source': source.progressSource,
            'orbis/target_value': source.targetValue,
            ...(fx.unit !== undefined && { 'orbis/unit': fx.unit }),
          },
          aspects: ['orbis/goal'],
        },
      },
    ],
  });
  if (!r.ok) throw new Error(`цель не создана: ${r.error.code} ${r.error.message}`);
  return r.results[0] as { id: string };
}

/** Смена источника у существующей цели — тем же путём и той же формой, что и создание. */
async function updateGoalSource(user: string, id: string, fx: SourceFixture): Promise<void> {
  const source = await withIdentity(db, user, async (tx) =>
    toGoalSource({ progress_source: fx, target_value: '100' }, await queryContext(tx, user, null)),
  );
  const r = await execute(db, {
    actorUserId: user,
    actorKind: 'owner',
    source: 'ui',
    operations: [
      {
        tool: 'entity_update',
        input: { id, props: { 'orbis/progress_source': source.progressSource } },
      },
    ],
  });
  if (!r.ok) throw new Error(`источник не обновлён: ${r.error.code} ${r.error.message}`);
}

/**
 * Строки console.error за время вызова. Лог отказа — ЧАСТЬ контракта расчёта (§11.3):
 * наружу отказ уезжает одним ярлыком на четыре разных беды, и всё, чем их различает
 * владелец сервера, — это текст в логе. Поэтому его проверяют тестом, а не глазами.
 */
async function captureErrors<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(' '));
  };
  try {
    return [await fn(), logged];
  } finally {
    console.error = realError;
  }
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
    await createIncome(user, caller, 'Отложил в мае', '100000.00', ['savings']);
    await createIncome(user, caller, 'Отложил в июне', '50000.00', ['savings']);
    // Мимо выборки: другой тег и другое направление — доказывают, что фильтр работает
    await createIncome(user, caller, 'Зарплата', '400000.00', ['salary']);
    await caller.entity.create({
      input: {
        title: 'Продукты',
        tags: ['savings'],
        aspects: {
          'orbis/financial': {
            amount: '3000.00',
            direction: 'expense',
            category_ref: await ensureCategory(user),
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
    const first = await createIncome(user, caller, 'Взнос 1', '82.5', ['loan']);
    await createIncome(user, caller, 'Взнос 2', '81.0', ['loan']);
    await createIncome(user, caller, 'Взнос 3', '80.5', ['loan']);
    // Правка ПЕРВОЙ сущности делает её последней по updated_at: если бы порядок брался
    // из created_at или из физического порядка строк, ответ был бы 80.5.
    await caller.entity.update({ id: first.id, title: 'Взнос 1 (уточнён)' });

    const goal: GoalFixture = {
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
    } as GoalFixture);
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
    await createIncome(user, caller, 'Премия', '150000.00', ['savings']);

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

describe('computeGoalProgress: источник хранится ДЕРЕВОМ (§А5-2/Р12)', () => {
  test('дерево-литерал считается, а ЗАКОННЫЙ текст того же запроса — нет: конвертера старого текста нет', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await createIncome(user, caller, 'Отложил', '100.00', ['savings']);

    // Дерево написано РУКАМИ, мимо парсера: иначе тест доказывал бы совпадение парсера с
    // самим собой, а не то, что расчёт принимает канон.
    const ast: QueryAst = {
      filter: {
        and: [{ aspect: 'orbis/financial' }, { tag: 'savings' }],
      },
    };
    const byAst = await withIdentity(db, user, async (tx) =>
      computeGoalProgress(tx, await queryContext(tx, user, null), {
        progressSource: { query: ast, aggregate: 'sum', field: 'amount' },
        targetValue: '1000.00',
      }),
    );
    expect(byAst.current).toBe('100.00');
    expect(byAst.unsupported).toBeUndefined();

    // Та же выборка, но записанная ТЕКСТОМ грамматики — законным, разбираемым текстом.
    // Расчёт его не разбирает: неразобранный блок §А5-2 отдаёт `invalid_query`, а не
    // тихий ноль и не результат. Обе стороны границы обязаны краснеть по отдельности.
    const byText = await withIdentity(db, user, async (tx) =>
      computeGoalProgress(tx, await queryContext(tx, user, null), {
        progressSource: {
          query: { text: 'aspect=orbis/financial, tags=savings' },
          aggregate: 'sum',
          field: 'amount',
        },
        targetValue: '1000.00',
      }),
    );
    expect(byText.unsupported).toBe('invalid_query');
    expect(byText.current).toBe('0');
  });
});

describe('computeGoalProgress: изоляция владельца', () => {
  test('цель не считает чужие сущности — ни в sum, ни в count, ни через entity.get', async () => {
    const me = freshUserId();
    const other = freshUserId();
    // Чужие сущности подобраны так, чтобы ЛЮБАЯ утечка была видна в ответе: суммы и
    // счётчики отличаются на порядки. Скомпилированный SQL owner-фильтра не содержит
    // вовсе (`query/compile-ast.ts`, §инварианты) — изоляцию целиком даёт identity транзакции
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
    await createIncome(other, callerFor(other), 'Чужой доход', '999999.00', ['savings']);
    await createIncome(other, callerFor(other), 'Ещё чужой', '888888.00', ['savings']);
    await createIncome(me, callerFor(me), 'Мой доход', '100.00', ['savings']);

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

    // Тот же путь, но через боевое чтение целиком
    const goal = await createGoal(me, {
      title: 'Накопить',
      progress_source: { ...source, aggregate: 'sum', field: 'amount' },
      target_value: '1000.00',
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
    // Лог проверяется ЗДЕСЬ, а не отдельным тестом, потому что оба места, дающие
    // `invalid_query`, дают его с разным диагнозом (грамматика vs компиляция), и второе
    // достижимо только вне контекста сущности — то есть мимо entity.get.
    //
    // Уникальный `this` — чтобы ассерты не зависели от ПОРЯДКА тестов: дроссель гасит
    // повтор по ключу «место + диагноз + цель», и с общим `null` любой отказ того же
    // места, добавленный выше по файлу, задавил бы эти строки. Для грамматической ветки
    // контекст безразличен (queryContext его в БД не ищет, компиляция сюда не доходит).
    const [broken, brokenLog] = await captureErrors(() =>
      progressOf(
        user,
        {
          progress_source: { query: 'aspect=orbis/financial, %%%', aggregate: 'count' },
          target_value: '10',
        },
        crypto.randomUUID(),
      ),
    );
    expect(broken.unsupported).toBe('invalid_query');
    expect(broken.current).toBe('0');
    expect(
      brokenLog.some((l) => l.includes('invalid_query') && l.includes('неразобранный запрос')),
    ).toBe(true);

    // `this` вне контекста сущности — структурная ошибка компиляции, тоже мягкая.
    // Здесь `this` ОБЯЗАН остаться NULL: он и есть предмет проверки. Порядок тестов этой
    // строке не страшен — ключ разводит диагноз, а такой запрос в файле один.
    const [noThis, noThisLog] = await captureErrors(() =>
      progressOf(user, {
        progress_source: { query: 'children_of=this', aggregate: 'count' },
        target_value: '10',
      }),
    );
    expect(noThis.unsupported).toBe('invalid_query');
    expect(
      noThisLog.some((l) => l.includes('invalid_query') && l.includes('не скомпилировался')),
    ).toBe(true);
  });
});

describe('computeGoalProgress: отказ САМОГО SQL не роняет чтение', () => {
  test('нечисловое значение в числовом поле — compute_failed, транзакция жива', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const row = await createIncome(user, caller, 'Взнос', '10.00', ['drift']);
    // Рассинхрон реестра и данных: реестр считает orbis/amount числом, а в JSONB текст.
    // Через executor такое не пройдёт (ajv), поэтому пишем админ-DSN мимо него —
    // ровно как это выглядело бы после ручной правки или дрейфа определения свойства.
    // Портится `props` (НОВАЯ форма хранения, §А1-1): именно её читает компилятор канона,
    // и порча старой карты после Задачи 9b на SQL уже не влияет вовсе.
    const admin = adminDb();
    try {
      await admin.db.execute(
        sql`UPDATE entities SET props = jsonb_set(props, '{orbis/amount}', '"не число"') WHERE id = ${row.id}`,
      );
    } finally {
      await admin.client.end();
    }

    const goal: GoalFixture = {
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
      await computeGoalProgress(tx, cctx, toGoalSource(goal, cctx));
      const rows = await tx.execute(sql`SELECT count(*)::text AS n FROM entities`);
      return (rows[0] as { n: string }).n;
    });
    // Две строки владельца: сам взнос и категория-цель его ссылки (обстановка §А6-1).
    // Проверяется тут не число, а то, что запрос ПОСЛЕ упавшего вообще отвечает.
    expect(stillReadable).toBe('2');
  });

  test('NaN на выходе агрегата — тоже compute_failed, и ловит его ДРУГОЙ catch', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const row = await createIncome(user, caller, 'Взнос', '10.00', ['nan']);
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
        sql`UPDATE entities SET props = jsonb_set(props, '{orbis/amount}', '"NaN"') WHERE id = ${row.id}`,
      );
    } finally {
      await admin.client.end();
    }

    // Уникальный `this` обязателен для НЕГАТИВНОГО ассерта ниже: ключ «aggregate + sum»
    // с общим `null` уже израсходован предыдущим тестом, и строка «агрегат sum не
    // выполнился» была бы задавлена дросселем, даже если бы тот catch сработал — то есть
    // ассерт проверял бы дроссель вместо разделения catch'ей. Свой id делает его честным.
    const [p, logged] = await captureErrors(() =>
      progressOf(
        user,
        {
          progress_source: {
            query: 'aspect=orbis/financial, tags=nan',
            aggregate: 'sum',
            field: 'amount',
          },
          target_value: '100',
        },
        crypto.randomUUID(),
      ),
    );
    expect(p.unsupported).toBe('compute_failed');
    expect(p.current).toBe('0');
    // Лог — «долевой», а не «агрегат не выполнился»: диагноз называет настоящую причину
    expect(logged.some((l) => l.includes('доля не посчиталась'))).toBe(true);
    expect(logged.some((l) => l.includes('агрегат sum не выполнился'))).toBe(false);
  });
});

describe('entity.get: прогресс приезжает с целью и только с ней', () => {
  test('снятый аспект цели гасит полосу, хотя источник и цель остались в props (Р9)', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await createIncome(user, caller, 'Отложил', '75000.00', ['savings']);
    const goal = await createGoal(user, {
      title: 'Цель, с которой снимут аспект',
      progress_source: {
        query: 'aspect=orbis/financial, direction=income, tags=savings',
        aggregate: 'sum',
        field: 'amount',
      },
      target_value: '300000.00',
    });
    expect((await caller.entity.get({ id: goal.id })).goalProgress).toEqual({
      current: '75000.00',
      target: '300000.00',
    });

    // Снятие аспекта значений НЕ трогает (Р9): `orbis/progress_source` и
    // `orbis/target_value` остаются в `props`. Старая карта теряла их вместе с аспектом —
    // и читатель без признака носителя рисовал бы полосу у записи, целью быть переставшей.
    const r = await execute(db, {
      actorUserId: user,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        { tool: 'entity_update', input: { id: goal.id, aspects: { detach: ['orbis/goal'] } } },
      ],
    });
    if (!r.ok) throw new Error(`аспект не снят: ${r.error.code} ${r.error.message}`);

    const after = await caller.entity.get({ id: goal.id });
    expect(after.goalProgress).toBeUndefined();
    expect(after.entity.props['orbis/progress_source']).toBeDefined();
    expect(after.entity.props['orbis/target_value']).toBe('300000.00');
  });

  test('цель получает goalProgress, обычная сущность — нет', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await createIncome(user, caller, 'Отложил', '75000.00', ['savings']);
    const goal = await createGoal(user, {
      title: 'Накопить 300 000 ₽',
      tags: ['goal'],
      progress_source: {
        query: 'aspect=orbis/financial, direction=income, tags=savings',
        aggregate: 'sum',
        field: 'amount',
      },
      target_value: '300000.00',
      unit: '₽',
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
    const goal = await createGoal(user, {
      title: 'Прочитать 24 книги',
      tags: ['goal'],
      progress_source: { query: 'children_of=this, status=done', aggregate: 'count' },
      target_value: '24',
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
        role: 'subitem',
      });
    }

    const got = await caller.entity.get({ id: goal.id });
    expect(got.goalProgress?.current).toBe('2');
  });

  test('испорченный источник прогресса не мешает открыть цель', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const goal = await createGoal(user, {
      title: 'Цель с мусорным запросом',
      tags: ['goal'],
      progress_source: { query: '%%% не запрос', aggregate: 'count' },
      target_value: '10',
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
    const goal = await createGoal(user, {
      title: 'Цель',
      progress_source: { query: 'aspect=orbis/note', aggregate: 'count' },
      target_value: '10',
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

      // Реестр читается ТОЛЬКО расчётом прогресса — его отсутствие и есть доказательство,
      // что ветка по аспекту не пускает обычную сущность в расчёт.
      expect(plainQueries.some((q) => q.includes('aspect_definitions'))).toBe(false);
      expect(goalQueries.some((q) => q.includes('aspect_definitions'))).toBe(true);
      // Измерено: 7 запросов на обычную сущность (begin + 2 identity + сущность + связи +
      // ВЕРСИЯ РЕЕСТРА + commit) и 14 на цель (+ четыре запроса снимка реестра, + таймзона,
      // + savepoint, + агрегат).
      //
      // Было 6 и 14, и обе цифры двинулись НЕ туда, куда кажется. `registryVersion` в
      // ответе (§А10-1, Задача 13a) стоит обычной сущности одного запроса: клиентский кеш
      // подписей и каталога полей инвалидируется несовпадением версии, и другого повода
      // перечитать реестр у web нет. Читается она ОДНИМ точечным SELECT'ом
      // (`loadRegistryVersions` — две подзапроса по первичному ключу), а не полным снимком:
      // иначе открытие каждой записи стоило бы ещё четырёх. У ЦЕЛИ число не изменилось —
      // тот же `loadRegistryVersions` заменил внутри `loadRegistry` два отдельных запроса
      // версий одним, и снимок подешевел ровно на столько, сколько стоила новая строка.
      // Раньше было 10: снимок реестра §А10-1 стоит четырёх запросов там, где старый
      // каталог полей стоил одного (`SELECT id, schema FROM aspect_definitions`), — это
      // цена перехода на реестр, названная числом, а не спрятанная. Процессный кеш по ключу
      // `(owner, version)` заводит Задача 14; когда он появится, оба числа здесь упадут, и
      // упасть они обязаны ЗАМЕТНО — на то тест и считает запросы.
      expect(plainQueries.length).toBe(7);
      expect(goalQueries.length).toBe(14);
    } finally {
      await counted.end();
    }
  });
});

describe('логи отказа: конфигурационный отказ не молчит и не льётся потоком', () => {
  /** Цель с заданным источником: важен id — именно он попадает в лог и в ключ дросселя. */
  function goalWith(user: string, title: string, source: SourceFixture) {
    return createGoal(user, { title, progress_source: source, target_value: '100' });
  }

  test('повторный отказ той же цели по той же причине логируется один раз', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const goal = await goalWith(user, 'Цель с опечаткой в поле', {
      query: 'aspect=orbis/financial, direction=income',
      aggregate: 'sum',
      field: 'amountt',
    });

    // Сломанная цель читается СНОВА И СНОВА: она открыта в UI, её чинят, её листают.
    // Без дросселя каждый entity.get писал бы строку, и лог сервера становился бы
    // шумом ровно там, где нужен сигнал.
    const [, logged] = await captureErrors(async () => {
      await caller.entity.get({ id: goal.id });
      await caller.entity.get({ id: goal.id });
      await caller.entity.get({ id: goal.id });
    });

    expect(logged.filter((l) => l.includes(goal.id)).length).toBe(1);
  });

  test('новая беда той же цели в том же месте печатается, а не гасится устаревшей', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const goal = await goalWith(user, 'Цель, которую чинят', {
      query: 'aspect=orbis/financial, direction=income',
      aggregate: 'sum',
      field: 'amountt',
    });

    const [, first] = await captureErrors(() => caller.entity.get({ id: goal.id }));
    expect(first.filter((l) => l.includes(goal.id)).map((l) => l.includes('amountt'))).toEqual([
      true,
    ]);

    // Цикл починки: владелец правит опечатку и промахивается СНОВА — тем же местом
    // отказа (`invalid_field`), но по другой причине (поле нечисловое). Если бы ключ
    // дедупа знал только место и цель, эта строка не напечаталась бы вовсе, а на сотом
    // чтении перепечаталась бы старая — про уже исправленное `amountt`. Лог с устаревшим
    // диагнозом хуже пустого: по нему чинят не то.
    // Правка — тоже НОВОЙ формой (`props` по id свойства): старая карта положила бы в
    // источник неразобранный блок `{text}`, и «новая беда» оказалась бы не той, которую
    // проверяет тест (`invalid_field` выродился бы в `invalid_query`).
    await updateGoalSource(user, goal.id, {
      query: 'aspect=orbis/financial, direction=income',
      aggregate: 'sum',
      field: 'counterparty',
    });

    const [got, second] = await captureErrors(() => caller.entity.get({ id: goal.id }));
    expect(got.goalProgress?.unsupported).toBe('invalid_field');
    const mine = second.filter((l) => l.includes(goal.id));
    expect(mine.length).toBe(1);
    expect(mine[0]).toContain('counterparty');
    expect(mine[0]).not.toContain('amountt');
  });

  test('конфигурационный отказ цели не молчит: ярлык и id цели есть в логе', async () => {
    const user = freshUserId();
    const caller = callerFor(user);

    // Самая вероятная жалоба владельца — «прогресс не считается, а почему, не понять».
    // До этого теста три ярлыка из четырёх не оставляли на сервере ни строки, и разбор
    // жалобы начинался с чтения аспекта в базе руками.
    const cases: Array<[GoalProgressUnsupported, SourceFixture]> = [
      [
        'array_field',
        { query: 'aspect=orbis/category', aggregate: 'sum', field: 'aliases[].weight' },
      ],
      ['invalid_query', { query: '%%% не запрос', aggregate: 'count' }],
      [
        'invalid_field',
        { query: 'aspect=orbis/financial, direction=income', aggregate: 'sum', field: 'amountt' },
      ],
    ];

    for (const [label, source] of cases) {
      const goal = await goalWith(user, `Цель: ${label}`, source);
      const [got, logged] = await captureErrors(() => caller.entity.get({ id: goal.id }));
      expect(got.goalProgress?.unsupported).toBe(label);
      const mine = logged.filter((l) => l.includes(goal.id));
      expect(mine.length).toBe(1);
      expect(mine[0]).toContain(label);
    }
  });

  test('аспект, не прошедший свою схему, тоже не молчит — хотя ярлыка у него нет', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const goal = await goalWith(user, 'Цель с дрейфом схемы', {
      query: 'aspect=orbis/financial',
      aggregate: 'count',
    });
    // Дрейф реестра/правка мимо executor'а: target_value '0' схему не проходит (строго > 0).
    // Наружу это уезжает не ярлыком, а ОТСУТСТВИЕМ прогресса — в UI цель просто «без
    // полосы». Молчащим этот выход был громче всех прочих: отличить его от «аспекта нет»
    // на сервере было нечем.
    const admin = adminDb();
    try {
      await admin.db.execute(
        sql`UPDATE entities SET props = jsonb_set(props, '{orbis/target_value}', '"0"') WHERE id = ${goal.id}`,
      );
    } finally {
      await admin.client.end();
    }

    const [got, logged] = await captureErrors(() => caller.entity.get({ id: goal.id }));
    expect(got.goalProgress).toBeUndefined();
    expect(got.entity.title).toBe('Цель с дрейфом схемы');
    expect(logged.filter((l) => l.includes(goal.id)).length).toBe(1);
  });
});
