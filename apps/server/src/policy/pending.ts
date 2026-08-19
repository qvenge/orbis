// apps/server/src/policy/pending.ts
// Pending-подтверждения §7.10 (Task 6): «одобрение исполняет сохранённый payload,
// не повторяет вызов модели». explicit-confirmation-действие НЕ исполняется — в тред
// пишется карточка-запрос с immutable payload'ом (envelope-валидированным в момент
// запроса), и до approve НИЧЕГО не записано ни в граф, ни в журнал §7.8. approve
// прогоняет сохранённый payload ПОЛНЫМ конвейером executor'а (стадии 1–7) без
// обращения к LLM; reject — системное сообщение-отказ (журнал append-only, §4.6).
//
// РЕШЕНИЕ ПО КОНТРАКТУ levelGate (dispatch): полная провалидированность payload'а
// (стадии 2–4 конвейера §9.2 — aspects-схемы, инварианты, expectedUpdatedAt/§5.2) —
// обязанность РЕВАЛИДАЦИИ APPROVE, а не dry-run'а при создании pending: dry-run не
// спасает от изменения состояния за время ожидания (ревалидация на approve обязательна
// в любом случае), а двойная валидация избыточна. Цена: структурная ошибка возможна
// после «Подтвердить» — честно и приемлемо для MVP.
//
// МЕХАНИКА ИДЕМПОТЕНТНОСТИ approve — batch §7.8 без нового механизма: payload
// исполняется атомарной группой с batch_id = pendingId (одиночный тул — batch из
// одной операции, валиден по §9.2; payload-batch_execute — собственная структура с
// ПЕРЕЗАПИСЬЮ его batch_id на pendingId — двойная идемпотентность по одному ключу).
// Детерминированный audit-id = batchAuditMessageId(owner, pendingId) — он заменяет
// отдельную формулу uuidv5('approval:<owner>:<pendingId>') ранней редакции брифа:
// та же детерминированность и идемпотентность по PK chat_messages, но одним общим
// механизмом (резолюция координатора). Подмена batch_id безопасна: pendingId
// генерирует сервер (uuidv7), коллизия с клиентским batch_id невероятна. Повторный
// approve: findByAuditId → replay сохранённого результата; гонка одинаковых approve →
// AuditIdConflictError → тот же replay (§7.8).
import {
  batchAuditMessageId,
  batchExecuteInput,
  newId,
  pendingMessageId,
  rejectMessageId,
} from '@orbis/shared';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { escalateAfterMutation } from '../ai/escalation';
import { appendMessageIdempotent } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import type { Db } from '../db/client';
import { chatMessages } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError, type StructuredError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind, ExecuteResult } from '../executor/types';
import type { Card } from '../tools/registry';
import type { ConfirmationLevel } from './confirmation';

// Боевой синк §7.8 — audit-сообщение approve пишется тем же tx, что стадия 5
const sink = makeChatJournalSink();

/** Русский плюрал операций batch: 1 операция, 2 операции, 5 операций. */
export function operationsNoun(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'операций';
  const mod10 = n % 10;
  if (mod10 === 1) return 'операция';
  if (mod10 >= 2 && mod10 <= 4) return 'операции';
  return 'операций';
}

/**
 * Формат metadata.pending карточки-запроса. Zod-парс при чтении — fail-closed:
 * повреждённая/чужеродная запись не исполняется. Без .strict() — форвард-совместимость
 * с будущими полями. actor_kind/source — атрибуция ИСХОДНОГО актора (§7.8, D11):
 * approve владельца исполняет план от имени запросившего AI/агента.
 */
const pendingRecord = z.object({
  id: z.string().uuid(),
  tool: z.string().min(1), // executor-форма (attach_<aspect_id с заменой «/»>)
  input: z.record(z.unknown()), // immutable payload — envelope-валидирован при создании
  actor_kind: z.enum(['owner', 'ai', 'agent']),
  source: z.enum(['chat', 'mcp', 'routine']),
  /**
   * Грант исходного вызова (С2) — вторая половина той же атрибуции: approve владельца
   * исполняет план от имени запросившего, и владелец обязан видеть, КАКОЙ доступ его
   * попросил. Ключа нет у владельческих и чатовых путей (за ними стоит сам владелец) и
   * не было у записей до этой работы — потому optional, а не обязательное поле;
   * миграции не нужно: metadata — jsonb, схема читается без .strict().
   */
  actor_grant_id: z.string().optional(),
  /**
   * Прогон рутины, предложивший этот план (V1.6). Тот же приём, что с грантом: одобрил
   * владелец, но в журнале §7.8 остаётся видно, ЧЕЙ прогон это предложил — по run_id
   * действие находит откат прогона (rollback.ts) и история рутины. Ключа нет у чата,
   * UI и MCP — там прогона нет; у записей до этой работы его тоже не было.
   */
  run_id: z.string().uuid().optional(),
  created_at: z.string(),
});

