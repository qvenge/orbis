// apps/server/src/routines/runner.test.ts
// Раннер прогона рутины (V1.5, V1.8, V1.12) против живой БД со ScriptedProvider:
// цикл модели, исходы, расход, гашение незакрытого и стоп-кран. Прогон создаётся
// фикстурой ровно так, как его заведёт планировщик (Задача 10): entity_create +
// relation parent одним batch'ем источником 'system'.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MAX_AGENT_STEPS } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { type RoutineRow, routineById } from '../agent-loop/queries';
import { rollbackRun } from '../agent-loop/rollback';
import { MAX_TOKENS_NOTE, STEP_LIMIT_NOTE } from '../ai/send-message';
import { aiUsage } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { ActionRecord } from '../executor/types';
import { ScriptedProvider } from '../llm/scripted';
import type { LLMProvider, LLMResponse } from '../llm/types';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import type { RoutineDeps } from './lifecycle';
import { type RunEnd, runRoutineRun } from './runner';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const { actionsOf, aspectsOf, seedEntity, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);

const MODEL = 'scripted-model';
const EXPLANATION = 'Задача висит в инбоксе третий день — предлагаю взять её сегодня.';

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

function endTurn(content: string, usage = { inputTokens: 10, outputTokens: 5 }): LLMResponse {
  return { content, toolCalls: [], usage, stopReason: 'end_turn' };
}

function toolUse(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
  usage = { inputTokens: 10, outputTokens: 5 },
): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map((c, i) => ({ id: `call-${i}`, name: c.name, input: c.input })),
    usage,
    stopReason: 'tool_use',
  };
}

function refusal(): LLMResponse {
  return {
    content: 'Не буду.',
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'refusal',
  };
}

/** Провайдер, дёргающий чужую ручку между шагами: так тест двигает часы и рубильник. */
class HookedProvider implements LLMProvider {
  readonly modelId = MODEL;
  constructor(
    readonly inner: ScriptedProvider,
    private readonly afterChat: () => void,
  ) {}
  async chat(req: Parameters<LLMProvider['chat']>[0]): Promise<LLMResponse> {
    const r = await this.inner.chat(req);
    this.afterChat();
    return r;
  }
}

function deps(provider: LLMProvider, over: Partial<RoutineDeps> = {}): RoutineDeps {
  return { db, provider, model: MODEL, clock: () => T0, ...over };
}

async function routineRow(routineId: string): Promise<RoutineRow> {
  const row = await withIdentity(db, owner, (tx) => routineById(tx, routineId));
  if (row === null) throw new Error(`рутина ${routineId} не найдена`);
  return row;
}

/** Один прогон целиком: фикстура прогона уже создана, раннер только ведёт цикл. */
async function run(
  provider: LLMProvider,
  args: { routineId: string; runId: string; bucket: string },
  over: Partial<RoutineDeps> = {},
): Promise<RunEnd> {
  const routine = await routineRow(args.routineId);
  return runRoutineRun(deps(provider, over), {
    ownerId: owner,
    routine,
    runId: args.runId,
    bucket: args.bucket,
  });
}

