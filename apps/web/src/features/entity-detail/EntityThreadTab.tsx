import { ChatThread } from '../chat/ChatThread';
import { ThreadSkeleton } from '../chat/MessageList';
import { EnsureFailedNotice, useEnsuredThread } from '../chat/useEnsuredThread';

/**
 * Вкладка «Тред» записи: СНАЧАЛА заводит тред, и только потом отдаёт его чату.
 *
 * Тред сущности ленив (§4.5): его id — формула (`uuidv5(owner:entity-thread:entity)`), и
 * `entity.get` считает его, НЕ создавая строки. То есть у записи, тред которой ни разу не
 * открывали, id есть, а треда нет, — и первое же сообщение отбивалось предпроверкой
 * `ai.sendMessage` («тред не найден», NOT_FOUND), причём после того, как человек его набрал и
 * отправил. Дефект предсуществующий, найден живым смоуком ADE-среза 1.
 *
 * Лечится там же, где лечит себя глобальный чат (ChatScreen): общий хук `useEnsuredThread`
 * зовёт `chat.ensureThread` на монтировании. Разница только в аргументе (`{entityId}` против
 * `{}`) и в моменте: вкладка «Тред» живой НЕ держится (keepMounted у неё нет), поэтому её
 * монтирование и есть жест «человек открыл тред» — записи, куда не заходили, лишней мутации не
 * платят. Обратная сторона размонтирования — повторное открытие: тред помнит модульный кеш
 * хука, и второй раз вкладка встаёт сразу лентой, без мутации и без мигания скелетоном.
 *
 * Чат поднимается ПОСЛЕ ответа, а не рядом с ним: до создания строки тред пуст в любом случае
 * (`chat.listMessages` вернёт []), а вот отправка в него — та самая ошибка, ради которой всё это
 * и написано. И threadId берётся из ОТВЕТА ensure, а не из `entity.get`: значения совпадают
 * (формула одна), но правда о треде — у того, кто его завёл.
 */
export function EntityThreadTab({ entityId }: { entityId: string }) {
  const { state, retry } = useEnsuredThread(entityId);
  if (state.status === 'pending') return <ThreadSkeleton />;
  if (state.status === 'failed')
    return (
      <EnsureFailedNotice
        what="Не удалось открыть тред записи."
        message={state.message}
        onRetry={retry}
      />
    );
  return <ChatThread threadId={state.threadId} />;
}
