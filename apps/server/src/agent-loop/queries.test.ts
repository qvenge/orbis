// Запросы круга исполнителя и рутин (§4.14, V1.3/V1.13): живая БД под RLS владельца.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
//
// Сьют — про SQL, а не про глаголы: он пинит ровно то, чего не видно в verbs.test.ts —
// отбор по паре (routine_id, bucket), порядок истории и то, что подметание с раннером
// не увидят чужого (архивной, приостановленной рутины).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId, type RunSummary } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  appDb,
  divergentEntityRow,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { agentLoopHelpers, iso, T0 } from '../test/agent-loop-helpers';
import {
  activeRoutines,
  assignedTickets,
  parentProject,
  type RunProps,
  type RunRow,
  routineById,
  runSummary,
  runsForBucket,
  runsOfParent,
  ticketOfRun,
} from './queries';

requireEnv();

const { db, client } = appDb();
const MINUTE = 60_000;
const { seedEntity, link, propsOf, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);

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
    expect(rows.map((r) => r.props['orbis/run_attempt'])).toEqual([1, 2]);
    expect(rows.every((r) => r.props['orbis/run_routine'] === routineId)).toBe(true);
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

describe('parentProject / ticketOfRun: проект и тикет через роли (§А4-3)', () => {
  test('очередь исполнителя: тикеты по роли ticket/run; parentProject → props.orbis/parent_project', async () => {
    const owner = freshUserId();
    const project = await seedEntity(owner, {
      title: 'Проект очереди',
      tags: [],
      body: 'Процесс проекта',
      aspects: { 'orbis/project': { stage: 'active' } },
    });
    const ticket = await seedEntity(owner, {
      title: 'Тикет очереди',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });
    await link(owner, project.id, ticket.id, 'ticket');
    // Субъект прогона — рутина (§А6-1 проверяет `orbis/run_routine` по множеству
    // `aspect=orbis/routine`), а РОДИТЕЛЬ в очереди — тикет: `runsOfParent`/`ticketOfRun`
    // ходят по роли `run`, и именно её источник здесь и проверяется.
    const routineId = await seedRoutine(owner, { title: 'Рутина очереди' });
    const run = await seedRoutineRun(owner, {
      routineId,
      parentId: ticket.id,
      bucket: '2026-08-27T07:00',
    });

    const got = await withIdentity(db, owner, async (tx) => ({
      project: await parentProject(tx, ticket.id),
      runs: await runsOfParent(tx, ticket.id),
      ticketOf: await ticketOfRun(tx, run.runId),
    }));
    expect(got.project).toEqual({
      id: project.id,
      title: 'Проект очереди',
      body: 'Процесс проекта',
    });
    // Ровно то же значение лежит на тикете вычисленным (§А8): у очереди и у графа один ответ
    expect((await propsOf(owner, ticket.id))['orbis/parent_project']).toBe(project.id);
    expect(got.runs.map((r) => r.id)).toEqual([run.runId]);
    expect(got.ticketOf?.id).toBe(ticket.id);
  });

  test('тикет ЧЕРЕЗ подзадачу: проект находится по вычисленному предку, а не по одному ребру', async () => {
    const owner = freshUserId();
    const project = await seedEntity(owner, {
      title: 'Проект в глубину',
      tags: [],
      aspects: { 'orbis/project': { stage: 'active' } },
    });
    const middle = await seedEntity(owner, { title: 'Промежуточная задача', tags: [] });
    const ticket = await seedEntity(owner, {
      title: 'Глубокий тикет',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });
    await link(owner, project.id, middle.id, 'subitem');
    await link(owner, middle.id, ticket.id, 'subitem');

    const got = await withIdentity(db, owner, (tx) => parentProject(tx, ticket.id));
    expect(got?.id).toBe(project.id);
  });

  // Проектов над тикетом бывает несколько: очередь показывает БЛИЖАЙШИЙ («в каком проекте
  // я работаю»), а не самый верхний — иначе исполнитель получил бы процесс не той затеи.
  test('под подпроектом внутри проекта очередь показывает БЛИЖАЙШИЙ проект, не корневой', async () => {
    const owner = freshUserId();
    const top = await seedEntity(owner, {
      title: 'Корневой проект',
      tags: [],
      body: 'Процесс корня',
      aspects: { 'orbis/project': { stage: 'active' } },
    });
    const sub = await seedEntity(owner, {
      title: 'Подпроект',
      tags: [],
      body: 'Процесс подпроекта',
      aspects: { 'orbis/project': { stage: 'active' } },
    });
    const ticket = await seedEntity(owner, {
      title: 'Тикет подпроекта',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });
    await link(owner, top.id, sub.id, 'subitem');
    await link(owner, sub.id, ticket.id, 'ticket');

    const got = await withIdentity(db, owner, (tx) => parentProject(tx, ticket.id));
    expect(got).toEqual({ id: sub.id, title: 'Подпроект', body: 'Процесс подпроекта' });
    // …и корневой при этом посчитан тоже — но живёт в СВОЁМ свойстве
    const props = await propsOf(owner, ticket.id);
    expect(props['orbis/root_project']).toBe(top.id);
  });

  test('тикет без проекта над собой — законный случай: null, а не отказ', async () => {
    const owner = freshUserId();
    const parent = await seedEntity(owner, { title: 'Просто задача', tags: [] });
    const ticket = await seedEntity(owner, {
      title: 'Личный тикет',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });
    await link(owner, parent.id, ticket.id, 'subitem');
    expect(await withIdentity(db, owner, (tx) => parentProject(tx, ticket.id))).toBeNull();
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
    expect(rows[0]?.props).toEqual({
      'orbis/routine_stage': 'active',
      'orbis/routine_at': '07:00',
      'orbis/routine_mode': 'act',
      'orbis/allowed_tools': ['entity_update'],
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
    expect(row?.props).toEqual({
      'orbis/routine_stage': 'paused',
      'orbis/routine_at': '21:30',
      'orbis/routine_mode': 'propose',
      'orbis/routine_days': ['mo', 'fr'],
    });

    expect(await withIdentity(db, owner, (tx) => routineById(tx, task.id))).toBeNull();
    expect(await withIdentity(db, owner, (tx) => routineById(tx, alien))).toBeNull();
    expect(await withIdentity(db, owner, (tx) => routineById(tx, newId()))).toBeNull();
  });
});

describe('assignedTickets: очередь исполнителя читает НОВУЮ правду (§А1-1)', () => {
  // Проба расхождением: на интервале дуальной записи обе колонки заполняет один писатель,
  // поэтому перевод читателя с одной на другую поведением НЕ наблюдаем, пока они равны.
  // Здесь они говорят РАЗНОЕ — и обе стороны границы обязаны краснеть по отдельности:
  // «вернуть всё» ловит строка со снятым аспектом, «вернуть ничего» — строка, назначение
  // которой записано только в новой форме.
  const owner = freshUserId();
  const grantId = newId();
  const otherGrantId = newId();
  const byProps = newId();
  const byLegacyOnly = newId();
  const detachedAssignment = newId();
  const notATask = newId();
  const otherGrant = newId();

  beforeAll(async () => {
    const row = (
      id: string,
      title: string,
      props: Record<string, unknown>,
      aspects: string[],
      legacy: Record<string, Record<string, unknown>> = {},
    ) => divergentEntityRow({ ownerId: owner, id, title, props, aspects, legacy });

    await withIdentity(db, owner, (tx) =>
      tx.insert(entities).values([
        // Назначение и задача — только в НОВОЙ форме; старая карта пуста.
        row(
          byProps,
          'Тикет новой формы',
          {
            'orbis/task_status': 'planned',
            'orbis/executor': 'agent',
            'orbis/grant': grantId,
            'orbis/priority': 'high',
            'orbis/due_date': '2026-08-20',
          },
          ['orbis/task', 'orbis/assignment'],
        ),
        // Зеркальная строка: назначение записано ТОЛЬКО старой картой. Читатель новой
        // правды её видеть не должен — иначе он читает не ту колонку.
        row(byLegacyOnly, 'Тикет только старой карты', {}, [], {
          'orbis/task': { status: 'planned' },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        }),
        // Аспект назначения СНЯТ, значения остались (Р9). Без признака носителя эта
        // строка попала бы в очередь — то есть агент получил бы работу, которую с него
        // сняли.
        row(
          detachedAssignment,
          'Назначение снято, значения остались',
          {
            'orbis/task_status': 'planned',
            'orbis/executor': 'agent',
            'orbis/grant': grantId,
          },
          ['orbis/task'],
        ),
        // Задачей быть перестала — та же проверка со второй стороны.
        row(
          notATask,
          'Задача снята, значения остались',
          {
            'orbis/task_status': 'planned',
            'orbis/executor': 'agent',
            'orbis/grant': grantId,
          },
          ['orbis/assignment'],
        ),
        // Чужой грант: containment по значению, а не по одному лишь ключу.
        row(
          otherGrant,
          'Тикет чужого гранта',
          {
            'orbis/task_status': 'planned',
            'orbis/executor': 'agent',
            'orbis/grant': otherGrantId,
          },
          ['orbis/task', 'orbis/assignment'],
        ),
      ]),
    );
  });

  test('в очередь входит строка, назначенная в props под обоими аспектами; строка старой карты — нет', async () => {
    const rows = await withIdentity(db, owner, (tx) => assignedTickets(tx, grantId));
    expect(rows.map((r) => r.id)).toEqual([byProps]);
    expect(rows[0]?.props['orbis/priority']).toBe('high');
    expect(rows[0]?.props['orbis/due_date']).toBe('2026-08-20');
    expect(rows[0]?.aspects.sort()).toEqual(['orbis/assignment', 'orbis/task']);
  });

  test('снятый аспект (назначения или задачи) убирает строку из очереди, хотя значения в props остались (Р9)', async () => {
    const ids = (await withIdentity(db, owner, (tx) => assignedTickets(tx, grantId))).map(
      (r) => r.id,
    );
    expect(ids).not.toContain(detachedAssignment);
    expect(ids).not.toContain(notATask);
    expect(ids).not.toContain(otherGrant);
  });
});

describe('runSummary: шестнадцать полей читаются по id свойств (§А8)', () => {
  test('каждое поле сводки берётся из своего свойства, а не из аспект-объекта', () => {
    const pendingId = newId();
    const props: RunProps = {
      'orbis/run_outcome': 'checkpoint',
      'orbis/run_started_at': iso(T0),
      'orbis/run_finished_at': iso(new Date(T0.getTime() + MINUTE)),
      'orbis/last_step_at': iso(T0),
      'orbis/step_count': 2,
      'orbis/run_steps': [
        { seq: 1, at: iso(T0), summary: 'первый', external: false },
        { seq: 2, at: iso(T0), summary: 'второй', external: true },
      ],
      'orbis/run_report': 'отчёт',
      'orbis/run_checkpoint': { question: 'вопрос?', asked_at: iso(T0) },
      'orbis/run_reply': { text: 'ответ', at: iso(T0) },
      'orbis/abandon_note': 'брошен',
      'orbis/session_url': 'https://example.test/s/1',
      'orbis/run_routine': '01a04700-0000-7000-8000-000000000001',
      'orbis/run_bucket': '2026-08-17T07:00',
      'orbis/run_attempt': 3,
      'orbis/fail_note': 'сбой',
      'orbis/undecided': true,
      'orbis/run_proposal': { pending_id: pendingId, status: 'stale', decided_at: iso(T0) },
    };
    const row: RunRow = {
      id: '01a04700-0000-7000-8000-0000000000ff',
      title: 'Прогон',
      createdAt: T0,
      archived: false,
      props,
    };

    const summary = runSummary(row);
    // Полный состав сравнивается ЦЕЛИКОМ: потерянное поле обязано краснеть так же громко,
    // как лишнее (мутация «убрать одно чтение» иначе прошла бы незамеченной).
    expect(summary).toEqual({
      id: row.id,
      outcome: 'checkpoint',
      started_at: iso(T0),
      step_count: 2,
      last_steps: props['orbis/run_steps'],
      finished_at: iso(new Date(T0.getTime() + MINUTE)),
      report: 'отчёт',
      checkpoint: { question: 'вопрос?', asked_at: iso(T0) },
      reply: { text: 'ответ', at: iso(T0) },
      abandon_note: 'брошен',
      session_url: 'https://example.test/s/1',
      routine_id: '01a04700-0000-7000-8000-000000000001',
      bucket: '2026-08-17T07:00',
      attempt: 3,
      fail_note: 'сбой',
      undecided: true,
      proposal: { pending_id: pendingId, status: 'stale', decided_at: iso(T0) },
    });
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

  test('undecided едет в сводку только как true (D42 ОЧ.6): при false ключа в сводке нет', async () => {
    const owner = freshUserId();
    const routineId = await seedRoutine(owner, { title: 'Рутина пачки' });
    const open = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      run: { outcome: 'finished', finished_at: iso(T0), undecided: true },
    });
    // Разобранная пачка: в АСПЕКТЕ флажок живёт значением false (снятие — запись, а не
    // удаление ключа: предиката «поля нет» у грамматики §6 нет)
    const decided = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      attempt: 2,
      startedAt: new Date(T0.getTime() + 5 * MINUTE),
      run: { outcome: 'finished', finished_at: iso(T0), undecided: false },
    });

    const rows = await withIdentity(db, owner, (tx) =>
      runsForBucket(tx, routineId, '2026-08-17T07:00'),
    );
    const summaryOf = (runId: string): RunSummary => {
      const row = rows.find((x) => x.id === runId);
      if (row === undefined) throw new Error('прогон не найден');
      return runSummary(row);
    };

    expect(summaryOf(open.runId).undecided).toBe(true);
    // …а в СВОДКЕ false не едет вовсе: читателю истории «разобрано» и «пачки не было»
    // неразличимы, и ключ-пустышка заставлял бы его различать несуществующее
    expect('undecided' in summaryOf(decided.runId)).toBe(false);
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
    await link(owner, ticket.id, run.id, 'run');
    // Роль ребра — та, что просил вызов: `link` не вправе подставить свою. До 0017
    // `runsOfParent` идёт по ПЕРЕХОДНОЙ колонке и подмены роли не заметил бы, а после —
    // потерял бы прогон молча (§А4-3).
    const roles = await withIdentity(db, owner, (tx) =>
      tx.execute(
        sql`SELECT role FROM relations WHERE source_id = ${ticket.id}::uuid AND target_id = ${run.id}::uuid`,
      ),
    );
    expect((roles as unknown as Array<{ role: string }>).map((r) => r.role)).toEqual(['run']);

    const rows = await withIdentity(db, owner, (tx) => runsOfParent(tx, ticket.id));
    const summary = runSummary(rows[0] as (typeof rows)[number]);
    expect(summary.report).toBe('Готово');
    expect('routine_id' in summary).toBe(false);
    expect('bucket' in summary).toBe(false);
    expect('attempt' in summary).toBe(false);
    expect('fail_note' in summary).toBe(false);
    expect('proposal' in summary).toBe(false);
    expect('undecided' in summary).toBe(false);
  });
});
