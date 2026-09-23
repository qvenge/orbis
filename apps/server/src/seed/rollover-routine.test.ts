// apps/server/src/seed/rollover-routine.test.ts
// Рутина «Перенос остатков» (В-4, Р-29, Р-К-38/39/41) против живой БД: как она сеется, с какой
// доверенностью и что делает её прогон. Прогон — настоящим раннером на `ScriptedProvider` (довод
// `seed/gardener.test.ts`: «что видит и может модель прогона» проверяется только там, где реестр
// тулов собирает раннер по посеянным свойствам рутины).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type GraphId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { type RoutineRow, routineById } from '../agent-loop/queries';
import { withIdentity } from '../db/with-identity';
import type { ActionRecord } from '../executor/types';
import { ScriptedProvider } from '../llm/scripted';
import type { LLMResponse } from '../llm/types';
import { approvePending, listRunUnits } from '../policy/pending';
import { appRouter } from '../router';
import { runRoutineRun } from '../routines/runner';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import { type RoutineRef, routineToolAllowed } from '../tools/registry';
import { createCallerFactory } from '../trpc';
import { seedRoutineId } from './gardener';
import {
  ROLLOVER_ROUTINE_ALLOWED_TOOLS,
  ROLLOVER_ROUTINE_BODY,
  ROLLOVER_ROUTINE_PROPS,
  ROLLOVER_ROUTINE_SLUG,
  ROLLOVER_ROUTINE_TITLE,
  seedRolloverRoutine,
} from './rollover-routine';

requireEnv();

const { db, client } = appDb();
const { propsOf, seedRoutineRun } = agentLoopHelpers(db);
const createCaller = createCallerFactory(appRouter);

function callerFor(user: GraphId) {
  return createCaller({ identity: personal(user), actorKind: 'owner', db, clientVersion: null });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await client.end();
});

