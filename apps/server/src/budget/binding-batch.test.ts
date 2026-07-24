// apps/server/src/budget/binding-batch.test.ts
// Task C2a (обязательство бэклога фазы A): батч-селектор конвертов вместо N+1 в
// авто-привязке и ребиндинге. Тесты фиксируют, что ускорение НЕ меняет поведения:
// (а) batch из N транзакций разных категорий/дат привязывается ровно к тем же
//     конвертам, что N одиночных вызовов;
// (б) «самый узкий конверт» побеждает в батче так же, как в одиночном селекторе
//     (пересечение месячного и отпускного, приёмка 03-budget §7.3);
// (в) число обращений к селектору конвертов на batch из 50 транзакций — константа,
//     а не N (счётчик statement'ов драйвера);
// плюс порядок чтений: два хука одного batch, затронувшие одну транзакцию, обязаны
// видеть эффект предыдущего (иначе привязка разъезжается с состоянием БД).
// Реальная БД под withIdentity (RLS enforced), без моков.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import * as schema from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, ExecuteResult, WireEntity } from '../executor/types';
import { selectEnvelope, selectEnvelopes } from './binding';

requireEnv();

const { db, client } = appDb();
const sink = makeChatJournalSink();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function ok(r: ExecuteResult) {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function budgetData(
  categoryRef: string,
  periodStart: string,
  periodEnd: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    category_ref: categoryRef,
    limit: '30000.00',
    period_start: periodStart,
    period_end: periodEnd,
    ...over,
  };
}

function finData(
  categoryRef: string,
  occurredOn: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    amount: '340.00',
    direction: 'expense',
    category_ref: categoryRef,
    occurred_on: occurredOn,
    ...over,
  };
}

async function createEntity(user: string, input: Record<string, unknown>): Promise<WireEntity> {
  const r = ok(
    await execute(
      db,
      {
        actorUserId: user,
        actorKind: 'owner',
        source: 'fast_path',
        operations: [{ tool: 'entity_create', input: { tags: [], ...input } }],
      },
      { sink },
    ),
  );
  return r.results[0] as WireEntity;
}

/** Живые budget-parent'ы транзакции — истина в БД (админ-DSN, обходит RLS). */
async function budgetParents(txnId: string): Promise<string[]> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = [
      ...(await admin.execute(
        sql`SELECT r.source_id FROM relations r
            JOIN entities e ON e.id = r.source_id
            WHERE r.target_id = ${txnId} AND r.relation_type = 'parent'
              AND e.aspects ? 'orbis/budget'
            ORDER BY r.source_id`,
      )),
    ];
    return rows.map((r) => (r as { source_id: string }).source_id);
  } finally {
    await adminClient.end();
  }
}

/** Единственный budget-parent транзакции (или null — Unbudgeted). */
async function boundEnvelope(txnId: string): Promise<string | null> {
  const parents = await budgetParents(txnId);
  if (parents.length > 1) throw new Error(`у ${txnId} больше одного budget-parent: ${parents}`);
  return parents[0] ?? null;
}

// ---------------------------------------------------------------------------
// Сцена: пересечение месячного и «отпускного» конверта (§7.3) + EUR-конверт
// ---------------------------------------------------------------------------
interface Scene {
  user: string;
  catA: string;
  catB: string;
  catC: string;
  monthly: string;
  narrow: string;
  eur: string;
}

async function makeScene(): Promise<Scene> {
  const user = freshUserId();
  const catA = newId();
  const catB = newId();
  const catC = newId();
  const monthly = await createEntity(user, {
    title: 'Еда — июль',
    aspects: { 'orbis/budget': budgetData(catA, '2026-07-01', '2026-07-31') },
  });
  const narrow = await createEntity(user, {
    title: 'Еда — отпуск',
    aspects: { 'orbis/budget': budgetData(catA, '2026-07-10', '2026-07-14') },
  });
  const eur = await createEntity(user, {
    title: 'Транспорт — июль (EUR)',
    aspects: { 'orbis/budget': budgetData(catB, '2026-07-01', '2026-07-31', { currency: 'EUR' }) },
  });
  return { user, catA, catB, catC, monthly: monthly.id, narrow: narrow.id, eur: eur.id };
}