interface RunAspect {
  outcome: string;
  report?: string;
  fail_note?: string;
  step_count: number;
  steps: Array<{ summary: string; action_id?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  proposal?: { pending_id: string; status: string };
  checkpoint?: { question: string };
}

async function runAspect(runId: string): Promise<RunAspect> {
  return (await aspectsOf(owner, runId))['orbis/agent-run'] as unknown as RunAspect;
}

async function usageRows() {
  return withIdentity(db, owner, (tx) => tx.select().from(aiUsage).where(eq(aiUsage.model, MODEL)));
}

async function seedTask(title: string): Promise<string> {
  const e = await seedEntity(owner, {
    title,
    tags: [],
    aspects: { 'orbis/task': { status: 'inbox' } },
  });
  return e.id;
}

let bucketSeq = 0;
/** Уникальный плановый слот на каждый прогон теста: бакет занят навсегда (V1.3). */
function nextBucket(): string {
  bucketSeq += 1;
  return `2026-08-${String((bucketSeq % 28) + 1).padStart(2, '0')}T07:00`;
}

// ---------------------------------------------------------------------------

describe('runRoutineRun: режим propose (V1.5, V1.6)', () => {
  test('entity_query → orbis_propose: прогон finished с предложением pending; шаг один (терминальный тул шага не пишет); расход в ai_usage и в аспекте; system несёт режим и историю', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });
    const taskId = await seedTask('Разобрать инбокс');

    const provider = new ScriptedProvider([
      toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/task, status=inbox' } }]),
      toolUse([
        {
          name: 'orbis_propose',
          input: {
            run_id: runId,
            explanation: EXPLANATION,
            operations: [
              {
                tool: 'entity_update',
                input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
              },
            ],
          },
        },
      ]),
    ]);

    const end = await run(provider, { routineId, runId, bucket });
    expect(end).toEqual({ outcome: 'finished' });

    const aspect = await runAspect(runId);
    expect(aspect.outcome).toBe('finished');
    expect(aspect.report).toBe(EXPLANATION);
    expect(aspect.proposal?.status).toBe('pending');
    // Терминальный тул шага не пишет: его исход и есть запись. В ленте — один шаг чтения.
    expect(aspect.step_count).toBe(1);
    expect(aspect.steps[0]?.summary).toBe('entity_query: ok');

    // Расход §4.7: и в дневном счётчике, и в аспекте прогона
    expect(aspect.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(20);
    expect(rows[0]?.outputTokens).toBe(10);
    expect(rows[0]?.requestCount).toBe(2);

    // Контекст: свой системный слой с секцией режима + история вместо ленты треда
    const first = provider.requests[0];
    expect(first?.system).toContain('режим: propose');
    expect(first?.system).toContain(`run_id этого прогона: ${runId}`);
    expect(first?.messages[0]?.content.startsWith('[история прогонов]')).toBe(true);
    expect(first?.messages.some((m) => m.role === 'system')).toBe(false);
    // Модели показаны orbis_propose и чекпойнт, но не глаголы бухгалтерии прогона
    const toolNames = (first?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain('orbis_propose');
    expect(toolNames).toContain('orbis_checkpoint');
    expect(toolNames).not.toContain('orbis_run_step');
    expect(toolNames).not.toContain('entity_update');

    // Результат первого тула ушёл модели каноническим сериализатором
    const second = provider.requests[1];
    expect(second?.messages.at(-1)?.content.startsWith('[tool_result:entity_query]')).toBe(true);
  });

  test('end_turn без предложения → failed no_proposal (прогон не «успешен» молча)', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });

    const end = await run(new ScriptedProvider([endTurn('Ничего не предлагаю.')]), {
      routineId,
      runId,
      bucket,
    });
    expect(end).toEqual({ outcome: 'failed', reason: 'no_proposal' });

    const aspect = await runAspect(runId);
    expect(aspect.outcome).toBe('failed');
    expect(aspect.fail_note).toMatch(/без предложения/);
  });

  test('лимит шагов: propose → failed steps', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });
    const script = Array.from({ length: MAX_AGENT_STEPS }, () =>
      toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/task' } }]),
    );

    const end = await run(new ScriptedProvider(script), { routineId, runId, bucket });
    expect(end).toEqual({ outcome: 'failed', reason: 'steps' });
    expect((await runAspect(runId)).fail_note).toMatch(/лимит шагов/);
  });
});

