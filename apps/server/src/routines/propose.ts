// apps/server/src/routines/propose.ts
// `orbis_propose` (V1.6, V1.7) — ТЕРМИНАЛЬНЫЙ глагол рутины в режиме `propose`: она не
// пишет в граф, а кладёт в свой тред предложение — список правок плюс объяснение прозой —
// и на этом её прогон заканчивается.
//
// Механики предложения СВОЕЙ нет: внутри — обычный pending §7.10 (policy/pending.ts) с
// сохранённым payload'ом, который исполняет approve владельца. Второй механизм «отложенной
// правки» пришлось бы отдельно учить откату (§7.8), ревалидации и сериализации с reject —
// то есть повторить pending хуже.
//
// Что здесь СВОЕГО и почему:
//  1. Форма сужена (PROPOSAL_ALLOWED_TOOLS): предложение переживает решение владельца во
//     времени, поэтому в нём нет ни attach_* (имя зависит от реестра его аспектов), ни
//     обёрток вроде batch_execute.
//  2. Предусловия СНИМАЮТСЯ СЕРВЕРОМ с текущих значений (V1.7) — модель их не подставляет
//     и подставить не может (её схема их не принимает). Это и есть «инвариант 8»:
//     предложение, устаревшее к моменту одобрения, обязано проиграть владельцу, а не
//     затереть его правку молча.
//  3. Запрет по объекту (инвариант 6) проверяется здесь ДВАЖДЫ — по форме операции и по
//     строкам БД, — хотя третий рубеж стоит в executor'е (invariants.ts). Отказ на approve
//     пришёл бы владельцу, который ни в чём не виноват: он нажал «Применить» на карточке,
//     которую ему показали. Отказать обязаны рутине и в момент предложения.
import {
  type EntityUpdatePreconditionItem,
  entityCreateInput,
  entityUpdateExecInput,
  entityUpdateInput,
  type ProposeInput,
  type ProposeResult,
  pendingMessageId,
  relationCreateInput,
  relationDeleteInput,
} from '@orbis/shared';
import { eq, inArray } from 'drizzle-orm';
import { runById } from '../agent-loop/queries';
import { closeRoutineRun } from '../agent-loop/verbs';
import { ensureEntityThread } from '../chat/threads';
import { chatMessages, entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { makeChatJournalSink } from '../executor/journal';
import type { AspectsMap } from '../executor/normalize';
import { createPending, rejectedReason, rejectPending } from '../policy/pending';
import type { ToolCallCtx, ToolDispatchResult } from '../tools/dispatch';
import { editsNoun } from './constants';
import { countProposalRows } from './edits';

/** Боевой синк журнала — один инстанс на модуль (состояния не хранит), как в dispatch.ts. */
const sink = makeChatJournalSink();

/**
 * Аспекты, до которых предложение не дотягивается вовсе (инвариант 6, V1.10). Тот же
 * список, что у `assertRoutineUntouchable`: доверенность, выданную владельцем, нельзя
 * переписывать её же руками, раздавать работу исполнителю рутина не вправе, а прогоны —
 * бухгалтерия и ответы владельца, подделывать которые нельзя ни тулом, ни предложением.
 */
const FORBIDDEN_ASPECTS = ['orbis/routine', 'orbis/agent-run', 'orbis/assignment'] as const;

/** Аспекты, которые делают ЦЕЛЬ операции запретной по БД (сущность уже рутина/прогон). */
const FORBIDDEN_TARGET_ASPECTS = ['orbis/routine', 'orbis/agent-run'] as const;

/** Строгая схема входа каждого допустимого тула — та же, что у прямого вызова (§9.2). */
const OPERATION_SCHEMAS = {
  entity_create: entityCreateInput,
  entity_update: entityUpdateInput,
  relation_create: relationCreateInput,
  relation_delete: relationDeleteInput,
} as const;

type ExecOperation = { tool: string; input: Record<string, unknown> };

function err(code: string, message: string, details?: unknown): ToolDispatchResult {
  return { status: 'error', error: { code, message, details } };
}

/** Отказ запрета по объекту — один текст и один `reason` на обе проверки (форма и БД). */
function forbiddenTarget(index: number, tool: string, note: string): ToolDispatchResult {
  return err(
    'VALIDATION',
    `операция ${index + 1} трогает рутину, прогон или назначение — предложить это нельзя (V1.6, инвариант 6): ${note}`,
    { reason: 'proposal_forbidden_target', index, tool },
  );
}

/**
 * Предложение рутины: проверить форму, снять предусловия с ТЕКУЩИХ значений, положить
 * pending в тред рутины и закрыть прогон исходом `finished` с судьбой предложения.
 *
 * Порядок именно такой: pending пишется ДО закрытия прогона. Обратный порядок оставлял бы
 * при сбое закрытый прогон, который обещает владельцу предложение, а предложения нет —
 * тупик, из которого нечего нажать.
 *
 * Осечка в другую сторону — pending лёг, а прогон не закрылся — повтором НЕ чинится,
 * КОГДА закрытие провалилось терминально: прогон уже стал терминальным (подметание, дедлайн)
 * или перестал быть нашим, и второй вызов упрётся в то же предусловие. Поэтому сирота не
 * допускается вовсе, двумя мерами:
 *  - ПРЕДПРОВЕРКА прогона в той же транзакции ДО записи pending (`checkRun`): не `running`
 *    и это не наше же предложение — структурный CONFLICT, ничего не записано;
 *  - КОМПЕНСАЦИЯ субсекундной гонки: прогон стал терминальным между предпроверкой и
 *    закрытием — уже записанный pending гасится `rejectPending(reason:'stale')`, чтобы он
 *    не остался «принимаемым» (V1.8), и наружу идёт отказ закрытия.
 * Компенсация сужена до ТЕРМИНАЛЬНОГО отказа (финальное ревью V1, B2): нетерминальный
 * отказ закрытия — прежде всего занятый `id` вызова (replayMismatch: модель взяла uuid из
 * истории прогонов) — прогон живым оставляет, и повтор с новым `id` обязан связать его с
 * УЖЕ лежащим pending'ом; погашенный компенсацией pending превратил бы этот повтор в
 * прогон finished с предложением, которое «Принять» уже не исполнит. Поэтому перед
 * гашением прогон перечитывается, а в ветке существующего pending'а отклонённая карточка —
 * не replay, а отказ.
 */
export async function runPropose(
  ctx: ToolCallCtx,
  input: ProposeInput,
): Promise<ToolDispatchResult> {
  // 1. Второй рубеж поверх гейта режима (routineGate): контекст без рутины означает
  // поломку вызывающего, а не «рутина неизвестна» — предложение некуда положить.
  const routine = ctx.routine;
  if (ctx.source !== 'routine' || routine === undefined) {
    return err(
      'VALIDATION',
      'orbis_propose доступен только внутреннему исполнителю рутины (V1.6)',
      {
        tool: 'orbis_propose',
        source: ctx.source,
      },
    );
  }
  // Ровно один субъект (V1.5, симметрично сборке subject в dispatch.ts): грант приходит с
  // MCP, рутина — из фонового прогона, и оба ключа сразу означают контекст, собранный не
  // тем, кто шлёт вызов. Молчаливо предпочесть один из них значило бы приписать
  // предложение не тому исполнителю.
  if (ctx.grant !== undefined) {
    return err('VALIDATION', 'контекст вызова собран неверно: и грант, и рутина (V1.5)', {
      tool: 'orbis_propose',
    });
  }
  // Прогон в предложении и прогон в контексте — это один прогон. Разойтись они могут
  // только если модель сочинила `run_id`: тогда pending был бы дедуплицирован по ЧУЖОМУ
  // прогону, а закрытие упёрлось бы в чужого субъекта, оставив предложение висеть.
  if (input.run_id !== routine.runId) {
    return err('VALIDATION', 'предложение адресовано не тому прогону, из которого сделан вызов', {
      tool: 'orbis_propose',
      run_id: input.run_id,
    });
  }

  // 2. Каждая операция — строгой схемой СВОЕГО тула. Непротекание `precondition` держится
  // именно этим: `entityUpdateInput` (контракт тула) поля не знает и strict его отклонит.
  const parsed: Array<{ tool: keyof typeof OPERATION_SCHEMAS; input: Record<string, unknown> }> =
    [];
  for (const [index, op] of input.operations.entries()) {
    const schema = OPERATION_SCHEMAS[op.tool];
    const r = schema.safeParse(op.input);
    if (!r.success) {
      return err('VALIDATION', `операция ${index + 1} («${op.tool}») невалидна`, {
        index,
        tool: op.tool,
        issues: r.error.issues,
      });
    }
    parsed.push({ tool: op.tool, input: r.data as Record<string, unknown> });
  }

  // 3а. Запрет по объекту, статическая половина: аспект в САМОЙ операции.
  for (const [index, op] of parsed.entries()) {
    const aspects = op.input.aspects as Record<string, unknown> | undefined;
    if (aspects === undefined) continue;
    for (const aspectId of FORBIDDEN_ASPECTS) {
      if (aspectId in aspects) return forbiddenTarget(index, op.tool, `аспект ${aspectId}`);
    }
  }

  // 3б–4. Всё, что требует состояния графа, — одной транзакцией под RLS: строки целей
  // читаются один раз и служат сразу двум делам — запрету по объекту и снятию предусловий.
  const dedupeKey = `proposal:${routine.runId}`;
  const pendingId = pendingMessageId(ctx.actorUserId, dedupeKey);

  const prepared = await withIdentity(ctx.db, ctx.actorUserId, async (tx): Promise<Prepared> => {
    // Предпроверка прогона — ПЕРВОЙ, до любой работы и до записи: закрывать нечего, если
    // прогон уже терминален, и pending в этом случае писать нельзя (см. докблок выше).
    const state = await checkRun(tx, routine.id, routine.runId, pendingId);
    if (state !== 'running') return state;

    const targets = await loadTargets(tx, parsed);
    if ('error' in targets) return targets;

    const operations: ExecOperation[] = [];
    // Одно поле одной сущности — ОДНА операция на предложение. Две правки того же поля
    // разошлись бы с собственными предусловиями: вторая сняла бы `in:[исходное]`, а
    // применялась бы поверх первой (executor в батче читает виртуальную строку) и
    // гарантированно упала бы CONFLICT'ом на approve — то есть у владельца, на его кнопке.
    const seen: Seen = { fields: new Map(), entities: new Map() };
    for (const [index, op] of parsed.entries()) {
      if (op.tool !== 'entity_update') {
        // entity_create предусловий не имеет: сущности ещё нет, а занятый `id`
        // отклонит сам батч на approve (CONFLICT/id_conflict). Связи — тоже: их
        // «предусловие» это существование обоих концов, и его проверяет executor.
        operations.push({ tool: op.tool, input: op.input });
        continue;
      }
      const current = targets.rows.get(op.input.id as string);
      if (current === undefined) {
        // Недостижимо: loadTargets уже вернул бы NOT_FOUND
        return { error: err('NOT_FOUND', 'сущность не найдена', { id: op.input.id }) };
      }
      const clash = collides(seen, index, op.input);
      if (clash !== null) return { error: clash };
      const built = buildUpdate(index, op.input, current);
      if ('error' in built) return built;
      operations.push(built.op);
    }

    // 5. Pending в треде РУТИНЫ (V1.6): предложение — событие рутины, и читается оно там
    // же, где её история, а не в общей ленте владельца.
    const threadId = await ensureEntityThread(tx, ctx.actorUserId, routine.id);
    // Повтор виден по существующей строке с тем же PK: `createPending` идемпотентен, но
    // «завёл» и «нашёл» он не различает, а ответ обязан их различать (§7.8). Сюда мы
    // попадаем при ЖИВОМ прогоне — то есть это ретрай, у которого не дошло закрытие.
    const before = await tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.id, pendingId));
    if (before.length > 0) {
      // Лежащий pending уже отклонён (владелец с карточки, гашение, прошлая компенсация):
      // связать с ним прогон значило бы закрыть его предложением, которое «Принять» не
      // исполнит. Это не replay и не «предложи заново» — отказ владельцу нечем отменить.
      const rejected = await rejectedReason(tx, pendingId);
      if (rejected !== undefined) {
        return {
          error: err(
            'CONFLICT',
            `предложение этого прогона уже отклонено (${rejected}) — повторить его нельзя`,
            { reason: 'proposal_already_rejected', run_id: routine.runId, rejected },
          ),
        };
      }
    }
    // Сводка считает СТРОКИ, а не операции: их владелец и видит списком в карточке и в
    // плашке (см. `countProposalRows`). Ответ тулу ниже остаётся про ОПЕРАЦИИ — он про
    // batch, а не про экран.
    const n = countProposalRows(operations);
    await createPending(tx, {
      threadId,
      actor: {
        userId: ctx.actorUserId,
        kind: 'ai',
        source: 'routine',
        runId: routine.runId,
      },
      tool: 'batch_execute',
      // `batch_id` в payload'е обязателен: approve разбирает его схемой batch_execute
      // (policy/pending.ts, toOperations). Значение — сам pendingId: approve всё равно
      // ключует идемпотентность им, и второе число здесь было бы враньём про ключ.
      input: { batch_id: pendingId, operations },
      level: 'explicit-confirmation',
      dedupeKey,
      clock: ctx.clock,
      // Строка ленты называет событие («Предложение рутины: 2 правки»), а не «Требуется
      // подтверждение: 2 операции»: это не подтверждение чата, а предложение (V1.6, D-4)
      content: `Предложение рутины: ${n} ${editsNoun(n)}`,
      card: {
        kind: 'proposal_card',
        pendingId,
        runId: routine.runId,
        routineId: routine.id,
        summary: `${n} ${editsNoun(n)}`,
        explanation: input.explanation,
      },
    });
    return { kind: 'created', replayed: before.length > 0, operations: operations.length };
  });
  if ('error' in prepared) return prepared.error;
  if (prepared.kind === 'replay') {
    // Прогон уже закрыт ЭТИМ ЖЕ предложением: повтор вызова (с `id` или без) обязан
    // вернуть тот же ответ, а не закрывать прогон второй раз и не плодить карточку.
    return {
      status: 'ok',
      result: {
        run_id: routine.runId,
        pending_id: pendingId,
        operations: prepared.operations,
        replayed: true,
      } satisfies ProposeResult,
    };
  }

  // 6. Закрытие прогона — ОДНОЙ операцией с судьбой предложения (closeRoutineRun кладёт
  // `proposal` тем же патчем, что исход): состояния «прогон закрыт, а предложения при нём
  // нет» не должно быть ни на миг — по нему экран рутины решает, ждёт ли она ответа.
  const closed = await closeRoutineRun(
    {
      db: ctx.db,
      ownerId: ctx.actorUserId,
      subject: { kind: 'routine', routineId: routine.id },
      clock: ctx.clock ?? (() => new Date()),
      sink,
    },
    {
      runId: routine.runId,
      outcome: 'finished',
      report: input.explanation,
      proposal: { pending_id: pendingId, status: 'pending' },
      ...(input.id !== undefined && { id: input.id }),
    },
  );
  if (closed.status !== 'ok') {
    // Гонка с подметанием (окно между предпроверкой и CAS закрытия): pending уже записан,
    // а прогон, который должен был на него сослаться, закрыт чужой рукой. Гасим карточку
    // причиной 'stale' — «предложение снято, потому что устарело», а не отказом владельца
    // (V1.8). Свою неудачу компенсация проглатывает: наружу идёт причина отказа закрытия,
    // а не вторая ошибка поверх неё.
    //
    // Гасим ТОЛЬКО если прогон и правда больше не наш живой (перечитываем — состояние
    // авторитетнее текста отказа): нетерминальный отказ (занятый `id` вызова и т. п.)
    // оставляет прогон running, а pending — ждать повтора с новым `id` (см. шапку).
    const alive = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
      const row = await runById(tx, routine.runId);
      return row !== null && row.run.routine_id === routine.id && row.run.outcome === 'running';
    });
    if (!alive) {
      await rejectPending(ctx.db, {
        ownerId: ctx.actorUserId,
        pendingId,
        reason: 'stale',
      });
    }
    return closed;
  }

  const result: ProposeResult = {
    run_id: routine.runId,
    pending_id: pendingId,
    operations: prepared.operations,
    replayed: prepared.replayed,
  };
  return { status: 'ok', result };
}

