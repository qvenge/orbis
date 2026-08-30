// apps/server/src/seed/gardener.test.ts
// «Садовник словаря» (§А2-7, Р17, рулинги Р-16-1 и Р-17-1) против живой БД: как он сеется,
// с какой доверенностью и что делает его прогон.
//
// Прогон гоняется ЦЕЛИКОМ — настоящим раннером (`runRoutineRun`) на `ScriptedProvider`, а не
// вызовом `dispatchTool` с подложенным контекстом. Разница здесь не стилистическая: доводы
// Р-16-1 («в `propose` отложенная единица садовнику недостижима») и «белый список ровно из
// одного тула» — это утверждения о том, ЧТО ВИДИТ И МОЖЕТ МОДЕЛЬ ПРОГОНА, и проверить их
// можно только там, где реестр тулов собирает раннер по посеянным свойствам рутины.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { type RoutineRow, routineById } from '../agent-loop/queries';
import { ensureEntityThread } from '../chat/threads';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { ScriptedProvider } from '../llm/scripted';
import type { LLMProvider, LLMResponse } from '../llm/types';
import { appRouter } from '../router';
import { type RunEnd, runRoutineRun } from '../routines/runner';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import { createCallerFactory } from '../trpc';
import {
  GARDENER_ALLOWED_TOOLS,
  GARDENER_SLUG,
  GARDENER_TITLE,
  seedGardener,
  seedRoutineId,
} from './gardener';
import { seedOnboarding } from './onboarding';

requireEnv();

const { db, client } = appDb();
const { propsOf, seedRoutineRun } = agentLoopHelpers(db);
const createCaller = createCallerFactory(appRouter);

const MODEL = 'scripted-model';

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await client.end();
});

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

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

/** Своё свойство владельца — той же операцией исполнителя, что зовут тул и роутер. */
async function ownProperty(owner: string, ru: string): Promise<{ id: string; key: string }> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    operations: [
      {
        tool: 'property_create',
        input: {
          label: { ru },
          description: { ru: `Смысл «${ru}»` },
          type: { kind: 'number' },
          status: 'active',
        },
      },
    ],
  });
  if (!r.ok) throw new Error(`ownProperty: ${r.error.code} ${r.error.message}`);
  const out = r.results[0] as { property: string; key: string };
  return { id: out.property, key: out.key };
}

/** Строки реестра как они лежат: «слияние НЕ применилось» доказывает база, а не ответ тула. */
async function mergedIntoOf(owner: string, id: string): Promise<unknown> {
  const rows = (await withIdentity(db, owner, (tx) =>
    tx.execute(
      sql`SELECT merged_into FROM property_definitions
           WHERE owner_id = ${owner}::uuid AND id = ${id}`,
    ),
  )) as unknown as Array<{ merged_into: unknown }>;
  return rows[0]?.merged_into ?? null;
}

/** Сущности владельца с аспектом рутины — «сколько садовников в графе» спрашиваем у графа. */
async function routineRows(owner: string): Promise<Array<{ id: string; title: string }>> {
  return (await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT id, title FROM entities
                    WHERE owner_id = ${owner}::uuid AND aspects @> ARRAY['orbis/routine']::text[]
                    ORDER BY created_at`),
  )) as unknown as Array<{ id: string; title: string }>;
}

/** Карточки пачки в треде рутины — единица пачки наблюдается строкой в БД, а не ответом. */
async function pendingsOf(owner: string, threadId: string) {
  const rows = (await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT metadata FROM chat_messages
                    WHERE thread_id = ${threadId}::uuid AND metadata ? 'pending'
                    ORDER BY created_at`),
  )) as unknown as Array<{ metadata: { pending: Record<string, unknown> } }>;
  return rows.map((r) => r.metadata.pending);
}

interface RunProps {
  'orbis/run_outcome': string;
  'orbis/run_report'?: string;
  'orbis/run_steps': Array<{ summary: string }>;
}