export type PendingRecord = z.infer<typeof pendingRecord>;

export interface PendingActor {
  userId: string; // владелец графа (D11)
  kind: ActorKind;
  source: 'chat' | 'mcp' | 'routine';
  /** Грант, от имени которого пришёл запрос (С2); нет у чата и UI — там актор сам владелец. */
  grantId?: string;
  /** Прогон рутины, предложивший план (V1.6); есть только у source 'routine'. */
  runId?: string;
}

/**
 * Карточка-запрос explicit-confirmation (§7.10): системное сообщение с
 * metadata.pending (immutable payload) + metadata.cards[confirmation_card
 * mode:'explicit'] — или карточка из args.card, если вызывающий рисует запрос по-своему
 * (V1.6). НИЧЕГО в граф и журнал: сообщение не несёт metadata.actions,
 * поэтому для журнала §7.8 (undo-сканы containment'ом по actions) невидимо.
 *
 * id сообщения = pendingId — прямая адресация; поиск при approve/reject —
 * containment по metadata.pending.id (GIN chat_messages_metadata_gin).
 * input обязан быть envelope-валидированным (контракт levelGate, fix round Task 5);
 * полная провалидированность — ревалидация approve (см. шапку модуля).
 */
export async function createPending(
  tx: Tx,
  args: {
    threadId?: string; // нет → глобальный тред владельца (как у audit-синка §7.8)
    actor: PendingActor;
    tool: string; // executor-форма; для batch — 'batch_execute'
    input: unknown; // envelope-валидированный payload (для batch — с транслированными именами)
    level: ConfirmationLevel;
    /**
     * Исходный batch_id модели: детерминирует pendingId (pendingMessageId) → ретрай
     * того же batch на explicit-уровне даёт тот же PK, appendMessageIdempotent
     * возвращает исходную карточку, а не плодит вторую (митигация Minor-4 Task 6).
     * Нет ключа (одиночная мутация без batch_id) → серверный uuidv7, дедуп не применим.
     */
    dedupeKey?: string;
    clock?: () => Date;
    /**
     * Карточка вместо confirmation_card по умолчанию (V1.6): предложение рутины рисуется
     * своей карточкой (proposal_card) — у неё другой текст, другие кнопки и статус с
     * сервера. Механика pending при этом та же: карточка — только представление, а
     * исполняет approve сохранённый payload. Не задана → confirmation_card.
     */
    card?: Card;
    /**
     * Человекочитаемая сводка вместо умолчания (имя тула / «N операций») — для карточки и
     * текста сообщения. Нужна там, где содержимое payload'а определяет ПРАВА (выдача
     * автономии рутине, V1.10): владелец обязан видеть, что подтверждает — режим и белый
     * список, а не «attach_orbis_routine».
     */
    summary?: string;
    /**
     * Текст сообщения-запроса вместо «Требуется подтверждение: <summary>». Предложение
     * рутины — не подтверждение чата: его строка в ленте называет само событие.
     */
    content?: string;
  },
): Promise<{ pendingId: string; card: Card }> {
  if (args.level !== 'explicit-confirmation') {
    // Программная ошибка вызывающего, не доменный отказ: pending порождает только
    // explicit-уровень (§7.10) — прочие уровни исполняются/отклоняются в dispatch
    throw new Error(`createPending: уровень «${args.level}» pending не порождает (§7.10)`);
  }
  const pendingId =
    args.dedupeKey !== undefined ? pendingMessageId(args.actor.userId, args.dedupeKey) : newId();
  const threadId = args.threadId ?? (await ensureGlobalThread(tx, args.actor.userId));
  const summary = args.summary ?? pendingSummary(args.tool, args.input);
  const card: Card = args.card ?? {
    kind: 'confirmation_card',
    mode: 'explicit',
    pendingId,
    summary,
  };
  const createdAt = (args.clock ?? (() => new Date()))();
  // Идемпотентность по pendingId: при dedupeKey (batch_id) повтор того же batch даёт тот
  // же PK → ON CONFLICT возвращает ИСХОДНУЮ запись (append-only — сохранённый payload
  // первого запроса, §4.6), вторая карточка не пишется. Карточка детерминирована (тот же
  // pendingId и summary при идентичном ретрае), поэтому реконструируется, а не читается.
  await appendMessageIdempotent(tx, {
    id: pendingId,
    threadId,
    role: 'system',
    content: args.content ?? `Требуется подтверждение: ${summary}`,
    metadata: {
      pending: {
        id: pendingId,
        tool: args.tool,
        input: args.input,
        actor_kind: args.actor.kind,
        source: args.actor.source,
        // Условная запись, а не `actor_grant_id: undefined`: ключ отсутствует у путей
        // без гранта — как в action'е журнала (executor.ts) и как проверяет тест
        ...(args.actor.grantId !== undefined && { actor_grant_id: args.actor.grantId }),
        // То же и для прогона (V1.6): ключа нет у путей без рутины
        ...(args.actor.runId !== undefined && { run_id: args.actor.runId }),
        created_at: createdAt.toISOString(),
      },
      cards: [card],
    },
  });
  return { pendingId, card };
}

