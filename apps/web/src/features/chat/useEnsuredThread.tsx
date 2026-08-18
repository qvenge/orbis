import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';

/** Состояние заведения треда: до ответа — `pending`, дальше либо id, либо причина отказа. */
export type EnsuredThread =
  | { status: 'pending' }
  | { status: 'ready'; threadId: string }
  | { status: 'failed'; message: string };

/**
 * Треды СУЩНОСТЕЙ, заведённые за эту сессию вкладки: `entityId → threadId`.
 *
 * Нужен потому, что вкладка «Тред» на detail живой не держится (Tabs без keepMounted —
 * ChatThread на монтировании заводит `chat.listMessages`, и держать её живой значило бы платить
 * этим запросом за КАЖДОЕ открытие записи). Размонтирование уносит и память о заведённом треде,
 * поэтому второе открытие той же вкладки снова звало `chat.ensureThread` и мигало скелетоном
 * ПОВЕРХ уже закешированных сообщений. Мутация идемпотентна, но платить ею и миганием за каждое
 * переключение вкладок незачем.
 *
 * Ключ — id сущности, и это безопасно: id уникален глобально, чужой владелец за ним встать не
 * может. У ГЛОБАЛЬНОГО треда такого ключа нет (он «мой», а кто «я» — модулю неизвестно), и
 * кешировать его по пустому ключу значило бы отдать тред прежнего владельца после смены
 * аккаунта в той же вкладке. Поэтому глобальный чат здесь не кешируется вовсе.
 *
 * Кеш модульный, а не в сторе: он не состояние приложения, а память о совершённом действии, —
 * подписываться на него некому, и перерисовок от него быть не должно.
 */
const sessionThreads = new Map<string, string>();

/**
 * Забыть заведённые треды. Существует РАДИ ТЕСТОВ: модуль живёт дольше теста, и без сброса
 * первый же тест, открывший тред записи, делал бы следующему тесту с той же записью нулевое
 * число вызовов `ensureThread` — то есть проверка «завели ровно один раз» краснела бы от
 * соседа, а не от кода. Альтернатива (уникальный id сущности в каждом тесте) держится на
 * дисциплине копипасты и молча ломается, когда id повторили.
 */
export function resetEnsuredThreads(): void {
  sessionThreads.clear();
}

/**
 * Завести тред и отдать его id: `chat.ensureThread` на монтировании, ровно один раз.
 *
 * Без аргумента — глобальный тред (вкладка «Чат»), с `entityId` — тред записи. Тред сущности
 * ленив (§4.5): его id — формула (`uuidv5(owner:entity-thread:entity)`), и `entity.get` считает
 * его, НЕ создавая строки. То есть у записи, тред которой ни разу не открывали, id есть, а треда
 * нет, — и первое же сообщение отбивалось предпроверкой `ai.sendMessage` («тред не найден»,
 * NOT_FOUND) уже после того, как человек его набрал и отправил.
 *
 * ОТВЕТ БЕРЁТСЯ ИЗ ПРОМИСА (`mutateAsync` + своё состояние), а не из `mutation.data`, и это не
 * вкусовщина — это обход поведения react-query под `<StrictMode>` (замерено, v5.101.2).
 * StrictMode (main.tsx — так приложение и живёт в разработке) прогоняет эффекты монтирования
 * дважды, отписка `useSyncExternalStore` между прогонами снимает наблюдателя с мутации
 * (`MutationObserver.onUnsubscribe`), а обратно при повторной подписке он НЕ встаёт — парного
 * `onSubscribe` в этой версии нет вовсе. Мутация доезжает, её ответ приходит, а `data` навсегда
 * остаётся `undefined`: экран стоял бы на скелетоне вечно. Промис же не зависит от наблюдателя
 * ни в какой момент.
 *
 * Гвард на ref, а не «эффект с пустыми зависимостями»: двойной прогон эффектов иначе стоил бы
 * двух мутаций. Про смену записи гварду знать незачем — вкладку монтируют с key по id записи
 * (DetailScreen), и на соседней записи это уже другой экземпляр.
 *
 * `retry` — тот же самый запуск: состояние возвращается в `pending` (скелетон) и ждёт ответа.
 */
export function useEnsuredThread(entityId?: string): {
  state: EnsuredThread;
  retry: () => void;
} {
  const { mutateAsync } = trpc.chat.ensureThread.useMutation();
  // Читается на ПЕРВОМ рендере: попадание в кеш означает «тред этой записи уже заведён», и
  // тогда ни мутации, ни скелетона быть не должно — сразу лента.
  const cached = entityId === undefined ? undefined : sessionThreads.get(entityId);
  const [state, setState] = useState<EnsuredThread>(
    cached === undefined ? { status: 'pending' } : { status: 'ready', threadId: cached },
  );
  const startedRef = useRef(cached !== undefined);

  const start = useCallback(() => {
    setState({ status: 'pending' });
    void mutateAsync(entityId === undefined ? {} : { entityId }).then(
      (r) => {
        if (entityId !== undefined) sessionThreads.set(entityId, r.threadId);
        setState({ status: 'ready', threadId: r.threadId });
      },
      // Отказ — вторым аргументом then, а не отдельным catch: своя ветка отказа обязана
      // сработать РОВНО на отказе ensure, а не заодно на любой ошибке в ветке успеха выше.
      (e: unknown) =>
        setState({ status: 'failed', message: e instanceof Error ? e.message : String(e) }),
    );
  }, [entityId, mutateAsync]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start();
  }, [start]);

  return { state, retry: start };
}

/**
 * Плашка «тред завести не вышло» с повтором. Молчать нельзя: без треда экран пуст, и вечный
 * скелетон читался бы как «грузится», хотя грузиться уже нечему. Кнопка — потому что единственным
 * способом повторить иначе остаётся уход с экрана и возврат, а на глобальном чате и его нет.
 */
export function EnsureFailedNotice({
  what,
  message,
  onRetry,
}: {
  /** Что именно не открылось, целым предложением: «Не удалось открыть тред записи.» */
  what: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 p-3 text-sm text-danger">
      <p>
        {what} {message}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Повторить
      </Button>
    </div>
  );
}
