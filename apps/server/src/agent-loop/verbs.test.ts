// Интеграционные тесты глаголов исполнителя (§9.3, С6/С7): живая БД, executor без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
// Вызов идёт ровно тем же путём, что у настоящего агента, — через dispatchTool с
// грантом скоупа worker: гейты скоупа и agentOnly (Задача 7) остаются в контуре теста.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type {
  AskResult,
  CheckpointResult,
  ClaimTaskResult,
  FinishResult,
  MyQueueResult,
  RunStepResult,
} from '@orbis/shared';
import { batchAuditMessageId, newId } from '@orbis/shared';
import { eq, sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { chatMessages } from '../db/schema';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { answerPendingQuestion } from '../policy/pending';
import { bumpOwnerRegistryVersion } from '../registry/version';
import { type AnyRecord, agentLoopHelpers, iso, T0 } from '../test/agent-loop-helpers';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { sweepStaleRuns } from './sweep';
import { closeRoutineRun, runAgentVerb, type VerbCtx } from './verbs';

requireEnv();

const { db, client } = appDb();
const {
  actionsOf,
  childrenOf,
  link,
  propsOf,
  routineCtx,
  seedEntity,
  seedRoutine,
  seedRoutineRun,
  worker,
  workerGrant,
} = agentLoopHelpers(db);

function okResult<T>(r: Awaited<ReturnType<typeof dispatchTool>>): T {
  if (r.status !== 'ok') throw new Error(`ожидался ok, получено: ${JSON.stringify(r)}`);
  return r.result as T;
}

function errorOf(r: Awaited<ReturnType<typeof dispatchTool>>): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (r.status !== 'error') throw new Error(`ожидалась ошибка, получено: ${JSON.stringify(r)}`);
  return r.error;
}

function errorCode(r: Awaited<ReturnType<typeof dispatchTool>>): string {
  return errorOf(r).code;
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// orbis_my_queue
// ---------------------------------------------------------------------------

describe('orbis_my_queue: очередь исполнителя (§9.3, С7)', () => {
  const owner = freshUserId();
  let grantId = '';
  let otherGrantId = '';
  let projectId = '';
  let ticketId = '';

  beforeAll(async () => {
    grantId = await workerGrant(owner, 'очередь');
    otherGrantId = await workerGrant(owner, 'второй исполнитель');
    projectId = (
      await seedEntity(owner, {
        title: 'Проект «Орбис»',
        tags: [],
        aspects: { 'orbis/project': { stage: 'active' } },
      })
    ).id;
    ticketId = (
      await seedEntity(owner, {
        title: 'Починить парсер',
        tags: [],
        aspects: {
          'orbis/task': { status: 'planned', priority: 'high', due_date: '2026-08-20' },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        },
      })
    ).id;
    await link(owner, projectId, ticketId, 'ticket');
    await seedEntity(owner, {
      title: 'Тикет другого исполнителя',
      tags: [],
      aspects: {
        'orbis/task': { status: 'planned' },
        'orbis/assignment': { executor: 'agent', grant_id: otherGrantId },
      },
    });
    await seedEntity(owner, {
      title: 'Тикет без назначения',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });
  });

  test('назначенные гранту тикеты; чужие/неназначенные не видны; claimable только inbox|planned', async () => {
    const r = await dispatchTool(worker(owner, grantId), 'orbis_my_queue', {});
    expect(r.status).toBe('ok');
    const q = okResult<MyQueueResult>(r);
    expect(q.tickets.map((t) => t.id)).toEqual([ticketId]);
    expect(q.tickets[0]?.claimable).toBe(true);
    expect(q.tickets[0]?.status).toBe('planned');
    expect(q.tickets[0]?.priority).toBe('high');
    expect(q.tickets[0]?.due_date).toBe('2026-08-20');
    expect(q.tickets[0]?.project?.id).toBe(projectId);
    expect(q.tickets[0]?.project?.title).toBe('Проект «Орбис»');
    expect(q.tickets[0]?.last_run).toBeUndefined();
    expect(q.swept).toBe(0);
  });

  test('тикет в waiting/done — в очереди виден, но не claimable (работу берут только из inbox|planned)', async () => {
    const waiting = (
      await seedEntity(owner, {
        title: 'Ждёт ответа владельца',
        tags: [],
        aspects: {
          'orbis/task': { status: 'waiting', waiting_for: 'вопрос с чекпойнта' },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        },
      })
    ).id;
    const done = (
      await seedEntity(owner, {
        title: 'Уже закрыт',
        tags: [],
        aspects: {
          'orbis/task': { status: 'done' },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        },
      })
    ).id;
    const q = okResult<MyQueueResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_my_queue', {}),
    );
    const byId = new Map(q.tickets.map((t) => [t.id, t]));
    expect(byId.get(waiting)?.claimable).toBe(false);
    expect(byId.get(done)?.claimable).toBe(false);
    expect(byId.get(ticketId)?.claimable).toBe(true);
  });

  test('лишнее поле в envelope → VALIDATION (strict, §7.10: валидация ДО классификации)', async () => {
    expect(errorCode(await dispatchTool(worker(owner, grantId), 'orbis_my_queue', { x: 1 }))).toBe(
      'VALIDATION',
    );
  });
});

// ---------------------------------------------------------------------------
// orbis_claim_task
// ---------------------------------------------------------------------------

