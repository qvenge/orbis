// apps/server/src/rules/task-status-default.test.ts
// Строка каталога `task_status_default` (Б-2 №98, срез 1б задача 3) и соседние правила задачи на
// боевом пути записи. Экран записи больше не держит копий правил: чекбокс шлёт только смену статуса
// (или её снятие), а штамп `completed_at`, снятие вопроса `waiting_for` и значение возврата из
// закрытия делает сервер. Через `execute()`, а не вызовом движка: предмет — именно то, что получит
// запись экрана, включая откат (Undo) того же действия.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteResult, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';

requireEnv();

const { db, client } = appDb();
beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

const T0 = new Date('2026-09-24T09:00:00.000Z');
const T1 = new Date('2026-09-25T12:30:00.000Z');
/** Откат ищет действие в журнале чата — пустой сток журнала ему не годится. */
const sink = makeChatJournalSink();

function run(
  graph: GraphId,
  tool: 'entity_create' | 'entity_update',
  input: Record<string, unknown>,
  at: Date = T0,
): Promise<ExecuteResult> {
  // Источник `ui` — тот же, что у чекбокса экрана записи.
  return execute(
    db,
    {
      identity: personal(graph),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool, input }],
      clock: () => at,
    },
    { sink },
  );
}

function ok(r: ExecuteResult): { actionId: string; entity: WireEntity } {
  if (!r.ok) throw new Error(`ожидался успех, получено ${JSON.stringify(r.error)}`);
  return { actionId: r.actionId, entity: r.results[0] as WireEntity };
}

/** Состояние записи из базы — не из ответа: откат ответа-сущности не возвращает. */
async function propsOf(graph: GraphId, id: string): Promise<Record<string, unknown>> {
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.select({ props: entities.props }).from(entities).where(eq(entities.id, id)),
  );
  const row = rows[0];
  if (!row) throw new Error(`запись ${id} не найдена`);
  return row.props as Record<string, unknown>;
}

async function closedTask(graph: GraphId): Promise<string> {
  const created = ok(
    await run(graph, 'entity_create', {
      title: 'Закрытая задача',
      tags: [],
      aspects: ['orbis/task'],
      props: { 'orbis/task_status': 'done' },
    }),
  );
  // Предусловие — правило `task_completed_at` уже поставило штамп на создании в `done`.
  expect(created.entity.props['orbis/completed_at']).toBeDefined();
  return created.entity.id;
}

test('снятие статуса у закрытой задачи → inbox строкой каталога, штамп completed_at снят', async () => {
  const graph = await freshGraph();
  const id = await closedTask(graph);

  const reopened = ok(await run(graph, 'entity_update', { id, unset: ['orbis/task_status'] }, T1));
  expect(reopened.entity.props['orbis/task_status']).toBe('inbox');
  // Уход из класса `done` снимает штамп — правило `task_completed_at`, не экран.
  expect(reopened.entity.props).not.toHaveProperty('orbis/completed_at');
  expect(await propsOf(graph, id)).toMatchObject({ 'orbis/task_status': 'inbox' });
});

test('закрытие тикета в ожидании одной сменой статуса: вопрос снят, completed_at = updated_at', async () => {
  const graph = await freshGraph();
  const created = ok(
    await run(graph, 'entity_create', {
      title: 'Тикет с вопросом',
      tags: [],
      aspects: ['orbis/task'],
      props: { 'orbis/task_status': 'waiting', 'orbis/waiting_for': 'Какую БД брать?' },
    }),
  );
  const closed = ok(
    await run(
      graph,
      'entity_update',
      { id: created.entity.id, props: { 'orbis/task_status': 'done' } },
      T1,
    ),
  );
  expect(closed.entity.props['orbis/task_status']).toBe('done');
  // Правило `waiting_for` снимает вопрос при уходе из ожидания — без `unset` во входе.
  expect(closed.entity.props).not.toHaveProperty('orbis/waiting_for');
  // Штамп — момент ЭТОЙ записи (`{prop:'orbis/updated_at'}`), а не часы клиента.
  expect(closed.entity.props['orbis/completed_at']).toBe(closed.entity.updatedAt);
});

test('Undo снятия статуса возвращает done и штамп completed_at', async () => {
  const graph = await freshGraph();
  const id = await closedTask(graph);
  const before = await propsOf(graph, id);

  const reopened = ok(await run(graph, 'entity_update', { id, unset: ['orbis/task_status'] }, T1));
  const undone = await undoAction(db, { identity: personal(graph), actionId: reopened.actionId });
  // Причина отказа отката — в тексте падения, а не голое false.
  expect(undone.ok ? 'ok' : JSON.stringify(undone.error)).toBe('ok');

  const after = await propsOf(graph, id);
  expect(after['orbis/task_status']).toBe('done');
  expect(after['orbis/completed_at']).toBe(before['orbis/completed_at']);
});

test('задача без статуса на создании получает inbox — строка default работает и там', async () => {
  const graph = await freshGraph();
  const created = ok(
    await run(graph, 'entity_create', {
      title: 'Задача без статуса',
      tags: [],
      aspects: ['orbis/task'],
    }),
  );
  expect(created.entity.props['orbis/task_status']).toBe('inbox');
  expect(created.entity.props).not.toHaveProperty('orbis/completed_at');
});