/** Строки импорта: разные категории, даты и валюты — включая границы отпускного окна. */
function sceneRows(s: Scene): Array<{ fin: Record<string, unknown>; expected: string | null }> {
  return [
    { fin: finData(s.catA, '2026-07-05'), expected: s.monthly },
    { fin: finData(s.catA, '2026-07-09'), expected: s.monthly },
    { fin: finData(s.catA, '2026-07-10'), expected: s.narrow }, // левая граница окна
    { fin: finData(s.catA, '2026-07-12'), expected: s.narrow },
    { fin: finData(s.catA, '2026-07-14'), expected: s.narrow }, // правая граница окна
    { fin: finData(s.catA, '2026-07-15'), expected: s.monthly },
    { fin: finData(s.catA, '2026-07-31'), expected: s.monthly },
    { fin: finData(s.catA, '2026-06-30'), expected: null }, // до периода
    { fin: finData(s.catA, '2026-08-01'), expected: null }, // после периода
    { fin: finData(s.catB, '2026-07-12', { currency: 'EUR' }), expected: s.eur },
    { fin: finData(s.catB, '2026-07-12'), expected: null }, // валюта не совпала
    { fin: finData(s.catC, '2026-07-12'), expected: null }, // категория без конверта
  ];
}

describe('батч-селектор конвертов: эквивалентность одиночному (Task C2a)', () => {
  test('(а)+(б) selectEnvelopes на набор === selectEnvelope по одному; узкий конверт побеждает', async () => {
    const s = await makeScene();
    const rows = sceneRows(s).map((r, i) => ({
      key: `r${i}`,
      categoryRef: r.fin.category_ref as string,
      currency: (r.fin.currency as string | undefined) ?? 'RUB',
      occurredOn: r.fin.occurred_on as string,
    }));

    const batch = await withIdentity(db, s.user, (tx) =>
      selectEnvelopes(tx, { ownerId: s.user, defaultCurrency: 'RUB', rows }),
    );
    const singles = await withIdentity(db, s.user, async (tx) => {
      const out = new Map<string, string | null>();
      for (const row of rows) {
        out.set(row.key, await selectEnvelope(tx, { ownerId: s.user, ...row }));
      }
      return out;
    });

    expect([...batch.entries()].sort()).toEqual([...singles.entries()].sort());
    // Ожидания приёмки §7.3 — не только «одинаково», но и «правильно»
    expect(rows.map((r) => batch.get(r.key) ?? null)).toEqual(sceneRows(s).map((r) => r.expected));
  });

  test('(а) batch из N транзакций привязывается так же, как N одиночных entity_create', async () => {
    const s = await makeScene();
    const rows = sceneRows(s);

    // Прогон 1: один batch_execute на все строки (форма массового импорта, §9.2)
    const batchIds = rows.map(() => newId());
    ok(
      await execute(
        db,
        {
          actorUserId: s.user,
          actorKind: 'owner',
          source: 'chat',
          batchId: newId(),
          operations: rows.map((r, i) => ({
            tool: 'entity_create',
            input: {
              id: batchIds[i],
              title: `batch ${i}`,
              tags: [],
              aspects: { 'orbis/financial': r.fin },
            },
          })),
        },
        { sink },
      ),
    );

    // Прогон 2: те же строки по одной операции за вызов
    const singleIds: string[] = [];
    for (const [i, r] of rows.entries()) {
      const e = await createEntity(s.user, {
        title: `single ${i}`,
        aspects: { 'orbis/financial': r.fin },
      });
      singleIds.push(e.id);
    }

    const fromBatch: Array<string | null> = [];
    const fromSingles: Array<string | null> = [];
    for (const id of batchIds) fromBatch.push(await boundEnvelope(id));
    for (const id of singleIds) fromSingles.push(await boundEnvelope(id));

    expect(fromBatch).toEqual(fromSingles);
    expect(fromBatch).toEqual(rows.map((r) => r.expected));
  });

  test('порядок чтений: второй хук того же batch видит привязку, дописанную первым', async () => {
    // Ловушка батчинга: хук архивации узкого конверта переносит транзакцию на месячный,
    // а следующий хук той же транзакции обязан увидеть НОВОГО родителя — иначе он
    // повторно удалит уже удалённую связь и создаст дубль (отказ всего batch).
    const s = await makeScene();
    const txn = await createEntity(s.user, {
      title: 'обед в отпуске',
      aspects: { 'orbis/financial': finData(s.catA, '2026-07-12') },
    });
    expect(await boundEnvelope(txn.id)).toBe(s.narrow);

    const r = ok(
      await execute(
        db,
        {
          actorUserId: s.user,
          actorKind: 'owner',
          source: 'chat',
          batchId: newId(),
          operations: [
            { tool: 'entity_update', input: { id: s.narrow, archived: true } },
            {
              tool: 'entity_update',
              input: { id: txn.id, aspects: { 'orbis/financial': { amount: '999.00' } } },
            },
          ],
        },
        { sink },
      ),
    );
    expect(r.results.length).toBe(2);
    // Узкий конверт архивирован → транзакция вернулась месячному, ровно одна связь
    expect(await boundEnvelope(txn.id)).toBe(s.monthly);
  });

  test('порядок чтений: обратный порядок операций — окно ребиндинга видит хук транзакции', async () => {
    // Зеркало предыдущего случая: сначала хук транзакции переносит её на месячный,
    // затем окно ребиндинга архивированного конверта обязано увидеть уже НОВУЮ связь.
    const s = await makeScene();
    const txn = await createEntity(s.user, {
      title: 'ужин в отпуске',
      aspects: { 'orbis/financial': finData(s.catA, '2026-07-12') },
    });
    expect(await boundEnvelope(txn.id)).toBe(s.narrow);

    ok(
      await execute(
        db,
        {
          actorUserId: s.user,
          actorKind: 'owner',
          source: 'chat',
          batchId: newId(),
          operations: [
            {
              tool: 'entity_update',
              input: { id: txn.id, aspects: { 'orbis/financial': { amount: '999.00' } } },
            },
            { tool: 'entity_update', input: { id: s.narrow, archived: true } },
          ],
        },
        { sink },
      ),
    );
    expect(await boundEnvelope(txn.id)).toBe(s.monthly);
  });
});

