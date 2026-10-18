import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from '@orbis/shared';
// Exercise the actual client query builders against PostgreSQL, including NULL/NOT semantics.
import { dayQuery, inboxQuery, planTaskPatch } from '../../../web/src/features/planning/model';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();
const { db, client } = appDb();
beforeAll(truncateAll);
afterAll(() => client.end());

test('raw capture → triage → day planning retains identity, content and independent deadline', async () => {
  const owner = await freshGraph();
  const api = createCallerFactory(appRouter)({
    identity: personal(owner),
    actorKind: 'owner',
    db,
    clientVersion: null,
  });
  const raw = await api.entity.create({
    input: {
      title: 'Необработанная мысль',
      body: 'Полный текст\nСо ссылкой https://example.com',
      tags: [],
      props: { 'orbis/inbox_state': 'pending' },
    },
    source: 'quick_capture',
  });
  const legacy = await api.entity.create({
    input: { title: 'Старая быстрая запись', tags: [] },
    source: 'quick_capture',
  });
  const note = await api.entity.create({
    input: { title: 'Знание', tags: ['gtd-reference'], aspects: ['orbis/note'] },
    source: 'quick_capture',
  });
  const later = await api.entity.create({
    input: { title: 'Позже', tags: ['gtd-someday'] },
    source: 'quick_capture',
  });
  const aspects = BUILTIN_ASPECT_DEFS.map((a) => a.id);
  const pending = () => api.entity.query({ ast: inboxQuery(aspects, 'pending', 100) });
  expect((await pending()).map((r) => r.id).sort()).toEqual([raw.id, legacy.id].sort());
  expect(
    (await api.entity.query({ ast: inboxQuery(aspects, 'later', 100) })).map((r) => r.id),
  ).toEqual([later.id]);
  await api.entity.updateBatch({
    operations: [
      {
        tool: 'entity_update',
        input: {
          ...planTaskPatch(raw, '2026-10-19', 0),
          props: { ...planTaskPatch(raw, '2026-10-19', 0).props, 'orbis/due_date': '2026-11-01' },
        },
      },
    ],
  });
  const day = await api.entity.query({ ast: dayQuery('2026-10-19', 100), fields: 'full' });
  expect(day.map((r) => r.id)).toEqual([raw.id]);
  expect(day[0]?.body).toBe(raw.body);
  expect(day[0]?.props['orbis/due_date']).toBe('2026-11-01');
  expect((await pending()).map((r) => r.id)).toEqual([legacy.id]);
  await api.entity.updateBatch({
    operations: [
      {
        tool: 'entity_update',
        input: {
          id: raw.id,
          props: { 'orbis/task_status': 'done', 'orbis/inbox_state': 'pending' },
        },
      },
    ],
  });
  expect((await pending()).map((r) => r.id)).toEqual([legacy.id]);
  expect((await api.entity.get({ id: note.id })).entity.aspects).toContain('orbis/note');
});
