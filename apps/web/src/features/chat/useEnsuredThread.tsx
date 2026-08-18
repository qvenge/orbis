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
 * Ключ — id сущности, и это безопасно НЕ потому, что id уникален (уникальность сама по себе
 * ничего не обещает), а потому, что запись доступна только своему владельцу: id треда —
 * формула от владельца И записи (`entityThreadId(ownerId, entityId)`), а `chat.ensureThread` —
 * ownerOnly. Чужой актор той же записи не откроет вовсе, а свой получит ровно тот id, что
 * лежит в кеше.
 *
 * У ГЛОБАЛЬНОГО треда ключа нет — потому что модуль НАМЕРЕННО не знает владельца. Ключ
 * `global:${userId}` из `useAuth()` (AuthProvider) технически доступен и снял бы заодно
 * предсуществующее «ensure на каждый вход во вкладку Чат», но заводить в этом модуле знание об
 * аккаунте — решение шире хвоста, и оно отложено владельцу. Пока владелец не решил, кешировать
 * глобальный тред по пустому ключу нельзя: после смены аккаунта в той же вкладке (AuthProvider
 * разлогинивает без перезагрузки) модуль отдал бы тред прежнего. Поэтому глобальный чат здесь
 * не кешируется вовсе.
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
 * двух мутаций. Но помнит он не «стартовали ли вообще», а ДЛЯ КАКОЙ записи стартовали, и это не
 * запас на будущее. Сегодняшние вызывающие меняют запись только вместе с экземпляром (вкладку
 * монтируют с `key` по id записи — DetailScreen), однако хук общий и экспортированный: первый
 * же вызывающий без `key` получил бы на новой записи тред ПРЕЖНЕЙ — и сообщения уехали бы не
 * туда, молча. Поэтому расхождение id хук лечит сам: сначала смотрит в кеш, при промахе —
 * `pending` и новая мутация. Симметрично и ответ: промис отдаёт результат, только если запись
 * за время полёта не сменилась, иначе поздний ответ прежней записи отбрасывается. В кеш он при
 * этом ложится всё равно — под тем id, ДЛЯ КОТОРОГО спрашивали, а это по-прежнему правда.
 *
 * `retry` — тот же самый запуск: состояние возвращается в `pending` (скелетон) и ждёт ответа.
 */
export function useEnsuredThread(entityId?: string): {
  state: EnsuredThread;
  retry: () => void;
} {
  const { mutateAsync } = trpc.chat.ensureThread.useMutation();
  const [state, setState] = useState<EnsuredThread>(() => initialFor(entityId));
  /**
   * Запись, ДЛЯ КОТОРОЙ уже стартовали; `null` — ещё ни для какой. Отдельный `null`, а не
   * сравнение с `entityId`, потому что `undefined` — законное значение ключа (глобальный тред),
   * и «не стартовали» пришлось бы путать с «стартовали для глобального».
   */
  const startedForRef = useRef<{ entityId: string | undefined } | null>(null);

  /**
   * Проп сменился без ремоунта — состояние правится ПРЯМО В РЕНДЕРЕ (штатный приём React
   * «adjusting state on prop change»), а не эффектом. Эффектом вызывающий получил бы один
   * закоммиченный кадр с тредом ПРЕЖНЕЙ записи: `ChatThread` смонтировался бы с чужим
   * threadId и успел бы сходить за его сообщениями.
   */
  const [seenEntityId, setSeenEntityId] = useState(entityId);
  if (seenEntityId !== entityId) {
    setSeenEntityId(entityId);
    setState(initialFor(entityId));
  }

  const start = useCallback(() => {
    startedForRef.current = { entityId };
    // Функцией, а не значением: на первом запуске состояние уже `pending`, и новый объект стоил
    // бы пустого ре-рендера.
    setState((s) => (s.status === 'pending' ? s : { status: 'pending' }));
    // Запись фиксируется в замыкании: сравнение с ней на ответе и есть защита от позднего
    // ответа прежней записи.
    const requested = entityId;
    void mutateAsync(requested === undefined ? {} : { entityId: requested }).then(
      (r) => {
        // В кеш — ВСЕГДА и под тем id, для которого спрашивали: этот ответ про него правда,
        // даже если экран уже смотрит на соседнюю запись.
        if (requested !== undefined) sessionThreads.set(requested, r.threadId);
        if (startedForRef.current?.entityId !== requested) return;
        setState({ status: 'ready', threadId: r.threadId });
      },
      // Отказ — вторым аргументом then, а не отдельным catch: своя ветка отказа обязана
      // сработать РОВНО на отказе ensure, а не заодно на любой ошибке в ветке успеха выше.
      (e: unknown) => {
        if (startedForRef.current?.entityId !== requested) return;
        setState({ status: 'failed', message: e instanceof Error ? e.message : String(e) });
      },
    );
  }, [entityId, mutateAsync]);

  useEffect(() => {
    const startedFor = startedForRef.current;
    if (startedFor !== null && startedFor.entityId === entityId) return;
    startedForRef.current = { entityId };
    // Попадание в кеш уже отдано начальным состоянием (initialFor) — мутация не нужна.
    if (entityId !== undefined && sessionThreads.has(entityId)) return;
    start();
  }, [entityId, start]);

  return { state, retry: start };
}

/**
 * С чего начинать для этой записи: попадание в кеш означает «тред уже заведён», и тогда ни
 * мутации, ни кадра скелетона быть не должно — сразу лента.
 */
function initialFor(entityId: string | undefined): EnsuredThread {
  const cached = entityId === undefined ? undefined : sessionThreads.get(entityId);
  return cached === undefined ? { status: 'pending' } : { status: 'ready', threadId: cached };
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
