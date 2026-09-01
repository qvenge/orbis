// apps/server/src/routines/propose.test.ts
// Терминальный глагол рутины `orbis_propose` (V1.6, V1.7) против живой БД: форма
// предложения, автоснятые предусловия, запрет по объекту, судьба pending и прогона.
//
// Через `dispatchTool`, а не прямым вызовом `runPropose`: гейт режима (V1.10), реестр и
// разбор envelope — часть контракта глагола, и проверять его в обход них значило бы
// закрыть тестом путь, которым модель не ходит.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId, newId, type ProposeResult, pendingMessageId } from '@orbis/shared';
import { eq, sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { rollbackRun } from '../agent-loop/rollback';
import { closeRoutineRun, runAgentVerb } from '../agent-loop/verbs';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { issuePatGrant, verifyBearer } from '../oauth/grants';
import { approvePending, rejectPending } from '../policy/pending';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { AGENT_VERB_NAMES, buildToolRegistry, WORKER_SCOPE_TOOLS } from '../tools/registry';
import { proposalView } from './lifecycle';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const {
  actionsOf,
  propsOf,
  routineCtx,
  seedEntity,
  seedRoutine,
  seedRoutineRun,
  worker,
  workerGrant,
} = agentLoopHelpers(db);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

interface LiveRoutine {
  routineId: string;
  runId: string;
  ctx: ToolCallCtx;
}

/** Рутина + её живой прогон + контекст вызова, указывающий ровно на них. */
async function liveRoutine(): Promise<LiveRoutine> {
  const routineId = await seedRoutine(owner);
  const { runId } = await seedRoutineRun(owner, { routineId });
  const ctx = routineCtx(owner, 'propose', [], {
    routine: { id: routineId, runId, mode: 'propose', allowedTools: new Set() },
  });
  return { routineId, runId, ctx };
}

/** Задача-цель предложения: статус есть, срока нет — обе формы предусловия сразу. */
async function seedTask(title: string): Promise<string> {
  const e = await seedEntity(owner, {
    title,
    tags: [],
    props: { 'orbis/task_status': 'inbox' },
    aspects: ['orbis/task'],
  });
  return e.id;
}

async function messageById(id: string) {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select().from(chatMessages).where(eq(chatMessages.id, id)),
  );
  return rows[0];
}

/** Сколько pending-карточек лежит в треде рутины. */
async function pendingsInRoutineThread(routineId: string): Promise<number> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, entityThreadId(owner, routineId))),
  );
  return rows.filter((r) => (r.metadata as { pending?: unknown }).pending !== undefined).length;
}

function expectError(r: Awaited<ReturnType<typeof dispatchTool>>, code: string): void {
  expect(r.status).toBe('error');
  if (r.status === 'error') expect(r.error.code).toBe(code);
}

function errorOf(r: Awaited<ReturnType<typeof dispatchTool>>) {
  if (r.status !== 'error') throw new Error(`ожидался отказ, получено «${r.status}»`);
  return r.error;
}

const EXPLANATION = 'Задача висит в инбоксе третий день — предлагаю взять её сегодня.';

// ---------------------------------------------------------------------------

