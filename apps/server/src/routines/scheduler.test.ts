// apps/server/src/routines/scheduler.test.ts
// Планировщик рутин (V1.2, V1.3, V1.12, V1.15) против живой БД со ScriptedProvider: тик
// перечисляет владельцев, подметает, находит наступившие бакеты в таймзоне владельца,
// заводит прогон и гонит модель — ровно один раз на бакет, с ретраями по паузе, догоном в
// окне и стоп-краном; фоновый цикл — интервал, наложение, остановка с рубильником.
//
// Каждый тест — свой владелец (тик обходит ВСЕХ владельцев в user_settings), а рутины
// теста после него ставятся на паузу: активная рутина с незакрытым бакетом иначе съела бы
// скрипт провайдера следующего теста.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId, routineRunId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { RUN_STALE_AFTER_MS } from '../agent-loop/constants';
import { runsOfParent } from '../agent-loop/queries';
import { chatMessages, userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { ScriptedProvider } from '../llm/scripted';
import type { LLMProvider, LLMResponse } from '../llm/types';
import { agentLoopHelpers } from '../test/agent-loop-helpers';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS } from './constants';
import { type RoutineDeps, startBucketRun } from './lifecycle';
import { makeRoutineLocks } from './locks';
import { routineTick, startRoutineScheduler } from './scheduler';

requireEnv();

const { db, client } = appDb();
const { propsOf, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);

/** 07:30 мск 18 августа 2026: бакет 07:00 наступил полчаса назад. */
const T0 = new Date('2026-08-18T04:30:00.000Z');
const BUCKET = '2026-08-18T07:00';
const MODEL = 'scripted-model';

/** Рутины теста — на паузу после него (см. шапку файла). */
const createdRoutines: Array<{ owner: string; routineId: string }> = [];

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

afterEach(async () => {
  for (const { owner, routineId } of createdRoutines.splice(0)) {
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: routineId,
            props: { 'orbis/routine_stage': 'paused' },
            aspects: { attach: ['orbis/routine'] },
          },
        },
      ],
      clock: () => T0,
    });
    if (!r.ok) throw new Error(`пауза рутины ${routineId}: ${r.error.code} ${r.error.message}`);
  }
});

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

function minutes(n: number, from: Date = T0): Date {
  return new Date(from.getTime() + n * 60_000);
}

function endTurn(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'end_turn',
  };
}

function toolUse(name: string, input: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id: 'call-0', name, input }],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_use',
  };
}

/** Владелец, видимый планировщику: строка user_settings с таймзоной (0013, V1.13). */
async function newOwner(timezone = 'Europe/Moscow'): Promise<string> {
  const owner = freshUserId();
  await withIdentity(db, owner, (tx) =>
    tx.insert(userSettings).values({ ownerId: owner, timezone }),
  );
  return owner;
}

/** Рутина режима act без белого списка: `end_turn` модели закрывает прогон finished. */
async function newRoutine(owner: string, routine: Record<string, unknown> = {}): Promise<string> {
  const routineId = await seedRoutine(owner, {
    routine: { 'orbis/routine_mode': 'act', ...routine },
  });
  createdRoutines.push({ owner, routineId });
  return routineId;
}

function deps(provider: LLMProvider, clock: () => Date = () => T0): RoutineDeps {
  return { db, provider, model: MODEL, clock };
}

/** Свойства прогона (§А1-1) в объёме, который читают тесты планировщика. */
interface RunProps {
  'orbis/run_outcome': string;
  'orbis/run_bucket': string;
  'orbis/run_attempt': number;
  'orbis/run_report'?: string;
  'orbis/fail_note'?: string;
}

async function runAspect(owner: string, runId: string): Promise<RunProps> {
  return (await propsOf(owner, runId)) as unknown as RunProps;
}

async function stage(owner: string, routineId: string): Promise<string> {
  return (await propsOf(owner, routineId))['orbis/routine_stage'] as string;
}

async function runsOf(owner: string, routineId: string) {
  return withIdentity(db, owner, (tx) => runsOfParent(tx, routineId));
}

