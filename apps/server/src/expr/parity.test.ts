// apps/server/src/expr/parity.test.ts
// ПАРИТЕТ ДВУХ БЭКЕНДОВ ЯЗЫКА E У ГРАНИЦЫ СУТОК (Р-33, остатки Б-1 36 и 82).
//
// Меряется ОДИН вопрос — «этот момент сегодня у владельца?», — и оба бэкенда обязаны ответить на него
// одинаково. SQL-бэкенд приводит момент к дню владельца `AT TIME ZONE` (`expr/compile.ts`,
// `localDateSql`); TS-интерпретатор до Б-2 читал сырой текст момента, то есть день его собственного
// смещения: '2026-05-15T23:30:00Z' был для него 15 мая и в Бангкоке, где там уже 16-е. Без паритета
// первое же правило «событие сегодня» ошибалось бы на записи семь часов в сутки, а список (SQL) и
// проверка записи (TS) расходились бы на одной и той же строке.
//
// Случаи выбраны по обе стороны полуночи и по обе стороны UTC (+07 и −04 летом), чтобы порча в любую
// сторону — «TS без зоны», «TS в UTC», «зона не та» — краснила хотя бы один.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { ExprNode } from '@orbis/shared/expr';
import { sql } from 'drizzle-orm';
import { appDb, mintGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { WireEntity } from '../executor/types';
import type { CompileCtx } from '../query/compile-ast';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { compileExprPredicate } from './compile';
import { evalExpr } from './eval';

requireEnv();

const { db, client } = appDb();
const owner = mintGraph();
const ids = new Map<string, string>();
let reg: RegistrySnapshot;

const EXPR: ExprNode = { op: '=', args: [{ prop: 'orbis/start_at' }, { ctx: '$today' }] };
const CASES = [
  { tz: 'Asia/Bangkok', at: '2026-05-15T23:30:00Z', today: '2026-05-16', expected: true },
  { tz: 'Asia/Bangkok', at: '2026-05-15T23:30:00Z', today: '2026-05-15', expected: false },
  { tz: 'America/New_York', at: '2026-05-16T02:30:00Z', today: '2026-05-15', expected: true },
  { tz: 'America/New_York', at: '2026-05-16T02:30:00Z', today: '2026-05-16', expected: false },
];

beforeAll(async () => {
  // Одна сущность на момент, через исполнитель: SQL-бэкенд читает то, что реально легло в `props`.
  await truncateAll();
  for (const c of CASES) {
    if (ids.has(c.at)) continue;
    const r = await execute(db, {
      identity: personal(owner),
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_create',
          input: {
            title: 'Событие у границы суток',
            tags: [],
            aspects: ['orbis/schedule'],
            props: { 'orbis/start_at': c.at },
          },
        },
      ],
    });
    if (!r.ok) throw new Error(`фикстура паритета: ${r.error.code}`);
    ids.set(c.at, (r.results[0] as WireEntity).id);
  }
  reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
});

afterAll(async () => {
  await client.end();
});

for (const c of CASES) {
  test(`${c.tz} ${c.at} против ${c.today} → ${c.expected}`, async () => {
    const cctx: CompileCtx = {
      graphId: owner,
      today: c.today,
      timeZone: c.tz,
      reg,
      thisEntityId: null,
    };
    const predicate = compileExprPredicate(EXPR, { cctx, row: sql.raw('e') });
    const rows = (await withIdentity(db, personal(owner), (tx) =>
      tx.execute(
        sql`SELECT e.id FROM entities e WHERE e.id = ${ids.get(c.at)}::uuid AND ${predicate}`,
      ),
    )) as unknown as Array<{ id: string }>;
    const ts = evalExpr(EXPR, {
      params: {},
      aggs: {},
      phase: null,
      today: c.today,
      timeZone: c.tz,
      props: { 'orbis/start_at': c.at },
    });
    expect(`sql=${rows.length === 1} ts=${ts}`).toBe(`sql=${c.expected} ts=${c.expected}`);
  });
}