/** Что получилось собрать: предложение записано, узнан свой же повтор либо отказ. */
type Prepared =
  | { kind: 'replay'; operations: number }
  | { kind: 'created'; operations: number; replayed: boolean }
  | { error: ToolDispatchResult };

/** Исход предпроверки прогона: работаем дальше либо готовый ответ вызывающему. */
type RunCheck = 'running' | { kind: 'replay'; operations: number } | { error: ToolDispatchResult };

/**
 * Прогон ЖИВ и он наш? (fix round 1) Проверка стоит ДО записи pending, потому что
 * `closeRoutineRun` на терминальном прогоне отказывает — и повтор вызова этого не чинит:
 * предусловие `outcome:'running'` провалится и во второй раз. Без предпроверки в треде
 * рутины оставалась бы карточка-зомби: `approvePending` её применит, а прогон о ней ничего
 * не знает — ни V1.8 («следующий прогон гасит незакрытое»), ни статус рутины её не увидят.
 *
 * Терминальный прогон, у которого `proposal.pending_id` — РОВНО наш детерминированный
 * pendingId, это не отказ, а собственный повтор: предложение уже лежит, прогон уже закрыт
 * им же. Отвечаем replay'ем, ничего не трогая.
 *
 * Читаем без замка намеренно: авторитетную сверку делает CAS самого закрытия
 * (`runStillMine` в closeRun), а субсекундную гонку компенсирует `rejectPending` выше.
 * Замок здесь удерживался бы до конца всей транзакции сборки — дороже, чем компенсация.
 */