async function until(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('условие не наступило за отведённое время');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------

describe('routineTick: бакет в таймзоне владельца, «создатель — не replay» (V1.3, инвариант 1)', () => {
  test('тик создаёт прогон бакета 2026-08-18T07:00 (id = routineRunId(R, bucket, 1)), гонит модель; второй тик за тот же бакет — done; модель вызвана один раз', async () => {
    const owner = await newOwner();
    const routineId = await newRoutine(owner);
    const runId = routineRunId(routineId, BUCKET, 1);
    const provider = new ScriptedProvider([endTurn('Утро спокойное, планов нет.')]);

    const first = await routineTick(deps(provider));
    expect(first.owners).toBeGreaterThanOrEqual(1);
    expect(first.started).toContain(runId);
    const run = await runAspect(owner, runId);
    expect(run).toMatchObject({
      'orbis/run_outcome': 'finished',
      'orbis/run_bucket': BUCKET,
      'orbis/run_attempt': 1,
    });
    expect(run['orbis/run_report']).toBe('Утро спокойное, планов нет.');
    expect(provider.requests).toHaveLength(1);
    // Секция режима в системном слое несёт бакет — модель знает, «за какое утро» работает
    expect(provider.requests[0]?.system).toContain(BUCKET);

    const second = await routineTick(deps(provider));
    expect(second.started).not.toContain(runId);
    expect(second.skipped).toContainEqual({ routineId, bucket: BUCKET, reason: 'done' });
    expect(provider.requests).toHaveLength(1);
    expect(await runsOf(owner, routineId)).toHaveLength(1);
  });

  test('два конкурентных тика на один бакет: ровно один прогон, модель вызвана один раз, проигравший выходит молча — 5 раундов (приёмка 13, Р-1)', async () => {
    for (let round = 0; round < 5; round++) {
      const owner = await newOwner();
      const routineId = await newRoutine(owner);
      const runId = routineRunId(routineId, BUCKET, 1);
      const provider = new ScriptedProvider([endTurn(`раунд ${round}`)]);

      // Два экземпляра замка рутины = два процесса (locks.ts): общий замок свёл бы второй тик
      // к «уже идёт», а здесь проверяется именно межпроцессная сходимость по batch_id/PK
      const [a, b] = await Promise.all([
        routineTick({ ...deps(provider), locks: makeRoutineLocks() }),
        routineTick({ ...deps(provider), locks: makeRoutineLocks() }),
      ]);
      const started = [...a.started, ...b.started].filter((id) => id === runId);
      expect(started).toHaveLength(1);
      const lost = [...a.skipped, ...b.skipped].filter((s) => s.routineId === routineId);
      expect(lost).toHaveLength(1);
      // Проигравший различим по причине, но не по последствиям — они всегда одни и те же:
      // одна сущность прогона и один вызов модели. Причина зависит только от того, когда он
      // успел прочитать слот: ДО коммита победителя — идёт в execute и проигрывает там
      // (`replay` по PK audit'а либо занятый id/связь → `id_conflict`); ПОСЛЕ старта, но до
      // закрытия — видит идущий прогон (`running`); ПОСЛЕ закрытия — отработанный слот
      // (`done`).
      //
      // `done` здесь ЗАКОНЕН, а не признак поломки: тик не просто заводит прогон, а тем же
      // вызовом гонит модель до конца (scheduler.ts), и победитель успевает закрыть прогон в
      // `finished` раньше, чем проигравший дошёл до своего снимка. Ровно это утверждает
      // соседний тест выше — второй ПОСЛЕДОВАТЕЛЬНЫЙ тик за тот же бакет получает `done`;
      // тут то же самое, только последовательность вышла не по замыслу теста, а по таймингу.
      // Замер отставанием: исход переключается running → done, когда проигравший опаздывает
      // на ~80–90 мс, а на CI сьюты трёх пакетов идут параллельно и такое отставание бывает.
      //
      // ЧЕМ ЭТО МЕСТО ОТЛИЧАЕТСЯ от пина lifecycle.test.ts «два конкурентных запуска одного
      // бакета ИЗ ДВУХ ПРОЦЕССОВ»: там `startBucketRun` зовётся напрямую, модель не гонится,
      // и прогон победителя навсегда остаётся `running`. `done` там невозможен и остаётся
      // настоящим сигналом поломки — регрессом f939456 (рваный снимок из двух запросов
      // принимал ИДУЩИЙ прогон конкурента за отработанный слот). Тот список расширять нельзя.
      expect(['replay', 'id_conflict', 'running', 'done']).toContain(lost[0]?.reason);
      expect(provider.requests).toHaveLength(1);
      expect((await runsOf(owner, routineId)).map((r) => r.id)).toEqual([runId]);
      expect((await runAspect(owner, runId))['orbis/run_outcome']).toBe('finished');
    }
  });

  test('догон: now = бакет+5ч → создаётся; now = бакет+7ч → молча пропущен; позавчерашний бакет не создаётся (приёмка 14)', async () => {
    // Сервер лежал ночь и проснулся в 12:00 мск — утренний бакет ещё в окне 6 ч
    const late = await newOwner();
    const lateRoutine = await newRoutine(late);
    const lateProvider = new ScriptedProvider([endTurn('догнал')]);
    const caught = await routineTick(deps(lateProvider, () => new Date('2026-08-18T09:00:00Z')));
    expect(caught.started).toContain(routineRunId(lateRoutine, BUCKET, 1));
    expect((await runAspect(late, routineRunId(lateRoutine, BUCKET, 1)))['orbis/run_outcome']).toBe(
      'finished',
    );
    // Вчерашний и позавчерашний бакеты за окном — их нет вовсе (пропуск виден отсутствием)
    expect((await runsOf(late, lateRoutine)).map((r) => r.props['orbis/run_bucket'])).toEqual([
      BUCKET,
    ]);

    // Проснулся в 14:00 мск — окно истекло: ни прогона, ни записи о пропуске
    const missed = await newOwner();
    const missedRoutine = await newRoutine(missed);
    const silent = new ScriptedProvider([]);
    const skipped = await routineTick(deps(silent, () => new Date('2026-08-18T11:00:00Z')));
    expect(skipped.started).not.toContain(routineRunId(missedRoutine, BUCKET, 1));
    expect(skipped.skipped.filter((s) => s.routineId === missedRoutine)).toEqual([]);
    expect(await runsOf(missed, missedRoutine)).toEqual([]);
    expect(silent.requests).toHaveLength(0);
  });
});

describe('routineTick: ретраи и стоп-кран (V1.3, V1.12, приёмка 12)', () => {
  test('провайдер пустой → failed attempt 1; тик через 1 мин → backoff; через 6 мин → attempt 2; после 3 failed → attempts, рутина paused', async () => {
    const owner = await newOwner();
    const routineId = await newRoutine(owner);
    const provider = new ScriptedProvider([]); // каждый вызов — сбой провайдера
    const idOf = (attempt: number) => routineRunId(routineId, BUCKET, attempt);
    const skippedAs = (r: { skipped: Array<{ routineId: string; reason: string }> }) =>
      r.skipped.filter((s) => s.routineId === routineId).map((s) => s.reason);

    const t1 = await routineTick(deps(provider));
    expect(t1.started).toContain(idOf(1));
    expect(await runAspect(owner, idOf(1))).toMatchObject({
      'orbis/run_outcome': 'failed',
      'orbis/run_attempt': 1,
    });
    expect((await runAspect(owner, idOf(1)))['orbis/fail_note']).toContain(
      'AI-провайдер недоступен',
    );

    // Пауза перед второй попыткой — RETRY_DELAYS_MS[0] от finished_at первой
    expect(RETRY_DELAYS_MS[0]).toBe(5 * 60_000);
    const t2 = await routineTick(deps(provider, () => minutes(1)));
    expect(t2.started).not.toContain(idOf(2));
    expect(skippedAs(t2)).toEqual(['backoff']);

    const t3 = await routineTick(deps(provider, () => minutes(6)));
    expect(t3.started).toContain(idOf(2));
    expect(await runAspect(owner, idOf(2))).toMatchObject({
      'orbis/run_outcome': 'failed',
      'orbis/run_attempt': 2,
    });

    // Пауза перед третьей — RETRY_DELAYS_MS[1] (15 мин) от finished_at второй (T0+6)
    expect(RETRY_DELAYS_MS[1]).toBe(15 * 60_000);
    expect(skippedAs(await routineTick(deps(provider, () => minutes(7))))).toEqual(['backoff']);
    expect(await stage(owner, routineId)).toBe('active');

    const t5 = await routineTick(deps(provider, () => minutes(22)));
    expect(t5.started).toContain(idOf(3));
    expect(await runAspect(owner, idOf(3))).toMatchObject({
      'orbis/run_outcome': 'failed',
      'orbis/run_attempt': 3,
    });
    expect(provider.requests).toHaveLength(MAX_ATTEMPTS);

    // Стоп-кран: три плановых сбоя подряд → пауза с записью в тред рутины
    expect(await stage(owner, routineId)).toBe('paused');
    const notes = await withIdentity(db, owner, (tx) =>
      tx
        .select({ metadata: chatMessages.metadata })
        .from(chatMessages)
        .where(eq(chatMessages.threadId, entityThreadId(owner, routineId))),
    );
    expect(notes.some((n) => (n.metadata as { type?: string }).type === 'routine_paused')).toBe(
      true,
    );

    // Приостановленную рутину тик больше не рассматривает; попыток по бакету не осталось
    const t6 = await routineTick(deps(provider, () => minutes(23)));
    expect(t6.started).not.toContain(idOf(4));
    expect(skippedAs(t6)).toEqual([]);
    expect(
      await startBucketRun(
        deps(provider, () => minutes(60)),
        {
          ownerId: owner,
          routine: { id: routineId, title: 'Утренний обзор' },
          bucket: BUCKET,
        },
      ),
    ).toEqual({ started: false, reason: 'attempts' });
    expect(await runsOf(owner, routineId)).toHaveLength(3);
  });

  test('крэш-луп: два плановых failed + зависший третий → тик подметает его в failed и ТЕМ ЖЕ тиком ставит рутину на паузу, нового прогона нет (C1b-3)', async () => {
    const owner = await newOwner();
    const routineId = await newRoutine(owner);
    // Два вчерашних провала закрыты кем угодно (раннером или подметанием) — по графу не видно
    for (const [bucket, offset] of [
      ['2026-08-16T07:00', -2 * 24 * 60],
      ['2026-08-17T07:00', -24 * 60],
    ] as const) {
      await seedRoutineRun(owner, {
        routineId,
        bucket,
        startedAt: minutes(offset),
        run: { 'orbis/run_outcome': 'failed', 'orbis/fail_note': 'прогон прерван: процесс умер' },
      });
    }
    // Сегодняшний бакет: процесс умер посреди прогона (SIGKILL) — шагов нет дольше порога.
    // Раннера у него нет и не будет — pauseIfFailing из runner.ts не вызовется
    await seedRoutineRun(owner, {
      routineId,
      bucket: BUCKET,
      startedAt: new Date(T0.getTime() - RUN_STALE_AFTER_MS - 5 * 60_000),
      lastStepAt: new Date(T0.getTime() - RUN_STALE_AFTER_MS - 60_000),
    });
    const provider = new ScriptedProvider([endTurn('не должно случиться')]);

    const tick = await routineTick(deps(provider));
    expect(tick.swept).toBeGreaterThanOrEqual(1);
    expect((await runAspect(owner, routineRunId(routineId, BUCKET, 1)))['orbis/run_outcome']).toBe(
      'failed',
    );
    // Стоп-кран сработал в тике, а не дожидался «живого» сбоя: рутина на паузе, с записью
    expect(tick.paused).toContain(routineId);
    expect(await stage(owner, routineId)).toBe('paused');
    const notes = await withIdentity(db, owner, (tx) =>
      tx
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.threadId, entityThreadId(owner, routineId))),
    );
    expect(
      notes.filter((r) => (r.metadata as { type?: string }).type === 'routine_paused'),
    ).toHaveLength(1);
    // Ретрай бакета не заведён, модель не вызвана: паузой решение о запуске и кончилось
    expect(tick.started).toEqual([]);
    expect(tick.skipped.filter((s) => s.routineId === routineId)).toEqual([]);
    expect(await runsOf(owner, routineId)).toHaveLength(3);
    expect(provider.requests).toHaveLength(0);

    // Следующий тик: рутина на паузе — не рассматривается, второй записи нет
    const next = await routineTick(deps(provider, () => minutes(10)));
    expect(next.paused).toEqual([]);
    expect(next.started).toEqual([]);
    expect(await runsOf(owner, routineId)).toHaveLength(3);
  });

  test('paused рутина и running прогон — тик пропускает; зависший прогон подметается ДО решения о запуске (V1.12)', async () => {
    const owner = await newOwner();
    const paused = await newRoutine(owner, { 'orbis/routine_stage': 'paused' });
    const busy = await newRoutine(owner);
    // Живой прогон бакета: шаг был минуту назад — его ведёт другой процесс
    const { runId: busyRun } = await seedRoutineRun(owner, {
      routineId: busy,
      bucket: BUCKET,
      startedAt: minutes(-2),
      lastStepAt: minutes(-1),
    });
    // Зависший прогон бакета: шагов нет дольше порога подметания — процесс умер
    const stuck = await newRoutine(owner);
    const { runId: stuckRun } = await seedRoutineRun(owner, {
      routineId: stuck,
      bucket: BUCKET,
      startedAt: new Date(T0.getTime() - RUN_STALE_AFTER_MS - 5 * 60_000),
      lastStepAt: new Date(T0.getTime() - RUN_STALE_AFTER_MS - 60_000),
    });
    const provider = new ScriptedProvider([endTurn('вторая попытка удалась')]);

    const t1 = await routineTick(deps(provider));
    // Приостановленная — не рассматривается вовсе, живая — «уже идёт»
    expect(t1.skipped.filter((s) => s.routineId === paused)).toEqual([]);
    expect(t1.skipped).toContainEqual({ routineId: busy, bucket: BUCKET, reason: 'running' });
    expect((await runAspect(owner, busyRun))['orbis/run_outcome']).toBe('running');
    // Зависший закрыт подметанием failed — и только ПОТОМ тик решал по бакету: решение
    // «backoff», а не «running», значит подметание отработало раньше
    expect(t1.swept).toBeGreaterThanOrEqual(1);
    const sweptRun = await runAspect(owner, stuckRun);
    expect(sweptRun['orbis/run_outcome']).toBe('failed');
    expect(sweptRun['orbis/fail_note']).toContain('прогон прерван');
    expect(t1.skipped).toContainEqual({ routineId: stuck, bucket: BUCKET, reason: 'backoff' });
    expect(provider.requests).toHaveLength(0);

    // Пауза вышла — ретрай бакета зависшей рутины: попытка 2, модель вызвана
    const t2 = await routineTick(deps(provider, () => minutes(5)));
    expect(t2.started).toContain(routineRunId(stuck, BUCKET, 2));
    expect(await runAspect(owner, routineRunId(stuck, BUCKET, 2))).toMatchObject({
      'orbis/run_outcome': 'finished',
      'orbis/run_attempt': 2,
    });
    expect(provider.requests).toHaveLength(1);
    // Живой прогон всё так же идёт: тик его не трогает
    expect(t2.skipped).toContainEqual({ routineId: busy, bucket: BUCKET, reason: 'running' });
    expect((await runAspect(owner, busyRun))['orbis/run_outcome']).toBe('running');
  });
});