/** Summary карточки-запроса: batch — «N операций» (как preview), одиночный — имя тула. */
function pendingSummary(tool: string, input: unknown): string {
  if (tool === 'batch_execute') {
    const env = batchExecuteInput.safeParse(input);
    if (env.success) {
      const n = env.data.operations.length;
      return `${n} ${operationsNoun(n)}`;
    }
  }
  return tool;
}

interface FoundPending {
  threadId: string;
  pending: PendingRecord;
}

/** Карточка-запрос по pendingId — containment по GIN (RLS скоупит владельцем). */
async function findPendingMessage(tx: Tx, pendingId: string): Promise<FoundPending | undefined> {
  const probe = JSON.stringify({ pending: { id: pendingId } });
  const rows = await tx.execute(
    sql`SELECT thread_id, metadata FROM chat_messages
        WHERE metadata @> ${probe}::jsonb
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return undefined;
  const parsed = pendingRecord.safeParse((row.metadata as { pending?: unknown }).pending);
  if (!parsed.success) {
    // fail-closed: повреждённый payload не исполняем (metadata неизменяема §4.6 —
    // сюда ведёт только баг записи или чужеродное сообщение с ключом pending)
    throw new ExecError('VALIDATION', 'pending-запись повреждена — исполнение невозможно', {
      pendingId,
      issues: parsed.error.issues,
    });
  }
  return { threadId: row.thread_id as string, pending: parsed.data };
}

/**
 * Причина отказа (V1.8): «владелец отказался» и «прогон заменил своё же предложение
 * новым» — разные события, и рутина обязана их различать, иначе замена читалась бы как
 * отказ владельца и останавливала бы её навсегда.
 *
 * 'owner' — кнопка владельца (по умолчанию); 'superseded' — раннер гасит предложение
 * прошлого прогона своим новым; 'stale' — состояние изменилось, предложение больше
 * не применимо.
 */
export type RejectReason = 'owner' | 'superseded' | 'stale';

const rejectReason = z.enum(['owner', 'superseded', 'stale']);

/** Текст reject-сообщения по причине — владелец читает ленту, а не значение поля. */
const REJECT_CONTENT: Record<RejectReason, string> = {
  owner: 'Подтверждение отклонено',
  superseded: 'Предложение заменено новым прогоном',
  stale: 'Предложение устарело: состояние изменилось',
};

/**
 * Причина отказа pending'а, если он отклонён; undefined — не отклонён.
 *
 * Проба контейнментом — прежняя, {type, rejects} БЕЗ причины: отказ обязан находиться
 * независимо от того, кто и почему его записал (иначе approve исполнил бы заменённое
 * предложение). Причина читается уже из найденного сообщения.
 *
 * Сообщения, написанные до появления причины, ключа reason не несут (metadata
 * неизменяема, §4.6) — читаются как отказ владельца: до V1.8 отклонить pending могла
 * только его кнопка, так что это не догадка, а факт истории.
 */
export async function rejectedReason(tx: Tx, pendingId: string): Promise<RejectReason | undefined> {
  const probe = JSON.stringify({ type: 'confirmation_rejected', rejects: pendingId });
  const rows = await tx.execute(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return undefined;
  const parsed = rejectReason.safeParse((row.metadata as { reason?: unknown }).reason);
  return parsed.success ? parsed.data : 'owner';
}

/** Pending отклонён ⇔ существует сообщение {type:'confirmation_rejected', rejects}. */
async function isRejected(tx: Tx, pendingId: string): Promise<boolean> {
  return (await rejectedReason(tx, pendingId)) !== undefined;
}

/**
 * Сериализация approve/reject одного pendingId (fix round Task 6): advisory-lock
 * уровня транзакции — умирает на commit/rollback. Берётся ПЕРВЫМ statement'ом
 * tx reject'а и audit-tx approve (executor beforeStages): без него approve
 * (проверки в одном tx, исполнение в другом) и reject образуют write-skew —
 * оба проходят свои проверки до чужого коммита, и владелец получает «исполнено»
 * И «отклонено» одновременно. Ключ — hashtextextended(pendingId): pendingId
 * глобально уникален (uuidv7), межвладельческие коллизии хэша безвредны
 * (кратковременная лишняя сериализация, не ошибка).
 */
async function acquirePendingLock(tx: Tx, pendingId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${pendingId}, 0))`);
}

