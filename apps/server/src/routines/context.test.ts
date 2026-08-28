// apps/server/src/routines/context.test.ts
// Контекст прогона рутины (V1.5) против живой БД: у раннера свой системный слой, а
// вместо ленты треда — история прошлых прогонов. Проверяется и то, чего в контексте
// быть НЕ должно: чат-промпта, роли 'system' в messages, обрезанной инструкции.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { RunSummary } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { ROUTINE_SYSTEM_PROMPT } from '../llm/prompts/routine-v2';
import { SYSTEM_PROMPT_V4 } from '../llm/prompts/v4';
import { agentLoopHelpers } from '../test/agent-loop-helpers';
import { buildRoutineContext, type RoutineHistoryItem, type RoutineHistoryUnit } from './context';

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
  clock?: () => Date,
) {
  return withIdentity(db, owner, (tx) =>
    buildRoutineContext(tx, {
      ownerId: owner,
      routine: {
        id: routineId,
        title: 'Утренний обзор',
        body: INSTRUCTION,
        props: {
          'orbis/routine_stage': 'active',
          'orbis/routine_at': '07:00',
          'orbis/routine_mode': mode,
          ...(allowedTools !== undefined && { 'orbis/allowed_tools': allowedTools }),
        },
      },
      run: { id: RUN_ID, bucket: '2026-08-17T07:00' },
      history,
      ...(clock !== undefined && { clock }),
    }),
  );
}

