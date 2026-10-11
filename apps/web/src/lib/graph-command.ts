import { TRPCClientError } from '@trpc/client';
import type { CommandOutcome } from '../features/entity-detail/properties-relations/types';

const UNKNOWN = 'Не удалось подтвердить сохранение';
const REJECTIONS: Record<string, string> = {
  BAD_REQUEST: 'Запрос не принят',
  UNPROCESSABLE_CONTENT: 'Изменения недопустимы',
  NOT_FOUND: 'Запись недоступна',
  FORBIDDEN: 'Изменение недоступно',
  CONFLICT: 'Состояние изменилось',
};
/** A single transport attempt. Only explicit public HTTP refusals prove non-commit. */
export async function runGraphCommand(
  write: () => Promise<{ actionId?: string; consequences?: boolean }>,
): Promise<CommandOutcome> {
  try {
    const result = await write();
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      (result.actionId !== undefined &&
        (typeof result.actionId !== 'string' || result.actionId.trim() === ''))
    )
      return { kind: 'unknown', message: UNKNOWN };
    return result.actionId === undefined
      ? { kind: 'confirmed' }
      : {
          kind: 'confirmed',
          actionId: result.actionId,
          ...(typeof result.consequences === 'boolean' && { consequences: result.consequences }),
        };
  } catch (error) {
    if (error instanceof TRPCClientError) {
      const code: unknown = error.data?.code;
      const fallback =
        typeof code === 'string' && Object.hasOwn(REJECTIONS, code) ? REJECTIONS[code] : undefined;
      if (fallback) {
        // The server's non-internal tRPC messages are public structured refusals.
        // Do not copy data/cause/stack into a form outcome.
        const message = error.message.trim();
        return {
          kind: 'rejected',
          message: message && message !== error.data?.code ? message : fallback,
        };
      }
    }
    return { kind: 'unknown', message: UNKNOWN };
  }
}
