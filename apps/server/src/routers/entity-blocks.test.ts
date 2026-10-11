// apps/server/src/routers/entity-blocks.test.ts
// `entity.blocks` (срез 1а, спека §6.3): пачка данных блоков страницы одним вызовом. Против живой
// БД через createCallerFactory — как в бою: RLS, материализация повторов, SAVEPOINT на блок.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  addDays,
  BLOCKS_BATCH_CAP,
  type BlockResult,
  type GraphId,
  newId,
  recurringInstanceId,
} from '@orbis/shared';
import { EMPTY_QUERY_MESSAGE } from '@orbis/shared/doc/placement';
import { TRPCError } from '@trpc/server';
import {
  appDb,
  freshGraph,
  personal,
  rawEntityRow,
  requireEnv,
  seedRefTargetRows,
  truncateAll,
} from '../../test/helpers';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { DEFAULT_TIMEZONE, todayInTimeZone } from '../query/context';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { EXECUTION_FAILED_MESSAGE } from './entity-blocks';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

function callerFor(user: GraphId, withDb: Db = db) {
  return createCaller({
    identity: personal(user),
    actorKind: 'owner',
    db: withDb,
    clientVersion: null,
  });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

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
 * Тонкая обёртка `db`, считающая ВЕРХНИЕ транзакции (`db.transaction`). SAVEPOINT блока идёт
 * через `tx.transaction` — мимо обёртки, так что счёт — ровно число транзакций пула.
 */
function countingDb(): { db: Db; transactions: () => number } {
  let n = 0;
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (...args: Parameters<Db['transaction']>) => {
          n += 1;
          return target.transaction(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: wrapped, transactions: () => n };
}

/** Результат блока, сужённый к ожидаемому виду: падение назовёт, что пришло на деле. */
function asKind<K extends Extract<BlockResult, { ok: true }>['kind']>(
  r: BlockResult | undefined,
  kind: K,
): Extract<BlockResult, { kind: K }> {
  if (r === undefined || !r.ok || r.kind !== kind) {
    throw new Error(`ожидался блок вида ${kind}, получено ${JSON.stringify(r)}`);
  }
  return r as Extract<BlockResult, { kind: K }>;
}

function asError(r: BlockResult | undefined): { code: string; message: string; position?: number } {
  if (r === undefined || r.ok)
    throw new Error(`ожидался отказ блока, получено ${JSON.stringify(r)}`);
  return r.error;
}

/** Категория — обстановка ссылки `orbis/finance_category`, а не предмет проверки. */
async function ensureCategory(user: GraphId): Promise<string> {
  const id = newId();
  await seedRefTargetRows(user, [{ id, aspect: 'orbis/category' }]);
  return id;
}

/**
 * Мир блоков: 7 задач (3 из них — дети записи-проекта), 2 финансовые записи в рублях. Валюта —
 * явно: умолчание `default_currency` каталог подставляет только конверту, не транзакции.
 * Возвращает id проекта и его детей.
 */
async function seedWorld(user: GraphId): Promise<{ projectId: string; childIds: string[] }> {
  const caller = callerFor(user);
  const project = await caller.entity.create({
    input: { title: 'Проект', tags: [] },
    source: 'ui',
  });
  const taskIds: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const t = await caller.entity.create({
      input: {
        title: `Задача ${i}`,
        tags: [],
        props: { 'orbis/task_status': 'inbox' },
        aspects: ['orbis/task'],
      },
      source: 'ui',
    });
    taskIds.push(t.id);
  }
  const childIds = taskIds.slice(0, 3);
  for (const id of childIds) {
    await caller.relation.create({ source_id: project.id, target_id: id, role: 'subitem' });
  }
  const category = await ensureCategory(user);
  for (const amount of ['100.00', '250.50']) {
    await caller.entity.create({
      input: {
        title: `Расход ${amount}`,
        tags: [],
        props: {
          'orbis/amount': amount,
          'orbis/direction': 'expense',
          'orbis/currency': 'RUB',
          'orbis/finance_category': category,
          'orbis/occurred_on': '2026-09-01',
        },
        aspects: ['orbis/financial'],
      },
      source: 'ui',
    });
  }
  return { projectId: project.id, childIds };
}

describe('entity.blocks — пачка данных блоков (§6.3)', () => {
  test('три блока — один вызов, три результата: строки с «ещё N», дети проекта, сумма по валютам', async () => {
    const user = await freshGraph();
    const { projectId, childIds } = await seedWorld(user);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'tasks', text: 'aspect=orbis/task, limit=5' },
        { key: 'children', text: 'children_of=this', thisEntityId: projectId },
        {
          key: 'spent',
          text: 'aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount',
        },
      ],
    });
    expect(Object.keys(results).sort()).toEqual(['children', 'spent', 'tasks']);

    const tasks = asKind(results.tasks, 'rows');
    expect(tasks.rows).toHaveLength(5);
    expect(tasks.more).toBe(2);

    const children = asKind(results.children, 'rows');
    expect(children.rows.map((r) => r.id).sort()).toEqual([...childIds].sort());
    expect(children.more).toBe(0);

    const spent = asKind(results.spent, 'sum');
    expect(spent).toEqual({
      ok: true,
      kind: 'sum',
      count: 2,
      sums: [{ currency: 'RUB', sum: '350.50', count: 2 }],
    });
  });

  test('limit блока важнее limit текста: «ещё N» раскрывается подъёмом limit', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'raised', text: 'aspect=orbis/task, limit=5', limit: 6 },
        { key: 'all', text: 'aspect=orbis/task, limit=5', limit: 7 },
      ],
    });
    const raised = asKind(results.raised, 'rows');
    expect(raised.rows).toHaveLength(6);
    expect(raised.more).toBe(1);
    const all = asKind(results.all, 'rows');
    expect(all.rows).toHaveLength(7);
    expect(all.more).toBe(0);
  });

  test('плитки count и latest; сумма по пустой выборке — ни одной суммы', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'n', text: 'aspect=orbis/task, display=tile, aggregate=count' },
        {
          key: 'last',
          text: 'aspect=orbis/financial, display=tile, aggregate=latest:orbis/amount',
        },
        {
          key: 'none',
          text: 'aspect=orbis/financial, orbis/direction=income, display=tile, aggregate=sum:orbis/amount',
        },
      ],
    });
    expect(results.n).toEqual({ ok: true, kind: 'count', count: 7 });
    // Последняя по updated_at — вторая созданная запись.
    expect(results.last).toEqual({ ok: true, kind: 'latest', value: '250.50', currency: 'RUB' });
    expect(results.none).toEqual({ ok: true, kind: 'sum', count: 0, sums: [] });
  });

  test('сумма по валютам раздельно; запись без валюты — в валюте владельца (дефект 1а: терялась, спека 1в §3.6)', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    const category = await ensureCategory(user);
    const caller = callerFor(user);
    for (const currency of ['USD', undefined]) {
      await caller.entity.create({
        input: {
          title: `Расход ${currency ?? 'без валюты'}`,
          tags: [],
          props: {
            'orbis/amount': '1.00',
            'orbis/direction': 'expense',
            ...(currency === undefined ? {} : { 'orbis/currency': currency }),
            'orbis/finance_category': category,
            'orbis/occurred_on': '2026-09-02',
          },
          aspects: ['orbis/financial'],
        },
        source: 'ui',
      });
    }
    const { results } = await caller.entity.blocks({
      blocks: [
        { key: 'mixed', text: 'aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount' },
      ],
    });
    expect(results.mixed).toEqual({
      ok: true,
      kind: 'sum',
      count: 4,
      sums: [
        { currency: 'RUB', sum: '351.50', count: 3 },
        { currency: 'USD', sum: '1.00', count: 1 },
      ],
    });
  });

  test('одна транзакция исполнения: без окна материализации — ровно одна; с окнами — как у одного entity.query', async () => {
    const user = await freshGraph();
    await seedWorld(user);

    const plain = countingDb();
    const { results: plainResults } = await callerFor(user, plain.db).entity.blocks({
      blocks: [
        { key: 'a', text: 'aspect=orbis/task, limit=5' },
        { key: 'b', text: 'aspect=orbis/financial, display=tile, aggregate=count' },
        { key: 'c', text: 'aspect=orbis/note' },
      ],
    });
    expect(Object.values(plainResults).every((r) => r.ok)).toBe(true);
    expect(plain.transactions()).toBe(1);

    // Эталон — один `entity.query` с окном: фаза 1, материализация, фаза исполнения.
    const single = countingDb();
    await callerFor(user, single.db).entity.query({
      query: 'aspect=orbis/task, orbis/due_date=today',
    });
    expect(single.transactions()).toBeGreaterThanOrEqual(3);

    // Три блока с РАЗНЫМИ окнами и один без окна: материализация одна (по объединению окон),
    // фаза исполнения одна — счёт транзакций тот же, что у одиночного запроса.
    const windowed = countingDb();
    const { results } = await callerFor(user, windowed.db).entity.blocks({
      blocks: [
        { key: 'today', text: 'aspect=orbis/task, orbis/due_date=today' },
        { key: 'week', text: 'aspect=orbis/task, orbis/due_date=next_7d' },
        { key: 'later', text: 'aspect=orbis/task, orbis/due_date=after_7d' },
        { key: 'plain', text: 'aspect=orbis/task, limit=5' },
      ],
    });
    expect(Object.values(results).every((r) => r.ok)).toBe(true);
    expect(windowed.transactions()).toBe(single.transactions());
  });

  test('одна материализация по ОБЪЕДИНЕНИЮ окон: экземпляр повтора из дальнего окна есть в строках своего блока', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    // Граф без настроек — таймзона по умолчанию; «сегодня» сервера считается в ней же.
    const today = todayInTimeZone(DEFAULT_TIMEZONE);
    const template = await caller.entity.create({
      input: {
        title: 'Ежедневная планёрка',
        tags: [],
        props: {
          'orbis/start_at': `${today}T09:00:00+03:00`,
          'orbis/timezone': DEFAULT_TIMEZONE,
          'orbis/recurrence': { freq: 'daily', interval: 1 },
        },
        aspects: ['orbis/schedule'],
      },
      source: 'ui',
    });
    // Окна двух блоков НЕ пересекаются: [сегодня] и [сегодня+8 … горизонт]. Материализация по
    // одному первому окну оставила бы дальний блок без экземпляров.
    const { results } = await caller.entity.blocks({
      blocks: [
        { key: 'today', text: 'aspect=orbis/schedule, orbis/start_at=today' },
        { key: 'later', text: 'aspect=orbis/schedule, orbis/start_at=after_7d' },
      ],
    });
    const farInstance = recurringInstanceId(template.id, addDays(today, 10));
    expect(asKind(results.later, 'rows').rows.map((r) => r.id)).toContain(farInstance);
    const nearInstance = recurringInstanceId(template.id, today);
    expect(asKind(results.today, 'rows').rows.map((r) => r.id)).toContain(nearInstance);
  });

  test('sum по нечисловому свойству (sum:orbis/title) — отказ РАЗБОРА своего блока (TYPE с позицией), соседи целы', async () => {
    // Вход `blocks` — только текст, и разбор проверяет числовой тип агрегата сам (задача 6):
    // до компилятора (`numericRef`, отказ FIELD) такой текст не доходит, путь «дерево мимо
    // разбора» у этой ручки недостижим.
    const user = await freshGraph();
    await seedWorld(user);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'titleSum', text: 'aspect=orbis/task, display=tile, aggregate=sum:orbis/title' },
        { key: 'fine', text: 'aspect=orbis/task, display=tile, aggregate=count' },
      ],
    });
    const err = asError(results.titleSum);
    expect(err.code).toBe('TYPE');
    expect(typeof err.position).toBe('number');
    expect(results.fine).toEqual({ ok: true, kind: 'count', count: 7 });
  });

  test('ошибка разбора — отказ своего блока с кодом и позицией, без SQL; соседи целы', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'ok1', text: 'aspect=orbis/task, limit=2' },
        { key: 'bad', text: 'неизвестное=1' },
        { key: 'ok2', text: 'aspect=orbis/task, display=tile, aggregate=count' },
      ],
    });
    const err = asError(results.bad);
    expect(err.code).toBe('UNKNOWN_FIELD');
    expect(err.position).toBe(0);
    expect(err.message.length).toBeGreaterThan(0);
    expect(asKind(results.ok1, 'rows').rows).toHaveLength(2);
    expect(results.ok2).toEqual({ ok: true, kind: 'count', count: 7 });
  });

  test('ошибка ИСПОЛНЕНИЯ (кривое значение в базе) — отказ своего блока, соседи той же пачки целы (SAVEPOINT)', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    // Значение, которого исполнитель не пропустил бы: каст `::numeric` падает в самой базе.
    await withIdentity(db, personal(user), (tx) =>
      tx.insert(entities).values(
        rawEntityRow({
          graphId: user,
          id: newId(),
          title: 'Кривая сумма',
          props: { 'orbis/amount': 'не число', 'orbis/direction': 'expense' },
          aspects: ['orbis/financial'],
        }),
      ),
    );
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'before', text: 'aspect=orbis/task, limit=1' },
        { key: 'broken', text: 'aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount' },
        // Сосед ПОСЛЕ упавшего: без SAVEPOINT транзакция уже в состоянии aborted.
        { key: 'after', text: 'aspect=orbis/task, limit=3' },
      ],
    });
    const err = asError(results.broken);
    expect(err.code).toBe('EXECUTION');
    // Текст базы наружу не идёт: сообщение — одна константа, без следов каста и драйвера.
    expect(err.message).toBe(EXECUTION_FAILED_MESSAGE);
    expect(err.message).not.toContain('numeric');
    expect(err.message).not.toContain('invalid input');
    expect(asKind(results.before, 'rows').rows).toHaveLength(1);
    expect(asKind(results.after, 'rows').rows).toHaveLength(3);
  });

  test('this вне контекста — отказ компиляции своего блока (THIS_OUT_OF_CONTEXT), пачка цела', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'orphan', text: 'children_of=this' },
        { key: 'fine', text: 'aspect=orbis/task, limit=1' },
      ],
    });
    expect(asError(results.orphan).code).toBe('THIS_OUT_OF_CONTEXT');
    expect(asKind(results.fine, 'rows').rows).toHaveLength(1);
  });

  test('пустой текст блока — «не настроен» (Р-21-8), а не все записи владельца', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'blank', text: '   ' },
        { key: 'fine', text: 'aspect=orbis/task, limit=1' },
      ],
    });
    expect(results.blank).toEqual({
      ok: false,
      error: { code: 'EMPTY', message: EMPTY_QUERY_MESSAGE },
    });
    expect(asKind(results.fine, 'rows').rows).toHaveLength(1);
  });

  test('потолки: 31 блок и limit 1000 — отказ схемы; limit=1000 в тексте — кламп до 500', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);

    const tooMany = Array.from({ length: BLOCKS_BATCH_CAP + 1 }, (_, i) => ({
      key: `b${i}`,
      text: 'aspect=orbis/task',
    }));
    expect((await trpcError(caller.entity.blocks({ blocks: tooMany }))).code).toBe('BAD_REQUEST');
    expect(
      (
        await trpcError(
          caller.entity.blocks({ blocks: [{ key: 'x', text: 'aspect=orbis/task', limit: 1000 }] }),
        )
      ).code,
    ).toBe('BAD_REQUEST');

    // 502 строки мимо исполнителя — одним INSERT: кламп виден только на выборке больше потолка.
    await withIdentity(db, personal(user), (tx) =>
      tx.insert(entities).values(
        Array.from({ length: 502 }, (_, i) =>
          rawEntityRow({
            graphId: user,
            id: newId(),
            title: `Массовая ${i}`,
            props: { 'orbis/task_status': 'inbox' },
            aspects: ['orbis/task'],
          }),
        ),
      ),
    );
    const { results } = await caller.entity.blocks({
      blocks: [{ key: 'big', text: 'aspect=orbis/task, limit=1000' }],
    });
    const big = asKind(results.big, 'rows');
    expect(big.rows).toHaveLength(500);
    expect(big.more).toBe(2);
  });

  test('дубликат ключа в пачке — отказ схемы (BAD_REQUEST), а не «последний победил»', async () => {
    const caller = callerFor(await freshGraph());
    const err = await trpcError(
      caller.entity.blocks({
        blocks: [
          { key: 'same', text: 'aspect=orbis/task' },
          { key: 'same', text: 'aspect=orbis/note' },
        ],
      }),
    );
    expect(err.code).toBe('BAD_REQUEST');
  });

  test('агент по PAT читает блоки законно: мутация по транспорту, чтение по сути (РП-8)', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    const agent = createCaller({
      identity: personal(user),
      actorKind: 'agent',
      db,
      clientVersion: null,
    });
    const { results } = await agent.entity.blocks({
      blocks: [{ key: 'n', text: 'aspect=orbis/task, display=tile, aggregate=count' }],
    });
    expect(results.n).toEqual({ ok: true, kind: 'count', count: 7 });
  });

  test('права: чужая запись в thisEntityId под RLS не видна — пустые строки, а не чужие данные', async () => {
    const owner = await freshGraph();
    const { projectId } = await seedWorld(owner);
    const stranger = await freshGraph();
    const { results } = await callerFor(stranger).entity.blocks({
      blocks: [{ key: 'peek', text: 'children_of=this', thisEntityId: projectId }],
    });
    expect(results.peek).toEqual({ ok: true, kind: 'rows', rows: [], more: 0, closedIds: [] });
  });
});