/** Заголовки рутин владельца — «какие рутины в графе» спрашиваем у графа. */
async function routineTitles(owner: GraphId): Promise<string[]> {
  const rows = (await withIdentity(db, personal(owner), (tx) =>
    tx.execute(sql`SELECT title FROM entities
                    WHERE graph_id = ${owner}::uuid AND aspects @> ARRAY['orbis/routine']::text[]
                    ORDER BY created_at`),
  )) as unknown as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

describe('сид рутины «Перенос остатков» (В-4, Р-29)', () => {
  test('онбординг сеет ОДНУ рутину с детерминированным id; повтор не плодит вторую', async () => {
    const owner = await freshGraph();
    expect(await callerFor(owner).user.seedOnboarding()).toEqual({ seeded: true });
    const id = seedRoutineId(owner, ROLLOVER_ROUTINE_SLUG);
    expect(await routineTitles(owner)).toContain(ROLLOVER_ROUTINE_TITLE);
    expect(await seedRolloverRoutine(db, personal(owner))).toEqual({ seeded: false, id });
    // Одна, а не две: и прямой повтор сева, и повтор ручки держит проба по PK.
    expect(await callerFor(owner).user.seedOnboarding()).toEqual({ seeded: false });
    expect((await routineTitles(owner)).filter((t) => t === ROLLOVER_ROUTINE_TITLE)).toHaveLength(
      1,
    );
  });

  test('доверенность: белый список РОВНО budget_rollover, стадия active', async () => {
    const owner = await freshGraph();
    await callerFor(owner).user.seedOnboarding();
    const props = await propsOf(owner, seedRoutineId(owner, ROLLOVER_ROUTINE_SLUG));
    // «Ровно один тул» — утверждение о ПРАВАХ: равенство списку, а не toContain.
    expect(props['orbis/allowed_tools']).toEqual([...ROLLOVER_ROUTINE_ALLOWED_TOOLS]);
    expect(props['orbis/allowed_tools']).toEqual(['budget_rollover']);
    expect(props['orbis/routine_stage']).toBe('active');
    expect(props['orbis/routine_mode']).toBe('act'); // Р-К-38, В-П-7
  });

  test('день месяца расписанием НЕ выражается — правило живёт в теле инструкции', () => {
    // `orbis/routine_days` — перечень дней НЕДЕЛИ (`builtin-properties.ts`), дня месяца у него нет;
    // отсутствие свойства = «каждый день» (`builtin-aspects.ts`). Пин держит ДОГОВОР: расписание
    // ежедневное, а «только первого числа» говорит тело.
    expect(ROLLOVER_ROUTINE_PROPS['orbis/routine_days']).toBeUndefined();
    expect(ROLLOVER_ROUTINE_BODY).toContain('первое число месяца');
  });

  test('гейт режима: тул проходит ровно в режиме act (Р-К-38)', () => {
    const allowed = (mode: 'propose' | 'act') =>
      routineToolAllowed({ name: 'budget_rollover', kind: 'mutate' }, {
        id: 'r',
        runId: 'run',
        mode,
        allowedTools: new Set(['budget_rollover']),
      } as RoutineRef);
    // В режиме `propose` рутине из мутаций доступен РОВНО `orbis_propose` (`routineToolAllowed`), а тот
    // принимает только правки графа (`PROPOSAL_ALLOWED_TOOLS`) — довод Р-16-1 садовника. Пин
    // фиксирует ФАКТ кода, из которого следует режим сида (Р-К-38, В-П-7).
    expect([allowed('propose'), allowed('act')]).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// Прогон посеянной рутины: фон откладывает перенос, конверты заводит «Принять» (Р-К-39)
// ---------------------------------------------------------------------------

function toolUse(name: string, input: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id: 'call-0', name, input }],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_use',
  };
}
function endTurn(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'end_turn',
  };
}

/** Конверты владельца за месяц — «создано ли что-нибудь» спрашиваем у графа. */
async function envelopesOf(owner: GraphId, periodStart: string): Promise<number> {
  const rows = (await withIdentity(db, personal(owner), (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM entities
                    WHERE graph_id = ${owner}::uuid AND 'orbis/budget' = ANY(aspects)
                      AND props->>'orbis/period_start' = ${periodStart}`),
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

async function anyCategory(owner: GraphId): Promise<string> {
  const rows = (await withIdentity(db, personal(owner), (tx) =>
    tx.execute(sql`SELECT id FROM entities
                    WHERE graph_id = ${owner}::uuid AND 'orbis/category' = ANY(aspects)
                    ORDER BY id LIMIT 1`),
  )) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('у владельца нет категорий — онбординг не отработал');
  return id;
}

describe('прогон рутины «Перенос остатков» (Р-К-38, Р-К-39)', () => {
  test('вызов budget_rollover из прогона — ОТЛОЖЕННАЯ единица; конвертов нет до «Принять», после — есть, с атрибуцией прогона', async () => {
    const owner = await freshGraph();
    await callerFor(owner).user.seedOnboarding();
    const categoryId = await anyCategory(owner);
    const routineId = seedRoutineId(owner, ROLLOVER_ROUTINE_SLUG);
    const bucket = '2026-09-01T09:00';
    const { runId } = await seedRoutineRun(owner, { routineId, bucket });
    const routine = await withIdentity(db, personal(owner), (tx) => routineById(tx, routineId));
    if (routine === null) throw new Error('рутина не посеяна');

    const month = '2031-01';
    const end = await runRoutineRun(
      {
        db,
        provider: new ScriptedProvider([
          // ОДНА строка — уровень таблицы `preview` (≤ 10), то есть малый перенос: и его фон не
          // исполняет сам (Р-К-39), а не только большой.
          toolUse('budget_rollover', {
            month,
            rows: [{ categoryId, limit: '5000.00', carryover: '120.00' }],
            batchId: newId(),
          }),
          endTurn('Перенос ждёт подтверждения владельца: один конверт.'),
        ]),
        model: 'scripted-model',
        clock: () => T0,
      },
      { identity: personal(owner), routine: routine satisfies RoutineRow, runId, bucket },
    );
    expect(end).toEqual({ outcome: 'finished' });
    expect(await envelopesOf(owner, `${month}-01`)).toBe(0);

    const units = await withIdentity(db, personal(owner), (tx) => listRunUnits(tx, owner, runId));
    expect(units.map((u) => [u.tool, u.fate])).toEqual([['budget_rollover', 'open']]);
    const unit = units[0];
    if (unit === undefined) throw new Error('единицы нет');
    expect(unit.card).toMatchObject({
      kind: 'deferred_action_card',
      summary: `Перенос остатков на ${month}: конвертов — 1`,
      rows: [{ field: categoryId, after: '5000.00' }],
    });
    const approved = await approvePending(db, {
      identity: personal(owner),
      pendingId: unit.pendingId,
    });
    expect(approved.ok).toBe(true);
    expect(await envelopesOf(owner, `${month}-01`)).toBe(1);
    // Судьба единицы — «принята»: audit ключуется pendingId, как у пачки (иначе «Принять все»
    // жевало бы исполненное снова).
    const after = await withIdentity(db, personal(owner), (tx) => listRunUnits(tx, owner, runId));
    expect(after.map((u) => u.fate)).toEqual(['approved']);
    // Атрибуция — ПРОГОН рутины, а не «владелец на экране»: откат прогона найдёт перенос по run_id.
    if (!approved.ok) return;
    const journal = (await withIdentity(db, personal(owner), (tx) =>
      tx.execute(sql`SELECT metadata FROM chat_messages
                      WHERE metadata @> ${JSON.stringify({ actions: [{ id: approved.actionId }] })}::jsonb`),
    )) as unknown as Array<{ metadata: { actions: ActionRecord[] } }>;
    const action = journal[0]?.metadata.actions[0];
    expect([action?.source, action?.run_id, action?.mechanism]).toEqual(['routine', runId, 'rule']);
    // Повторное «Принять» — replay, второй группы конвертов нет.
    const again = await approvePending(db, {
      identity: personal(owner),
      pendingId: unit.pendingId,
    });
    expect(again.ok && again.idempotentReplay).toBe(true);
    expect(await envelopesOf(owner, `${month}-01`)).toBe(1);
  });
});
