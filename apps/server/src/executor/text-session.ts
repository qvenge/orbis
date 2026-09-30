// apps/server/src/executor/text-session.ts
// Сеанс правки текста (§8.5, Р-11) — ОСОБЫЙ СЛУЧАЙ ядра журнала, и живёт он здесь одним местом.
// Автосохранение редактора владельца продолжает сеанс — правка применяется без новой записи журнала, — если текущий
// текст дал этот же сеанс (колонка действия тела, БЕЗ раскрутки §8.6) и с последнего изменения тела прошло меньше
// 10 минут (пауза набора, а не длина сеанса). Иначе — новая запись. Хранимых сеансов нет: всё вычисляется по записи и
// журналу; гонку двух автосохранений сериализует FOR UPDATE строки, уже взятый гейтом тела.
//
// Что здесь, а что у исполнителя. Здесь — правила: кому сеанс положен (`assertTextSessionRequest`), продолжать ли
// (`sessionToContinue`), форма записи сеанса (`sessionOperations`), инвариант продолжения (`assertNothingAppended`),
// отрезок и подпись сеанса для «отмени последнее» и контекста модели (`sessionSpan`, `sessionLabels`,
// `undoableTitle`). У исполнителя — только проводка: повторное объявление действия, пропуск записи журнала, ответ с id
// сеанса (`executor.ts`, три места с пометкой «сеанс правки текста»). Порядок «последнего» по времени последнего
// изменения — у единственного читателя журнала (`journal-read.ts`, `LAST_CHANGE`).
//
// Закрытие сеанса отдельного кода не имеет и иметь не должно: сеанс закрывает ЛЮБАЯ запись, давшая тело не этим
// сеансом, потому что каждая такая запись ставит колонке своё действие (триггер `entities_body_stamp`, задача 7), и
// колонка перестаёт указывать на сеанс. Правка заголовка тела не трогает — колонку не двигает и сеанс не закрывает.
import type { GraphId } from '@orbis/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { clockTime, ownerTimeZone } from '../query/context';
import { ExecError } from './errors';
import { findAction, isUndone, type JournalEntry } from './journal-read';
import type { ActionOperation, ExecuteRequest } from './types';

type EntityRow = typeof entities.$inferSelect;

/** Пауза набора, после которой автосохранение открывает новый сеанс (§8.5): от последнего изменения тела. */
export const SESSION_PAUSE_MS = 10 * 60 * 1000;

/** Поля входа автосохранения: запись, тело (одной из двух форм) и ревизия, поверх которой набрано (§8.1). */
const AUTOSAVE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'body',
  'bodyDoc',
  'expectedBodyRevision',
]);

/**
 * Сеанс положен только автосохранению редактора владельца — одиночной правке, меняющей лишь тело (§8.5, К-14).
 * Иначе `VALIDATION`, и транзакция не начинается.
 *
 * Почему правило здесь, а не только в роутере: при продолжении сеанса записи журнала нет, и всё, что правка сделала
 * сверх тела (заголовок, свойство, тег), осталось бы без данных отмены — тихая потеря, которую не поймал бы никто.
 * Роутер — единственный, кто ставит признак, но правило обязано держаться у того, кто пишет журнал.
 */
export function assertTextSessionRequest(req: ExecuteRequest): void {
  if (req.textSession !== true) return;
  const op = req.operations.length === 1 ? req.operations[0] : undefined;
  if (
    op === undefined ||
    req.batchId !== undefined ||
    op.tool !== 'entity_update' ||
    req.actorKind !== 'owner'
  ) {
    throw new ExecError(
      'VALIDATION',
      'сеанс правки текста — только одиночное автосохранение редактора владельца (§8.5)',
      { tool: op?.tool ?? 'batch', actorKind: req.actorKind },
    );
  }
  const input = op.input;
  const fields =
    typeof input === 'object' && input !== null && !Array.isArray(input) ? Object.keys(input) : [];
  const extra = fields.filter((f) => !AUTOSAVE_FIELDS.has(f));
  const body = input as { body?: unknown; bodyDoc?: unknown } | null;
  if (extra.length > 0 || (body?.body === undefined && body?.bodyDoc === undefined)) {
    throw new ExecError(
      'VALIDATION',
      'автосохранение несёт только тело: id, body или bodyDoc, expectedBodyRevision (§8.5)',
      { extra },
    );
  }
}

/** Что пробе сеанса нужно от контекста исполнителя (`ExecCtx` подходит как есть). */
interface SessionProbe {
  tx: Tx;
  req: ExecuteRequest;
  clock: () => Date;
}

/**
 * id сеанса, который продолжает это автосохранение, или `null` — открыть новый. `current` — строка под FOR UPDATE.
 *
 * Пауза — от времени изменения тела (часы базы, триггер), а не от начала сеанса: сеанс длится, пока человек печатает.
 * Внутри одной транзакции время записи журнала (`now()`) не позже времени изменения тела (`clock_timestamp()`), так что
 * от начала сеанса пауза была бы длиннее настоящей — и час непрерывного набора рвался бы на записи по 10 минут.
 */
