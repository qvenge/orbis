import type { EntityCreateInput } from '@orbis/shared';
import { TRPCClientError } from '@trpc/client';
import type { FlushOutcome, QueuedCreate } from '../lib/retry-buffer';
import type { OrbisVanillaClient } from '../trpc';

const BUSINESS_CODES = new Set([
  'BAD_REQUEST', // VALIDATION
  'UNPROCESSABLE_CONTENT', // INVARIANT
  'TOO_MANY_REQUESTS', // LIMIT
  'FORBIDDEN', // FORBIDDEN_LEVEL
  'NOT_FOUND', // NOT_FOUND
]);

// §5.3: CONFLICT/id_conflict онлайн — идемпотентный успех (confirmed);
// бизнес-коды — окончательный отказ (business_rejection); сеть/прочее — retry.
export function mapSendError(err: unknown): FlushOutcome {
  if (err instanceof TRPCClientError) {
    const code = err.data?.code as string | undefined;
    if (code === 'CONFLICT') return 'confirmed';
    if (code && BUSINESS_CODES.has(code)) return 'business_rejection';
  }
  return 'transport_failure';
}

export function makeRetrySend(
  client: OrbisVanillaClient,
): (op: QueuedCreate) => Promise<FlushOutcome> {
  return async (op) => {
    const { input, source } = op.payload as { input: EntityCreateInput; source: 'fast_path' };
    try {
      // Идемпотентность по client-UUID (§5.3): id операции — из payload, если он там есть
      // (упавший онлайн-create уже отправлял его серверу), иначе clientId очереди.
      const id = input.id ?? op.clientId;
      await client.entity.create.mutate({ input: { ...input, id }, source });
      return 'confirmed';
    } catch (err) {
      return mapSendError(err);
    }
  };
}