describe('runRoutineRun: режим act (V1.10)', () => {
  test('end_turn → finished, финальный текст стал отчётом', async () => {
    const routineId = await seedRoutine(owner, { routine: { mode: 'act' } });
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });

    const end = await run(new ScriptedProvider([endTurn('Всё в порядке, менять нечего.')]), {
      routineId,
      runId,
      bucket,
    });
    expect(end).toEqual({ outcome: 'finished' });
    const aspect = await runAspect(runId);
    expect(aspect.outcome).toBe('finished');
    expect(aspect.report).toBe('Всё в порядке, менять нечего.');
  });

  test('белый список: entity_update правит граф с source routine и run_id (rollbackRun откатывает); тул вне списка — отказ модели, а не сбой прогона', async () => {
    const routineId = await seedRoutine(owner, {
      routine: { mode: 'act', allowed_tools: ['entity_update'] },
    });
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });
    const taskId = await seedTask('Купить билеты');

    const provider = new ScriptedProvider([
      // вне белого списка (V1.10): отказ обязан вернуться модели, а не уронить прогон
      toolUse([
        { name: 'attach_orbis_task', input: { entity_id: taskId, data: { status: 'done' } } },
      ]),
      toolUse([
        {
          name: 'entity_update',
          input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
        },
      ]),
      endTurn('Перевёл задачу в план.'),
    ]);

    const end = await run(provider, { routineId, runId, bucket });
    expect(end).toEqual({ outcome: 'finished' });

    const aspect = await runAspect(runId);
    expect(aspect.outcome).toBe('finished');
    expect(aspect.step_count).toBe(2);
    expect(aspect.steps[0]?.summary).toBe('attach_orbis_task: error');
    expect(aspect.steps[1]?.summary).toBe('entity_update: ok');

    // Отказ доехал до модели tool-результатом, а не исключением
    const afterDenial = provider.requests[1]?.messages.at(-1)?.content ?? '';
    expect(afterDenial).toContain('[tool_result:attach_orbis_task]');
    expect(afterDenial).toContain('FORBIDDEN_LEVEL');

    // Правка в графе с атрибуцией рутины (Р-7): модельная мутация — source routine + run_id
    expect((await aspectsOf(owner, taskId))['orbis/task']?.status).toBe('planned');
    const mutation = (await actionsOf(owner)).find(
      (a: ActionRecord) => a.source === 'routine' && a.entity_id === taskId,
    );
    expect(mutation).toBeDefined();
    expect(mutation?.run_id).toBe(runId);
    expect(mutation?.actor_kind).toBe('ai');

    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(true);
    expect((await aspectsOf(owner, taskId))['orbis/task']?.status).toBe('inbox');
  });

  test('лимит шагов: act → finished с пометкой в отчёте', async () => {
    const routineId = await seedRoutine(owner, { routine: { mode: 'act' } });
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });
    const script = Array.from({ length: MAX_AGENT_STEPS }, () =>
      toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/task' } }]),
    );

    const end = await run(new ScriptedProvider(script), { routineId, runId, bucket });
    expect(end).toEqual({ outcome: 'finished' });
    expect((await runAspect(runId)).report).toContain(STEP_LIMIT_NOTE);
  });

  test('обрыв по потолку токенов: act → finished, отчёт с видимой пометкой (не «успешный» обрубок)', async () => {
    const routineId = await seedRoutine(owner, { routine: { mode: 'act' } });
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });
    const cut: LLMResponse = {
      content: 'Разобрал инбокс и начал переносить сроки, но',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'max_tokens',
    };

    const end = await run(new ScriptedProvider([cut]), { routineId, runId, bucket });
    expect(end).toEqual({ outcome: 'finished' });
    const aspect = await runAspect(runId);
    expect(aspect.report?.startsWith('Разобрал инбокс и начал переносить сроки, но')).toBe(true);
    expect(aspect.report).toContain(MAX_TOKENS_NOTE);
  });
});

describe('runRoutineRun: вопрос владельцу и гашение незакрытого (V1.8, V1.9)', () => {
  test('orbis_checkpoint → RunEnd checkpoint; следующий прогон переводит вопрос в stale', async () => {
    const routineId = await seedRoutine(owner);
    const firstBucket = nextBucket();
    const { runId: askedId } = await seedRoutineRun(owner, { routineId, bucket: firstBucket });

    const asked = await run(
      new ScriptedProvider([
        toolUse([
          {
            name: 'orbis_checkpoint',
            input: { run_id: askedId, question: 'Переносить ли встречу с Ирой?' },
          },
        ]),
      ]),
      { routineId, runId: askedId, bucket: firstBucket },
    );
    expect(asked).toEqual({ outcome: 'checkpoint' });
    const askedAspect = await runAspect(askedId);
    expect(askedAspect.outcome).toBe('checkpoint');
    expect(askedAspect.checkpoint?.question).toBe('Переносить ли встречу с Ирой?');
    // расход дописан отдельным патчем: прогон закрыл глагол, usage знает только раннер
    expect(askedAspect.usage).toEqual({ input_tokens: 10, output_tokens: 5 });

    const secondBucket = nextBucket();
    const { runId: nextId } = await seedRoutineRun(owner, {
      routineId,
      bucket: secondBucket,
      startedAt: new Date(T0.getTime() + 60_000),
    });
    const taskId = await seedTask('Позвонить Ире');
    const next = await run(
      new ScriptedProvider([
        toolUse([
          {
            name: 'orbis_propose',
            input: {
              run_id: nextId,
              explanation: EXPLANATION,
              operations: [
                {
                  tool: 'entity_update',
                  input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
                },
              ],
            },
          },
        ]),
      ]),
      { routineId, runId: nextId, bucket: secondBucket },
    );
    expect(next).toEqual({ outcome: 'finished' });
    expect((await runAspect(askedId)).outcome).toBe('stale');
  });

  test('история: второй прогон видит в контексте предложение первого и его статус', async () => {
    const routineId = await seedRoutine(owner);
    const firstBucket = nextBucket();
    const { runId: firstId } = await seedRoutineRun(owner, { routineId, bucket: firstBucket });
    const taskId = await seedTask('Оплатить страховку');
    await run(
      new ScriptedProvider([
        toolUse([
          {
            name: 'orbis_propose',
            input: {
              run_id: firstId,
              explanation: EXPLANATION,
              operations: [
                {
                  tool: 'entity_update',
                  input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
                },
              ],
            },
          },
        ]),
      ]),
      { routineId, runId: firstId, bucket: firstBucket },
    );

    const secondBucket = nextBucket();
    const { runId: secondId } = await seedRoutineRun(owner, {
      routineId,
      bucket: secondBucket,
      startedAt: new Date(T0.getTime() + 120_000),
    });
    const provider = new ScriptedProvider([endTurn('Ничего нового.')]);
    await run(provider, { routineId, runId: secondId, bucket: secondBucket });

    const history = provider.requests[0]?.messages[0]?.content ?? '';
    expect(history).toContain(firstBucket);
    expect(history).toContain(EXPLANATION);
    // supersedeOpen отработал ДО сборки контекста: статус в истории уже «заменено»
    expect(history).toContain('заменено новым прогоном');
  });
});

