// apps/server/src/query/refs.dataset.test.ts
// «КТО ССЫЛАЕТСЯ НА ЗАПИСЬ» (спека 1в §3.9, С1в-9): `parents_of=this via=ref` по коду выражает
// «записи, ссылающиеся на эту запись ссылочным свойством» — роль `ref` зеркалит значение
// ссылочного свойства ребром «откуда ссылка → цель ссылки». До 1в это не проверял ни тест, ни
// живой текст. Срез форму НЕ чинит: результат этого теста — вход среза Бюджета (§7.3).
//
// Мир: запись `X`; `A` и `B` ссылаются на неё своим ссылочным свойством владельца (тип `ref` без
// цели), `C` несёт то же свойство без значения. Блок страницы X — ровно `A`, `B`.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BlockResult, GraphId } from '@orbis/shared';
import { appDb, freshGraph, personal, requireEnv, seedCustomAspect } from '../../test/helpers';
import { execute } from '../executor/executor';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

afterAll(async () => {
  await client.end();
});

let graph: GraphId;
const ids: Record<'X' | 'A' | 'B' | 'C', string> = { X: '', A: '', B: '', C: '' };

async function create(input: Record<string, unknown>): Promise<string> {
  const r = await execute(db, {
    identity: personal(graph),
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input: { tags: [], ...input } }],
  });
  if (!r.ok) throw new Error(`мир «ссылки»: ${r.error.code} — ${r.error.message}`);
  return (r.results[0] as { id: string }).id;
}

beforeAll(async () => {
  graph = await freshGraph();
  await seedCustomAspect(graph, {
    key: 'user/linker',
    label: { ru: 'Ссылается' },
    module: null,
    properties: [{ key: 'link', type: { kind: 'ref' } }],
  });
  ids.X = await create({ title: 'X цель ссылок', aspects: ['orbis/note'], props: {} });
  ids.A = await create({ title: 'A', aspects: ['user/linker'], props: { 'user/link': ids.X } });
  ids.B = await create({ title: 'B', aspects: ['user/linker'], props: { 'user/link': ids.X } });
  ids.C = await create({ title: 'C без ссылки', aspects: ['user/linker'], props: {} });
});

test('блок `parents_of=this via=ref` на странице X — ровно записи, ссылающиеся на X', async () => {
  const { results } = await createCaller({
    identity: personal(graph),
    actorKind: 'owner',
    db,
    clientVersion: null,
  }).entity.blocks({
    blocks: [{ key: 'refs', text: 'parents_of=this via=ref', thisEntityId: ids.X }],
  });
  const refs = results.refs as BlockResult;
  if (!refs.ok || refs.kind !== 'rows')
    throw new Error(`ожидались строки: ${JSON.stringify(refs)}`);
  expect(refs.rows.map((r) => r.id).sort()).toEqual([ids.A, ids.B].sort());
  expect(refs.more).toBe(0);
  // Провод 1в: у строк есть `closedIds` (заполняет задача 6) — с первого подъёма версии клиента.
  expect(refs.closedIds).toEqual([]);
});