// ---------------------------------------------------------------------------
// (в) счётчик обращений: batch из 50 транзакций — константа, а не N
// ---------------------------------------------------------------------------

/** Соединение со счётчиком statement'ов: postgres-js зовёт debug на КАЖДОЕ исполнение. */
function countingDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('countingDb: DATABASE_URL не задан');
  const queries: string[] = [];
  const counted = postgres(url, {
    max: 1,
    prepare: process.env.PG_PREPARE !== 'false',
    onnotice: () => {},
    debug: (_conn, query) => {
      queries.push(query);
    },
  });
  return { db: drizzle(counted, { schema }), client: counted, queries };
}

/**
 * Классы чтений авто-привязки по тексту statement'а. assertSingleBudgetParent
 * (инвариант §4.2, по одному запросу на КАЖДУЮ создаваемую связь) в счёт не идёт:
 * это цена самой операции relation_create, а не N+1 селектора; отличается отсутствием
 * ORDER BY.
 */
const READS = {
  selector: (q: string) => q.includes("'orbis/budget'->>'period_end'"),
  parents: (q: string) => q.includes("aspects ? 'orbis/budget'") && q.includes('ORDER BY'),
  currency: (q: string) => q.includes('user_settings'),
};

describe('число обращений к селектору не растёт линейно (Task C2a)', () => {
  test('batch из 50 транзакций: чтения привязки — константа', async () => {
    const counting = countingDb();
    try {
      const user = freshUserId();
      const cat = newId();
      const envelope = ok(
        await execute(
          counting.db,
          {
            actorUserId: user,
            actorKind: 'owner',
            source: 'fast_path',
            operations: [
              {
                tool: 'entity_create',
                input: {
                  title: 'Еда — июль',
                  tags: [],
                  aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
                },
              },
            ],
          },
          { sink },
        ),
      );
      const envelopeId = (envelope.results[0] as WireEntity).id;

      const N = 50;
      const txnIds = Array.from({ length: N }, () => newId());
      const request: ExecuteRequest = {
        actorUserId: user,
        actorKind: 'owner',
        source: 'chat',
        batchId: newId(),
        operations: txnIds.map((id, i) => ({
          tool: 'entity_create',
          input: {
            id,
            title: `Импорт ${i}`,
            tags: [],
            aspects: { 'orbis/financial': finData(cat, '2026-07-12') },
          },
        })),
      };

      counting.queries.length = 0; // считаем только batch импорта
      ok(await execute(counting.db, request, { sink }));
      const counts = {
        selector: counting.queries.filter(READS.selector).length,
        parents: counting.queries.filter(READS.parents).length,
        currency: counting.queries.filter(READS.currency).length,
      };

      // Работа действительно сделана: все 50 транзакций привязаны к конверту
      expect(await budgetParents(txnIds[0] as string)).toEqual([envelopeId]);
      expect(await budgetParents(txnIds[N - 1] as string)).toEqual([envelopeId]);

      // K — константа, не зависящая от N (сегодня 1/1/1: три запроса на весь batch)
      const K = 4;
      expect(counts.selector).toBeLessThanOrEqual(K);
      expect(counts.parents).toBeLessThanOrEqual(K);
      expect(counts.currency).toBeLessThanOrEqual(K);
      // Счётчик действительно ловит эти чтения (иначе «≤ K» выполнялось бы вхолостую)
      expect(counts.selector).toBeGreaterThan(0);
      expect(counts.parents).toBeGreaterThan(0);
    } finally {
      await counting.client.end();
    }
  });
});
