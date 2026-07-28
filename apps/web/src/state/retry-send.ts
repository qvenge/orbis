import { type EntityCreateInput, newId } from '@orbis/shared';
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

export function makeRetrySend(
  client: OrbisVanillaClient,
): (op: QueuedCreate) => Promise<FlushOutcome> {
  return async (op) => {
    const { input, source } = op.payload as { input: EntityCreateInput; source: 'fast_path' };
    // Идемпотентность по client-UUID (§5.3): id операции — из payload, если он там есть
    // (упавший онлайн-create уже отправлял его серверу), иначе clientId очереди.
    const id = input.id ?? op.clientId;
    try {
      await client.entity.create.mutate({ input: { ...input, id }, source });
      return 'confirmed';
    } catch (err) {
      if (!isConflict(err)) return mapSendError(err);
      // id занят ЧУЖОЙ строкой — своя дала бы replay-успех. Запись владельца не создана,
      // и ждать бессмысленно: повторяем РОВНО один раз со свежим UUID. Ввод при этом не
      // теряется (ради чего буфер и существует), а бесконечного цикла не возникает —
      // второй CONFLICT уходит в business_rejection и вычищает операцию из очереди.
      try {
        await client.entity.create.mutate({ input: { ...input, id: newId() }, source });
        return 'confirmed';
      } catch (retryErr) {
        return mapSendError(retryErr);
      }
    }
  };
}