/** Операции ExecuteRequest из сохранённого payload (batch — собственная структура). */
function toOperations(pending: PendingRecord): Array<{ tool: string; input: unknown }> {
  if (pending.tool === 'batch_execute') {
    const env = batchExecuteInput.safeParse(pending.input);
    if (!env.success) {
      throw new ExecError('VALIDATION', 'pending-запись повреждена — batch-envelope невалиден', {
        pendingId: pending.id,
        issues: env.error.issues,
      });
    }
    // batch_id из payload НЕ используется — идемпотентность approve ключуется
    // pendingId (перезапись batch_id, см. шапку модуля)
    return env.data.operations;
  }
  return [{ tool: pending.tool, input: pending.input }];
}

/**
 * Одобрение §7.10: исполнить СОХРАНЁННЫЙ payload, не повторяя вызов модели.
 * Порядок проверок: (1) pending виден под RLS (чужой и несуществующий → единый
 * NOT_FOUND); (2) не отклонён → VALIDATION «отклонено»; (3) исполненность проверяет
 * сам executor batch-путём (findByAuditId по batchAuditMessageId(owner, pendingId) →
 * идемпотентный replay сохранённого результата — «как executor для batch», §7.8).
 * Исполнение — полный конвейер (стадии 1–7): это и есть «ревалидация текущего
 * состояния» §7.10 — изменившееся/удалённое состояние даёт структурную ошибку
 * (NOT_FOUND/STALE_VERSION/INVARIANT/...), не тихий провал, и ничего не пишет.
 *
 * Сериализация против reject (fix round): проверка (2) в отдельном tx — лишь
 * fast-path; авторитетная перепроверка «не отклонён» выполняется ПОД advisory-lock'ом
 * по pendingId ПЕРВЫМ statement'ом audit-tx executor'а (beforeStages) — В ТОМ ЖЕ tx,
 * где пишется audit-сообщение. Конкурентный reject держит тот же замок: он либо
 * закоммитился ДО захвата (перепроверка увидит reject-сообщение свежим snapshot'ом
 * READ COMMITTED → «отклонено», ни одной записи), либо ждёт наш commit и увидит
 * audit-сообщение → «уже исполнено». Write-skew исключён; закреплено гонным тестом.
 */