describe('orbis_claim_task: атомарный захват (С7, инвариант 1)', () => {
  const owner = freshUserId();
  let grantId = '';
  let otherGrantId = '';
  let projectId = '';

  /** Сохранённый ответ вызова (§7.8) как он лежит в журнале — админ-DSN, мимо RLS. */
  async function savedResults(callId: string): Promise<Array<Record<string, unknown>>> {
    const auditId = batchAuditMessageId(owner, callId);
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = await admin
        .select({ metadata: chatMessages.metadata })
        .from(chatMessages)
        .where(eq(chatMessages.id, auditId));
      const md = rows[0]?.metadata as { results?: Array<Record<string, unknown>> } | undefined;
      if (md?.results === undefined) throw new Error(`снимок ответа ${auditId} не найден`);
      return md.results;
    } finally {
      await adminClient.end();
    }
  }

  /**
   * Правка СОХРАНЁННОГО ответа (§7.8) админ-DSN — мимо исполнителя, как расходящаяся
   * строка `entities` у соседних проб. Иначе форму снимка не выбрать: обе колонки в нём
   * согласованы по построению, и «какую читает replay» поведением не наблюдаемо.
   *
   * Подтверждение подстановки живёт СНАРУЖИ — вызывающий читает снимок `savedResults` до
   * и после. Внутри колбэка ему делать нечего: мутация, съедающая колбэк целиком, съела бы
   * вместе с ним и проверку, и проба молча стала бы вакуумной.
   */
  async function patchSavedResults(
    callId: string,
    edit: (results: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
  ): Promise<void> {
    const auditId = batchAuditMessageId(owner, callId);
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = await admin
        .select({ metadata: chatMessages.metadata })
        .from(chatMessages)
        .where(eq(chatMessages.id, auditId));
      const md = rows[0]?.metadata as { results?: Array<Record<string, unknown>> } | undefined;
      if (md?.results === undefined) throw new Error(`снимок ответа ${auditId} не найден`);
      await admin
        .update(chatMessages)
        .set({ metadata: { ...md, results: edit(md.results) } })
        .where(eq(chatMessages.id, auditId));
    } finally {
      await adminClient.end();
    }
  }

  /** Свежий тикет проекта, назначенный основному гранту. */
  async function makeTicket(title = 'Тикет для захвата', status = 'planned'): Promise<string> {
    const id = (
      await seedEntity(owner, {
        title,
        tags: [],
        aspects: {
          'orbis/task': { status },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        },
      })
    ).id;
    await link(owner, projectId, id, 'ticket');
    return id;
  }

  beforeAll(async () => {
    grantId = await workerGrant(owner, 'захват');
    otherGrantId = await workerGrant(owner, 'чужой грант');
    projectId = (
      await seedEntity(owner, {
        title: 'Проект захвата',
        tags: [],
        aspects: { 'orbis/project': { stage: 'active' } },
      })
    ).id;
  });

  test('тикет → in_progress, прогон создан ребёнком, ответ несёт body проекта (процесс) и пустую историю', async () => {
    const ticketId = await makeTicket('Первый захват');
    const r = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: ticketId,
    });
    expect(r.status).toBe('ok');
    const c = okResult<ClaimTaskResult>(r);

    expect(c.process).toContain('## Процесс');
    expect(c.project?.id).toBe(projectId);
    expect(c.ticket.id).toBe(ticketId);
    expect(c.ticket.title).toBe('Первый захват');
    expect(c.history).toEqual([]);
    expect(c.replayed).toBe(false);

    const ticketProps = await propsOf(owner, ticketId);
    expect(ticketProps['orbis/task_status']).toBe('in_progress');

    const runProps = await propsOf(owner, c.run_id);
    expect(runProps).toMatchObject({
      'orbis/grant': grantId,
      'orbis/run_outcome': 'running',
      'orbis/step_count': 0,
      'orbis/run_started_at': iso(T0),
      'orbis/last_step_at': iso(T0),
      'orbis/run_steps': [],
    });
    // §А8 УДАЛЯЕТ денормализацию проекта на прогон: свойства `project_id` в реестре нет,
    // его заменяют вычисляемые `orbis/parent_project`/`orbis/root_project` (правило
    // `nearest_ancestor`). Захват его больше не пишет — иначе получил бы
    // `UNKNOWN_PROPERTY` и не состоялся бы вовсе.
    expect(runProps).not.toHaveProperty('orbis/project_id');

    // НОВАЯ правда строки (§А1-1) на боевом пути глагола: значения лежат плоско по id
    // свойства, а не парой «аспект + поле». Читается КОЛОНКА `props`, а не перевод старой
    // карты, — иначе проверка молчала бы ровно там, где носителя в старой форме нет.
    expect(await propsOf(owner, c.run_id)).toMatchObject({
      'orbis/grant': grantId,
      'orbis/run_outcome': 'running',
      'orbis/step_count': 0,
      'orbis/run_started_at': iso(T0),
      // …и вместо снятого `project_id` на прогоне лежит ВЫЧИСЛЕННЫЙ предок: связь
      // «тикет → прогон» иерархическая, и её создание тем же batch запустило пересчёт
      'orbis/parent_project': projectId,
      'orbis/root_project': projectId,
    });

    expect(await childrenOf(owner, ticketId)).toEqual([c.run_id]);

    // Журнал §7.8: ровно один action типа batch, с run_id и actor_grant_id
    const action = (await actionsOf(owner)).find((a) => a.id === c.action_id);
    expect(action?.type).toBe('batch');
    expect(action?.run_id).toBe(c.run_id);
    expect(action?.actor_grant_id).toBe(grantId);
    expect(action?.actor_kind).toBe('agent');
    expect(action?.source).toBe('mcp');
  });

  /**
   * ЗАДАНИЕ ПЕЧАТАЕТСЯ ПО KEY, А НЕ ПО ID (§А9-2, Р12 «key для машин»).
   *
   * У всех ВСТРОЕННЫХ свойств key совпадает с id, поэтому на них подмена
   * `ticketForModel.props` → `ticketWire.props` неразличима ни поведением, ни tsc (обе
   * стороны — `Record<string, unknown>`). Окно открывает СВОЁ свойство владельца: его id —
   * uuid, а key — `user/…`, и адрес, который увидит модель, обязан быть вторым: она пишет
   * тем же именем, которым читала (`entity_update.props`), а uuid реестра до неё доезжать
   * не должен.
   *
   * Строка реестра кладётся прямым INSERT'ом от админа: операций реестра в срезе А ещё нет
   * (Задача 15), а свойство владельца уже бывает — тот же приём, что в `export.test.ts`.
   */
  test('ответ захвата печатает props по KEY: своё свойство владельца — под `user/…`, не под uuid', async () => {
    const propertyId = crypto.randomUUID();
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.execute(sql`
        INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
        VALUES (${propertyId}, ${owner}::uuid, 'user/ticket-note',
                ${JSON.stringify({ ru: 'Пометка', en: 'Note' })}::jsonb,
                ${JSON.stringify({ ru: 'Пометка владельца', en: "The owner's note" })}::jsonb,
                ${JSON.stringify({ kind: 'text' })}::jsonb, 1001)`);
      // Мутация реестра двигает версию тем же путём, что боевой писатель (§А10-1): без
      // этого кеш эффективных определений не увидел бы нового свойства владельца.
      await bumpOwnerRegistryVersion(admin, owner);
    } finally {
      await adminClient.end();
    }

    const ticketId = await makeTicket('Тикет со своим свойством');
    const written = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        { tool: 'entity_update', input: { id: ticketId, props: { [propertyId]: 'смотри тред' } } },
      ],
    });
    if (!written.ok) throw new Error(`своё свойство не записалось: ${JSON.stringify(written)}`);

    const c = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    // В графе значение лежит под id (§А1-1) — а модели уезжает под key.
    expect((await propsOf(owner, ticketId))[propertyId]).toBe('смотри тред');
    expect(c.ticket.props['user/ticket-note']).toBe('смотри тред');
    expect(c.ticket.props).not.toHaveProperty(propertyId);
    // Встроенные свойства едут тем же адресом — проекция одна на всё задание.
    expect(c.ticket.props['orbis/task_status']).toBe('in_progress');
    expect(c.ticket.aspects).toContain('orbis/task');
  });

  test('инвариант 1: два одновременных захвата одного тикета — ровно один получает работу, второй CONFLICT', async () => {
    for (let round = 0; round < 5; round++) {
      const ticketId = await makeTicket(`Гонка ${round}`);
      const [a, b] = await Promise.all([
        dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
        dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
      ]);
      const oks = [a, b].filter((x) => x.status === 'ok');
      expect(oks).toHaveLength(1);
      const lost = [a, b].find((x) => x.status === 'error');
      expect(lost === undefined ? null : errorCode(lost)).toBe('CONFLICT');
      // Ровно один прогон-ребёнок: проигравший batch откатился целиком
      expect(await childrenOf(owner, ticketId)).toHaveLength(1);
    }
  }, 60_000);

  test('захват тикета, назначенного ДРУГОМУ гранту / не назначенного / в waiting|done → CONFLICT, ничего не создано', async () => {
    const foreign = (
      await seedEntity(owner, {
        title: 'Назначен другому гранту',
        tags: [],
        aspects: {
          'orbis/task': { status: 'planned' },
          'orbis/assignment': { executor: 'agent', grant_id: otherGrantId },
        },
      })
    ).id;
    const unassigned = (
      await seedEntity(owner, {
        title: 'Без назначения',
        tags: [],
        aspects: { 'orbis/task': { status: 'planned' } },
      })
    ).id;
    const human = (
      await seedEntity(owner, {
        title: 'Назначен человеку',
        tags: [],
        aspects: {
          'orbis/task': { status: 'planned' },
          'orbis/assignment': { executor: 'human', assignee: 'владелец' },
        },
      })
    ).id;
    const waiting = await makeTicket('Ждёт владельца', 'waiting');
    const done = await makeTicket('Закрыт', 'done');

    for (const id of [foreign, unassigned, human, waiting, done]) {
      const r = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: id });
      expect({ id, code: errorCode(r) }).toEqual({ id, code: 'CONFLICT' });
      // Ничего не создано: транзакция batch откатилась целиком
      expect(await childrenOf(owner, id)).toHaveLength(0);
    }
    // Статусы не сдвинулись
    expect(await propsOf(owner, waiting)).toMatchObject({ 'orbis/task_status': 'waiting' });
    expect(await propsOf(owner, done)).toMatchObject({ 'orbis/task_status': 'done' });
  });

  test('чужой тикет (RLS) → NOT_FOUND', async () => {
    const stranger = freshUserId();
    const alien = (
      await seedEntity(stranger, {
        title: 'Тикет постороннего',
        tags: [],
        aspects: { 'orbis/task': { status: 'planned' } },
      })
    ).id;
    expect(
      errorCode(
        await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: alien }),
      ),
    ).toBe('NOT_FOUND');
  });

  test('повтор orbis_claim_task с тем же id — replay: тот же run_id, второй прогон не создан', async () => {
    const ticketId = await makeTicket('Идемпотентный захват');
    const callId = newId();
    const first = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: ticketId,
      id: callId,
    });
    const second = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: ticketId,
      id: callId,
    });
    const c1 = okResult<ClaimTaskResult>(first);
    const c2 = okResult<ClaimTaskResult>(second);
    expect(c1.replayed).toBe(false);
    expect(c2.replayed).toBe(true);
    expect(c2.run_id).toBe(c1.run_id);
    expect(await childrenOf(owner, ticketId)).toEqual([c1.run_id]);
    expect(c2.history).toEqual([]); // сам прогон в свою же историю не попадает
  });

  // Проба той самой границы, которой греп-маркер старой формы НЕ видит: сохранённый ответ
  // (§7.8) — это ЗАМОРОЖЕННЫЙ снимок wire-формы, а проекции `aspectsMap` в ней больше нет
  // (снята Задачей 13c). Пока обе колонки согласованы, «какую из них читает replay»
  // поведением не наблюдаемо вовсе — поэтому снимок правится админ-DSN мимо исполнителя,
  // ровно как расходящаяся строка `entities` у соседних проб.
  //  • снимок БЕЗ проекции обязан узнаваться (иначе каждый честный повтор захвата получал
  //    бы «использован другим исполнителем» вместо своего же ответа);
  //  • снимок, где прогон перестал нести свой аспект, узнаваться НЕ обязан — под id лежит
  //    не прогон, и отдать его за прогон значило бы соврать про состояние.
  test('replay захвата читает сохранённый ответ НОВОЙ формой: проекции в снимке нет вовсе, снимок без аспекта прогона — не узнаётся', async () => {
    const ticketA = await makeTicket('Захват со снимком без проекции');
    const callA = newId();
    const c1 = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
        ticket_id: ticketA,
        id: callA,
      }),
    );
    /**
     * Старой карты в снимке НЕТ НИ У ОДНОЙ строки — она ушла из wire-формы вместе с
     * последним читателем (Задача 13c, §А1-1). Прежде эта половина теста снимала проекцию
     * РУЧНОЙ правкой снимка и проверяла, что захват всё равно узнаётся; теперь снимать
     * нечего, и утверждение стало структурным: замер идёт по живому снимку, а не по
     * подделанному, и вернувшаяся в wire карта покрасит его.
     */
    const withProjection = (rows: Array<Record<string, unknown>>) =>
      rows.filter((row) => Object.hasOwn(row, 'aspectsMap')).length;
    const savedA = await savedResults(callA);
    // Три строки снимка (тикет, прогон, связь) — иначе «проекции нет» было бы истинным на
    // пустом списке, то есть при любом поведении захвата.
    expect(savedA.length).toBe(3);
    expect(withProjection(savedA)).toBe(0);
    // Читаемое — НОВАЯ правда: у обеих сущностей снимка есть `props` и `aspects`.
    expect(savedA.filter((row) => Object.hasOwn(row, 'props')).length).toBe(2);
    const c2 = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
        ticket_id: ticketA,
        id: callA,
      }),
    );
    expect(c2.replayed).toBe(true);
    expect(c2.run_id).toBe(c1.run_id);

    const ticketB = await makeTicket('Захват со снимком без аспекта прогона');
    const callB = newId();
    okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
        ticket_id: ticketB,
        id: callB,
      }),
    );
    await patchSavedResults(callB, (results) => {
      const run = results[1];
      if (run === undefined) throw new Error('в снимке нет строки прогона');
      run.aspects = (run.aspects as string[]).filter((a) => a !== 'orbis/agent-run');
      return results;
    });
    // Подтверждение подстановки — тоже снаружи: аспект снят, а грант в `props` остался,
    // то есть случай различает ТОЛЬКО признак носителя.
    const savedRun = (await savedResults(callB))[1];
    expect(savedRun?.aspects).not.toContain('orbis/agent-run');
    expect((savedRun?.props as Record<string, unknown>)['orbis/grant']).toBe(grantId);
    const r = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: ticketB,
      id: callB,
    });
    expect(errorCode(r)).toBe('CONFLICT');
  });

  test('тот же id вызова на ДРУГОМ тикете — CONFLICT, чужой прогон агенту не отдаётся', async () => {
    // Ключ идемпотентности адресует ВЫЗОВ (batch_id action'а §7.8), а не тикет: повтор с
    // тем же id вернул бы сохранённый ответ первого захвата — то есть прогон по чужому
    // тикету, в который агент начал бы писать шаги.
    const callId = newId();
    const first = await makeTicket('Первый тикет одного id');
    const second = await makeTicket('Второй тикет того же id');
    const c1 = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
        ticket_id: first,
        id: callId,
      }),
    );
    const r = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: second,
      id: callId,
    });
    expect(errorCode(r)).toBe('CONFLICT');
    // Второй тикет не тронут: replay ничего не применял, а мы ничего не отдали
    expect(await childrenOf(owner, second)).toHaveLength(0);
    expect(await propsOf(owner, second)).toMatchObject({ 'orbis/task_status': 'planned' });
    expect(await childrenOf(owner, first)).toEqual([c1.run_id]);
  });

  test('replay захвата достаётся только своему гранту: тот же id вызова от ДРУГОГО гранта → CONFLICT', async () => {
    // Ключ идемпотентности общий на владельца (audit-id считается по batch_id): без
    // проверки гранта второй исполнитель, повторив id первого, получил бы ЧУЖОЙ прогон —
    // и начал бы писать в него шаги, пока первый ещё работает.
    const ticketId = await makeTicket('Захват под общим id');
    const callId = newId();
    const c1 = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
        ticket_id: ticketId,
        id: callId,
      }),
    );
    const r = await dispatchTool(worker(owner, otherGrantId), 'orbis_claim_task', {
      ticket_id: ticketId,
      id: callId,
    });
    expect(errorCode(r)).toBe('CONFLICT');
    expect(await childrenOf(owner, ticketId)).toEqual([c1.run_id]);
  });

  test('под id вызова лежит не захват (чужой batch владельца) → CONFLICT, а не падение', async () => {
    const ticketId = await makeTicket('Захват поверх чужого batch');
    const callId = newId();
    const note = await seedEntity(owner, { title: 'Заметка владельца', tags: [], aspects: {} });
    // Тем же id владелец уже записал СВОЙ batch: сохранённый ответ — одна сущность, а не
    // пара «тикет + прогон». Глагол обязан ответить структурным отказом, а не упасть на
    // разборе чужой формы (TypeError уехал бы в 500).
    const pre = await execute(
      db,
      {
        actorUserId: owner,
        actorKind: 'owner',
        source: 'ui',
        batchId: callId,
        operations: [{ tool: 'entity_update', input: { id: note.id, title: 'Заметка (правка)' } }],
      },
      { sink: makeChatJournalSink() },
    );
    expect(pre.ok).toBe(true);

    const r = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: ticketId,
      id: callId,
    });
    expect(errorCode(r)).toBe('CONFLICT');
    expect(await childrenOf(owner, ticketId)).toHaveLength(0);
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'planned' });
  });

  test('orbis_claim_task тикета с историей: history содержит прошлый прогон с reply', async () => {
    const ticketId = await makeTicket('Тикет с историей');
    const askedAt = new Date(T0.getTime() - 3 * 3_600_000);
    const past = await seedEntity(owner, {
      title: 'Прогон: Тикет с историей',
      tags: [],
      aspects: {
        'orbis/agent-run': {
          grant_id: grantId,
          // `project_id` из фикстуры снят: §А8 удаляет поле (см. соседний тест)
          outcome: 'checkpoint',
          started_at: iso(new Date(T0.getTime() - 4 * 3_600_000)),
          finished_at: iso(askedAt),
          last_step_at: iso(askedAt),
          step_count: 1,
          steps: [{ seq: 1, at: iso(askedAt), summary: 'Прочитал требования', external: false }],
          checkpoint: { question: 'Какую библиотеку взять?', asked_at: iso(askedAt) },
          reply: { text: 'Бери zod.', at: iso(new Date(T0.getTime() - 2 * 3_600_000)) },
        },
      },
    });
    await link(owner, ticketId, past.id, 'run');

    const c = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    expect(c.history.map((h) => h.id)).toEqual([past.id]);
    expect(c.history[0]?.outcome).toBe('checkpoint');
    expect(c.history[0]?.reply?.text).toBe('Бери zod.');
    expect(c.history[0]?.checkpoint?.question).toBe('Какую библиотеку взять?');
    expect(c.history[0]?.step_count).toBe(1);
    expect(c.history[0]?.last_steps).toHaveLength(1);
    expect(c.run_id).not.toBe(past.id);
  });
});

