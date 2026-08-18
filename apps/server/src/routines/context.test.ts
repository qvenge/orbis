// apps/server/src/routines/context.test.ts
// Контекст прогона рутины (V1.5) против живой БД: у раннера свой системный слой, а
// вместо ленты треда — история прошлых прогонов. Проверяется и то, чего в контексте
// быть НЕ должно: чат-промпта, роли 'system' в messages, обрезанной инструкции.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { RunSummary } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { ROUTINE_SYSTEM_PROMPT } from '../llm/prompts/routine-v1';
import { SYSTEM_PROMPT_V4 } from '../llm/prompts/v4';
import { agentLoopHelpers } from '../test/agent-loop-helpers';
import { buildRoutineContext, type RoutineHistoryItem } from './context';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const { seedEntity, seedRoutine } = agentLoopHelpers(db);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

const INSTRUCTION = [
  'Собери план дня:',
  '- посмотри задачи со сроком сегодня и просроченные;',
  '- предложи, что делать, и объясни почему.',
].join('\n');

const RUN_ID = '019e4466-aaaa-7e07-b5d4-64be9721da51';

/** Минимальная сводка прогона: только то, что схема требует всегда. */
function summary(over: Partial<RunSummary> & Pick<RunSummary, 'outcome'>): RunSummary {
  return {
    id: RUN_ID,
    started_at: '2026-08-16T04:00:00.000Z',
    step_count: 1,
    last_steps: [],
    ...over,
  };
}

async function contextOf(
  routineId: string,
  history: RoutineHistoryItem[] = [],
  mode: 'propose' | 'act' = 'propose',
  allowedTools?: string[],
) {
  return withIdentity(db, owner, (tx) =>
    buildRoutineContext(tx, {
      ownerId: owner,
      routine: {
        id: routineId,
        title: 'Утренний обзор',
        body: INSTRUCTION,
        routine: {
          stage: 'active',
          at: '07:00',
          mode,
          ...(allowedTools !== undefined && { allowed_tools: allowedTools }),
        },
      },
      run: { id: RUN_ID, bucket: '2026-08-17T07:00' },
      history,
    }),
  );
}

describe('buildRoutineContext: системный слой (V1.5)', () => {
  test('system = промпт раннера + секция режима + инструкции аспектов + память + якорь-рутина; чат-промпта в нём нет', async () => {
    const routineId = await seedRoutine(owner, { title: 'Утренний обзор', body: INSTRUCTION });
    await seedEntity(owner, {
      title: 'Не назначать встречи до 10 утра',
      body: 'Утро — для работы над задачами.',
      tags: [],
      aspects: { 'orbis/memory': { kind: 'rule', scope: 'календарь' } },
    });

    const { system } = await contextOf(routineId);

    expect(system.startsWith(ROUTINE_SYSTEM_PROMPT)).toBe(true);
    // Промпт чат-ассистента в фоновом прогоне не участвует (V1.5): он завершал бы цикл
    // «ответом пользователю», которого никто не прочтёт
    expect(system).not.toContain(SYSTEM_PROMPT_V4);
    expect(system).toContain('режим: propose');
    expect(system).toContain(`run_id этого прогона: ${RUN_ID}`);
    expect(system).toContain('2026-08-17T07:00');
    expect(system).toContain('Инструкции активных аспектов:');
    expect(system).toContain('Память о пользователе');
    expect(system).toContain('Не назначать встречи до 10 утра');
    expect(system).toContain(`id: ${routineId}`);
  });

  test('инструкция рутины приезжает ЦЕЛИКОМ, со строками (тело = задание, V1.1)', async () => {
    const routineId = await seedRoutine(owner, { body: INSTRUCTION });
    const { system } = await contextOf(routineId);
    const block = system.slice(system.indexOf('Инструкция рутины (тело сущности):'));
    // не превью и не схлопнутая в одну строку: список пунктов обязан остаться списком
    // (пустые строки между блоками добавляет нормализация тела — не наша забота)
    expect(block).toContain('\n- посмотри задачи со сроком сегодня и просроченные;');
    expect(block).toContain('\n- предложи, что делать, и объясни почему.');
    expect(block).not.toContain('…');
  });

  test('act: секция режима перечисляет ровно белый список владельца', async () => {
    const routineId = await seedRoutine(owner, { routine: { mode: 'act' } });
    const { system } = await contextOf(routineId, [], 'act', ['entity_update']);
    expect(system).toContain('режим: act');
    expect(system).toContain('entity_update');
  });
});

describe('buildRoutineContext: история вместо треда (V1.5, Р-18)', () => {
  test('messages — два user-сообщения: история и сработавшая рутина; роли system нет', async () => {
    const routineId = await seedRoutine(owner);
    const { messages } = await contextOf(routineId);

    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.role === 'user')).toBe(true);
    expect(messages[0]?.content.startsWith('[история прогонов]')).toBe(true);
    expect(messages[1]?.content).toBe(
      'Сработала рутина «Утренний обзор» (бакет 2026-08-17T07:00). Выполни инструкцию.',
    );
  });

  test('прошлых прогонов нет — блок истории остаётся и говорит об этом прямо', async () => {
    const routineId = await seedRoutine(owner);
    const { messages } = await contextOf(routineId);
    expect(messages[0]?.content).toMatch(/прогонов[^.]*не было/i);
  });

  test('сводки: что предлагал → статус предложения, вопрос → ответ владельца, сбой → причина', async () => {
    const routineId = await seedRoutine(owner);
    const history: RoutineHistoryItem[] = [
      {
        run: summary({
          outcome: 'finished',
          bucket: '2026-08-15T07:00',
          report: 'Три задачи просрочены — предлагаю перенести их на сегодня.',
          proposal: { pending_id: RUN_ID, status: 'superseded' },
        }),
        proposalStatus: 'superseded',
        explanation: 'Три задачи просрочены — предлагаю перенести их на сегодня.',
      },
      {
        run: summary({
          outcome: 'answered',
          bucket: '2026-08-16T07:00',
          checkpoint: {
            question: 'Переносить ли встречу с Ирой?',
            asked_at: '2026-08-16T04:01:00.000Z',
          },
          reply: { text: 'Не переноси, я сам напишу.', at: '2026-08-16T09:00:00.000Z' },
        }),
        reply: 'Не переноси, я сам напишу.',
      },
      {
        run: summary({
          outcome: 'failed',
          bucket: '2026-08-17T06:00',
          fail_note: 'AI-провайдер недоступен',
        }),
      },
    ];

    const { messages } = await contextOf(routineId, history);
    const text = messages[0]?.content ?? '';

    expect(text).toContain('2026-08-15T07:00');
    expect(text).toContain('Три задачи просрочены — предлагаю перенести их на сегодня.');
    expect(text).toContain('заменено новым прогоном');
    expect(text).toContain('Переносить ли встречу с Ирой?');
    expect(text).toContain('Не переноси, я сам напишу.');
    expect(text).toContain('AI-провайдер недоступен');
  });
});