async function checkRun(
  tx: Tx,
  routineId: string,
  runId: string,
  pendingId: string,
): Promise<RunCheck> {
  const row = await runById(tx, runId);
  if (row === null) return { error: err('NOT_FOUND', 'прогон не найден', { run_id: runId }) };
  if (row.run.routine_id !== routineId) {
    return { error: err('CONFLICT', 'прогон принадлежит другой рутине', { run_id: runId }) };
  }
  if (row.run.outcome === 'running') return 'running';
  if (row.run.proposal?.pending_id === pendingId) {
    // Размер берём из САМОГО предложения, а не из повторного вызова: ответ описывает то,
    // что лежит в треде владельца, а не то, что модель прислала во второй раз.
    const n = await storedOperationCount(tx, pendingId);
    if (n !== null) return { kind: 'replay', operations: n };
  }
  return {
    error: err('CONFLICT', `прогон завершён (${row.run.outcome}) — предложение не принимается`, {
      run_id: runId,
      outcome: row.run.outcome,
    }),
  };
}

/** Сколько операций в уже лежащем предложении; null — карточки нет (журнал повреждён). */
async function storedOperationCount(tx: Tx, pendingId: string): Promise<number | null> {
  const rows = await tx
    .select({ metadata: chatMessages.metadata })
    .from(chatMessages)
    .where(eq(chatMessages.id, pendingId));
  const stored = rows[0]?.metadata as
    | { pending?: { input?: { operations?: unknown[] } } }
    | undefined;
  const operations = stored?.pending?.input?.operations;
  return Array.isArray(operations) ? operations.length : null;
}