export async function approvePending(
  db: Db,
  args: { ownerId: string; pendingId: string; clock?: () => Date },
): Promise<ExecuteResult> {
  try {
    const found = await withIdentity(db, args.ownerId, async (tx) => {
      const msg = await findPendingMessage(tx, args.pendingId);
      if (!msg) {
        throw new ExecError('NOT_FOUND', `pending-подтверждение ${args.pendingId} не найдено`, {
          pendingId: args.pendingId,
        });
      }
      if (await isRejected(tx, args.pendingId)) {
        throw new ExecError(
          'VALIDATION',
          `подтверждение ${args.pendingId} отклонено — исполнение невозможно (§7.10)`,
          { pendingId: args.pendingId },
        );
      }
      return msg;
    });
    // Вне tx проверок: execute открывает собственный withIdentity-tx (вложить нельзя).
    // Чтение pending отдельным tx безопасно: journal append-only, metadata неизменяема
    // (§4.6). audit — в тред карточки-запроса; атрибуция — исходный актор (§7.8)
    const operations = toOperations(found.pending);
    const r = await execute(
      db,
      {
        actorUserId: args.ownerId,
        actorKind: found.pending.actor_kind,
        source: found.pending.source,
        // Грант исходного вызова доживает до исполнения (С2): подтвердил владелец, но в
        // журнале §7.8 видно, КАКОЙ доступ этот план попросил
        actorGrantId: found.pending.actor_grant_id,
        // Прогон рутины — та же логика, что с грантом (V1.6): предложение одобрил
        // владелец, но сделала правку рутина, и по run_id её найдёт откат прогона
        runId: found.pending.run_id,
        threadId: found.threadId,
        operations,
        batchId: args.pendingId,
        clock: args.clock,
      },
      {
        sink,
        // Первый statement audit-tx (до replay-проверки и стадий 1–7): замок +
        // авторитетная перепроверка «не отклонён» — см. док approvePending
        beforeStages: async (tx) => {
          await acquirePendingLock(tx, args.pendingId);
          if (await isRejected(tx, args.pendingId)) {
            throw new ExecError(
              'VALIDATION',
              `подтверждение ${args.pendingId} отклонено — исполнение невозможно (§7.10)`,
              { pendingId: args.pendingId },
            );
          }
        },
      },
    );

    // Эскалация повторных исправлений (§7.8) — ВТОРАЯ точка вызова (уборочная фаза,
    // решение 4). Батч из 11+ операций classifyToolCall уводит в explicit-confirmation,
    // и диспатч возвращает pending_confirmation ДО execute — то есть мимо своего вызова
    // эскалации. Исполняет сохранённый payload только этот путь, поэтому «перенеси все 12
    // покупок в Пятёрочке из Еды в Развлечения» дважды не давало предложения правила
    // никогда: рекатегоризации в журнал попадали, но триггер не срабатывал.
    // Задвоения нет — из диспатча этот payload не исполняется вовсе; повторный approve
    // отсекается idempotentReplay (журналировать нечего). Ошибку эскалация логирует
    // внутри и не пробрасывает: правки уже закоммичены.
    if (r.ok && !r.idempotentReplay && found.pending.source === 'chat') {
      await escalateAfterMutation(db, {
        ownerId: args.ownerId,
        actionId: r.actionId,
        operations,
      });
    }
    return r;
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}

export type RejectPendingResult =
  | { ok: true; pendingId: string; alreadyRejected: boolean; reason: RejectReason }
  | { ok: false; error: StructuredError };

/**
 * Отклонение §7.10: журнал append-only (§4.6) — карточка-запрос не правится, в её
 * тред пишется НОВОЕ системное сообщение {type:'confirmation_rejected', rejects}
 * с детерминированным PK rejectMessageId(owner, pendingId) — идемпотентность reject
 * по PK, как у audit-сообщений (§7.8). Уже исполненный pending отклонить нельзя
 * (audit-сообщение по детерминированному PK уже существует) → VALIDATION.
 *
 * Сериализация против approve (fix round): advisory-lock по pendingId ПЕРВЫМ
 * statement'ом tx — конкурентный approve держит тот же замок в audit-tx; проверка
 * «уже исполнено» идёт строго после захвата, поэтому видит его закоммиченный audit
 * (или сама коммитится первой, и approve увидит reject). Повторный reject
 * идемпотентен: проверка isRejected под замком + ON CONFLICT DO NOTHING по
 * детерминированному PK (двойная страховка — второго сообщения не бывает).
 *
 * Причина (V1.8) определяет текст сообщения и уезжает в metadata.reason. Повторный
 * reject возвращает ИСХОДНУЮ причину, а не переданную: сообщение append-only, и врать
 * про то, что записано в ленте, нельзя — раннер, гасящий уже отклонённое владельцем
 * предложение, обязан увидеть 'owner', а не своё 'superseded'.
 */
export async function rejectPending(
  db: Db,
  args: { ownerId: string; pendingId: string; reason?: RejectReason },
): Promise<RejectPendingResult> {
  const reason = args.reason ?? 'owner';
  try {
    return await withIdentity(db, args.ownerId, async (tx) => {
      await acquirePendingLock(tx, args.pendingId); // первым statement'ом — см. док выше
      const msg = await findPendingMessage(tx, args.pendingId);
      if (!msg) {
        throw new ExecError('NOT_FOUND', `pending-подтверждение ${args.pendingId} не найдено`, {
          pendingId: args.pendingId,
        });
      }
      const auditId = batchAuditMessageId(args.ownerId, args.pendingId);
      const executed = await tx
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.id, auditId));
      if (executed.length > 0) {
        throw new ExecError(
          'VALIDATION',
          `подтверждение ${args.pendingId} уже исполнено — отклонить нельзя`,
          { pendingId: args.pendingId, auditId },
        );
      }
      const already = await rejectedReason(tx, args.pendingId);
      if (already !== undefined) {
        return {
          ok: true as const,
          pendingId: args.pendingId,
          alreadyRejected: true,
          reason: already,
        };
      }
      await appendMessageIdempotent(tx, {
        id: rejectMessageId(args.ownerId, args.pendingId),
        threadId: msg.threadId,
        role: 'system',
        content: REJECT_CONTENT[reason],
        metadata: { type: 'confirmation_rejected', rejects: args.pendingId, reason },
      });
      return { ok: true as const, pendingId: args.pendingId, alreadyRejected: false, reason };
    });
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}
