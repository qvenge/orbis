// apps/server/src/routers/entity-suggest.test.ts
// Задача 6: entity.suggest (префиксный поиск для `/`-меню и @-упоминаний) и
// entity.resolveRefs (заголовки чипов ПАЧКОЙ). Обе процедуры — чтение под withIdentity
// (RLS, §4.10), входы ТОЛЬКО tRPC: в реестре тулов (§9.2) их нет и не должно быть.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

/** Caller от лица владельца: ctx как в бою — actorUserId + db (§9.1). */
function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}
type Caller = ReturnType<typeof callerFor>;

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

/** Ошибка вызова процедуры — TRPCError с внятным падением при успехе. */
async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

/**
 * Сид через боевой путь записи (executor), а не INSERT'ом: заголовок и аспекты обязаны
 * пройти ту же нормализацию, что в бою. Архивность — ВТОРЫМ шагом: у entityCreateInput
 * поля `archived` нет (проверено — .strict() отклоняет).
 */
async function seedEntity(
  caller: Caller,
  over: {
    title: string;
    emoji?: string;
    archived?: boolean;
    aspects?: Record<string, Record<string, unknown>>;
  },
) {
  const created = await caller.entity.create({
    input: {
      title: over.title,
      tags: [],
      ...(over.emoji !== undefined && { emoji: over.emoji }),
      ...(over.aspects !== undefined && { aspects: over.aspects }),
    },
    source: 'fast_path',
  });
  if (over.archived) await caller.entity.update({ id: created.id, archived: true });
  return created;
}

const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();

