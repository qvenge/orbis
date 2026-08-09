import { type EntityCreateInput, retryCreateId } from '@orbis/shared';
import { TRPCClientError } from '@trpc/client';
import type { FlushOutcome, QueuedCreate } from '../lib/retry-buffer';
import type { OrbisVanillaClient } from '../trpc';

const BUSINESS_CODES = new Set([
  'BAD_REQUEST', // VALIDATION
  'UNPROCESSABLE_CONTENT', // INVARIANT
  'TOO_MANY_REQUESTS', // LIMIT
  'FORBIDDEN', // FORBIDDEN_LEVEL
  'NOT_FOUND', // NOT_FOUND
  // CONFLICT (id_conflict) — окончательный отказ, а НЕ повод крутить операцию в очереди:
  // сколько ни повторяй, чужой id своим не станет. Повтор со свежим id делает
  // makeRetrySend ниже — ДО того, как исход дойдёт сюда.
  'CONFLICT',
]);

export function isConflict(err: unknown): boolean {
  return err instanceof TRPCClientError && err.data?.code === 'CONFLICT';
}

/**
 * Исход отправки буферизованной операции (§5.3): бизнес-коды — окончательный отказ
 * (business_rejection), сеть и прочее — повтор (transport_failure).
 *
 * CONFLICT больше НЕ считается успехом (уборочная фаза, решение 7). Прежняя конвенция
 * «CONFLICT = подтверждённый успех» противоречила серверу: честный повтор владельца
 * с тем же id executor отдаёт replay-УСПЕХОМ (стадия 5, entity_create вне batch), а
 * CONFLICT кидается ровно тогда, когда id занят строкой, невидимой владельцу под RLS, —
 * то есть записи владельца на сервере НЕТ, и успех фабриковался на пустом месте.
 */
export function mapSendError(err: unknown): FlushOutcome {
  if (err instanceof TRPCClientError) {
    const code = err.data?.code as string | undefined;
    if (code && BUSINESS_CODES.has(code)) return 'business_rejection';
  }
  return 'transport_failure';
}

/**
 * Предел ожидания ОДНОЙ отправки. httpBatchLink таймаута не имеет (trpc.ts), а браузер
 * сдаётся на полуоткрытом сокете только по TCP-таймауту — минуты; captive portal может
 * держать соединение и вовсе без конца. Раньше это стоило одной зависшей записи, теперь —
 * всего буфера: слив сериализован (state/retry.ts), и к неоседающему промису
 * присоединяются ВСЕ следующие вызовы, включая ручной досыл. То есть спасательное
 * средство умирало бы ровно в том сценарии, ради которого заведено.
 *
 * 20 с — выше правдоподобного round-trip создания записи на медленной мобильной сети
 * (с холодным стартом API) и заметно ниже терпения человека, который жмёт «Ждут отправки»
 * руками и ждёт реакции.
 */
export const SEND_TIMEOUT_MS = 20_000;

/** Исход попытки: id_conflict отделён от business_rejection — на него есть свой ответ. */
type AttemptOutcome = FlushOutcome | 'id_conflict';

/**
 * Одна попытка create с пределом ожидания.
 *
 * Сигнал рвёт сам запрос — сокет освобождается, а не висит до конца сессии. Гонка с
 * таймером поверх сигнала не избыточна: она гарантирует, что промис ОСЯДЕТ, даже если
 * транспорт на разрыв не ответит отказом. Исход по истечении — transport_failure: запись
 * остаётся в очереди и уйдёт следующим сливом, а не теряется. Повторить безопасно — сервер
 * идемпотентен по client-UUID, поэтому «запрос дошёл, ответ не успел» второй сущности
 * не создаёт.
 */
async function attemptCreate(
  client: OrbisVanillaClient,
  input: EntityCreateInput,
  source: 'fast_path',
): Promise<AttemptOutcome> {
  const control = new AbortController();
  let onDeadline: (outcome: AttemptOutcome) => void = () => {};
  const deadline = new Promise<AttemptOutcome>((resolve) => {
    onDeadline = resolve;
  });
  const timer = setTimeout(() => {
    control.abort();
    onDeadline('transport_failure');
  }, SEND_TIMEOUT_MS);
  // Отказ разбирается здесь же, поэтому `sent` никогда не отклоняется: проигравшая гонку
  // ветка не оставит необработанного rejection.
  const sent = client.entity.create.mutate({ input, source }, { signal: control.signal }).then(
    (): AttemptOutcome => 'confirmed',
    (err: unknown): AttemptOutcome => (isConflict(err) ? 'id_conflict' : mapSendError(err)),
  );
  try {
    return await Promise.race([sent, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function makeRetrySend(
  client: OrbisVanillaClient,
): (op: QueuedCreate) => Promise<FlushOutcome> {
  return async (op) => {
    const { input, source } = op.payload as { input: EntityCreateInput; source: 'fast_path' };
    // Идемпотентность по client-UUID (§5.3): id операции — из payload, если он там есть
    // (упавший онлайн-create уже отправлял его серверу), иначе clientId очереди.
    const id = input.id ?? op.clientId;
    const first = await attemptCreate(client, { ...input, id }, source);
    if (first !== 'id_conflict') return first;
    // id занят ЧУЖОЙ строкой — своя дала бы replay-успех. Запись владельца не создана,
    // и ждать бессмысленно: повторяем РОВНО один раз с замещающим id. Он ДЕТЕРМИНИРОВАН
    // по исходному (retryCreateId): потерянный ответ на повтор оставляет в очереди тот же
    // payload, следующий flush снова получает CONFLICT и берёт ТОТ ЖЕ замещающий id —
    // сервер отвечает replay-успехом на свою строку, второй сущности не появляется.
    // Бесконечного цикла нет: второй CONFLICT (замещающий id тоже занят чужим) уходит
    // в business_rejection и вычищает операцию из очереди.
    const second = await attemptCreate(client, { ...input, id: retryCreateId(id) }, source);
    return second === 'id_conflict' ? 'business_rejection' : second;
  };
}