/** Что уже правят предыдущие операции предложения: поля по сущности и сами сущности. */
interface Seen {
  /** «сущность + аспект + поле» → номер первой операции. */
  fields: Map<string, number>;
  /** сущность → первая операция по ней и правит ли хоть одна из них тело. */
  entities: Map<string, { index: number; body: boolean }>;
}

/**
 * Не правит ли операция то, что УЖЕ правит предыдущая (fix round 1)? Ключ — сущность плюс
 * поле аспекта.
 *
 * Отказ здесь, а не на approve: предусловия обеих операций снимаются с ОДНОГО исходного
 * состояния, а исполняются они последовательно поверх друг друга (в батче executor читает
 * виртуальную строку) — вторая гарантированно разошлась бы со своим предусловием, и
 * владелец получил бы CONFLICT на кнопке, которую ему предложили нажать.
 *
 * ТЕЛО — правило шире (финальное ревью V1, B2-2): правка тела сущности X несовместима с
 * ЛЮБОЙ другой `entity_update` X в том же предложении, в любом порядке. У тела свой CAS по
 * `updated_at` строки (§5.2), а `updated_at` бампит любая правка сущности: в батче вторая
 * операция по X читает виртуальную строку с уже сдвинутым `updated_at`, и CAS тела, снятый
 * с исходной строки, гарантированно даёт STALE_VERSION на approve — независимо от того,
 * стоит правка тела первой или второй.
 */