export async function sessionToContinue(
  ctx: SessionProbe,
  current: EntityRow,
): Promise<string | null> {
  if (!ctx.req.textSession || ctx.req.actorKind !== 'owner' || current.bodyActionId === null)
    return null;
  if (ctx.clock().getTime() - current.bodyChangedAt.getTime() >= SESSION_PAUSE_MS) return null;
  const s = await findAction(ctx.tx, ctx.req.identity.graph, current.bodyActionId);
  if (!s?.textSession || s.actorUserId !== ctx.req.identity.actor || s.actorKind !== 'owner')
    return null;
  // Отменённый сеанс, чья отмена текст не сменила (набрал и стёр до исходного), колонку не двигает (триггер
  // IS DISTINCT FROM) — продолжать его нельзя: продолжение легло бы в уже отменённое действие.
  if (await isUndone(ctx.tx, ctx.req.identity.graph, s.id)) return null;
  return s.id;
}

/**
 * Операции записи сеанса — без «после» (§8.5): после — это текущий текст самой записи, и копия каждого автосохранения
 * в журнале была бы ровно тем ростом базы, от которого сеанс и заведён. Признак в нагрузке — чтобы читатель
 * операций не принял запись за правку без тела. Данные отмены («до») — обычный inverse первой правки сеанса.
 */
export function sessionOperations(entityId: string): ActionOperation[] {
  return [{ op: 'entity_update', payload: { id: entityId, textSession: true } }];
}

/**
 * Инвариант записи сеанса: дописанных операций быть не может. Вход — только тело (`assertTextSessionRequest`):
 * бюджет-хук и засев не срабатывают, «дом», предки и ссылки считаются от свойств. Если это когда-нибудь перестанет быть
 * правдой, продолжение без записи журнала потеряло бы их данные отмены молча, а новая запись сеанса несла бы чужие
 * операции под признаком сеанса — поэтому здесь исключение (не отказ): транзакция откатывается, ошибка видна как
 * поломка. Путь недостижим по построению, и поэтому проверяется в коде, а не только тестом сценария.
 */
export function assertNothingAppended(
  sessionId: string,
  appended: readonly ActionOperation[],
): void {
  if (appended.length === 0) return;
  throw new Error(
    `инвариант сеанса правки текста (§8.5): продолжение ${sessionId} дописало операции ` +
      `${appended.map((o) => o.op).join(', ')} — записи журнала для них нет`,
  );
}

/**
 * Отрезок сеанса: начало — время записи, конец — время изменения тела, пока колонка действия тела указывает на
 * сеанс. Когда её сменила следующая запись, конца не знает никто (цена §16: колонка у записи графа одна).
 */
export function sessionSpan(
  entry: JournalEntry,
  entity: { bodyActionId: string | null; bodyChangedAt: Date },
): { start: Date; end: Date | null } {
  return {
    start: entry.createdAt,
    end: entity.bodyActionId === entry.id ? entity.bodyChangedAt : null,
  };
}

/** Подпись сеанса владельцу и модели: «правка текста «<заголовок>» 14:02–14:18»; без конца — только начало. */
function sessionLabel(
  entry: JournalEntry,
  span: { start: Date; end: Date | null },
  timeZone: string,
): string {
  const end = span.end === null ? '' : `–${clockTime(span.end, timeZone)}`;
  return `правка текста «${entry.title}» ${clockTime(span.start, timeZone)}${end}`;
}

/**
 * Подписи записей сеанса среди `entries` (id записи → подпись с отрезком); прочие записи в ответ не попадают. Колонки
 * тела — одной выборкой по записям графа.
 */
export async function sessionLabels(
  tx: Tx,
  graph: GraphId,
  entries: readonly JournalEntry[],
  timeZone: string,
): Promise<Map<string, string>> {
  const sessions = entries.filter((e) => e.textSession && e.entityId !== null);
  const out = new Map<string, string>();
  if (sessions.length === 0) return out;
  const rows = await tx
    .select({
      id: entities.id,
      bodyActionId: entities.bodyActionId,
      bodyChangedAt: entities.bodyChangedAt,
    })
    .from(entities)
    .where(
      and(
        eq(entities.graphId, graph),
        inArray(
          entities.id,
          sessions.map((s) => s.entityId as string),
        ),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const s of sessions) {
    const row = byId.get(s.entityId as string);
    // Записи нет (не видна) — конца сеанса не знает никто, остаётся начало
    const span = sessionSpan(s, row ?? { bodyActionId: null, bodyChangedAt: s.createdAt });
    out.set(s.id, sessionLabel(s, span, timeZone));
  }
  return out;
}

/**
 * Что назвать владельцу у «последнего отменяемого» (§8.5: «правка текста 14:02–14:18»): у сеанса — подпись с отрезком
 * во времени владельца, у остальных — заголовок записи журнала.
 */
export async function undoableTitle(tx: Tx, graph: GraphId, entry: JournalEntry): Promise<string> {
  if (!entry.textSession) return entry.title;
  const labels = await sessionLabels(tx, graph, [entry], await ownerTimeZone(tx, graph));
  return labels.get(entry.id) ?? entry.title;
}