// ---------------------------------------------------------------------------
// orbis_run_step / orbis_checkpoint / orbis_finish
// ---------------------------------------------------------------------------

describe('Глаголы II: шаг, чекпойнт, итог (С3, С5, С8, инвариант 5)', () => {
  const owner = freshUserId();
  let grantId = '';
  let otherGrantId = '';
  const MINUTE = 60_000;
  const T1 = new Date(T0.getTime() + 5 * MINUTE);
  const T2 = new Date(T0.getTime() + 9 * MINUTE);

  /**
   * Тикет, назначенный основному гранту. `mayClose`: undefined — поля нет вовсе (обычный
   * случай, «не сказано» = «нельзя», С8), true/false — владелец высказался явно.
   */
  async function makeTicket(title: string, mayClose?: boolean): Promise<string> {
    const e = await seedEntity(owner, {
      title,
      tags: [],
      aspects: {
        'orbis/task': { status: 'planned' },
        'orbis/assignment': {
          executor: 'agent',
          grant_id: grantId,
          ...(mayClose !== undefined && { may_close: mayClose }),
        },
      },
    });
    return e.id;
  }

  /** Тикет, взятый в работу штатным глаголом: дальше проверяются шаги этого прогона. */
  async function claimed(
    title: string,
    mayClose?: boolean,
  ): Promise<{ ticketId: string; runId: string }> {
    const ticketId = await makeTicket(title, mayClose);
    const c = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    return { ticketId, runId: c.run_id };
  }

  /** Владелец правит тикет руками — своим путём, не глаголом исполнителя. */
  async function patchTask(ticketId: string, patch: Record<string, unknown>): Promise<void> {
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        { tool: 'entity_update', input: { id: ticketId, aspects: { 'orbis/task': patch } } },
      ],
    });
    if (!r.ok) throw new Error(`patchTask: ${r.error.code} ${r.error.message}`);
  }

  /** Владелец переназначает тикет — тем же путём, что из карточки назначения. */
  async function patchAssignment(ticketId: string, patch: Record<string, unknown>): Promise<void> {
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        { tool: 'entity_update', input: { id: ticketId, aspects: { 'orbis/assignment': patch } } },
      ],
    });
    if (!r.ok) throw new Error(`patchAssignment: ${r.error.code} ${r.error.message}`);
  }

  /** Владелец убирает запись с глаз — архив (не удаление). */
  async function archive(id: string): Promise<void> {
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id, archived: true } }],
    });
    if (!r.ok) throw new Error(`archive: ${r.error.code} ${r.error.message}`);
  }

  beforeAll(async () => {
    grantId = await workerGrant(owner, 'исполнитель шагов');
    otherGrantId = await workerGrant(owner, 'второй исполнитель');
  });

  test('orbis_run_step: шаг дописан, step_count и last_step_at растут, action_id = id вызова; шаг виден в журнале с actor_grant_id и run_id', async () => {
    const { runId } = await claimed('Шаги прогона');
    const callId = newId();
    const first = okResult<RunStepResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T1 }), 'orbis_run_step', {
        run_id: runId,
        summary: 'Прочитал тикет и требования',
        id: callId,
      }),
    );
    expect(first).toEqual({ run_id: runId, step_count: 1, action_id: callId });

    const second = okResult<RunStepResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_run_step', {
        run_id: runId,
        summary: 'Создал ветку fix/parser',
        external: true,
      }),
    );
    expect(second.step_count).toBe(2);

    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('running');
    expect(run['orbis/step_count']).toBe(2);
    // Отметка живости растёт с шагами — по ней подметание отличает работу от обрыва (С6)
    expect(run['orbis/last_step_at']).toBe(iso(T2));
    expect(run['orbis/run_steps']).toEqual([
      {
        seq: 1,
        at: iso(T1),
        summary: 'Прочитал тикет и требования',
        external: false,
        action_id: callId,
      },
      {
        seq: 2,
        at: iso(T2),
        summary: 'Создал ветку fix/parser',
        external: true,
        action_id: second.action_id,
      },
    ]);

    // Журнал §7.8: шаг — свой action с адресом прогона и гранта
    const action = (await actionsOf(owner)).find((a) => a.id === callId);
    expect(action?.type).toBe('batch');
    expect(action?.run_id).toBe(runId);
    expect(action?.actor_grant_id).toBe(grantId);
    expect(action?.actor_kind).toBe('agent');
    expect(action?.source).toBe('mcp');
  });

  test('повтор orbis_run_step с тем же id — replay: шаг не дублируется, step_count тот же', async () => {
    const { runId } = await claimed('Идемпотентный шаг');
    const callId = newId();
    const ctx = worker(owner, grantId, { clock: () => T1 });
    const a = okResult<RunStepResult>(
      await dispatchTool(ctx, 'orbis_run_step', {
        run_id: runId,
        summary: 'Один и тот же шаг',
        id: callId,
      }),
    );
    const b = okResult<RunStepResult>(
      await dispatchTool(ctx, 'orbis_run_step', {
        run_id: runId,
        summary: 'Один и тот же шаг',
        id: callId,
      }),
    );
    expect(b).toEqual(a);
    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/step_count']).toBe(1);
    expect(run['orbis/run_steps']).toHaveLength(1);
  });

  test('гонка шагов: два одновременных orbis_run_step на один прогон — оба ok, step_count 2, оба шага на месте (серверный ретрай CAS по step_count)', async () => {
    for (let round = 0; round < 3; round++) {
      const { runId } = await claimed(`Гонка шагов ${round}`);
      const ctx = worker(owner, grantId, { clock: () => T1 });
      const [a, b] = await Promise.all([
        dispatchTool(ctx, 'orbis_run_step', { run_id: runId, summary: 'шаг A' }),
        dispatchTool(ctx, 'orbis_run_step', { run_id: runId, summary: 'шаг B' }),
      ]);
      expect([a.status, b.status]).toEqual(['ok', 'ok']);

      const run = (await propsOf(owner, runId)) as AnyRecord;
      expect(run['orbis/step_count']).toBe(2);
      const steps = run['orbis/run_steps'] as Array<{ seq: number; summary: string }>;
      expect(steps.map((s) => s.seq)).toEqual([1, 2]);
      expect(new Set(steps.map((s) => s.summary))).toEqual(new Set(['шаг A', 'шаг B']));
    }
  }, 60_000);

  test('четыре ПАРАЛЛЕЛЬНЫХ шага одного прогона: все ok, step_count 4, ни один шаг не потерян', async () => {
    // Агент выпускает несколько tool-call'ов одним ходом (Claude Code так и делает), а CAS
    // по step_count пропускает за круг ровно один шаг: k-му по порядку победы нужно k
    // попыток. Четырёх параллельных шагов уже хватало, чтобы последний получил CONFLICT
    // на ровном месте, — это про запас попыток, а не про поведение глагола.
    for (let round = 0; round < 2; round++) {
      const { runId } = await claimed(`Четыре параллельных шага ${round}`);
      const ctx = worker(owner, grantId, { clock: () => T1 });
      const summaries = ['шаг 1', 'шаг 2', 'шаг 3', 'шаг 4'];
      const results = await Promise.all(
        summaries.map((summary) => dispatchTool(ctx, 'orbis_run_step', { run_id: runId, summary })),
      );
      expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok']);

      const run = (await propsOf(owner, runId)) as AnyRecord;
      expect(run['orbis/step_count']).toBe(4);
      const steps = run['orbis/run_steps'] as Array<{ seq: number; summary: string }>;
      expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
      expect(new Set(steps.map((s) => s.summary))).toEqual(new Set(summaries));
    }
  }, 60_000);

  test('orbis_checkpoint: тикет waiting, waiting_for = вопрос, прогон outcome checkpoint с checkpoint.question (С3)', async () => {
    const { ticketId, runId } = await claimed('Нужен ответ владельца');
    await dispatchTool(worker(owner, grantId, { clock: () => T1 }), 'orbis_run_step', {
      run_id: runId,
      summary: 'Разобрал варианты',
    });

    const question = 'Какую библиотеку взять — zod или ajv?';
    const c = okResult<CheckpointResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_checkpoint', {
        run_id: runId,
        question,
        usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.01 },
        session_url: 'https://agent.example/session/1',
      }),
    );
    expect(c.run_id).toBe(runId);
    expect(c.ticket_id).toBe(ticketId);
    expect(c.ticket_status).toBe('waiting');

    const task = (await propsOf(owner, ticketId)) as AnyRecord;
    expect(task['orbis/task_status']).toBe('waiting');
    expect(task['orbis/waiting_for']).toBe(question);

    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('checkpoint');
    expect(run['orbis/run_finished_at']).toBe(iso(T2));
    expect(run['orbis/last_step_at']).toBe(iso(T2));
    expect(run['orbis/run_checkpoint']).toEqual({ question, asked_at: iso(T2) });
    expect(run['orbis/run_usage']).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cost_usd: 0.01,
    });
    expect(run['orbis/session_url']).toBe('https://agent.example/session/1');
    expect(run['orbis/step_count']).toBe(1); // чекпойнт шагов не дописывает
    // Грантовый чекпойнт патч не менял и после D42: единиц пачки у внешнего исполнителя не
    // бывает (`orbis_ask` ему закрыт гейтом ОЧ.12), и флажок `undecided` на его прогоне
    // означал бы нерешённое, которого нет и разбирать которое владельцу негде
    expect(run['orbis/undecided']).toBeUndefined();

    // Прогон и тикет меняются ОДНИМ action'ом: откат вернёт их вместе
    const action = (await actionsOf(owner)).find((a) => a.id === c.action_id);
    expect(action?.type).toBe('batch');
    expect(action?.run_id).toBe(runId);
    expect(action?.actor_grant_id).toBe(grantId);
  });

  test('orbis_finish без may_close: тикет waiting «готово, проверь», НЕ done; report на прогоне (С8, приёмка 9)', async () => {
    const { ticketId, runId } = await claimed('Работа без права закрытия');
    // Явный may_close=false — тот же исход, что и «поля нет»: см. хвост теста
    const report = 'Починил парсер, добавил тест. Проверь на ветке fix/parser.';
    const f = okResult<FinishResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
        run_id: runId,
        report,
      }),
    );
    expect(f.run_id).toBe(runId);
    expect(f.ticket_id).toBe(ticketId);
    expect(f.ticket_status).toBe('waiting');

    const task = (await propsOf(owner, ticketId)) as AnyRecord;
    expect(task['orbis/task_status']).toBe('waiting');
    expect(task['orbis/waiting_for']).toBe(report);
    expect(task['orbis/completed_at']).toBeUndefined();

    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('finished');
    expect(run['orbis/run_report']).toBe(report);
    expect(run['orbis/run_finished_at']).toBe(iso(T2));
    expect(run['orbis/last_step_at']).toBe(iso(T2));

    // may_close=false, выставленный явно, ничем не отличается от отсутствия поля
    const denied = await claimed('Право закрытия отозвано явно', false);
    const d = okResult<FinishResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
        run_id: denied.runId,
        report: 'Сделал, закрывать не мне.',
      }),
    );
    expect(d.ticket_status).toBe('waiting');
    expect(await propsOf(owner, denied.ticketId)).toMatchObject({
      'orbis/task_status': 'waiting',
    });
  });

  test('orbis_finish с may_close=true: тикет done, completed_at проставлен сервером, waiting_for снят', async () => {
    const { ticketId, runId } = await claimed('Работа с правом закрытия', true);
    // Хвост от прошлого ожидания владельца: уходя из waiting, глагол обязан его снять —
    // иначе рядом с `done` висел бы незакрытый вопрос
    await patchTask(ticketId, { waiting_for: 'старый вопрос с чекпойнта' });
    const f = okResult<FinishResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
        run_id: runId,
        report: 'Готово, тикет можно закрывать.',
      }),
    );
    expect(f.ticket_status).toBe('done');

    const task = (await propsOf(owner, ticketId)) as AnyRecord;
    expect(task['orbis/task_status']).toBe('done');
    // completed_at ставит сам executor (§3.2) — глагол его не подставляет
    expect(task['orbis/completed_at']).toBe(iso(T2));
    expect(task['orbis/waiting_for']).toBeUndefined();

    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('finished');
    expect(run['orbis/run_report']).toBe('Готово, тикет можно закрывать.');
  });

  // Проба расхождением колонок (§А1-1): аспект НАЗНАЧЕНИЯ снят, `orbis/may_close: true` в
  // `props` остался (Р9 — detach значений не трогает). Старая карта теряла право закрытия
  // вместе с аспектом; без признака носителя агент закрывал бы тикет `done` по праву,
  // которое владелец уже снял. Предусловия по `orbis/executor`/`orbis/grant` снятие
  // переживают, поэтому сам батч проходит — различает случай только признак.
  test('снятый аспект назначения снимает и право закрытия, хотя may_close остался в props (Р9)', async () => {
    const { ticketId, runId } = await claimed('Работа с отозванным правом', true);
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: ticketId, aspects: { detach: ['orbis/assignment'] } },
        },
      ],
    });
    if (!r.ok) throw new Error(`аспект не снят: ${r.error.code} ${r.error.message}`);
    expect((await propsOf(owner, ticketId))['orbis/may_close']).toBe(true);

    const f = okResult<FinishResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
        run_id: runId,
        report: 'Готово, проверь.',
      }),
    );
    expect(f.ticket_status).toBe('waiting');
    expect((await propsOf(owner, ticketId))['orbis/task_status']).toBe('waiting');
  });

  test('повтор orbis_finish с тем же id — replay: тот же ответ, вторая работа не делалась (§7.8, С7)', async () => {
    const { ticketId, runId } = await claimed('Идемпотентный итог');
    const callId = newId();
    const ctx = worker(owner, grantId, { clock: () => T2 });
    const report = 'Готово, проверь ветку.';
    const a = okResult<FinishResult>(
      await dispatchTool(ctx, 'orbis_finish', { run_id: runId, report, id: callId }),
    );
    // Повтор идёт по УЖЕ терминальному прогону: отказать по прочитанному состоянию
    // нельзя — сохранённый ответ обязан вернуться (иначе агент сочтёт работу несделанной)
    const b = okResult<FinishResult>(
      await dispatchTool(ctx, 'orbis_finish', { run_id: runId, report, id: callId }),
    );
    expect(b).toEqual(a);
    expect(b.action_id).toBe(callId);
    // Ровно один action на оба вызова — второй раз ничего не применялось
    expect((await actionsOf(owner)).filter((x) => x.id === callId)).toHaveLength(1);

    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('finished');
    expect(run['orbis/run_finished_at']).toBe(iso(T2));
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'waiting' });
  });

  test('повтор orbis_checkpoint с тем же id — replay: тот же ответ, второй вопрос не задан', async () => {
    const { ticketId, runId } = await claimed('Идемпотентный чекпойнт');
    const callId = newId();
    const ctx = worker(owner, grantId, { clock: () => T2 });
    const question = 'Брать zod или ajv?';
    const a = okResult<CheckpointResult>(
      await dispatchTool(ctx, 'orbis_checkpoint', { run_id: runId, question, id: callId }),
    );
    const b = okResult<CheckpointResult>(
      await dispatchTool(ctx, 'orbis_checkpoint', { run_id: runId, question, id: callId }),
    );
    expect(b).toEqual(a);
    expect(b.ticket_status).toBe('waiting');
    expect((await actionsOf(owner)).filter((x) => x.id === callId)).toHaveLength(1);
    expect(await propsOf(owner, ticketId)).toMatchObject({
      'orbis/task_status': 'waiting',
      'orbis/waiting_for': question,
    });
  });

  test('повтор orbis_run_step с тем же id ПОСЛЕ закрытия прогона — replay, а не CONFLICT', async () => {
    const { runId } = await claimed('Шаг, переживший закрытие');
    const callId = newId();
    const a = okResult<RunStepResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T1 }), 'orbis_run_step', {
        run_id: runId,
        summary: 'Единственный шаг',
        id: callId,
      }),
    );
    await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
      run_id: runId,
      report: 'Готово',
    });
    // Ретрай сети приходит уже к закрытому прогону: у вызова есть ключ идемпотентности,
    // и правильный ответ — сохранённый результат ТОГО шага, а не отказ по исходу
    const b = okResult<RunStepResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_run_step', {
        run_id: runId,
        summary: 'Единственный шаг',
        id: callId,
      }),
    );
    expect(b).toEqual(a);
    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/step_count']).toBe(1);
    expect(run['orbis/run_outcome']).toBe('finished');
  });

  test('терминальность (инвариант 5): после checkpoint, finish и подметания orbis_run_step и orbis_finish → CONFLICT со ссылкой на исход', async () => {
    const cp = await claimed('Терминальность чекпойнта');
    await dispatchTool(worker(owner, grantId, { clock: () => T1 }), 'orbis_checkpoint', {
      run_id: cp.runId,
      question: 'Что дальше?',
    });
    const stepAfterCheckpoint = errorOf(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_run_step', {
        run_id: cp.runId,
        summary: 'поздний шаг',
      }),
    );
    expect(stepAfterCheckpoint.code).toBe('CONFLICT');
    expect((stepAfterCheckpoint.details as AnyRecord).outcome).toBe('checkpoint');
    const finishAfterCheckpoint = errorOf(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
        run_id: cp.runId,
        report: 'поздний итог',
      }),
    );
    expect(finishAfterCheckpoint.code).toBe('CONFLICT');
    expect((finishAfterCheckpoint.details as AnyRecord).outcome).toBe('checkpoint');
    const cpRun = (await propsOf(owner, cp.runId)) as AnyRecord;
    expect(cpRun['orbis/run_outcome']).toBe('checkpoint');
    expect(cpRun['orbis/step_count']).toBe(0);
    expect(cpRun['orbis/run_report']).toBeUndefined();

    const fin = await claimed('Терминальность итога');
    await dispatchTool(worker(owner, grantId, { clock: () => T1 }), 'orbis_finish', {
      run_id: fin.runId,
      report: 'Готово',
    });
    const stepAfterFinish = errorOf(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_run_step', {
        run_id: fin.runId,
        summary: 'ещё шажок',
      }),
    );
    expect(stepAfterFinish.code).toBe('CONFLICT');
    expect((stepAfterFinish.details as AnyRecord).outcome).toBe('finished');
    const finishAfterFinish = errorOf(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
        run_id: fin.runId,
        report: 'ещё один итог',
      }),
    );
    expect(finishAfterFinish.code).toBe('CONFLICT');
    expect((finishAfterFinish.details as AnyRecord).outcome).toBe('finished');
    // СВЕЖИЙ id предпроверку проходит (она пропускает вызовы с ключом ради replay) —
    // отказ приходит предусловием, но ответ обязан быть тем же самым
    const finishFreshId = errorOf(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
        run_id: fin.runId,
        report: 'итог со свежим id',
        id: newId(),
      }),
    );
    expect(finishFreshId.code).toBe('CONFLICT');
    expect((finishFreshId.details as AnyRecord).outcome).toBe('finished');
    const stepFreshId = errorOf(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_run_step', {
        run_id: fin.runId,
        summary: 'шаг со свежим id',
        id: newId(),
      }),
    );
    expect(stepFreshId.code).toBe('CONFLICT');
    expect((stepFreshId.details as AnyRecord).outcome).toBe('finished');

    // Подметённый прогон терминален так же: агент вернулся через час — работа уже не его
    const ab = await claimed('Терминальность брошенного');
    await sweepStaleRuns(db, {
      ownerId: owner,
      actorKind: 'owner',
      clock: () => new Date(T0.getTime() + 31 * MINUTE),
    });
    const stepAfterSweep = errorOf(
      await dispatchTool(
        worker(owner, grantId, { clock: () => new Date(T0.getTime() + 32 * MINUTE) }),
        'orbis_run_step',
        { run_id: ab.runId, summary: 'вернулся к работе' },
      ),
    );
    expect(stepAfterSweep.code).toBe('CONFLICT');
    expect((stepAfterSweep.details as AnyRecord).outcome).toBe('abandoned');
    expect(String((stepAfterSweep.details as AnyRecord).note)).toContain('оборван');
    const finishAfterSweep = errorOf(
      await dispatchTool(
        worker(owner, grantId, { clock: () => new Date(T0.getTime() + 32 * MINUTE) }),
        'orbis_finish',
        { run_id: ab.runId, report: 'итог после обрыва', id: newId() },
      ),
    );
    expect(finishAfterSweep.code).toBe('CONFLICT');
    expect((finishAfterSweep.details as AnyRecord).outcome).toBe('abandoned');
    // Заметка об обрыве едет и по пути предусловия: её глагол берёт из прочитанного прогона
    expect(String((finishAfterSweep.details as AnyRecord).note)).toContain('оборван');
  });

  test('orbis_finish по тикету не в in_progress (владелец вернул руками) → CONFLICT, прогон остался running', async () => {
    const { ticketId, runId } = await claimed('Владелец вернул тикет');
    await patchTask(ticketId, { status: 'planned' });

    const e = errorOf(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
        run_id: runId,
        report: 'Готово',
      }),
    );
    expect(e.code).toBe('CONFLICT');

    // Batch откатился целиком: ни исхода прогона, ни отчёта — иначе прогон был бы
    // терминален, а тикет об этом не знал
    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('running');
    expect(run['orbis/run_report']).toBeUndefined();
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'planned' });
  });

  test('владелец переназначил тикет другому гранту между захватом и итогом → orbis_finish CONFLICT, тикет и прогон не тронуты', async () => {
    // may_close=true намеренно: без сверки «тикет всё ещё МОЙ» право закрытия читалось бы
    // из ЧУЖОГО назначения — и прогон закрыл бы тикет, который владелец уже отдал другому.
    const { ticketId, runId } = await claimed('Тикет, отданный другому', true);
    await patchAssignment(ticketId, {
      executor: 'agent',
      grant_id: otherGrantId,
      may_close: true,
    });

    const e = errorOf(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_finish', {
        run_id: runId,
        report: 'Готово',
      }),
    );
    expect(e.code).toBe('CONFLICT');

    // Batch откатился целиком: тикет остался в работе и с чужим назначением, прогон — running
    expect(await propsOf(owner, ticketId)).toMatchObject({
      'orbis/task_status': 'in_progress',
    });
    expect(await propsOf(owner, ticketId)).toMatchObject({
      'orbis/grant': otherGrantId,
    });
    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('running');
    expect(run['orbis/run_report']).toBeUndefined();
  });

  test('архивированный тикет: orbis_claim_task → NOT_FOUND, прогон не создан', async () => {
    const ticketId = await makeTicket('Тикет, убранный в архив');
    await archive(ticketId);

    expect(
      errorCode(
        await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
      ),
    ).toBe('NOT_FOUND');
    expect(await childrenOf(owner, ticketId)).toHaveLength(0);
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'planned' });
  });

  test('архивированный прогон: orbis_run_step → NOT_FOUND (для глаголов прогона больше нет)', async () => {
    const { runId } = await claimed('Прогон, убранный в архив');
    await archive(runId);

    expect(
      errorCode(
        await dispatchTool(worker(owner, grantId, { clock: () => T1 }), 'orbis_run_step', {
          run_id: runId,
          summary: 'шаг в архивный прогон',
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(await propsOf(owner, runId)).toMatchObject({ 'orbis/step_count': 0 });
  });

  test('прогон другого гранта: orbis_run_step/checkpoint/finish → CONFLICT «другому субъекту»; чужой владелец и несуществующий прогон → NOT_FOUND', async () => {
    const { runId } = await claimed('Прогон первого исполнителя');
    const foreign = worker(owner, otherGrantId, { clock: () => T1 });
    const e = errorOf(
      await dispatchTool(foreign, 'orbis_run_step', { run_id: runId, summary: 'чужой шаг' }),
    );
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toContain('другому субъекту');
    expect(
      errorCode(await dispatchTool(foreign, 'orbis_checkpoint', { run_id: runId, question: 'а?' })),
    ).toBe('CONFLICT');
    expect(
      errorCode(await dispatchTool(foreign, 'orbis_finish', { run_id: runId, report: 'готово' })),
    ).toBe('CONFLICT');
    expect(await propsOf(owner, runId)).toMatchObject({
      'orbis/run_outcome': 'running',
      'orbis/step_count': 0,
    });

    // Чужой (RLS) и несуществующий прогон неразличимы намеренно: оба NOT_FOUND
    const stranger = freshUserId();
    const alien = await seedEntity(stranger, {
      title: 'Прогон постороннего',
      tags: [],
      aspects: {
        'orbis/agent-run': {
          grant_id: newId(),
          outcome: 'running',
          started_at: iso(T0),
          last_step_at: iso(T0),
          step_count: 0,
          steps: [],
        },
      },
    });
    expect(
      errorCode(
        await dispatchTool(worker(owner, grantId), 'orbis_run_step', {
          run_id: alien.id,
          summary: 'шаг в чужой прогон',
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      errorCode(
        await dispatchTool(worker(owner, grantId), 'orbis_run_step', {
          run_id: newId(),
          summary: 'шаг в никуда',
        }),
      ),
    ).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Субъект прогона — рутина (V1.4, V1.5): те же глаголы, другой хозяин прогона
// ---------------------------------------------------------------------------

describe('субъект прогона — рутина (V1.5)', () => {
  const owner = freshUserId();
  const MINUTE = 60_000;
  const T1 = new Date(T0.getTime() + 5 * MINUTE);

  /**
   * Контекст вызова из ЖИВОГО прогона рутины: `routineCtx` минтит id сам (гейту режима
   * сущности не нужны), а глаголам нужны настоящие — иначе `readRun` не найдёт прогон.
   */
  function fromRun(
    routineId: string,
    runId: string,
    mode: 'propose' | 'act' = 'propose',
    tools: string[] = [],
    over: Partial<ToolCallCtx> = {},
  ) {
    return routineCtx(owner, mode, tools, {
      routine: { id: routineId, runId, mode, allowedTools: new Set(tools) },
      ...over,
    });
  }

  /** VerbCtx рутины для внутренних вызовов раннера (closeRoutineRun — не тул). */
  function verbCtx(routineId: string, clock: () => Date = () => T0): VerbCtx {
    return {
      db,
      ownerId: owner,
      subject: { kind: 'routine', routineId },
      clock,
      sink: makeChatJournalSink(),
    };
  }

  /**
   * Открытая единица пачки на прогоне — НАСТОЯЩИМ путём (`orbis_ask` через диспатч), а не
   * вставкой в ленту руками: флажок `undecided` считается пробой по pending-записям, и сид
   * мимо `createPending` проверял бы форму записи, которой в проде не бывает.
   */
  async function askFrom(routineId: string, runId: string, question: string): Promise<string> {
    return okResult<AskResult>(
      await dispatchTool(fromRun(routineId, runId), 'orbis_ask', { run_id: runId, question }),
    ).pending_id;
  }

  test('orbis_checkpoint от рутинного прогона: outcome checkpoint, тикет не нужен; журнал — actor ai, source system, run_id', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина чекпойнта' });
    const { runId } = await seedRoutineRun(owner, { routineId });

    const r = await dispatchTool(fromRun(routineId, runId), 'orbis_checkpoint', {
      run_id: runId,
      question: 'Заводить задачу на разбор писем?',
    });
    expect(r.status).toBe('ok');
    const c = okResult<CheckpointResult>(r);
    expect(c.run_id).toBe(runId);
    // Тикета у рутинного прогона нет вовсе: прогон — дочерняя РУТИНЕ сущность (V1.4)
    expect(c.ticket_id).toBeUndefined();
    expect(c.ticket_status).toBeUndefined();

    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('checkpoint');
    expect(run['orbis/run_checkpoint']).toEqual({
      question: 'Заводить задачу на разбор писем?',
      asked_at: iso(T0),
    });
    expect(run['orbis/run_routine']).toBe(routineId);
    expect(run['orbis/grant']).toBeUndefined();
    // Единиц пачки у этого прогона нет — флажка тоже нет (не `false`): ставит его только
    // проба, нашедшая открытое, а «прогон без пачки» и «пачка разобрана» — разные события
    expect(run['orbis/undecided']).toBeUndefined();

    // Бухгалтерия прогона (Р-7): актор — внутренний AI, источник — system, прогон адресован
    const action = (await actionsOf(owner)).find((a) => a.id === c.action_id);
    expect(action?.actor_kind).toBe('ai');
    expect(action?.source).toBe('system');
    expect(action?.run_id).toBe(runId);
    expect(action?.actor_grant_id).toBeUndefined();
  });

  test('orbis_run_step рутинного прогона (вызовом раннера) пишет шаг с CAS-счётчиком; прогон другой рутины → CONFLICT «другому субъекту»', async () => {
    // Шаг рутинного прогона идёт НЕ через dispatchTool: `orbis_run_step` закрыт рутине в
    // реестре (V1.5, ROUTINE_CLOSED_VERBS) — бухгалтерию прогона ведёт раннер, а не
    // модель. Раннер зовёт глагол напрямую, этим путём и проверяем.
    const routineId = await seedRoutine(owner, { title: 'Рутина шагов' });
    const { runId } = await seedRoutineRun(owner, { routineId });
    const ctx = verbCtx(routineId, () => T1);

    const first = okResult<RunStepResult>(
      await runAgentVerb(ctx, 'orbis_run_step', { run_id: runId, summary: 'Прочитал задачи дня' }),
    );
    expect(first.step_count).toBe(1);
    const second = okResult<RunStepResult>(
      await runAgentVerb(ctx, 'orbis_run_step', { run_id: runId, summary: 'Собрал предложение' }),
    );
    expect(second.step_count).toBe(2);
    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/step_count']).toBe(2);
    expect((run['orbis/run_steps'] as AnyRecord[]).map((s) => s.seq)).toEqual([1, 2]);
    expect(run['orbis/last_step_at']).toBe(iso(T1));

    // Чужой субъект — не «не найдено», а конфликт: прогон есть, но он не этой рутины
    const otherId = await seedRoutine(owner, { title: 'Соседняя рутина' });
    const e = errorOf(
      await runAgentVerb(verbCtx(otherId), 'orbis_run_step', {
        run_id: runId,
        summary: 'шаг в чужой прогон',
      }),
    );
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toContain('другому субъекту');
    expect((await propsOf(owner, runId))['orbis/step_count']).toBe(2);

    // Модели тот же глагол закрыт — даже вписанный владельцем в allowed_tools (V1.5)
    const denied = errorOf(
      await dispatchTool(fromRun(routineId, runId, 'act', ['orbis_run_step']), 'orbis_run_step', {
        run_id: runId,
        summary: 'шаг рукой модели',
      }),
    );
    expect(denied.code).toBe('FORBIDDEN_LEVEL');
    expect((await propsOf(owner, runId))['orbis/step_count']).toBe(2);
  });

  test('closeRoutineRun: finished с отчётом и failed с fail_note; повтор с тем же id — replay', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина исходов' });
    const good = await seedRoutineRun(owner, { routineId, bucket: '2026-08-17T08:00' });
    const bad = await seedRoutineRun(owner, { routineId, bucket: '2026-08-17T09:00' });

    const fin = await closeRoutineRun(verbCtx(routineId), {
      runId: good.runId,
      outcome: 'finished',
      report: 'Предложение отправлено владельцу',
    });
    expect(fin.status).toBe('ok');
    const finRun = (await propsOf(owner, good.runId)) as AnyRecord;
    expect(finRun['orbis/run_outcome']).toBe('finished');
    expect(finRun['orbis/run_report']).toBe('Предложение отправлено владельцу');
    expect(finRun['orbis/run_finished_at']).toBe(iso(T0));

    const callId = newId();
    const failed = okResult<FinishResult>(
      await closeRoutineRun(verbCtx(routineId), {
        runId: bad.runId,
        outcome: 'failed',
        failNote: 'модель вернула отказ на третьем шаге',
        id: callId,
      }),
    );
    const failedRun = (await propsOf(owner, bad.runId)) as AnyRecord;
    expect(failedRun['orbis/run_outcome']).toBe('failed');
    expect(failedRun['orbis/fail_note']).toBe('модель вернула отказ на третьем шаге');
    expect(failedRun['orbis/abandon_note']).toBeUndefined();

    // Повтор ТОГО ЖЕ вызова (§7.8) отдаёт сохранённый ответ, а не второй action
    const replay = okResult<FinishResult>(
      await closeRoutineRun(verbCtx(routineId), {
        runId: bad.runId,
        outcome: 'failed',
        failNote: 'модель вернула отказ на третьем шаге',
        id: callId,
      }),
    );
    expect(replay.action_id).toBe(failed.action_id);
    expect((await actionsOf(owner)).filter((a) => a.id === callId)).toHaveLength(1);
  });

  test("closeRoutineRun: открытая единица → close-патч несёт undecided:true ОДНИМ action'ом; единственная решённая → флажка нет (D42 ОЧ.6, С1)", async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина с пачкой' });

    // 1. Прогон оставил после себя нерешённое. Флажок — единственный дешёвый способ узнать
    // об этом (его читают бейдж, смарт-лист и экран прогона), и ставится он ТЕМ ЖЕ патчем,
    // что исход: два патча дали бы миг «прогон закрыт, а нерешённого при нём нет».
    const open = await seedRoutineRun(owner, { routineId, bucket: '2026-08-18T07:00' });
    await askFrom(routineId, open.runId, 'Переносить ли встречу с понедельника?');
    const closed = okResult<FinishResult>(
      await closeRoutineRun(verbCtx(routineId), {
        runId: open.runId,
        outcome: 'finished',
        report: 'Разобрал день, один вопрос оставил владельцу.',
      }),
    );
    const openRun = (await propsOf(owner, open.runId)) as AnyRecord;
    expect(openRun['orbis/run_outcome']).toBe('finished');
    expect(openRun['orbis/undecided']).toBe(true);
    // Ровно один action на прогон — закрывающий: бухгалтерской дозаписи флажка следом нет
    expect(
      (await actionsOf(owner)).filter((a) => a.run_id === open.runId).map((a) => a.id),
    ).toEqual([closed.action_id]);
    // Актор прежний (§9.6): писатель флажка обязан быть `system`, иначе «отмени последнее»
    // после «Принять» снимало бы флажок вместо действия владельца (undo пропускает system)
    const action = (await actionsOf(owner)).find((a) => a.id === closed.action_id);
    expect(action?.actor_kind).toBe('ai');
    expect(action?.source).toBe('system');

    // 2. Единственная единица прогона решена владельцем — писать нечего: флажка нет вовсе
    const decided = await seedRoutineRun(owner, { routineId, bucket: '2026-08-18T08:00' });
    const pendingId = await askFrom(routineId, decided.runId, 'Брать ли отчёт сегодня?');
    expect(
      await answerPendingQuestion(db, { ownerId: owner, pendingId, answer: 'да, бери' }),
    ).toEqual({ status: 'answered', pendingId });
    expect(
      (
        await closeRoutineRun(verbCtx(routineId), {
          runId: decided.runId,
          outcome: 'finished',
          report: 'Владелец ответил, всё разобрано.',
        })
      ).status,
    ).toBe('ok');
    const decidedRun = (await propsOf(owner, decided.runId)) as AnyRecord;
    expect(decidedRun['orbis/run_outcome']).toBe('finished');
    expect(decidedRun['orbis/undecided']).toBeUndefined();
  });

  test('orbis_checkpoint рутинного прогона с открытой единицей: терминальный вопрос И пачка сосуществуют — {outcome:checkpoint, undecided:true} одним патчем (ОЧ.6, приёмка 9)', async () => {
    // Третий путь закрытия (Р-5) — и единственный, где `checkpoint` вообще начинает
    // различать субъекта: грантовая половина обязана остаться прежней, рутинная — нести
    // флажок. Прогон при этом закрывается ОБЫЧНЫМ терминальным исходом: `RUN_OUTCOMES` не
    // расширяется, «отложивший» прогон — не новый вид прогона (ОЧ.6).
    const routineId = await seedRoutine(owner, { title: 'Рутина чекпойнта поверх пачки' });
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-18T09:00' });
    await askFrom(routineId, runId, 'Какой из двух отчётов сдавать первым?');

    const question = 'Без решения по бюджету дальше двигаться некуда — что делаем?';
    const c = okResult<CheckpointResult>(
      await dispatchTool(fromRun(routineId, runId), 'orbis_checkpoint', {
        run_id: runId,
        question,
      }),
    );
    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('checkpoint');
    expect(run['orbis/run_checkpoint']).toEqual({ question, asked_at: iso(T0) });
    expect(run['orbis/undecided']).toBe(true);
    // Одним action'ом и прежним актором — те же два довода, что у closeRoutineRun выше
    expect((await actionsOf(owner)).filter((a) => a.run_id === runId).map((a) => a.id)).toEqual([
      c.action_id,
    ]);
    const action = (await actionsOf(owner)).find((a) => a.id === c.action_id);
    expect(action?.actor_kind).toBe('ai');
    expect(action?.source).toBe('system');
  });

  test('orbis_my_queue / orbis_claim_task рутине закрыты дважды: гейт режима (FORBIDDEN_LEVEL) и сам глагол (VALIDATION)', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина без очереди' });
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-17T10:00' });
    // Владелец мог вписать эти имена в allowed_tools — реестр рутины их всё равно не
    // отдаёт (V1.5): у прогона рутины нет ни очереди, ни тикета
    const ctx = fromRun(routineId, runId, 'act', ['orbis_my_queue', 'orbis_claim_task']);

    expect(errorOf(await dispatchTool(ctx, 'orbis_my_queue', {})).code).toBe('FORBIDDEN_LEVEL');
    expect(errorOf(await dispatchTool(ctx, 'orbis_claim_task', { ticket_id: newId() })).code).toBe(
      'FORBIDDEN_LEVEL',
    );

    // Второй рубеж — сам глагол: он отказывает и внутреннему вызову раннера (fail-closed)
    const verbs = verbCtx(routineId);
    const queue = errorOf(await runAgentVerb(verbs, 'orbis_my_queue', {}));
    expect(queue.code).toBe('VALIDATION');
    expect(queue.message).toContain('только для гранта');
    const claim = errorOf(await runAgentVerb(verbs, 'orbis_claim_task', { ticket_id: newId() }));
    expect(claim.code).toBe('VALIDATION');
    expect(claim.message).toContain('только для гранта');
  });

  test('грантовый путь не изменился: захват → шаг → итог по-прежнему ведут тикет', async () => {
    const grantOwner = freshUserId();
    const grantId = await workerGrant(grantOwner, 'грантовый путь после обобщения');
    const ticket = await seedEntity(grantOwner, {
      title: 'Тикет грантового пути',
      tags: [],
      aspects: {
        'orbis/task': { status: 'planned' },
        'orbis/assignment': { executor: 'agent', grant_id: grantId },
      },
    });
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(worker(grantOwner, grantId), 'orbis_claim_task', { ticket_id: ticket.id }),
    );
    const step = okResult<RunStepResult>(
      await dispatchTool(worker(grantOwner, grantId, { clock: () => T1 }), 'orbis_run_step', {
        run_id: claim.run_id,
        summary: 'Шаг грантового прогона',
      }),
    );
    expect(step.step_count).toBe(1);
    const fin = okResult<FinishResult>(
      await dispatchTool(worker(grantOwner, grantId, { clock: () => T1 }), 'orbis_finish', {
        run_id: claim.run_id,
        report: 'Готово, проверь',
      }),
    );
    expect(fin.ticket_id).toBe(ticket.id);
    expect(fin.ticket_status).toBe('waiting');
    const run = (await propsOf(grantOwner, claim.run_id)) as AnyRecord;
    expect(run['orbis/grant']).toBe(grantId);
    expect(run['orbis/run_routine']).toBeUndefined();
    expect(await propsOf(grantOwner, ticket.id)).toMatchObject({
      'orbis/task_status': 'waiting',
      'orbis/waiting_for': 'Готово, проверь',
    });
  });
});
