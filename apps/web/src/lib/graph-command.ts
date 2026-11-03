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
export const GRAPH_OFFLINE = 'Нет сети';

export function graphOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function publicRejection(error: unknown): string | undefined {
  if (error instanceof Error && error.message === GRAPH_OFFLINE) return GRAPH_OFFLINE;
  if (!(error instanceof TRPCClientError)) return;
  const code: unknown = error.data?.code;
  if (typeof code !== 'string' || !Object.hasOwn(REJECTIONS, code)) return;
  const message = error.message.trim();
  // Only structured public refusals can carry a server explanation to the UI.
  return message && message !== code ? message : REJECTIONS[code];
}

export function graphFailure(error: unknown): Exclude<CommandOutcome, { kind: 'confirmed' }> {
  const message = publicRejection(error);
  return message ? { kind: 'rejected', message } : { kind: 'unknown', message: UNKNOWN };
}

/** A single transport attempt. Only explicit public HTTP refusals prove non-commit. */
export async function runGraphCommand(
  write: () => Promise<{ actionId?: string; consequences?: boolean }>,
): Promise<CommandOutcome> {
  if (!graphOnline()) return { kind: 'rejected', message: GRAPH_OFFLINE };
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
    return graphFailure(error);
  }
}