describe('startRoutineScheduler: интервал, наложение, остановка (V1.2, Р-12)', () => {
  test('интервал 20 мс: два тика прошли, lastTickAt заполнен и растёт; после stop() тиков нет', async () => {
    await newOwner(); // владелец без рутин: тик пустой, но настоящий
    let t = T0.getTime();
    const clock = () => new Date(++t); // монотонные часы: каждый тик получает своё «сейчас»
    const scheduler = startRoutineScheduler(deps(new ScriptedProvider([]), clock), {
      intervalMs: 20,
    });
    expect(scheduler.lastTickAt()).toBeNull();
    await until(() => scheduler.lastTickAt() !== null);
    const first = scheduler.lastTickAt();
    if (first === null) throw new Error('unreachable');
    await until(() => (scheduler.lastTickAt()?.getTime() ?? 0) > first.getTime());

    await scheduler.stop();
    const atStop = scheduler.lastTickAt();
    await sleep(80);
    expect(scheduler.lastTickAt()).toEqual(atStop);
  });

  test('stop() ждёт текущий тик, а рубильник закрывает идущий прогон failed «остановлен при выключении процесса»', async () => {
    const owner = await newOwner();
    const routineId = await newRoutine(owner);
    const runId = routineRunId(routineId, BUCKET, 1);

    // Провайдер, который «думает», пока тест не отпустит: так stop() застаёт прогон
    // посреди шага, а рубильник срабатывает на следующей проверке между шагами
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const provider: LLMProvider = {
      modelId: MODEL,
      async chat() {
        calls += 1;
        await gate;
        return toolUse('entity_query', { query: 'aspect=orbis/task, status=inbox' });
      },
    };
    const scheduler = startRoutineScheduler(deps(provider), { intervalMs: 20 });
    await until(() => calls === 1);
    // Прогон создан и идёт; интервал уже мог тикнуть повторно — наложение пропущено
    expect((await runAspect(owner, runId))['orbis/run_outcome']).toBe('running');

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    // stop() не завершается, пока тик держит прогон
    await sleep(40);
    expect(stopped).toBe(false);
    release();
    await stopping;

    const run = await runAspect(owner, runId);
    expect(run['orbis/run_outcome']).toBe('failed');
    expect(run['orbis/fail_note']).toBe('прогон остановлен при выключении процесса');
    // Модель вызвана один раз: после рубильника новых шагов нет, новых тиков тоже
    expect(calls).toBe(1);
    await sleep(60);
    expect(calls).toBe(1);
    expect(await runsOf(owner, routineId)).toHaveLength(1);
  });
});