function collides(
  seen: Seen,
  index: number,
  input: Record<string, unknown>,
): ToolDispatchResult | null {
  const id = input.id as string;
  const hasBody = input.body !== undefined;
  const prev = seen.entities.get(id);
  if (prev !== undefined && (prev.body || hasBody)) {
    return err(
      'VALIDATION',
      `операции ${prev.index + 1} и ${index + 1} правят одну сущность ${id}, и одна из них — её тело: правка тела в предложении должна быть единственной операцией по сущности`,
      { reason: 'proposal_conflicting_operations', index, first: prev.index, id, field: 'тело' },
    );
  }
  seen.entities.set(id, { index: prev?.index ?? index, body: (prev?.body ?? false) || hasBody });

  const keys: Array<{ key: string; what: string }> = [];
  const aspects = input.aspects as Record<string, Record<string, unknown> | null> | undefined;
  for (const [aspectId, patch] of Object.entries(aspects ?? {})) {
    if (patch === null) continue; // detach отклоняет buildUpdate — своим, более точным текстом
    for (const field of Object.keys(patch)) {
      keys.push({ key: `${id}\u0000${aspectId}\u0000${field}`, what: `${aspectId}.${field}` });
    }
  }
  for (const { key, what } of keys) {
    const first = seen.fields.get(key);
    if (first !== undefined) {
      return err(
        'VALIDATION',
        `операции ${first + 1} и ${index + 1} правят одно и то же (${what} сущности ${id}) — в предложении так нельзя`,
        { reason: 'proposal_conflicting_operations', index, first, id, field: what },
      );
    }
    seen.fields.set(key, index);
  }
  return null;
}