describe('entity.blocks — группировка по дням (спека 1в §5.2, задача 6)', () => {
  test('верх ответа — today и пояс владельца пачки; блок с group — вид groups, отказ группы — отказ блока', async () => {
    const user = await freshGraph();
    const res = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'feed', text: 'aspect=orbis/task, group=day:orbis/due_date, display=list' },
        { key: 'bad', text: 'group=day:orbis/title' },
        { key: 'table', text: 'group=day:orbis/due_date, display=table' },
      ],
    });
    // Строки настроек нет — запасной пояс; «сегодня» — в нём (как у компиляции блоков).
    expect(res.timeZone).toBe(DEFAULT_TIMEZONE);
    expect(res.today).toBe(todayInTimeZone(DEFAULT_TIMEZONE));
    expect(res.results.feed).toEqual({
      ok: true,
      kind: 'groups',
      groups: [],
      more: 0,
      closedIds: [],
    });
    expect(res.results.bad).toMatchObject({ ok: false, error: { code: 'TYPE' } });
    expect(res.results.table).toMatchObject({ ok: false, error: { code: 'SYNTAX' } });
  });
});

describe('entity.blocks — бейдж раздела `badgeOf` (срез 1б §9.3, РП-8)', () => {
  /** Страница с телом дословно — бейдж читает тело сервером. */
  async function pageWithBody(user: GraphId, body: string): Promise<string> {
    const created = await callerFor(user).entity.create({
      input: { title: 'Раздел', tags: [], body, aspects: ['orbis/page'] },
      source: 'ui',
    });
    return created.id;
  }

  // Первый блок — во вкладке контейнера, второй — ниже на верхнем уровне: считается ПЕРВЫЙ в
  // порядке документа (обход в глубину, как у `bodyIssues`), а не первый на верхнем уровне.
  const TWO_BLOCKS = [
    'Шапка раздела',
    '',
    '{{tabs}}',
    '{{tab: Задачи}}',
    '{{query:aspect=orbis/task}}',
    '{{/tab}}',
    '{{/tabs}}',
    '',
    '{{query:aspect=orbis/financial}}',
    '',
  ].join('\n');

  test('страница с двумя блоками (первый — во вкладке) — число первого в порядке документа', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    const section = await pageWithBody(user, TWO_BLOCKS);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [{ key: 'badge', badgeOf: section }],
    });
    expect(results.badge).toEqual({ ok: true, kind: 'count', count: 7 });
  });

  test('страница без блоков данных — kind:none, а не отказ', async () => {
    const user = await freshGraph();
    const section = await pageWithBody(user, 'Просто текст без блоков.\n');
    const { results } = await callerFor(user).entity.blocks({
      blocks: [{ key: 'badge', badgeOf: section }],
    });
    expect(results.badge).toEqual({ ok: true, kind: 'none' });
  });

  test('чужой и несуществующий id — отказ бейджа (ok:false), не чужие данные', async () => {
    const owner = await freshGraph();
    await seedWorld(owner);
    const foreign = await pageWithBody(owner, TWO_BLOCKS);
    const stranger = await freshGraph();
    const { results } = await callerFor(stranger).entity.blocks({
      blocks: [
        { key: 'foreign', badgeOf: foreign },
        { key: 'missing', badgeOf: newId() },
      ],
    });
    expect(asError(results.foreign).code).toBe('NOT_FOUND');
    expect(asError(results.missing).code).toBe('NOT_FOUND');
  });

  test('пачка из текстового блока и двух бейджей — один вызов, одна транзакция', async () => {
    const user = await freshGraph();
    await seedWorld(user);
    const first = await pageWithBody(user, TWO_BLOCKS);
    const empty = await pageWithBody(user, 'Без блоков\n');
    const counting = countingDb();
    const { results } = await callerFor(user, counting.db).entity.blocks({
      blocks: [
        { key: 'text', text: 'aspect=orbis/financial, display=tile, aggregate=count' },
        { key: 'b1', badgeOf: first },
        { key: 'b2', badgeOf: empty },
      ],
    });
    expect(results).toEqual({
      text: { ok: true, kind: 'count', count: 2 },
      b1: { ok: true, kind: 'count', count: 7 },
      b2: { ok: true, kind: 'none' },
    });
    expect(counting.transactions()).toBe(1);
  });
});

