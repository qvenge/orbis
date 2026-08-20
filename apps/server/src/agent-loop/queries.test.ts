// Запросы круга исполнителя и рутин (§4.14, V1.3/V1.13): живая БД под RLS владельца.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
//
// Сьют — про SQL, а не про глаголы: он пинит ровно то, чего не видно в verbs.test.ts —
// отбор по паре (routine_id, bucket), порядок истории и то, что подметание с раннером
// не увидят чужого (архивной, приостановленной рутины).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { agentLoopHelpers, iso, T0 } from '../test/agent-loop-helpers';
import { activeRoutines, routineById, runSummary, runsForBucket, runsOfParent } from './queries';

requireEnv();

const { db, client } = appDb();
const MINUTE = 60_000;
const { seedEntity, link, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('runsForBucket: прогоны слота рутины (V1.3)', () => {
  test('отбор по паре (routine_id, bucket) в порядке created_at; соседний бакет и соседняя рутина не примешиваются', async () => {
    const owner = freshUserId();
    const routineId = await seedRoutine(owner, { title: 'Рутина слотов' });
    const otherId = await seedRoutine(owner, { title: 'Соседняя рутина' });

    const first = await seedRoutineRun(owner, { routineId, bucket: '2026-08-17T07:00' });
    const retry = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      attempt: 2,
      startedAt: new Date(T0.getTime() + 5 * MINUTE),
    });
    const next = await seedRoutineRun(owner, { routineId, bucket: '2026-08-17T08:00' });
    // Тот же слот у другой рутины: bucket сам по себе не различает субъектов
    const alien = await seedRoutineRun(owner, {
      routineId: otherId,
      bucket: '2026-08-17T07:00',
    });

    const rows = await withIdentity(db, owner, (tx) =>
      runsForBucket(tx, routineId, '2026-08-17T07:00'),
    );
    expect(rows.map((r) => r.id)).toEqual([first.runId, retry.runId]);
    expect(rows.map((r) => r.run.attempt)).toEqual([1, 2]);
    expect(rows.every((r) => r.run.routine_id === routineId)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(next.runId);
    expect(rows.map((r) => r.id)).not.toContain(alien.runId);

    expect(
      (await withIdentity(db, owner, (tx) => runsForBucket(tx, routineId, '2026-08-17T09:00')))
        .length,
    ).toBe(0);
  });

  test('прогоны чужого владельца не видны (RLS)', async () => {
    const owner = freshUserId();
    const stranger = freshUserId();
    const routineId = await seedRoutine(stranger, { title: 'Рутина постороннего' });
    await seedRoutineRun(stranger, { routineId, bucket: '2026-08-17T07:00' });

    expect(
      (await withIdentity(db, owner, (tx) => runsForBucket(tx, routineId, '2026-08-17T07:00')))
        .length,
    ).toBe(0);
  });
});

describe('runsOfParent: прогоны родителя — и тикета, и рутины', () => {
  test('дети по связи parent в порядке появления; у рутины это её прогоны', async () => {
    const owner = freshUserId();
    const routineId = await seedRoutine(owner, { title: 'Рутина истории' });
    const a = await seedRoutineRun(owner, { routineId, bucket: '2026-08-17T07:00' });
    const b = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T08:00',
      startedAt: new Date(T0.getTime() + 60 * MINUTE),
    });

    const rows = await withIdentity(db, owner, (tx) => runsOfParent(tx, routineId));
    expect(rows.map((r) => r.id)).toEqual([a.runId, b.runId]);
  });
});

describe('activeRoutines / routineById (V1.13)', () => {
  test('activeRoutines: только активные и неархивные, с телом-инструкцией; paused и архив не видны', async () => {
    const owner = freshUserId();
    const active = await seedRoutine(owner, {
      title: 'Утренний обзор',
      body: 'Пройди по задачам дня и предложи план.',
      routine: { stage: 'active', at: '07:00', mode: 'act', allowed_tools: ['entity_update'] },
    });
    const paused = await seedRoutine(owner, {
      title: 'Приостановленная',
      routine: { stage: 'paused' },
    });
    const archived = await seedRoutine(owner, { title: 'Архивная' });
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: archived, archived: true } }],
    });
    if (!r.ok) throw new Error(`архивация: ${r.error.code} ${r.error.message}`);
    // Не-рутина рядом: отбор идёт по аспекту, а не по «всему графу владельца»
    await seedEntity(owner, {
      title: 'Обычная задача',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });

    const rows = await withIdentity(db, owner, (tx) => activeRoutines(tx));
    expect(rows.map((x) => x.id)).toEqual([active]);
    expect(rows[0]?.title).toBe('Утренний обзор');
    // Тело — это и есть инструкция прогону (V1.1): без него раннеру нечего сказать модели
    expect(rows[0]?.body).toBe('Пройди по задачам дня и предложи план.');
    expect(rows[0]?.routine).toEqual({
      stage: 'active',
      at: '07:00',
      mode: 'act',
      allowed_tools: ['entity_update'],
    });
    expect(rows.map((x) => x.id)).not.toContain(paused);
    expect(rows.map((x) => x.id)).not.toContain(archived);
  });

  test('routineById: рутина с телом и аспектом; не-рутина, чужая и несуществующая — null', async () => {
    const owner = freshUserId();
    const stranger = freshUserId();
    const routineId = await seedRoutine(owner, {
      title: 'Вечерний разбор',
      body: 'Закрой день: что сделано, что перенести.',
      routine: { stage: 'paused', at: '21:30', mode: 'propose', days: ['mo', 'fr'] },
    });
    const task = await seedEntity(owner, {
      title: 'Не рутина',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });
    const alien = await seedRoutine(stranger, { title: 'Чужая рутина' });

    const row = await withIdentity(db, owner, (tx) => routineById(tx, routineId));
    expect(row?.id).toBe(routineId);
    expect(row?.title).toBe('Вечерний разбор');
    expect(row?.body).toBe('Закрой день: что сделано, что перенести.');
    // Приостановленная читается по id намеренно: пауза — про запуск по расписанию,
    // а не про видимость (иначе экран рутины не смог бы её показать)
    expect(row?.routine).toEqual({
      stage: 'paused',
      at: '21:30',
      mode: 'propose',
      days: ['mo', 'fr'],
    });

    expect(await withIdentity(db, owner, (tx) => routineById(tx, task.id))).toBeNull();
    expect(await withIdentity(db, owner, (tx) => routineById(tx, alien))).toBeNull();
    expect(await withIdentity(db, owner, (tx) => routineById(tx, newId()))).toBeNull();
  });
});

