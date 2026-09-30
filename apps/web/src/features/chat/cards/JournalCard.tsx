import { useState } from 'react';
import { invalidateGraph } from '../../../lib/invalidate';
import { trpc } from '../../../trpc';
import { smoothAuditText } from '../format-audit';
import type { JournalCardMeta } from './types';

/**
 * Кто сделал действие — словом строки журнала. Рутина — по ИСТОЧНИКУ: её правки идут от «ai», как и у чат-агента,
 * и по актору неотличимы (V1.9, Р-16); дальше — актор.
 */
export function authorWord(meta: Pick<JournalCardMeta, 'source' | 'actorKind'>): string {
  if (meta.source === 'routine') return 'рутина';
  if (meta.actorKind === 'agent') return 'агент';
  if (meta.actorKind === 'ai') return 'AI';
  return 'вы';
}

// Строка-сводка действия из журнала (§11.3, Р-16): правки агента и пачки из разговора. Сводка — что, кем, можно ли
// отменить; операций и текстов в ней нет (§9). Отказ отмены показываем словами — продолжение §8.6 подключает задача 17.
export function JournalCard({ meta, readOnly }: { meta: JournalCardMeta; readOnly?: boolean }) {
  const utils = trpc.useUtils();
  const [undone, setUndone] = useState(meta.undone);
  const [error, setError] = useState<string | null>(null);
  const undo = trpc.ai.undo.useMutation({
    onSuccess: () => {
      setUndone(true);
      // Отмена — такая же правка графа, как любая другая: списки и открытые записи о ней узнать обязаны (Р17).
      // Денежные агрегаты — тоже: чем было действие, строка не знает (аспектов в сводке нет), а ключ без
      // наблюдателя гасится бесплатно
      invalidateGraph(utils);
      void utils.budget.invalidate();
    },
    onError: (e) => setError(e.message),
  });
  // Цвет — токен дизайн-системы `text-text-muted` (tokens.css): тихая служебная строка, как подписи карточек
  return (
    <div data-testid="journal-card" className="flex items-center gap-2 text-sm text-text-muted">
      {/* Одобренная одиночная единица называется «batch: операций — 1» — та же сглаживающая подпись, что у карточки
          подтверждения */}
      <span className="min-w-0 truncate">{smoothAuditText(meta.title)}</span>
      <span>· {authorWord(meta)}</span>
      {undone ? (
        <span>· отменено</span>
      ) : meta.undoable && !readOnly ? (
        <button
          type="button"
          className="underline"
          disabled={undo.isPending}
          onClick={() => undo.mutate({ actionId: meta.actionId })}
        >
          Отменить
        </button>
      ) : null}
      {error ? <span role="alert">· не удалось отменить: {error}</span> : null}
    </div>
  );
}
