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
import { closeRoutineRun } from '../agent-loop/verbs';
import { ensureEntityThread } from '../chat/threads';
import { chatMessages, entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { makeChatJournalSink } from '../executor/journal';
import type { AspectsMap } from '../executor/normalize';
import { createPending } from '../policy/pending';
import type { ToolCallCtx, ToolDispatchResult } from '../tools/dispatch';

/** Боевой синк журнала — один инстанс на модуль (состояния не хранит), как в dispatch.ts. */
const sink = makeChatJournalSink();

/**
 * Аспекты, до которых предложение не дотягивается вовсе (инвариант 6, V1.10). Тот же
 * список, что у `assertRoutineUntouchable`: доверенность, выданную владельцем, нельзя
 * переписывать её же руками, и раздавать работу исполнителю рутина тоже не вправе.
 */
const FORBIDDEN_ASPECTS = ['orbis/routine', 'orbis/assignment'] as const;

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
    `операция ${index + 1} трогает рутину или назначение — предложить это нельзя (V1.6, инвариант 6): ${note}`,
    { reason: 'proposal_forbidden_target', index, tool },
  );
}

/** Русский плюрал правок: 1 правка, 2 правки, 5 правок — сводку читает владелец. */
function editsNoun(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'правок';
  const mod10 = n % 10;
  if (mod10 === 1) return 'правка';
  if (mod10 >= 2 && mod10 <= 4) return 'правки';
  return 'правок';
}

/**
 * Предложение рутины: проверить форму, снять предусловия с ТЕКУЩИХ значений, положить
 * pending в тред рутины и закрыть прогон исходом `finished` с судьбой предложения.
 *
 * Порядок именно такой. Pending пишется ДО закрытия прогона: обратный порядок оставлял бы
 * при сбое закрытый прогон, который обещает владельцу предложение, а предложения нет —
 * тупик, из которого нечего нажать. Осечка в другую сторону (pending есть, прогон не
 * закрылся) чинится повтором вызова с тем же `id`: pending дедуплицирован по прогону.
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

  const prepared = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
    const targets = await loadTargets(tx, parsed);
    if ('error' in targets) return targets;

    const operations: ExecOperation[] = [];
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
      const built = buildUpdate(index, op.input, current);
      if ('error' in built) return built;
      operations.push(built.op);
    }

    // 5. Pending в треде РУТИНЫ (V1.6): предложение — событие рутины, и читается оно там
    // же, где её история, а не в общей ленте владельца.
    const threadId = await ensureEntityThread(tx, ctx.actorUserId, routine.id);
    // Повтор виден по существующей строке с тем же PK: `createPending` идемпотентен, но
    // «завёл» и «нашёл» он не различает, а ответ обязан их различать (§7.8).
    const before = await tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.id, pendingId));
    const n = operations.length;
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
      card: {
        kind: 'proposal_card',
        pendingId,
        runId: routine.runId,
        routineId: routine.id,
        summary: `${n} ${editsNoun(n)}`,
        explanation: input.explanation,
      },
    });
    return { replayed: before.length > 0, operations: n };
  });
  if ('error' in prepared) return prepared.error;

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
  if (closed.status !== 'ok') return closed;

  const result: ProposeResult = {
    run_id: routine.runId,
    pending_id: pendingId,
    operations: prepared.operations,
    replayed: prepared.replayed,
  };
  return { status: 'ok', result };
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
 */
async function loadTargets(
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
    // Запрет по объекту, половина «по БД»: аспекта рутины в патче может не быть вовсе —
    // рутиной сущность делает её собственное состояние, а не форма операции.
    if (row.aspects['orbis/routine'] !== undefined) {
      return { error: forbiddenTarget(w.index, w.tool, `сущность ${w.id} — рутина`) };
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
 */
function buildUpdate(
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