describe('runSummary: рутинные поля сводки (V1.4)', () => {
  test('routine_id, bucket, attempt, fail_note и статус предложения едут в сводку; mismatches — нет', async () => {
    const owner = freshUserId();
    const routineId = await seedRoutine(owner, { title: 'Рутина сводки' });
    const pendingId = newId();
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      attempt: 2,
      run: {
        outcome: 'failed',
        fail_note: 'предусловие разошлось — предложение снято',
        finished_at: iso(T0),
        proposal: {
          pending_id: pendingId,
          status: 'stale',
          decided_at: iso(T0),
          mismatches: [{ aspect: 'orbis/task', field: 'status', note: 'стало done' }],
        },
      },
    });

    const rows = await withIdentity(db, owner, (tx) =>
      runsForBucket(tx, routineId, '2026-08-17T07:00'),
    );
    const row = rows.find((x) => x.id === runId);
    if (row === undefined) throw new Error('прогон не найден');
    const summary = runSummary(row);

    expect(summary.routine_id).toBe(routineId);
    expect(summary.bucket).toBe('2026-08-17T07:00');
    expect(summary.attempt).toBe(2);
    expect(summary.outcome).toBe('failed');
    expect(summary.fail_note).toBe('предусловие разошлось — предложение снято');
    // Расхождения предусловия — материал экрана предложения, а не сводки: в хвосте
    // истории (V1.4) они раздули бы каждый ответ раннера чужим разбором
    expect(summary.proposal).toEqual({
      pending_id: pendingId,
      status: 'stale',
      decided_at: iso(T0),
    });
  });

  test('edited_from предложения едет в сводку (Ш1.8): следующий прогон обязан узнать, что его текст правили', async () => {
    const owner = freshUserId();
    const routineId = await seedRoutine(owner, { title: 'Рутина правки' });
    const pendingId = newId();
    const editedFrom = newId();
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      run: {
        outcome: 'finished',
        finished_at: iso(T0),
        report: 'Перенесу три просроченные задачи на сегодня.',
        proposal: {
          pending_id: pendingId,
          status: 'approved',
          decided_at: iso(T0),
          edited_from: editedFrom,
        },
      },
    });

    const rows = await withIdentity(db, owner, (tx) =>
      runsForBucket(tx, routineId, '2026-08-17T07:00'),
    );
    const row = rows.find((x) => x.id === runId);
    if (row === undefined) throw new Error('прогон не найден');

    expect(runSummary(row).proposal).toEqual({
      pending_id: pendingId,
      status: 'approved',
      decided_at: iso(T0),
      edited_from: editedFrom,
    });
  });

  test('грантовая сводка рутинных ключей не заводит: `?` значит «этого не было»', async () => {
    const owner = freshUserId();
    const ticket = await seedEntity(owner, {
      title: 'Тикет сводки',
      tags: [],
      aspects: { 'orbis/task': { status: 'in_progress' } },
    });
    const run = await seedEntity(owner, {
      title: 'Прогон тикета',
      tags: [],
      aspects: {
        'orbis/agent-run': {
          grant_id: newId(),
          outcome: 'finished',
          started_at: iso(T0),
          last_step_at: iso(T0),
          finished_at: iso(T0),
          step_count: 0,
          steps: [],
          report: 'Готово',
        },
      },
    });
    await link(owner, ticket.id, run.id);

    const rows = await withIdentity(db, owner, (tx) => runsOfParent(tx, ticket.id));
    const summary = runSummary(rows[0] as (typeof rows)[number]);
    expect(summary.report).toBe('Готово');
    expect('routine_id' in summary).toBe(false);
    expect('bucket' in summary).toBe(false);
    expect('attempt' in summary).toBe(false);
    expect('fail_note' in summary).toBe(false);
    expect('proposal' in summary).toBe(false);
  });
});