interface TargetRow {
  aspects: AspectsMap;
  updatedAt: Date;
}

/**
 * Цели операций под RLS: строки, до которых предложение дотягивается по id. Читаются ОДНИМ
 * запросом и служат обеим оставшимся проверкам — запрету по объекту (сущность уже рутина) и
 * снятию предусловий (текущие значения полей).
 *
 * Отсутствующая цель — NOT_FOUND здесь, а не на approve: предложение правки того, чего нет,
 * не станет валидным от ожидания, а владельцу пришлось бы разбирать отказ на своей кнопке.
 *
 * Экспортирована для отложки диспатча (D42 ОЧ.13, `tools/dispatch.ts`): единица пачки
 * снимает предусловия ровно теми же двумя шагами, что предложение, — прочитать цель и
 * собрать по ней `entity_update`. Второй такой пары в сервере быть не должно: разъехавшись,
 * она дала бы предложению и отложке РАЗНЫЕ предусловия на одном и том же патче.
 */
export async function loadTargets(
  tx: Tx,
  parsed: Array<{ tool: string; input: Record<string, unknown> }>,
): Promise<{ rows: Map<string, TargetRow> } | { error: ToolDispatchResult }> {
  const wanted: Array<{ index: number; tool: string; id: string }> = [];
  for (const [index, op] of parsed.entries()) {
    if (op.tool === 'entity_update') {
      wanted.push({ index, tool: op.tool, id: op.input.id as string });
    } else if (op.tool === 'relation_create' || op.tool === 'relation_delete') {
      wanted.push({ index, tool: op.tool, id: op.input.source_id as string });
      wanted.push({ index, tool: op.tool, id: op.input.target_id as string });
    }
  }
  const rows = new Map<string, TargetRow>();
  if (wanted.length === 0) return { rows };

  const found = await tx
    .select({ id: entities.id, aspects: entities.aspects, updatedAt: entities.updatedAt })
    .from(entities)
    .where(
      inArray(
        entities.id,
        wanted.map((w) => w.id),
      ),
    );
  for (const row of found) {
    rows.set(row.id, { aspects: row.aspects as AspectsMap, updatedAt: row.updatedAt });
  }

  for (const w of wanted) {
    const row = rows.get(w.id);
    if (row === undefined) {
      // Чужая строка и несуществующая под RLS неразличимы — единый NOT_FOUND (как в executor)
      return { error: err('NOT_FOUND', 'сущность не найдена', { id: w.id, index: w.index }) };
    }
    // Запрет по объекту, половина «по БД»: аспекта рутины (прогона) в патче может не быть
    // вовсе — рутиной или прогоном сущность делает её собственное состояние, а не форма
    // операции.
    for (const aspectId of FORBIDDEN_TARGET_ASPECTS) {
      if (row.aspects[aspectId] !== undefined) {
        return {
          error: forbiddenTarget(
            w.index,
            w.tool,
            `сущность ${w.id} — ${aspectId === 'orbis/routine' ? 'рутина' : 'прогон'}`,
          ),
        };
      }
    }
  }
  return { rows };
}