describe('entity.suggest (§6.1 не трогаем: своя процедура для префиксов)', () => {
  test('находит по ПРЕФИКСУ то, чего `search=` не находит принципиально', async () => {
    // Ради этой разницы процедура и заведена: `search=` — plainto_tsquery('simple'),
    // то есть совпадение по ЦЕЛОМУ слову. «куп» не находило «Купить кроссовки», и пикер
    // связей честно извинялся подсказкой «введите слово целиком».
    const caller = callerFor(freshUserId());
    await seedEntity(caller, { title: 'Купить кроссовки' });

    // Контроль: `search=` жив и по целому слову находит — иначе тест был бы зелёным
    // по ложной причине (пустой FTS вместо доказанной разницы семантик).
    expect(titles(await caller.entity.query({ query: 'search=Купить, limit=10' }))).toEqual([
      'Купить кроссовки',
    ]);
    expect(await caller.entity.query({ query: 'search=куп, limit=10' })).toEqual([]);

    expect(titles(await caller.entity.suggest({ prefix: 'куп' }))).toEqual(['Купить кроссовки']);
  });

  test('регистр не важен', async () => {
    const caller = callerFor(freshUserId());
    await seedEntity(caller, { title: 'Купить кроссовки' });
    expect(titles(await caller.entity.suggest({ prefix: 'КУП' }))).toEqual(['Купить кроссовки']);
  });

  test('находит по ВХОЖДЕНИЮ, а не только с начала заголовка', async () => {
    // Якорь на начало заголовка отнимал бы находимость, которую `search=` давал: «Отчёт за
    // квартал» набором «квартал» находиться обязан. Платы за снятие якоря нет — индекса под
    // этот запрос всё равно не существует (см. комментарий у процедуры), а при Seq Scan
    // '%куп%' стоит ровно столько же, сколько 'куп%'.
    const caller = callerFor(freshUserId());
    await seedEntity(caller, { title: 'Отчёт за квартал' });

    // Контроль: прежний путь это находил — значит речь о СОХРАНЕНИИ находимости, а не о
    // новой возможности. Если бы `search=` тут промахнулся, тест не доказывал бы регресса.
    expect(titles(await caller.entity.query({ query: 'search=квартал, limit=10' }))).toEqual([
      'Отчёт за квартал',
    ]);
    expect(titles(await caller.entity.suggest({ prefix: 'квартал' }))).toEqual([
      'Отчёт за квартал',
    ]);
    // И по префиксу второго слова — того, чего `search=` как раз не умеет
    expect(titles(await caller.entity.suggest({ prefix: 'кварт' }))).toEqual(['Отчёт за квартал']);
  });

  test('совпадения С НАЧАЛА заголовка идут выше вхождений в середине — даже если те свежее', async () => {
    // Релевантность важнее свежести: набирая «куп», человек ищет «Купить…», а не заметку,
    // где это слово встретилось в середине. Порядок создания здесь ПРОТИВ ожидаемого
    // порядка выдачи — иначе тест прошёл бы и на одном updated_at DESC.
    const caller = callerFor(freshUserId());
    const fromStart = await seedEntity(caller, { title: 'Купить кроссовки' });
    const inMiddle = await seedEntity(caller, { title: 'Не забыть купить' });
    expect((await caller.entity.suggest({ prefix: 'куп' })).map((e) => e.id)).toEqual([
      fromStart.id,
      inMiddle.id,
    ]);
  });

  test('архивные не предлагаются', async () => {
    const caller = callerFor(freshUserId());
    const live = await seedEntity(caller, { title: 'Купить живое' });
    await seedEntity(caller, { title: 'Купить старое', archived: true });
    const got = await caller.entity.suggest({ prefix: 'куп' });
    // Не просто «не пусто»: архивная ушла, живая осталась — иначе фильтр по archived
    // мог бы вырезать вообще всё, и тест был бы зелёным по ложной причине.
    expect(got.map((e) => e.id)).toEqual([live.id]);
  });

  test('ЗАКРЫТЫЕ задачи остаются в выдаче (решение v2), архивные — нет', async () => {
    const caller = callerFor(freshUserId());
    await seedEntity(caller, {
      title: 'Купить хлеб',
      aspects: { 'orbis/task': { status: 'done' } },
    });
    const got = await caller.entity.suggest({ prefix: 'куп' });
    expect(titles(got)).toEqual(['Купить хлеб']);
    expect(got[0]?.status).toBe('done');
  });

  test('статус задачи приезжает ПЛОСКИМ полем, emoji и archived — тоже', async () => {
    const caller = callerFor(freshUserId());
    const e = await seedEntity(caller, {
      title: 'Купить молоко',
      emoji: '🥛',
      aspects: { 'orbis/task': { status: 'inbox' } },
    });
    expect(await caller.entity.suggest({ prefix: 'куп' })).toEqual([
      { id: e.id, title: 'Купить молоко', emoji: '🥛', status: 'inbox', archived: false },
    ]);
  });

  test('сущность без task-аспекта отдаёт status = null, emoji = null', async () => {
    const caller = callerFor(freshUserId());
    const e = await seedEntity(caller, { title: 'Купить без аспекта' });
    expect(await caller.entity.suggest({ prefix: 'куп' })).toEqual([
      { id: e.id, title: 'Купить без аспекта', emoji: null, status: null, archived: false },
    ]);
  });

  test('спецсимволы шаблона LIKE экранированы: «%», «_» и «\\» ищут себя, а не что угодно', async () => {
    const caller = callerFor(freshUserId());
    await seedEntity(caller, { title: 'Купить кроссовки' });
    const pct = await seedEntity(caller, { title: '%скидка' });
    const under = await seedEntity(caller, { title: '_черновик' });
    const back = await seedEntity(caller, { title: '\\сеть' });

    // Без экранирования «%» дал бы ВСЕ строки, «_» — все (любой первый символ),
    // а «\» съел бы следующий символ шаблона и не нашёл бы ничего.
    expect((await caller.entity.suggest({ prefix: '%' })).map((e) => e.id)).toEqual([pct.id]);
    expect((await caller.entity.suggest({ prefix: '_' })).map((e) => e.id)).toEqual([under.id]);
    expect((await caller.entity.suggest({ prefix: '\\' })).map((e) => e.id)).toEqual([back.id]);
  });

  test('чужие сущности не предлагаются (RLS §4.10)', async () => {
    const owner = callerFor(freshUserId());
    const e = await seedEntity(owner, { title: 'Купить чужое' });
    expect(await callerFor(freshUserId()).entity.suggest({ prefix: 'куп' })).toEqual([]);
    // Контроль: пусто именно у ЧУЖОГО. Без этой строки тест был бы зелёным и от вовсе
    // сломанного suggest — классика ложного зелёного.
    expect((await owner.entity.suggest({ prefix: 'куп' })).map((r) => r.id)).toEqual([e.id]);
  });

  test('порядок — по updated_at DESC: свежее наверху', async () => {
    // `/`-меню показывает 10 из многих: без порядка «десять любых» зависели бы от плана.
    const caller = callerFor(freshUserId());
    const first = await seedEntity(caller, { title: 'Купить первое' });
    const second = await seedEntity(caller, { title: 'Купить второе' });
    expect((await caller.entity.suggest({ prefix: 'куп' })).map((r) => r.id)).toEqual([
      second.id,
      first.id,
    ]);

    // Тронули старую — она поднялась наверх (а не просто «порядок создания случайно совпал»)
    await caller.entity.update({ id: first.id, title: 'Купить первое ещё раз' });
    expect((await caller.entity.suggest({ prefix: 'куп' })).map((r) => r.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  test('одинаковый updated_at не делает порядок случайным: тай-брейк по id (M4)', async () => {
    // `updated_at` по умолчанию now() — время НАЧАЛА транзакции, поэтому всё, созданное
    // одним batch_execute, получает ОДИН штамп. Без последнего ключа порядок таких строк
    // определял бы план, и выдача «десяти из многих» плавала бы между запросами.
    const user = freshUserId();
    const caller = callerFor(user);
    const made: string[] = [];
    for (let i = 0; i < 8; i++) made.push((await seedEntity(caller, { title: `Купить ${i}` })).id);

    // Ровно та ситуация, которую создаёт batch_execute, — но детерминированно.
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.execute(
        sql`UPDATE entities SET updated_at = '2026-08-14T00:00:00Z' WHERE owner_id = ${user}::uuid`,
      );
    } finally {
      await adminClient.end();
    }

    // id — UUIDv7 (schema.ts:27), то есть DESC читается как «свежее выше»; прецедент того же
    // тай-брейка — llm/context.ts:126. Порядок создания здесь ВОЗРАСТАЮЩИЙ, ожидаемый —
    // строго обратный, так что физический порядок строк тест не спасёт.
    expect((await caller.entity.suggest({ prefix: 'куп', limit: 8 })).map((r) => r.id)).toEqual(
      [...made].sort().reverse(),
    );
  });

  test('limit: по умолчанию 10, переданный уважается, свыше 20 — BAD_REQUEST', async () => {
    const caller = callerFor(freshUserId());
    for (let i = 0; i < 12; i++) await seedEntity(caller, { title: `Купить ${i}` });
    expect((await caller.entity.suggest({ prefix: 'куп' })).length).toBe(10);
    expect((await caller.entity.suggest({ prefix: 'куп', limit: 3 })).length).toBe(3);
    const e = await trpcError(caller.entity.suggest({ prefix: 'куп', limit: 21 }));
    expect(e.code).toBe('BAD_REQUEST');
  });

  test('пустой prefix отклоняется на входе → BAD_REQUEST', async () => {
    const e = await trpcError(callerFor(freshUserId()).entity.suggest({ prefix: '' }));
    expect(e.code).toBe('BAD_REQUEST');
  });
});

describe('entity.resolveRefs (заголовки чипов одним запросом)', () => {
  test('отдаёт заголовки пачкой', async () => {
    const caller = callerFor(freshUserId());
    const a = await seedEntity(caller, { title: 'Первая' });
    const b = await seedEntity(caller, { title: 'Вторая' });
    expect(titles(await caller.entity.resolveRefs({ ids: [a.id, b.id] }))).toEqual([
      'Вторая',
      'Первая',
    ]);
  });

  test('несуществующий id не роняет запрос и просто отсутствует в ответе', async () => {
    const caller = callerFor(freshUserId());
    const a = await seedEntity(caller, { title: 'Первая' });
    const got = await caller.entity.resolveRefs({
      ids: [a.id, '11111111-1111-4111-8111-111111111111'],
    });
    expect(got.map((e) => e.id)).toEqual([a.id]);
  });

  test('101 id не роняет запрос (лимит 200: тело со 101 ссылкой валило весь резолв)', async () => {
    const caller = callerFor(freshUserId());
    const a = await seedEntity(caller, { title: 'Единственная живая' });
    const ids = [a.id, ...Array.from({ length: 100 }, () => crypto.randomUUID())];
    expect(ids.length).toBe(101);
    const got = await caller.entity.resolveRefs({ ids });
    expect(got.map((e) => e.id)).toEqual([a.id]);
  });

  test('201 id отклоняется на входе → BAD_REQUEST (а не таймаутом в БД)', async () => {
    const ids = Array.from({ length: 201 }, () => crypto.randomUUID());
    const e = await trpcError(callerFor(freshUserId()).entity.resolveRefs({ ids }));
    expect(e.code).toBe('BAD_REQUEST');
  });

  test('пустой список отклоняется на входе → BAD_REQUEST', async () => {
    const e = await trpcError(callerFor(freshUserId()).entity.resolveRefs({ ids: [] }));
    expect(e.code).toBe('BAD_REQUEST');
  });

  test('АРХИВНАЯ резолвится и помечена archived: чип обязан показать заголовок', async () => {
    // Ссылка на архивную сущность в теле остаётся ссылкой: спрятать заголовок значило бы
    // показать «11111111…» вместо названия. Признак отдаём — рисовать решает чип.
    const caller = callerFor(freshUserId());
    const a = await seedEntity(caller, { title: 'Архивная цель', archived: true });
    expect(await caller.entity.resolveRefs({ ids: [a.id] })).toEqual([
      { id: a.id, title: 'Архивная цель', emoji: null, status: null, archived: true },
    ]);
  });

  test('статус задачи — плоским полем (чип зачёркивает done)', async () => {
    const caller = callerFor(freshUserId());
    const a = await seedEntity(caller, {
      title: 'Сделанная',
      aspects: { 'orbis/task': { status: 'done' } },
    });
    expect((await caller.entity.resolveRefs({ ids: [a.id] }))[0]?.status).toBe('done');
  });

  test('чужие сущности не резолвятся (RLS §4.10)', async () => {
    const owner = callerFor(freshUserId());
    const a = await seedEntity(owner, { title: 'Чужая цель' });
    expect(await callerFor(freshUserId()).entity.resolveRefs({ ids: [a.id] })).toEqual([]);
    // Контроль: тот же id владельцем резолвится — иначе пустота ничего не доказывала бы.
    expect((await owner.entity.resolveRefs({ ids: [a.id] })).map((r) => r.id)).toEqual([a.id]);
  });

  test('не-uuid отклоняется на входе → BAD_REQUEST', async () => {
    const e = await trpcError(callerFor(freshUserId()).entity.resolveRefs({ ids: ['не-uuid'] }));
    expect(e.code).toBe('BAD_REQUEST');
  });
});