describe('entity.blocks — параметр страницы (спека 1в §5.1, РП-6)', () => {
  /** Две задачи: срок через 2 и через 10 дней — `next_7d` видит одну, `next_14d` — обе. */
  async function seedDue(user: GraphId): Promise<void> {
    const today = todayInTimeZone(DEFAULT_TIMEZONE);
    for (const days of [2, 10]) {
      await callerFor(user).entity.create({
        input: {
          title: `Срок +${days}`,
          tags: [],
          props: { 'orbis/task_status': 'planned', 'orbis/due_date': addDays(today, days) },
          aspects: ['orbis/task'],
        },
        source: 'ui',
      });
    }
  }

  const ROWS = 'aspect=orbis/task, orbis/due_date=$period';
  const TILE = 'aspect=orbis/task, orbis/due_date=$period, display=tile, aggregate=count';
  const DECL = '{{param: period, type=period, default=next_7d, options=next_7d|next_14d}}';

  async function pageWithBody(user: GraphId, body: string): Promise<string> {
    const created = await callerFor(user).entity.create({
      input: { title: 'Раздел', tags: [], body, aspects: ['orbis/page'] },
      source: 'ui',
    });
    return created.id;
  }

  test('два блока с $period и одним значением next_14d — одна пачка, оба посчитаны от next_14d', async () => {
    const user = await freshGraph();
    await seedDue(user);
    const counting = countingDb();
    const params = { period: 'next_14d' };
    const { results } = await callerFor(user, counting.db).entity.blocks({
      blocks: [
        { key: 'rows', text: ROWS, params },
        { key: 'tile', text: TILE, params },
      ],
    });
    expect(asKind(results.rows, 'rows').rows).toHaveLength(2);
    expect(results.tile).toEqual({ ok: true, kind: 'count', count: 2 });
    // То же с next_7d — одна: значение действительно подставлено, а не проигнорировано.
    const week = await callerFor(user).entity.blocks({
      blocks: [{ key: 'tile', text: TILE, params: { period: 'next_7d' } }],
    });
    expect(week.results.tile).toEqual({ ok: true, kind: 'count', count: 1 });
    // Одна пачка: два блока с параметром стоят столько же транзакций, сколько один.
    const one = countingDb();
    await callerFor(user, one.db).entity.blocks({ blocks: [{ key: 'tile', text: TILE, params }] });
    expect(counting.transactions()).toBe(one.transactions());
  });

  test('блок с $period без значения — отказ блока UNKNOWN_PARAM; плохое значение — PARAM_VALUE; соседи живы', async () => {
    const user = await freshGraph();
    await seedDue(user);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'none', text: TILE },
        { key: 'bad', text: TILE, params: { period: 'soon' } },
        { key: 'plain', text: 'aspect=orbis/task, display=tile, aggregate=count' },
      ],
    });
    expect(asError(results.none)).toMatchObject({
      code: 'UNKNOWN_PARAM',
      message: 'параметр «period» не объявлен на странице',
    });
    expect(asError(results.bad).code).toBe('PARAM_VALUE');
    expect(results.plain).toEqual({ ok: true, kind: 'count', count: 2 });
  });

  test('params — поле элемента пачки: больше 16 ключей — отказ схемы пачки', async () => {
    const user = await freshGraph();
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, 'today']));
    const e = await trpcError(
      callerFor(user).entity.blocks({ blocks: [{ key: 'x', text: TILE, params: many }] }),
    );
    expect(e.code).toBe('BAD_REQUEST');
  });

  test('бейдж: первый блок данных с $period считается по умолчанию {{param}} того же тела (параметр — выше блока)', async () => {
    const user = await freshGraph();
    await seedDue(user);
    const section = await pageWithBody(user, `${DECL}\n\n{{query:${ROWS}}}\n`);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [{ key: 'badge', badgeOf: section }],
    });
    expect(results.badge).toEqual({ ok: true, kind: 'count', count: 1 });
  });

  test('бейдж: параметр с ошибкой блока или без объявления — отказ бейджа UNKNOWN_PARAM', async () => {
    const user = await freshGraph();
    await seedDue(user);
    const broken = await pageWithBody(
      user,
      `{{param: period, type=period, default=today, options=next_7d}}\n\n{{query:${ROWS}}}\n`,
    );
    const undeclared = await pageWithBody(user, `{{query:${ROWS}}}\n`);
    const { results } = await callerFor(user).entity.blocks({
      blocks: [
        { key: 'broken', badgeOf: broken },
        { key: 'undeclared', badgeOf: undeclared },
      ],
    });
    expect(asError(results.broken).code).toBe('UNKNOWN_PARAM');
    expect(asError(results.undeclared).code).toBe('UNKNOWN_PARAM');
  });
});