/**
 * Правка в exec-форме: тот же вход плюс СНЯТОЕ предусловие (V1.7).
 *
 * По каждому полю патча: поля не было — `absent: true`, поле есть — `in: [текущее]`. Оба
 * пункта об одном: «применимо, пока владелец не тронул это сам». Форма `absent` не сводится
 * к `in`: отсутствие поля не совпадает ни с одним значением (докблок assertPrecondition), а
 * предложение сплошь и рядом ДОПИСЫВАЕТ поле, которого ещё не было.
 *
 * Патч тела едет со своим существующим CAS (§5.2) — `expectedUpdatedAt` текущей строки:
 * предусловия аспектов о теле ничего не знают, и без него правка тела затирала бы чужую.
 *
 * Экспортирована для отложки диспатча (D42 ОЧ.13) — см. довод у `loadTargets`. Функция
 * ходит ТОЛЬКО по `input.aspects`, поэтому для чистой архивации (`{id, archived:true}`)
 * даёт ПУСТОЙ список: `archived` — колонка, а не поле аспекта. Предусловие по колонке
 * (псевдо-аспект `orbis/entity`, `executor.ts`) добавляет к результату сам диспатч — здесь
 * оно появиться не может, потому что предложение обязано остаться байт-в-байт прежним.
 */
export function buildUpdate(
  index: number,
  input: Record<string, unknown>,
  current: TargetRow,
): { op: ExecOperation } | { error: ToolDispatchResult } {
  const precondition: EntityUpdatePreconditionItem[] = [];
  const aspects = input.aspects as Record<string, Record<string, unknown> | null> | undefined;
  for (const [aspectId, patch] of Object.entries(aspects ?? {})) {
    if (patch === null) {
      // Снятие аспекта целиком: предусловия «аспект ещё на месте» в форме {aspect, field}
      // не существует, а без него detach молча выигрывал бы у любой правки владельца.
      return {
        error: err(
          'VALIDATION',
          `снятие аспекта предложением не поддерживается (операция ${index + 1}, ${aspectId})`,
          { reason: 'proposal_detach_unsupported', index, aspect: aspectId },
        ),
      };
    }
    for (const field of Object.keys(patch)) {
      const value = current.aspects[aspectId]?.[field];
      precondition.push(
        value === undefined
          ? { aspect: aspectId, field, absent: true }
          : { aspect: aspectId, field, in: [value] },
      );
    }
  }

  const { expectedUpdatedAt: _fromModel, ...rest } = input;
  const built = {
    ...rest,
    // Модельный expectedUpdatedAt отбрасывается намеренно: CAS предложения снимается ТОГДА
    // ЖЕ, когда предусловия, — с той же прочитанной строки. Без тела он вообще ни на что не
    // влияет (executor смотрит на него только при правке body), и хранить его значило бы
    // держать в payload'е поле, которое ничего не значит.
    ...(input.body !== undefined && { expectedUpdatedAt: current.updatedAt.toISOString() }),
    ...(precondition.length > 0 && { precondition }),
  };
  // Fail-closed: собранная операция обязана быть валидной exec-формой. Провал здесь —
  // программная ошибка сборки, а не отказ домену, поэтому голый Error.
  const check = entityUpdateExecInput.safeParse(built);
  if (!check.success) {
    throw new Error(`runPropose: собранный entity_update невалиден: ${check.error.message}`);
  }
  return { op: { tool: 'entity_update', input: built } };
}
