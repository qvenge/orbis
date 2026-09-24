// apps/server/src/routers/entity-update-batch.test.ts
// `entity.updateBatch` (срез 1а, спека §4.3 и §8.4): пачка правок одним `execute` с `batchId` —
// один actionId и один Undo. Против живой БД через createCallerFactory, как в бою.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type GraphId,
  globalThreadId,
  PAGE_ASPECT,
  TEMPLATE_FOR_PROPERTY,
  TEMPLATE_WINS_OVER_PROPERTY,
  UPDATE_BATCH_CAP,
} from '@orbis/shared';
import { canonicalizeBody, parseBody } from '@orbis/shared/doc';
import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { entityVersions } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import type { Card } from '../tools/registry';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

function callerFor(user: GraphId) {
  return createCaller({ identity: personal(user), actorKind: 'owner', db, clientVersion: null });
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

/** Шаблон записи — страница с «Шаблон для» (без него «Главнее, чем» отказывает правилом). */
async function createTemplate(user: GraphId, title: string): Promise<string> {
  const created = await callerFor(user).entity.create({
    input: {
      title,
      tags: [],
      props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'] },
      aspects: [PAGE_ASPECT],
    },
    source: 'ui',
  });
  return created.id;
}

async function winsOver(user: GraphId, id: string): Promise<unknown> {
  const got = await callerFor(user).entity.get({ id, include: [] });
  return got.entity.props[TEMPLATE_WINS_OVER_PROPERTY];
}

/**
 * Документ тела во входной форме `entity_update` (`bodyDocSchema`): `parseBody` отдаёт общий
 * `JSONContent`, у которого `type`/`content` необязательны, — схема входа же их требует.
 */
function pageDoc(markdown: string): {
  v: number;
  doc: { type: 'doc'; content: Record<string, unknown>[] };
} {
  const parsed = parseBody(markdown);
  return {
    v: parsed.v,
    doc: { type: 'doc', content: (parsed.doc.content ?? []) as Record<string, unknown>[] },
  };
}

/** Тела закреплённых версий записи — под RLS владельца, прямым чтением (список их не отдаёт). */
async function pinnedBodies(user: GraphId, entityId: string): Promise<string[]> {
  const rows = await withIdentity(db, personal(user), (tx) =>
    tx
      .select({ body: entityVersions.body })
      .from(entityVersions)
      .where(eq(entityVersions.entityId, entityId)),
  );
  return rows.map((r) => r.body);
}

/** Карточки заданного вида из глобального треда владельца (админ-DSN — как `ai/escalation.test.ts`). */
async function cardsOf(user: GraphId, kind: string): Promise<Card[]> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT metadata FROM chat_messages WHERE thread_id = ${globalThreadId(user)}
          ORDER BY created_at, id`,
    );
    return [...rows]
      .flatMap((r) => (r.metadata as { cards?: Card[] }).cards ?? [])
      .filter((c) => c.kind === kind);
  } finally {
    await adminClient.end();
  }
}

describe('entity.updateBatch — пачка правок, один Undo (§4.3, §8.4)', () => {
  test('две правки двух записей — один actionId; ai.undo откатывает обе', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const a = await createTemplate(user, 'Шаблон A');
    const b = await createTemplate(user, 'Шаблон B');
    const loser = await createTemplate(user, 'Шаблон C');

    const r = await caller.entity.updateBatch({
      operations: [
        {
          tool: 'entity_update',
          input: { id: a, props: { [TEMPLATE_WINS_OVER_PROPERTY]: [loser] } },
        },
        {
          tool: 'entity_update',
          input: { id: b, props: { [TEMPLATE_WINS_OVER_PROPERTY]: [loser] } },
        },
      ],
    });
    expect(typeof r.actionId).toBe('string');
    expect(r.results).toHaveLength(2);
    expect(await winsOver(user, a)).toEqual([loser]);
    expect(await winsOver(user, b)).toEqual([loser]);

    await caller.ai.undo({ actionId: r.actionId });
    expect(await winsOver(user, a)).toBeUndefined();
    expect(await winsOver(user, b)).toBeUndefined();
  });

  test('закрепление + замена тела + аспект страницы одной пачкой: версия со СТАРЫМ телом; Undo возвращает тело, снимает аспект и версию', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const oldBody = 'Старое тело записи';
    const x = await caller.entity.create({
      input: { title: 'Запись', tags: [], body: oldBody },
      source: 'ui',
    });
    const before = await caller.entity.get({ id: x.id, include: ['body'] });

    const r = await caller.entity.updateBatch({
      operations: [
        {
          tool: 'entity_version_pin',
          input: { entity_id: x.id, label: 'Текст до изменения вида' },
        },
        {
          tool: 'entity_update',
          input: {
            id: x.id,
            expectedUpdatedAt: before.entity.updatedAt,
            bodyDoc: pageDoc('# Страница\n\nНовое тело'),
            aspects: { attach: [PAGE_ASPECT] },
          },
        },
      ],
    });

    const list = await caller.version.list({ entityId: x.id });
    expect(list.map((v) => v.label)).toEqual(['Текст до изменения вида']);
    // Закрепление стоит ПЕРВЫМ и видит тело ДО замены — виртуальное состояние пачки.
    expect(await pinnedBodies(user, x.id)).toEqual([canonicalizeBody(oldBody).body]);
    const after = await caller.entity.get({ id: x.id, include: ['body'] });
    expect(after.entity.body).toBe(canonicalizeBody('# Страница\n\nНовое тело').body);
    expect(after.entity.aspects).toContain(PAGE_ASPECT);

    await caller.ai.undo({ actionId: r.actionId });
    const undone = await caller.entity.get({ id: x.id, include: ['body'] });
    expect(undone.entity.body).toBe(before.entity.body);
    expect(undone.entity.aspects).not.toContain(PAGE_ASPECT);
    expect(await caller.version.list({ entityId: x.id })).toEqual([]);
  });

  test('отказ одной операции (INVARIANT page_wins_over_not_self) отвергает всю пачку — изменений нет', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const a = await createTemplate(user, 'Шаблон A');
    const b = await createTemplate(user, 'Шаблон B');

    const err = await trpcError(
      caller.entity.updateBatch({
        operations: [
          {
            tool: 'entity_update',
            input: { id: a, props: { [TEMPLATE_WINS_OVER_PROPERTY]: [b] } },
          },
          // Самоссылка — законная форма значения, но запрещённая правилом каталога.
          {
            tool: 'entity_update',
            input: { id: b, props: { [TEMPLATE_WINS_OVER_PROPERTY]: [b] } },
          },
        ],
      }),
    );
    const cause = err.cause as unknown as { code: string; details?: { invariant?: string } };
    expect(cause.code).toBe('INVARIANT');
    expect(cause.details?.invariant).toBe('page_wins_over_not_self');
    // Первая операция пачки законна сама по себе — и всё равно не легла.
    expect(await winsOver(user, a)).toBeUndefined();
    expect(await winsOver(user, b)).toBeUndefined();
  });

  test('эскалация категорий: второй одинаковый перенос категории пачкой — карточка предложения правила (§7.8)', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const category = async (title: string) =>
      (
        await caller.entity.create({
          input: { title, tags: [], props: { 'orbis/icon': '🍔' }, aspects: ['orbis/category'] },
          source: 'ui',
        })
      ).id;
    const food = await category('Еда');
    const fun = await category('Развлечения');
    const txn = async (title: string) =>
      (
        await caller.entity.create({
          input: {
            title,
            tags: [],
            props: {
              'orbis/amount': '340.00',
              'orbis/direction': 'expense',
              'orbis/finance_category': food,
              'orbis/occurred_on': '2026-07-20',
            },
            aspects: ['orbis/financial'],
          },
          source: 'ui',
        })
      ).id;
    const a = await txn('ПЯТЕРОЧКА 843');
    const b = await txn('Пятёрочка');
    const other = await txn('Кофе');

    // Счёт исправлений — по журналу ДЕЙСТВИЙ (скан за 30 дней): первое действие — одно
    // исправление, предложения ещё нет; второе — порог, карточка. Каждая пачка — две правки:
    // перенос категории и посторонняя правка заголовка.
    await caller.entity.updateBatch({
      operations: [
        { tool: 'entity_update', input: { id: a, props: { 'orbis/finance_category': fun } } },
        { tool: 'entity_update', input: { id: other, title: 'Кофе с собой' } },
      ],
    });
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
    await caller.entity.updateBatch({
      operations: [
        { tool: 'entity_update', input: { id: b, props: { 'orbis/finance_category': fun } } },
        { tool: 'entity_update', input: { id: other, title: 'Кофе навынос' } },
      ],
    });
    const cards = await cardsOf(user, 'memory_rule_suggestion');
    expect(cards).toEqual([
      {
        kind: 'memory_rule_suggestion',
        ruleText: 'пятерочка → Развлечения',
        pattern: 'пятерочка',
        fromCategoryId: food,
        toCategoryId: fun,
        categoryTitle: 'Развлечения',
      },
    ]);
  });

  test(`${UPDATE_BATCH_CAP + 1} операция — отказ схемы (BAD_REQUEST)`, async () => {
    const user = await freshGraph();
    const a = await createTemplate(user, 'Шаблон A');
    const operations = Array.from({ length: UPDATE_BATCH_CAP + 1 }, () => ({
      tool: 'entity_update' as const,
      input: { id: a, props: { 'orbis/title': 'Новое имя' } },
    }));
    const err = await trpcError(callerFor(user).entity.updateBatch({ operations }));
    expect(err.code).toBe('BAD_REQUEST');
  });

  test('не-владелец (агент) — FORBIDDEN до базы (ownerOnlyProcedure)', async () => {
    // db — стаб: если гейт пропустит, вызов упадёт не-FORBIDDEN ошибкой базы.
    const agent = createCaller({
      identity: personal(await freshGraph()),
      actorKind: 'agent',
      db: undefined as never,
      clientVersion: null,
    });
    const err = await trpcError(
      agent.entity.updateBatch({
        operations: [
          {
            tool: 'entity_version_pin',
            input: { entity_id: crypto.randomUUID(), label: 'подпись' },
          },
        ],
      }),
    );
    expect(err.code).toBe('FORBIDDEN');
  });
});