let bucketSeq = 0;
/** Свой плановый слот на каждый прогон: бакет занят навсегда (V1.3). */
function nextBucket(): string {
  bucketSeq += 1;
  return `2026-08-${String((bucketSeq % 28) + 1).padStart(2, '0')}T09:00`;
}

/**
 * Полный прогон садовника: сид владельца → прогон в его бакете → раннер на сценарии.
 * Возвращает всё, что нужно потребителю для проб У ПОТРЕБИТЕЛЯ (тред, прогон, исход).
 */
async function runGardener(
  owner: string,
  provider: LLMProvider,
): Promise<{ end: RunEnd; runId: string; threadId: string; routineId: string; run: RunProps }> {
  const routineId = seedRoutineId(owner, GARDENER_SLUG);
  const bucket = nextBucket();
  const { runId } = await seedRoutineRun(owner, { routineId, bucket });
  const routine = await withIdentity(db, owner, (tx) => routineById(tx, routineId));
  if (routine === null) throw new Error('садовник не найден — сид не отработал');
  const end = await runRoutineRun(
    { db, provider, model: MODEL, clock: () => T0 },
    { ownerId: owner, routine: routine satisfies RoutineRow, runId, bucket },
  );
  const threadId = await withIdentity(db, owner, (tx) => ensureEntityThread(tx, owner, routineId));
  const run = (await propsOf(owner, runId)) as unknown as RunProps;
  return { end, runId, threadId, routineId, run };
}

// ---------------------------------------------------------------------------

describe('сид садовника словаря (Р-17-1)', () => {
  test('онбординг сеет ОДНОГО садовника с детерминированным id; повтор ручки не плодит второго', async () => {
    const owner = freshUserId();
    const caller = callerFor(owner);

    expect(await caller.user.seedOnboarding()).toEqual({ seeded: true });
    const first = await routineRows(owner);
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe(seedRoutineId(owner, GARDENER_SLUG));
    expect(first[0]?.title).toBe(GARDENER_TITLE);

    // Одноразовость §7 распространяется и на вторую фазу сева.
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect(await routineRows(owner)).toHaveLength(1);

    // …и прямой повтор второй фазы тоже: идемпотентность держит проба по PK, а не guard.
    expect(await seedGardener(db, owner)).toEqual({
      seeded: false,
      id: seedRoutineId(owner, GARDENER_SLUG),
    });
    expect(await routineRows(owner)).toHaveLength(1);
  });

  test('садовник ДОСЕВАЕТСЯ владельцу, у которого онбординг уже был, а садовника нет (почему проба по PK, а не guard настроек)', async () => {
    // Сценарий Р-17-1 живьём: первая фаза закоммитилась, вторая упала (кончился коннекшн,
    // отказ валидатора — что угодно). Guard настроек на следующем заходе ответил бы
    // «онбординг уже был» и не досеял бы садовника НИКОГДА.
    const owner = freshUserId();
    await withIdentity(db, owner, (tx) => seedOnboarding(tx, owner));
    expect(await routineRows(owner)).toHaveLength(0);

    const caller = callerFor(owner);
    // Ручка честно говорит «онбординг уже был» — и всё-таки досевает садовника.
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    const rows = await routineRows(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(seedRoutineId(owner, GARDENER_SLUG));
  });

  test('доверенность садовника: act, белый список РОВНО property_merge, понедельник 09:00, стадия active', async () => {
    const owner = freshUserId();
    await callerFor(owner).user.seedOnboarding();
    const props = await propsOf(owner, seedRoutineId(owner, GARDENER_SLUG));

    expect(props['orbis/routine_mode']).toBe('act');
    // «Ровно один тул» — это утверждение о ПРАВАХ: равенство списку, а не `toContain`.
    expect(props['orbis/allowed_tools']).toEqual([...GARDENER_ALLOWED_TOOLS]);
    expect(props['orbis/allowed_tools']).toEqual(['property_merge']);
    expect(props['orbis/routine_days']).toEqual(['mo']);
    expect(props['orbis/routine_at']).toBe('09:00');
    expect(props['orbis/routine_stage']).toBe('active');
  });

  test('сев прошёл ЧЕРЕЗ исполнителя и МИМО журнала: аспект на строке есть, audit-сообщения нет', async () => {
    const owner = freshUserId();
    await callerFor(owner).user.seedOnboarding();

    // Через исполнителя — значит строка прошла стадию 2: аспект лежит в колонке `aspects`,
    // а свойства — плоско по id (§А1-1). Прямой SQL-сид этого не гарантировал бы.
    const rows = (await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT aspects, props FROM entities
                      WHERE id = ${seedRoutineId(owner, GARDENER_SLUG)}::uuid`),
    )) as unknown as Array<{ aspects: string[]; props: Record<string, unknown> }>;
    expect(rows[0]?.aspects).toEqual(['orbis/routine']);
    // §А1-3: `title` живёт КОЛОНКОЙ и в `props` не попадает (CORE_IN_PROPS).
    expect(rows[0]?.props['orbis/title']).toBeUndefined();

    // Мимо журнала: ни одного сообщения у владельца — ни audit'а сева, ни карточки.
    const msgs = (await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM chat_messages m
                      JOIN chat_threads t ON t.id = m.thread_id
                     WHERE t.owner_id = ${owner}::uuid`),
    )) as unknown as Array<{ n: number }>;
    expect(Number(msgs[0]?.n)).toBe(0);
  });
});

