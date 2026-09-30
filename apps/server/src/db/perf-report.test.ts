import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { adminDb, appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { journalSourceOf, journalVolume, parsePerfArgs } from './perf-report';

requireEnv();
const { db, client } = appDb();
const admin = adminDb();
const sink = makeChatJournalSink();
beforeAll(truncateAll);
afterAll(async () => {
  await truncateAll();
  await client.end();
  await admin.client.end();
});

describe('ops.ts perf: разбор флагов', () => {
  test('умолчание 7 дней; --since Nd; --metric; мусор — ошибка', () => {
    expect(parsePerfArgs([])).toEqual({ sinceDays: 7, metric: null });
    expect(parsePerfArgs(['--since', '30d', '--metric', 'inp'])).toEqual({
      sinceDays: 30,
      metric: 'inp',
    });
    expect(parsePerfArgs(['--since', '30'])).toHaveProperty('error');
    expect(parsePerfArgs(['--since', '400d'])).toHaveProperty('error');
    expect(parsePerfArgs(['--wat'])).toHaveProperty('error');
  });
});

describe('ops.ts perf: объём журнала', () => {
  test('записи, байты и «сеансы» по графу и дню — только чтение', async () => {
    const g = await freshGraph();
    const id = newId();
    const run = (input: unknown, tool = 'entity_update') =>
      execute(
        db,
        { identity: personal(g), actorKind: 'owner', source: 'ui', operations: [{ tool, input }] },
        { sink },
      );
    const created = await run({ id, title: 'Замер', tags: [] }, 'entity_create');
    if (!created.ok) throw new Error(created.error.message);
    const at = (created.results[0] as { updatedAt: string }).updatedAt;
    const bodyOnly = await run({ id, body: 'только текст', expectedUpdatedAt: at });
    if (!bodyOnly.ok) throw new Error(bodyOnly.error.message);
    const at2 = (bodyOnly.results[0] as { updatedAt: string }).updatedAt;
    const mixed = await run({
      id,
      title: 'Замер 2',
      body: 'текст и заголовок',
      expectedUpdatedAt: at2,
    });
    if (!mixed.ok) throw new Error(mixed.error.message);

    const { source, rows } = await admin.client.begin('read only', (tx) => journalVolume(tx, 7));
    const mine = rows.filter((r) => r.graphId === g);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.records).toBe(3);
    expect(mine[0]?.bytes).toBeGreaterThan(0);
    // до плана А «сеанс» — одиночная правка ТОЛЬКО тела из ui; после задачи 9 — колонка text_session
    // (правка без autosave сеансом не считается) — ожидание зависит от источника, не от задачи
    expect(mine[0]?.sessions).toBe(source === 'chat_messages' ? 1 : 0);
  });
  test('источник: таблицы журнала нет — сообщения чата', async () => {
    const source = await admin.client.begin('read only', (tx) => journalSourceOf(tx));
    expect(['chat_messages', 'action_journal']).toContain(source);
  });
});