describe('buildRoutineContext: системный слой (V1.5)', () => {
  test('system = промпт раннера + дата + секция режима + инструкции аспектов + память + якорь-рутина; чат-промпта в нём нет', async () => {
    const routineId = await seedRoutine(owner, { title: 'Утренний обзор', body: INSTRUCTION });
    await seedEntity(owner, {
      title: 'Не назначать встречи до 10 утра',
      body: 'Утро — для работы над задачами.',
      tags: [],
      aspects: { 'orbis/memory': { kind: 'rule', scope: 'orbis/recurrence' } },
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

  // §Б7-6-1: фоновый прогон обязан знать дату не хуже чата — иначе «сегодняшние» задачи
  // рутина считает от даты обучения модели. Блока продолжений у раннера нет (гард
  // routine-v2.test.ts) — переставлять в его канале нечего, дата просто идёт за промптом.
  test('routine-канал: дата владельца стоит сразу после ROUTINE_SYSTEM_PROMPT; блока продолжений нет', async () => {
    const routineId = await seedRoutine(owner, { body: INSTRUCTION });
    const { system } = await contextOf(
      routineId,
      [],
      'propose',
      undefined,
      // Europe/Moscow (дефолт: строки user_settings у owner нет) — 22:30Z уже следующий день
      () => new Date('2026-08-26T22:30:00Z'),
    );
    const dateLine = 'Сегодня: 2026-08-27 (четверг), таймзона владельца: Europe/Moscow.';
    expect(system).toContain(dateLine);
    expect(system.indexOf(dateLine)).toBe(`${ROUTINE_SYSTEM_PROMPT}\n\n`.length);
    expect(system.indexOf(dateLine)).toBeLessThan(system.indexOf('режим: propose'));
    expect(system).not.toContain('Продолжения разговора:');
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

  test('принятое предложение: с edited_from — «принято с правками владельца», без него — прежняя строка байт-в-байт (Ш1.8)', async () => {
    const routineId = await seedRoutine(owner);
    const approved = (edited_from?: string): RoutineHistoryItem => ({
      run: summary({
        outcome: 'finished',
        bucket: '2026-08-15T07:00',
        report: 'Перенесу три просроченные задачи на сегодня.',
        proposal: {
          pending_id: RUN_ID,
          status: 'approved',
          ...(edited_from !== undefined && { edited_from }),
        },
      }),
      proposalStatus: 'approved',
      explanation: 'Перенесу три просроченные задачи на сегодня.',
    });
    /** Строка прогона — последняя в блоке истории (перед ней только шапка блока). */
    const lineOf = async (item: RoutineHistoryItem): Promise<string | undefined> => {
      const { messages } = await contextOf(routineId, [item]);
      return (messages[0]?.content ?? '').split('\n').at(-1);
    };

    // Правку владельца следующий прогон обязан УВИДЕТЬ: без неё он предложит то же слово
    // в слово, а «владелец принял» прочитается как «всё было верно»
    expect(await lineOf(approved('019e4466-bbbb-7e07-b5d4-64be9721da51'))).toBe(
      '— 2026-08-15T07:00: завершён; предлагал: «Перенесу три просроченные задачи на сегодня.»; предложение: принято с правками владельца',
    );
    // Прогон без правки не меняется ни на байт: поле опционально, и старые прогоны
    // обязаны давать модели ровно тот же текст, что до Ш1
    expect(await lineOf(approved())).toBe(
      '— 2026-08-15T07:00: завершён; предлагал: «Перенесу три просроченные задачи на сегодня.»; предложение: владелец принял',
    );
  });
});

// ---------------------------------------------------------------------------
// Единицы пачки в строке истории (D42 ОЧ.7, блокер Б1 ревью спеки). Ленту треда этот
// контекст не читает вовсе — значит ответы владельца и судьбы отложенных действий
// доезжают следующему прогону ТОЛЬКО отсюда. Тесты бьют по каждой ветке подписи: одна
// потерянная — это владелец, ответивший в пустоту.
// ---------------------------------------------------------------------------

describe('buildRoutineContext: единицы пачки в строке истории (D42 ОЧ.7, Б1)', () => {
  const QUESTION = 'Переносить ли встречу с Ирой?';
  const ANSWER = 'Не переноси, я сам напишу.';
  const ACTION = 'Архивировать «Прошлогодний отчёт»';

  /** Строка прогона — последняя в блоке истории (перед ней только шапка блока). */
  async function lineOf(routineId: string, item: RoutineHistoryItem): Promise<string> {
    const { messages } = await contextOf(routineId, [item]);
    return (messages[0]?.content ?? '').split('\n').at(-1) ?? '';
  }

  /**
   * Прогон-носитель единиц: голый `finished` без предложения, отчёта и чекпойнта — в
   * строке остаются слот, исход и сами единицы, и ни одна проверка подписи не смешивается
   * с прежними частями строки.
   */
  function withUnits(units: RoutineHistoryUnit[], omitted?: number): RoutineHistoryItem {
    return {
      run: summary({ outcome: 'finished', bucket: '2026-08-15T07:00' }),
      units,
      ...(omitted !== undefined && { unitsOmitted: omitted }),
    };
  }

  const HEAD = '— 2026-08-15T07:00: завершён';

  test('вопрос с ответом и принятая отложка: ответ владельца доезжает текстом (приёмка 7)', async () => {
    const routineId = await seedRoutine(owner);
    // Ровно та пара, ради которой написан весь срез: следующий прогон обязан прочитать,
    // что он уже спрашивал и что ему ответили, — иначе спросит то же самое заново
    expect(
      await lineOf(
        routineId,
        withUnits([
          { kind: 'question', text: QUESTION, fate: 'answered', answer: ANSWER },
          { kind: 'action', text: ACTION, fate: 'approved' },
        ]),
      ),
    ).toBe(
      `${HEAD}; спрашивал: «${QUESTION}» — ответ: «${ANSWER}»; откладывал: «${ACTION}» — принято`,
    );
  });

  test('вопрос: снят и без ответа — разные подписи (судьба вопроса единственна, ОЧ.8)', async () => {
    const routineId = await seedRoutine(owner);
    expect(
      await lineOf(routineId, withUnits([{ kind: 'question', text: QUESTION, fate: 'stale' }])),
    ).toBe(`${HEAD}; спрашивал: «${QUESTION}» — снят`);
    expect(
      await lineOf(routineId, withUnits([{ kind: 'question', text: QUESTION, fate: 'open' }])),
    ).toBe(`${HEAD}; спрашивал: «${QUESTION}» — без ответа`);
  });

  test('ответ БЕЗ текста — «отвечено», а не «без ответа»: рутина не спросит второй раз', async () => {
    const routineId = await seedRoutine(owner);
    // Сообщение ответа, написанное мимо процедуры, `listRunUnits` читает как `answered`
    // без `answer`: показать нечего, но выдать это за «владелец промолчал» нельзя
    expect(
      await lineOf(routineId, withUnits([{ kind: 'question', text: QUESTION, fate: 'answered' }])),
    ).toBe(`${HEAD}; спрашивал: «${QUESTION}» — отвечено`);
  });

  test('отложка: ждёт решения — не «отклонено»', async () => {
    const routineId = await seedRoutine(owner);
    expect(
      await lineOf(routineId, withUnits([{ kind: 'action', text: ACTION, fate: 'open' }])),
    ).toBe(`${HEAD}; откладывал: «${ACTION}» — ждёт решения`);
  });

  test('отклонённая отложка: подпись из ПАРЫ (fate, reason) — три разные судьбы', async () => {
    const routineId = await seedRoutine(owner);
    const rejected = async (reason: 'owner' | 'stale' | 'superseded'): Promise<string> =>
      lineOf(routineId, withUnits([{ kind: 'action', text: ACTION, fate: 'rejected', reason }]));
    // Разница не косметическая: «отклонено» рутина обязана прочитать как «так не делай»,
    // а «устарело»/«снято» — как «состояние ушло, попробуй заново по свежему»
    expect(await rejected('owner')).toBe(`${HEAD}; откладывал: «${ACTION}» — отклонено`);
    expect(await rejected('stale')).toBe(`${HEAD}; откладывал: «${ACTION}» — устарело`);
    expect(await rejected('superseded')).toBe(`${HEAD}; откладывал: «${ACTION}» — снято`);
  });

  test('текст единицы и ответа обрезаны HISTORY_TEXT_CAP (500) — отчёт на 20к не вытеснит инструкцию', async () => {
    const routineId = await seedRoutine(owner);
    const long = 'я'.repeat(600);
    const line = await lineOf(
      routineId,
      withUnits([{ kind: 'question', text: long, fate: 'answered', answer: long }]),
    );
    expect(line).toBe(`${HEAD}; спрашивал: «${'я'.repeat(500)}…» — ответ: «${'я'.repeat(500)}…»`);
    expect(line).not.toContain('я'.repeat(501));
  });

  test('переполнение потолка истории — «и ещё N решений» со склонением', async () => {
    const routineId = await seedRoutine(owner);
    const unit: RoutineHistoryUnit = { kind: 'action', text: ACTION, fate: 'approved' };
    const tail = async (omitted: number): Promise<string> =>
      lineOf(routineId, withUnits([unit], omitted));
    expect(await tail(1)).toBe(`${HEAD}; откладывал: «${ACTION}» — принято; и ещё 1 решение`);
    expect(await tail(2)).toBe(`${HEAD}; откладывал: «${ACTION}» — принято; и ещё 2 решения`);
    expect(await tail(5)).toBe(`${HEAD}; откладывал: «${ACTION}» — принято; и ещё 5 решений`);
    expect(await tail(11)).toBe(`${HEAD}; откладывал: «${ACTION}» — принято; и ещё 11 решений`);
    expect(await tail(21)).toBe(`${HEAD}; откладывал: «${ACTION}» — принято; и ещё 21 решение`);
  });

  test('прогон БЕЗ единиц — строка прежняя байт-в-байт: старые прогоны истории не меняются', async () => {
    const routineId = await seedRoutine(owner);
    // Ключа `units` у прогона до D42 нет вовсе (не пустой массив), и строка обязана
    // остаться той же, что до среза: «и ещё 0 решений» или лишняя «;» — уже регресс
    const item: RoutineHistoryItem = {
      run: summary({
        outcome: 'answered',
        bucket: '2026-08-16T07:00',
        report: 'Разобрал день.',
        checkpoint: { question: QUESTION, asked_at: '2026-08-16T04:01:00.000Z' },
        reply: { text: ANSWER, at: '2026-08-16T09:00:00.000Z' },
      }),
      reply: ANSWER,
    };
    expect(await lineOf(routineId, item)).toBe(
      `— 2026-08-16T07:00: владелец ответил; отчёт: «Разобрал день.»; спрашивал: «${QUESTION}»; ответ владельца: «${ANSWER}»`,
    );
  });
});