describe('прогон садовника (Р-16-1, §С8-11)', () => {
  test('дубль своих свойств → property_merge ложится ОТЛОЖЕННОЙ ЕДИНИЦЕЙ в пачку, реестр не тронут, прогон продолжается и пишет отчёт', async () => {
    const owner = freshUserId();
    await callerFor(owner).user.seedOnboarding();
    const source = await ownProperty(owner, 'Усилие');
    const into = await ownProperty(owner, 'Уровень усилия');

    const report =
      'Предложил слить «Усилие» в «Уровень усилия» — это одно и то же. ' +
      'Сироты: «Настроение» (0 носителей, 0 значений). ' +
      'Предложения старше 14 дней: «Темп» (40 дней).';
    const { end, threadId, runId, run } = await runGardener(
      owner,
      new ScriptedProvider([
        toolUse('property_catalog', {}),
        toolUse('property_merge', { source: source.id, into: into.id }),
        endTurn(report),
      ]),
    );

    // Прогон НЕ оборвался на отложке: «pending_confirmation» для модели — не отказ.
    expect(end).toEqual({ outcome: 'finished' });
    expect(run['orbis/run_outcome']).toBe('finished');

    // Единица наблюдается СТРОКОЙ в треде рутины, а не ответом функции.
    const pendings = await pendingsOf(owner, threadId);
    expect(pendings).toHaveLength(1);
    expect(pendings[0]?.kind).toBe('action');
    expect(pendings[0]?.tool).toBe('property_merge');
    expect(pendings[0]?.run_id).toBe(runId);
    expect(pendings[0]?.input).toEqual({ source: source.id, into: into.id });

    // Реестр до решения владельца не тронут: слияние до `execute` не доходит ни одним путём.
    expect(await mergedIntoOf(owner, source.id)).toBeNull();

    // Отчёт — финальный текст хода: и он, и обе рассказанные им находки лежат в прогоне
    // (белый список садовника — ровно `property_merge`, `thread_post` ему недоступен).
    expect(run['orbis/run_report']).toBe(report);
    expect(run['orbis/run_report']).toContain('Сироты');
    expect(run['orbis/run_report']).toContain('старше 14 дней');
    // Шаги прогона называют отложенное содержанием, а не именем тула.
    expect(run['orbis/run_steps'].map((s) => s.summary)).toEqual([
      'property_catalog: ok',
      'отложено: Слияние свойств: «Усилие» → «Уровень усилия»',
    ]);
  });

  test('ВСТРОЕННОЕ свойство концом слияния → отказ по объекту (routine_untouchable), единица НЕ рождается', async () => {
    const owner = freshUserId();
    await callerFor(owner).user.seedOnboarding();
    const own = await ownProperty(owner, 'Усилие');

    const provider = new ScriptedProvider([
      // Оба конца проверяются порознь: слияние пишет и в источник, и в цель.
      toolUse('property_merge', { source: own.id, into: 'orbis/task_status' }),
      toolUse('property_merge', { source: 'orbis/task_status', into: own.id }),
      endTurn('Встроенные свойства сливать нельзя — сказал владельцу словами.'),
    ]);
    const { end, threadId, run } = await runGardener(owner, provider);

    expect(end).toEqual({ outcome: 'finished' });
    // «Не откладывается никогда»: ни одной карточки в пачке.
    expect(await pendingsOf(owner, threadId)).toHaveLength(0);
    expect(await mergedIntoOf(owner, own.id)).toBeNull();
    // Оба вызова получили ОТКАЗ, а не отложку, — и это видно в шагах прогона.
    expect(run['orbis/run_steps'].map((s) => s.summary)).toEqual([
      'property_merge: error',
      'property_merge: error',
    ]);

    // ЧТО ИМЕННО ответил сервер, читаем У ПОТРЕБИТЕЛЯ — в ленте, которую увидела модель:
    // «error» в шаге не отличает запрет по объекту от опечатки во входе, а различать их
    // модель обязана (отказ по объекту повтором не чинится).
    for (const step of [1, 2]) {
      const seen = JSON.stringify(provider.requests[step]?.messages ?? []);
      expect(seen).toContain('routine_untouchable');
      expect(seen).toContain('перенастройка системного объекта');
      // Отказ обязан вести к выходу, иначе модель чинит не то и вечно.
      expect(seen).toContain('orbis_ask');
    }
  });

  test('реестр тулов прогона: `property_merge` и чтения видны, остальные четыре тула реестра — нет; вызов сверх списка отклонён гейтом режима', async () => {
    // Вторая половина «ровно одного тула»: список тулов — подсказка модели, доступ решает
    // сервер, и разойтись они не имеют права (V1.10). Пин на ОБОИХ рубежах.
    const owner = freshUserId();
    await callerFor(owner).user.seedOnboarding();

    const provider = new ScriptedProvider([
      toolUse('aspect_delta_set', { aspect: 'orbis/task', delta: { icon: '📌' } }),
      endTurn('Инструмента нет — доложил владельцу.'),
    ]);
    const { end, threadId, run } = await runGardener(owner, provider);
    expect(end).toEqual({ outcome: 'finished' });

    const shown = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    expect(shown).toContain('property_merge');
    expect(shown).toContain('property_catalog'); // чтения открыты рутине в любом режиме
    expect(shown).toContain('orbis_ask'); // ROUTINE_BASE_TOOLS — выход из тупика
    for (const hidden of [
      'property_create',
      'property_update',
      'aspect_delta_set',
      'aspect_delta_remove',
      'entity_update',
      'batch_execute',
      'undo_last',
      // `thread_post` — тоже мутация, и он тоже вне списка: пиши садовник отчёт им, «ровно
      // один тул» перестало бы быть правдой на ЭТОМ рубеже, а тест доверенности выше
      // (равенство списку) остался бы единственным сторожем.
      'thread_post',
    ]) {
      expect(shown).not.toContain(hidden);
    }
    // Вызов по угаданному имени всё равно отклонён — гейтом режима, а не запретом по объекту.
    expect(run['orbis/run_steps'].map((s) => s.summary)).toEqual(['aspect_delta_set: error']);
    expect(await pendingsOf(owner, threadId)).toHaveLength(0);
  });
});