describe('orbis_propose: предложение и предусловия (V1.6, V1.7)', () => {
  test('две правки (status + отсутствующий due_date) → pending в треде рутины с proposal_card, прогон finished с proposal pending; payload несёт in:[inbox] и absent:true', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Разобрать инбокс');

    const r = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: taskId,
            props: { 'orbis/task_status': 'planned', 'orbis/due_date': '2026-08-20' },
          },
        },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const result = r.result as ProposeResult;
    expect(result.run_id).toBe(runId);
    // А вот ответ ТУЛУ по-прежнему про операции: он про размер батча, а не про экран.
    expect(result.operations).toBe(1);
    expect(result.replayed).toBe(false);

    // Pending лежит в треде РУТИНЫ (V1.6), а не в глобальном: предложение — событие рутины
    const msg = await messageById(result.pending_id);
    expect(msg).toBeDefined();
    expect(msg?.threadId).toBe(entityThreadId(owner, routineId));
    // Строка ленты называет событие, а не «Требуется подтверждение: N операций» (D-4).
    // ДВЕ, хотя операция одна: считаются СТРОКИ предложения (`countProposalRows`) — их
    // владелец и видит списком, и здесь их ровно две, `status` и `due_date`. Пока считали
    // операции, лента говорила «1 правка» под списком из двух строк (смоук Ш1, 4.6.1).
    expect(msg?.content).toBe('Предложение рутины: 2 правки');

    const metadata = msg?.metadata as {
      pending: {
        tool: string;
        source: string;
        actor_kind: string;
        run_id?: string;
        input: unknown;
      };
      cards: unknown[];
    };
    expect(metadata.pending.tool).toBe('batch_execute');
    expect(metadata.pending.source).toBe('routine');
    expect(metadata.pending.actor_kind).toBe('ai');
    expect(metadata.pending.run_id).toBe(runId);

    // Автоснятые предусловия (V1.7, §А7-3): адрес — id СВОЙСТВА, текущее значение — в `in`,
    // отсутствующее — `absent`
    const payload = metadata.pending.input as {
      operations: Array<{ tool: string; input: Record<string, unknown> }>;
    };
    expect(payload.operations).toHaveLength(1);
    expect(payload.operations[0]?.tool).toBe('entity_update');
    expect(payload.operations[0]?.input.precondition).toEqual([
      { property: 'orbis/task_status', in: ['inbox'] },
      { property: 'orbis/due_date', absent: true },
    ]);

    // Карточка предложения (V1.6) — своя, не confirmation_card
    expect(metadata.cards).toEqual([
      {
        kind: 'proposal_card',
        pendingId: result.pending_id,
        runId,
        routineId,
        summary: '2 правки',
        explanation: EXPLANATION,
      },
    ]);

    // Прогон закрыт ТЕМ ЖЕ вызовом: исход и судьба предложения — одним патчем
    const run = await propsOf(owner, runId);
    expect(run['orbis/run_outcome']).toBe('finished');
    expect(run['orbis/run_report']).toBe(EXPLANATION);
    expect(run['orbis/run_proposal']).toEqual({ pending_id: result.pending_id, status: 'pending' });
    // Само предложение — НЕ единица пачки (D42, приёмка 11): его запись живёт под тем же
    // `run_id`, но явного `kind` не несёт, и проба `undecided` её не видит. Иначе каждый
    // propose-прогон попадал бы в блок «Пачка решений» списка «Рутины» и в счётчик
    // `overview.undecided`, хотя разбирать в нём нечего: предложение решается своим путём
    expect(run['orbis/undecided']).toBeUndefined();

    // До решения владельца граф не тронут
    expect(await propsOf(owner, taskId)).toMatchObject({ 'orbis/task_status': 'inbox' });
    // `toEqual` по всему набору свойств не годится: у тикета есть ещё назначение и
    // вычисленные предки. Смысл прежней проверки — «хвоста прошлого ожидания нет».
    expect(await propsOf(owner, taskId)).not.toHaveProperty('orbis/waiting_for');
  });

  test('терминальный propose поверх открытого вопроса: прогон finished с proposal И undecided:true (второй путь закрытия, Р-5 / D42 ОЧ.6)', async () => {
    // `orbis_propose` закрывает прогон СВОИМ вызовом `closeRoutineRun` (propose.ts), минуя
    // settle раннера. Путь отдельный — значит и пропустить флажок он может отдельно: тогда
    // пачка propose-прогона осталась бы владельцу невидимой, хотя карточки в треде лежат.
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Задача предложения с вопросом');

    expect(
      (
        await dispatchTool(ctx, 'orbis_ask', {
          run_id: runId,
          question: 'Переносить ли остальные задачи недели на следующую?',
        })
      ).status,
    ).toBe('ok');

    const r = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const result = r.result as ProposeResult;

    const run = await propsOf(owner, runId);
    expect(run['orbis/run_outcome']).toBe('finished');
    expect(run['orbis/run_proposal']).toEqual({ pending_id: result.pending_id, status: 'pending' });
    // Предложение и пачка на одном прогоне уживаются: их читают разные экраны
    expect(run['orbis/undecided']).toBe(true);
    // В треде рутины две карточки — вопрос и предложение; в счёт `undecided` идёт первая
    expect(await pendingsInRoutineThread(routineId)).toBe(2);
  });

  test('approvePending применяет всё одним батчем с run_id и source routine; rollbackRun возвращает исходное (инвариант 9)', async () => {
    const { runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Задача под одобрение');
    const otherId = await seedTask('Вторая задача предложения');

    const r = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        },
        {
          tool: 'entity_update',
          input: { id: otherId, props: { 'orbis/task_status': 'done' } },
        },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const { pending_id: pendingId } = r.result as ProposeResult;

    const applied = await approvePending(db, { ownerId: owner, pendingId, clock: () => T0 });
    expect(applied.ok).toBe(true);
    expect((await propsOf(owner, taskId))['orbis/task_status']).toBe('planned');
    expect((await propsOf(owner, otherId))['orbis/task_status']).toBe('done');

    // ОДИН action на всё предложение (batch), атрибуция — прогон рутины (V1.6)
    const actions = (await actionsOf(owner)).filter((a) => a.source === 'routine');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe('batch');
    expect(actions[0]?.run_id).toBe(runId);
    expect(actions[0]?.actor_kind).toBe('ai');

    // Инвариант 9: у принятого предложения тот же откат, что у любого прогона
    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(true);
    expect(await propsOf(owner, taskId)).toMatchObject({ 'orbis/task_status': 'inbox' });
    // `toEqual` по всему набору свойств не годится: у тикета есть ещё назначение и
    // вычисленные предки. Смысл прежней проверки — «хвоста прошлого ожидания нет».
    expect(await propsOf(owner, taskId)).not.toHaveProperty('orbis/waiting_for');
    expect(await propsOf(owner, otherId)).toMatchObject({ 'orbis/task_status': 'inbox' });
    // `toEqual` по всему набору свойств не годится: у тикета есть ещё назначение и
    // вычисленные предки. Смысл прежней проверки — «хвоста прошлого ожидания нет».
    expect(await propsOf(owner, otherId)).not.toHaveProperty('orbis/waiting_for');
  });

  test('предложение СНЯТИЯ (`unset`): payload несёт unset, предусловие — текущее значение, строка «снять»', async () => {
    // Снятие значения — вторая половина новой формы (§А9-1), и она не сводится к первой:
    // `null` в `props` это законное ЗНАЧЕНИЕ json-свойства, а не «убрать». Без своей
    // проверки перевод предложения на `props` молча терял бы половину: рутина предлагала
    // бы снять поле, а payload вёз бы `undefined` — то есть ничего.
    const { runId, ctx } = await liveRoutine();
    const waiting = await seedEntity(owner, {
      title: 'Ждём ответа банка',
      tags: [],
      props: { 'orbis/task_status': 'waiting', 'orbis/waiting_for': 'ответа банка' },
      aspects: ['orbis/task'],
    });

    const r = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: waiting.id,
            props: { 'orbis/task_status': 'in_progress' },
            unset: ['orbis/waiting_for'],
          },
        },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const pendingId = (r.result as ProposeResult).pending_id;
    const msg = await messageById(pendingId);
    // Две СТРОКИ на одну операцию: правка и снятие — владелец видит обе.
    expect(msg?.content).toBe('Предложение рутины: 2 правки');

    const payload = (
      msg?.metadata as {
        pending: { input: { operations: Array<{ input: Record<string, unknown> }> } };
      }
    ).pending.input;
    const input = payload.operations[0]?.input as Record<string, unknown>;
    expect(input.props).toEqual({ 'orbis/task_status': 'in_progress' });
    expect(input.unset).toEqual(['orbis/waiting_for']);
    // Предусловие снято и на снимаемое свойство: без него `unset` молча выиграл бы у
    // владельца, успевшего заполнить поле по-своему.
    expect(input.precondition).toEqual([
      { property: 'orbis/task_status', in: ['waiting'] },
      { property: 'orbis/waiting_for', in: ['ответа банка'] },
    ]);

    // Экран предложения: строка снятия называет свойство и «станет» литералом «—».
    const view = await proposalView(db, { ownerId: owner, runId });
    expect(
      view?.operations.map((o) => ({ field: o.field, before: o.before, after: o.after })),
    ).toEqual([
      { field: 'orbis/task_status', before: 'waiting', after: 'in_progress' },
      { field: 'orbis/waiting_for', before: 'ответа банка', after: '—' },
    ]);
  });

  test('предусловие снимается по `props`, а не по проекции: форма значения у них РАЗНАЯ (orbis/progress_source)', async () => {
    // Ловушка перевода. Снять текущее значение можно двумя способами: из `aspects_legacy`
    // (проекция старой формы) или из `props` (то, с чем сверяется executor). У большинства
    // свойств это одно и то же —
    // и именно поэтому подмена прошла бы незаметно. У `orbis/progress_source` формы
    // РАЗНЫЕ: в `props` запрос лежит Q-AST-обёрткой `{text}` (§А5-2), а проекция
    // разворачивает её обратно в строку. Сняв предусловие с проекции, предложение
    // получило бы вечный CONFLICT на «Принять» — у владельца, ни в чём не виноватого.
    const { runId, ctx } = await liveRoutine();
    const goal = await seedEntity(owner, {
      title: 'Пробежать 100 км',
      tags: [],
      // СТАРОЙ картой намеренно: она проходит через переходный перевод, который и
      // заворачивает текст запроса в `{text}` (§А5-2) — то самое расхождение форм, которое
      // тест и проверяет. Путь `execute` обе формы принимает (exec-надмножество).
      props: {
        'orbis/target_value': '100.00',
        'orbis/unit': 'км',
        'orbis/progress_source': {
          query: { text: 'аспект=финансы' },
          aggregate: 'sum',
          field: 'amount',
        },
      },
      aspects: ['orbis/goal'],
    });

    // Две формы одного значения — если они совпадут, тест перестанет что-либо ловить.
    const row = await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT props, aspects_legacy FROM entities WHERE id = ${goal.id}`),
    );
    const stored = (row as unknown as Array<Record<string, unknown>>)[0];
    const inProps = (stored?.props as Record<string, unknown>)['orbis/progress_source'];
    const inLegacy = (stored?.aspects_legacy as Record<string, Record<string, unknown>>)[
      'orbis/goal'
    ]?.progress_source;
    expect(inProps).not.toEqual(inLegacy);

    const proposed = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: goal.id,
            // Патч предложения — НОВОЙ формой (§А9-1), и значение в ней уже такое, каким
            // оно лежит в `props`: обёртка `{text}` запроса, а не голая строка.
            props: {
              'orbis/progress_source': {
                query: { text: 'аспект=финансы' },
                aggregate: 'latest',
                field: 'orbis/amount',
              },
            },
          },
        },
      ],
    });
    expect(proposed.status).toBe('ok');
    if (proposed.status !== 'ok') return;
    const pendingId = (proposed.result as ProposeResult).pending_id;

    // Снятое предусловие — ровно то значение, что лежит в `props`.
    const metadata = (await messageById(pendingId))?.metadata as {
      pending: { input: { operations: Array<{ input: Record<string, unknown> }> } };
    };
    expect(metadata.pending.input.operations[0]?.input.precondition).toEqual([
      { property: 'orbis/progress_source', in: [inProps] },
    ]);

    // И «Принять» проходит: граф с тех пор не менялся.
    const applied = await approvePending(db, { ownerId: owner, pendingId });
    expect(applied.ok).toBe(true);
    const after = await propsOf(owner, goal.id);
    expect(after['orbis/progress_source']).toMatchObject({ aggregate: 'latest' });
  });

  test('ручная правка до approve → CONFLICT precondition_failed с mismatches, ничего не применено (инвариант 8) — и для поля, которого не было', async () => {
    // Сценарий 1: владелец сам сдвинул статус
    const first = await liveRoutine();
    const taskId = await seedTask('Задача, которую тронут руками');
    const untouchedId = await seedTask('Соседняя задача того же предложения');
    const r1 = await dispatchTool(first.ctx, 'orbis_propose', {
      run_id: first.runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        },
        {
          tool: 'entity_update',
          input: { id: untouchedId, props: { 'orbis/task_status': 'done' } },
        },
      ],
    });
    expect(r1.status).toBe('ok');
    if (r1.status !== 'ok') return;
    const pending1 = (r1.result as ProposeResult).pending_id;

    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'in_progress' } },
        },
      ],
    });

    const denied = await approvePending(db, { ownerId: owner, pendingId: pending1 });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('CONFLICT');
    const details = denied.error.details as { reason: string; mismatches: unknown[] };
    expect(details.reason).toBe('precondition_failed');
    expect(details.mismatches).toEqual([
      { property: 'orbis/task_status', expected: ['inbox'], actual: 'in_progress' },
    ]);
    // «Всё или ничего»: соседняя операция того же предложения тоже не применилась
    expect((await propsOf(owner, untouchedId))['orbis/task_status']).toBe('inbox');

    // Сценарий 2: владелец заполнил поле, которого при снятии предусловия НЕ БЫЛО
    const second = await liveRoutine();
    const dueId = await seedTask('Задача, которой поставят срок');
    const r2 = await dispatchTool(second.ctx, 'orbis_propose', {
      run_id: second.runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: dueId, props: { 'orbis/due_date': '2026-08-20' } },
        },
      ],
    });
    expect(r2.status).toBe('ok');
    if (r2.status !== 'ok') return;
    const pending2 = (r2.result as ProposeResult).pending_id;

    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: dueId, props: { 'orbis/due_date': '2026-09-01' } },
        },
      ],
    });

    const denied2 = await approvePending(db, { ownerId: owner, pendingId: pending2 });
    expect(denied2.ok).toBe(false);
    if (denied2.ok) return;
    expect(denied2.error.code).toBe('CONFLICT');
    const details2 = denied2.error.details as { reason: string; mismatches: unknown[] };
    expect(details2.reason).toBe('precondition_failed');
    expect(details2.mismatches).toEqual([
      { property: 'orbis/due_date', expected: 'absent', actual: '2026-09-01' },
    ]);
    expect((await propsOf(owner, dueId))['orbis/due_date']).toBe('2026-09-01');
  });
});

describe('orbis_propose: форма и запрет по объекту (V1.6, инвариант 6)', () => {
  test('attach_* / batch_execute / thread_post / >50 операций / precondition во входе / detach аспекта → VALIDATION', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель форменных отказов');
    const base = { run_id: runId, explanation: EXPLANATION };

    for (const tool of ['attach_orbis_task', 'batch_execute', 'thread_post', 'entity_get']) {
      expectError(
        await dispatchTool(ctx, 'orbis_propose', {
          ...base,
          operations: [{ tool, input: { entity_id: taskId, data: { status: 'done' } } }],
        }),
        'VALIDATION',
      );
    }

    // Потолок 50 (V1.6) — 51-я операция отклоняется схемой входа
    expectError(
      await dispatchTool(ctx, 'orbis_propose', {
        ...base,
        operations: Array.from({ length: 51 }, () => ({
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        })),
      }),
      'VALIDATION',
    );

    // Непротекание: предусловия снимает СЕРВЕР, модель их не подставляет
    expectError(
      await dispatchTool(ctx, 'orbis_propose', {
        ...base,
        operations: [
          {
            tool: 'entity_update',
            input: {
              id: taskId,
              props: { 'orbis/task_status': 'planned' },
              precondition: [{ property: 'orbis/task_status', in: ['done'] }],
            },
          },
        ],
      }),
      'VALIDATION',
    );

    // Снятие аспекта целиком предложением не выражается (V1.7)
    expectError(
      await dispatchTool(ctx, 'orbis_propose', {
        ...base,
        operations: [
          { tool: 'entity_update', input: { id: taskId, aspects: { detach: ['orbis/task'] } } },
        ],
      }),
      'VALIDATION',
    );

    // Ни один отказ формы не завёл pending и не закрыл прогон
    expect(await pendingsInRoutineThread(routineId)).toBe(0);
    expect((await propsOf(owner, runId))['orbis/run_outcome']).toBe('running');
  });

  test('операция над рутиной, прогоном или с orbis/assignment (статически и по id из БД) → VALIDATION proposal_forbidden_target (приёмка 8)', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель запрета по объекту');
    const base = { run_id: runId, explanation: EXPLANATION };

    const forbidden: Array<{ tool: string; input: Record<string, unknown> }> = [
      // Статически: аспект рутины в патче
      {
        tool: 'entity_create',
        input: {
          title: 'Своя новая рутина',
          tags: [],
          props: {
            'orbis/routine_stage': 'active',
            'orbis/routine_at': '08:00',
            'orbis/routine_mode': 'act',
          },
          aspects: ['orbis/routine'],
        },
      },
      {
        tool: 'entity_update',
        input: { id: taskId, props: { 'orbis/routine_mode': 'act' } },
      },
      // Статически: назначение исполнителю
      {
        tool: 'entity_update',
        input: { id: taskId, props: { 'orbis/executor': 'agent' } },
      },
      // По БД: объект — сама рутина, её аспекта в патче нет
      { tool: 'entity_update', input: { id: routineId, title: 'Переименовать рутину' } },
      // Прогон (A-1): подделка ответа владельца статически — и правка прогона по БД
      {
        tool: 'entity_update',
        input: {
          id: taskId,
          props: { 'orbis/run_reply': { text: 'да', at: '2026-08-18T08:00:00.000Z' } },
        },
      },
      { tool: 'entity_update', input: { id: runId, title: 'Переписать прогон' } },
      {
        tool: 'relation_create',
        input: { source_id: taskId, target_id: runId, role: 'mention' },
      },
      // По БД: связь одним концом упирается в рутину
      {
        tool: 'relation_create',
        input: { source_id: routineId, target_id: taskId, role: 'subitem' },
      },
      {
        tool: 'relation_delete',
        input: { source_id: taskId, target_id: routineId, role: 'mention' },
      },
    ];

    for (const op of forbidden) {
      const r = await dispatchTool(ctx, 'orbis_propose', { ...base, operations: [op] });
      expectError(r, 'VALIDATION');
      expect((errorOf(r).details as { reason?: string }).reason).toBe('proposal_forbidden_target');
    }

    expect(await pendingsInRoutineThread(routineId)).toBe(0);
    expect((await propsOf(owner, runId))['orbis/run_outcome']).toBe('running');
  });

  test('от chat и mcp → VALIDATION (routineOnly); в реестре чата и MCP orbis_propose нет; в WORKER_SCOPE_TOOLS нет', async () => {
    const { runId } = await liveRoutine();
    const taskId = await seedTask('Цель чужой поверхности');
    const payload = {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        },
      ],
    };

    const chat: ToolCallCtx = {
      db,
      actorUserId: owner,
      actorKind: 'ai',
      source: 'chat',
      explicitCommand: false,
      clock: () => T0,
    };
    expectError(await dispatchTool(chat, 'orbis_propose', payload), 'VALIDATION');

    const grantId = await workerGrant(owner, 'propose-mcp');
    expectError(await dispatchTool(worker(owner, grantId), 'orbis_propose', payload), 'VALIDATION');

    const defs = await withIdentity(db, owner, (tx) => buildToolRegistry(tx, owner));
    expect(defs.find((d) => d.name === 'orbis_propose')?.routineOnly).toBe(true);
    // Фильтры публикации: чат (send-message.ts) и MCP (mcp/server.ts) режут routineOnly
    expect(defs.filter((d) => d.routineOnly !== true).map((d) => d.name)).not.toContain(
      'orbis_propose',
    );
    // Не глагол внешнего исполнителя: ни в его именах, ни в скоупе worker
    expect((AGENT_VERB_NAMES as readonly string[]).includes('orbis_propose')).toBe(false);
    expect(WORKER_SCOPE_TOOLS.has('orbis_propose')).toBe(false);
  });

  test('повтор с тем же id → replayed, второго pending нет', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель повтора');
    const payload = {
      run_id: runId,
      explanation: EXPLANATION,
      id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        },
      ],
    };

    const first = await dispatchTool(ctx, 'orbis_propose', payload);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    const firstResult = first.result as ProposeResult;
    expect(firstResult.replayed).toBe(false);

    const second = await dispatchTool(ctx, 'orbis_propose', payload);
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    const secondResult = second.result as ProposeResult;
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.pending_id).toBe(firstResult.pending_id);

    expect(await pendingsInRoutineThread(routineId)).toBe(1);
    const run = await propsOf(owner, runId);
    expect(run['orbis/run_outcome']).toBe('finished');
    expect(run['orbis/run_proposal']).toEqual({
      pending_id: firstResult.pending_id,
      status: 'pending',
    });

    // Повтор БЕЗ ключа идемпотентности — тоже replay: прогон уже закрыт ЭТИМ предложением,
    // и узнаёт его предпроверка по детерминированному pendingId, а не по ключу вызова
    const { id: _dropped, ...noCallId } = payload;
    const third = await dispatchTool(ctx, 'orbis_propose', noCallId);
    expect(third.status).toBe('ok');
    if (third.status !== 'ok') return;
    const thirdResult = third.result as ProposeResult;
    expect(thirdResult.replayed).toBe(true);
    expect(thirdResult.pending_id).toBe(firstResult.pending_id);
    expect(thirdResult.operations).toBe(1);
    expect(await pendingsInRoutineThread(routineId)).toBe(1);
  });

  test("нетерминальный отказ закрытия (id вызова занят action'ом шага) → CONFLICT БЕЗ гашения pending; повтор с новым id связывает прогон с тем же pending (replayed), approve исполняет (B2)", async () => {
    // Реестр просит «передавай id (uuid)», а в контексте модели лежат uuid прошлых action'ов
    // (history → last_steps[].action_id); совпадение даёт replayMismatch при ЖИВОМ прогоне.
    // Прежняя компенсация гасила pending на любом отказе — и повтор отдавал replayed со
    // ссылкой на отклонённый pending: план дня терялся тихо.
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель занятого id');
    const stepId = newId();
    const step = await runAgentVerb(
      {
        db,
        ownerId: owner,
        subject: { kind: 'routine', routineId },
        clock: () => T0,
        sink: makeChatJournalSink(),
      },
      'orbis_run_step',
      { run_id: runId, id: stepId, summary: 'entity_query: ok', external: false },
    );
    expect(step.status).toBe('ok');

    const operations = [
      {
        tool: 'entity_update',
        input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
      },
    ];
    const clash = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      id: stepId,
      operations,
    });
    expectError(clash, 'CONFLICT');
    expect(errorOf(clash).message).toContain('id вызова уже использован');
    // Прогон жив, pending лежит и НЕ отклонён
    expect((await propsOf(owner, runId))['orbis/run_outcome']).toBe('running');
    expect(await pendingsInRoutineThread(routineId)).toBe(1);

    const again = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      id: newId(),
      operations,
    });
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    const result = again.result as ProposeResult;
    expect(result.replayed).toBe(true);
    expect(await pendingsInRoutineThread(routineId)).toBe(1);
    const run = await propsOf(owner, runId);
    expect(run['orbis/run_outcome']).toBe('finished');
    expect(run['orbis/run_proposal']).toEqual({ pending_id: result.pending_id, status: 'pending' });

    // Предложение действующее: «Принять» исполняет его
    const applied = await approvePending(db, {
      ownerId: owner,
      pendingId: result.pending_id,
      clock: () => T0,
    });
    expect(applied.ok).toBe(true);
    expect((await propsOf(owner, taskId))['orbis/task_status']).toBe('planned');
  });

  test('лежащий pending уже отклонён → повтор предложения не replayed, а CONFLICT proposal_already_rejected; прогон не закрыт (B2)', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель отклонённого повтора');
    const operations = [
      {
        tool: 'entity_update',
        input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
      },
    ];
    // Первый вызов падает на закрытии занятым id → pending лежит, прогон жив
    const stepId = newId();
    await runAgentVerb(
      {
        db,
        ownerId: owner,
        subject: { kind: 'routine', routineId },
        clock: () => T0,
        sink: makeChatJournalSink(),
      },
      'orbis_run_step',
      { run_id: runId, id: stepId, summary: 'entity_query: ok', external: false },
    );
    const clash = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      id: stepId,
      operations,
    });
    expectError(clash, 'CONFLICT');
    const pendingId = pendingMessageId(owner, `proposal:${runId}`);
    // Владелец успел отклонить карточку с экрана
    const rejected = await rejectPending(db, { ownerId: owner, pendingId, reason: 'owner' });
    expect(rejected.ok).toBe(true);

    const again = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      operations,
    });
    expectError(again, 'CONFLICT');
    expect((errorOf(again).details as { reason?: string }).reason).toBe(
      'proposal_already_rejected',
    );
    expect((await propsOf(owner, runId))['orbis/run_outcome']).toBe('running');
    expect(await pendingsInRoutineThread(routineId)).toBe(1);
  });

  test('прогон уже терминален (failed) → CONFLICT, pending НЕ создан (fix round 1)', async () => {
    // Сирота-предложение недопустима: pending с proposal_card лежал бы в треде и
    // применялся бы кнопкой, а прогон о нём ничего не знает — ни V1.8, ни статус рутины
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель предложения от мёртвого прогона');

    const closed = await closeRoutineRun(
      {
        db,
        ownerId: owner,
        subject: { kind: 'routine', routineId },
        clock: () => T0,
        sink: makeChatJournalSink(),
      },
      { runId, outcome: 'failed', failNote: 'дедлайн прогона' },
    );
    expect(closed.status).toBe('ok');

    const r = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        },
      ],
    });
    expectError(r, 'CONFLICT');
    expect(errorOf(r).message).toContain('прогон завершён (failed)');
    expect(await pendingsInRoutineThread(routineId)).toBe(0);
    // Исход прогона предложением не переписан
    const run = await propsOf(owner, runId);
    expect(run['orbis/run_outcome']).toBe('failed');
    expect(run['orbis/run_proposal']).toBeUndefined();
  });

  test('run_id не тот, из которого сделан вызов → VALIDATION, pending НЕ создан', async () => {
    const { routineId, ctx } = await liveRoutine();
    const other = await liveRoutine();
    const taskId = await seedTask('Цель чужого run_id');

    const r = await dispatchTool(ctx, 'orbis_propose', {
      run_id: other.runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        },
      ],
    });
    expectError(r, 'VALIDATION');
    expect(errorOf(r).message).toContain('не тому прогону');
    expect(await pendingsInRoutineThread(routineId)).toBe(0);
    expect(await pendingsInRoutineThread(other.routineId)).toBe(0);
    expect((await propsOf(owner, other.runId))['orbis/run_outcome']).toBe('running');
  });

  test('и грант, и рутина в контексте → VALIDATION (ровно один субъект, V1.5)', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель двойного субъекта');
    // Грант полного скоупа: у worker-скоупа раньше сработал бы гейт §4.14, и до сборки
    // субъекта вызов бы не дошёл — проверялся бы не тот рубеж
    const token = await issuePatGrant(db, {
      ownerId: owner,
      label: 'propose-двойной-субъект',
      scope: 'full',
    });
    const identity = await verifyBearer(db, token);
    expect(identity).not.toBeNull();
    if (identity === null) return;
    const r = await dispatchTool(
      { ...ctx, grant: { id: identity.grantId, scope: 'full', label: 'полный' } },
      'orbis_propose',
      {
        run_id: runId,
        explanation: EXPLANATION,
        operations: [
          {
            tool: 'entity_update',
            input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
          },
        ],
      },
    );
    expectError(r, 'VALIDATION');
    expect(errorOf(r).message).toContain('и грант, и рутина');
    expect(await pendingsInRoutineThread(routineId)).toBe(0);
  });

  test('две операции на одно поле одной сущности → VALIDATION, pending НЕ создан', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель двух правок одного поля');
    const base = { run_id: runId, explanation: EXPLANATION };

    const r = await dispatchTool(ctx, 'orbis_propose', {
      ...base,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        },
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'done' } },
        },
      ],
    });
    expectError(r, 'VALIDATION');
    expect((errorOf(r).details as { reason?: string }).reason).toBe(
      'proposal_conflicting_operations',
    );
    // Единица столкновения — СВОЙСТВО (§А1-1), и отказ называет именно его, а не пару
    // «аспект + поле»: два аспекта делят одно свойство, и по паре они выглядели бы разными.
    expect(errorOf(r).message).toContain('orbis/task_status');

    // Разные поля той же сущности — законная пара: их предусловия не пересекаются
    const ok = await dispatchTool(ctx, 'orbis_propose', {
      ...base,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
        },
        {
          tool: 'entity_update',
          input: { id: taskId, props: { 'orbis/due_date': '2026-08-20' } },
        },
      ],
    });
    expect(ok.status).toBe('ok');
    expect(await pendingsInRoutineThread(routineId)).toBe(1);
  });

  test('правка тела + любая другая правка той же сущности (в любом порядке) → VALIDATION proposal_conflicting_operations; тело одно — ok с expectedUpdatedAt (B2-2)', async () => {
    const taskId = await seedTask('Цель правки тела');
    const explanation = { explanation: EXPLANATION };
    const bodyOp = { tool: 'entity_update', input: { id: taskId, body: 'Новый текст задачи' } };
    const statusOp = {
      tool: 'entity_update',
      input: { id: taskId, props: { 'orbis/task_status': 'planned' } },
    };

    // Аспекты, потом тело — вторая операция читала бы виртуальную строку с бампнутым
    // updated_at и гарантированно падала бы STALE_VERSION на approve
    const first = await liveRoutine();
    const r1 = await dispatchTool(first.ctx, 'orbis_propose', {
      run_id: first.runId,
      ...explanation,
      operations: [statusOp, bodyOp],
    });
    expectError(r1, 'VALIDATION');
    expect((errorOf(r1).details as { reason?: string }).reason).toBe(
      'proposal_conflicting_operations',
    );
    // Тело, потом аспекты — тот же отказ: правило не зависит от порядка
    const r2 = await dispatchTool(first.ctx, 'orbis_propose', {
      run_id: first.runId,
      ...explanation,
      operations: [bodyOp, statusOp],
    });
    expectError(r2, 'VALIDATION');
    expect((errorOf(r2).details as { reason?: string }).reason).toBe(
      'proposal_conflicting_operations',
    );
    expect(await pendingsInRoutineThread(first.routineId)).toBe(0);
    expect((await propsOf(owner, first.runId))['orbis/run_outcome']).toBe('running');

    // Тело единственной операцией по сущности — законно; CAS снят сервером
    const ok = await dispatchTool(first.ctx, 'orbis_propose', {
      run_id: first.runId,
      ...explanation,
      operations: [bodyOp],
    });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    const msg = await messageById((ok.result as ProposeResult).pending_id);
    const payload = (
      msg?.metadata as {
        pending: { input: { operations: Array<{ input: Record<string, unknown> }> } };
      }
    ).pending.input;
    expect(payload.operations[0]?.input.body).toBe('Новый текст задачи');
    expect(typeof payload.operations[0]?.input.expectedUpdatedAt).toBe('string');
    expect(payload.operations[0]?.input.precondition).toBeUndefined();
  });
});