describe('runRoutineRun: сбои и стоп-кран (V1.12)', () => {
  test('провайдер недоступен → failed provider; три плановых сбоя подряд → пауза с записью в тред; ручной прогон в счёт не идёт', async () => {
    const routineId = await seedRoutine(owner);

    async function failedRun(bucket: string, offsetMin: number): Promise<RunEnd> {
      const { runId } = await seedRoutineRun(owner, {
        routineId,
        bucket,
        startedAt: new Date(T0.getTime() + offsetMin * 60_000),
      });
      return run(new ScriptedProvider([]), { routineId, runId, bucket });
    }

    const first = await failedRun(nextBucket(), 1);
    expect(first).toEqual({ outcome: 'failed', reason: 'provider' });

    // ручной прогон между плановыми: он тоже failed, но стоп-кран его не считает
    await failedRun('manual:2026-08-17T12:30:00.000Z', 2);
    await failedRun(nextBucket(), 3);
    expect((await aspectsOf(owner, routineId))['orbis/routine']?.stage).toBe('active');

    await failedRun(nextBucket(), 4);
    expect((await aspectsOf(owner, routineId))['orbis/routine']?.stage).toBe('paused');
  });

  test('отказ модели → failed refusal', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });
    const end = await run(new ScriptedProvider([refusal()]), { routineId, runId, bucket });
    expect(end).toEqual({ outcome: 'failed', reason: 'refusal' });
    expect((await runAspect(runId)).outcome).toBe('failed');
    // токены шага-отказа честно отмечены
    expect((await runAspect(runId)).usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  test('дедлайн проверяется между шагами: часы скакнули на 11 минут → failed deadline', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });

    let now = T0;
    const inner = new ScriptedProvider([
      toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/task' } }]),
      toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/note' } }]),
    ]);
    const provider = new HookedProvider(inner, () => {
      now = new Date(T0.getTime() + 11 * 60_000);
    });

    const end = await run(provider, { routineId, runId, bucket }, { clock: () => now });
    expect(end).toEqual({ outcome: 'failed', reason: 'deadline' });
    expect(inner.requests).toHaveLength(1); // второго обращения к модели не было
    expect((await runAspect(runId)).fail_note).toMatch(/дедлайн/);
  });

  test('процесс выключают: signal.abort между шагами → failed aborted', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });

    const ac = new AbortController();
    const inner = new ScriptedProvider([
      toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/task' } }]),
      toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/note' } }]),
    ]);
    const provider = new HookedProvider(inner, () => ac.abort());

    const end = await run(provider, { routineId, runId, bucket }, { signal: ac.signal });
    expect(end).toEqual({ outcome: 'failed', reason: 'aborted' });
    expect(inner.requests).toHaveLength(1);
    expect((await runAspect(runId)).fail_note).toMatch(/выключении процесса/);
  });

  test('исчерпанный лимит → failed limit, провайдер не вызван (инвариант 13, приёмка 15)', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });
    const provider = new ScriptedProvider([endTurn('не должно случиться')]);

    const end = await run(
      provider,
      { routineId, runId, bucket },
      { entitlements: () => ({ allowed: false, limit: 0 }) },
    );
    expect(end).toEqual({ outcome: 'failed', reason: 'limit' });
    expect(provider.requests).toHaveLength(0);
    const aspect = await runAspect(runId);
    expect(aspect.outcome).toBe('failed');
    expect(aspect.fail_note).toMatch(/лимит/);
    expect(aspect.usage).toBeUndefined();
  });

  test('прогон уже закрыт чужой рукой (подметание) → раннер молча выходит, ничего не переписывая', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = nextBucket();
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      bucket,
      run: { outcome: 'failed', fail_note: 'прогон прерван: нет шагов дольше 30 мин' },
    });
    const provider = new ScriptedProvider([endTurn('не должно случиться')]);

    const end = await run(provider, { routineId, runId, bucket });
    expect(end).toEqual({ outcome: 'failed', reason: 'aborted' });
    expect(provider.requests).toHaveLength(0);
    expect((await runAspect(runId)).fail_note).toBe('прогон прерван: нет шагов дольше 30 мин');
  });
});
