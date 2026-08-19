// Опрос идущего прогона (V1.3, финальное ревью D-2). Экран прогона живёт на `entity.get`
// с глобальным `staleTime` 30 с и `refetchOnWindowFocus:false` (trpc.ts): после «Прогнать
// сейчас» приложение само приводит владельца на прогон, созданный ДО модели (outcome
// `running`, 0 шагов), — и без опроса он видел бы «идёт · 0 шагов» весь прогон и после него,
// пока не перезагрузит страницу. Пока прогон идёт, запрос повторяется сам; терминальный исход
// опрос выключает — дальше данные меняет только владелец, и обычной инвалидации достаточно.

/**
 * Тот же id, что `RUN_ASPECT` в useTicketRuns.ts, — литералом, а не импортом: useTicketRuns
 * сам подключает этот модуль, и импорт в обратную сторону замыкал бы цикл модулей.
 */
const RUN_ASPECT = 'orbis/agent-run';

/** Период опроса. Три секунды: шаг модели дольше, а лишний запрос дешевле застывшего экрана. */
export const RUN_POLL_MS = 3000;

/**
 * Интервал `refetchInterval` react-query по аспектам сущности: число, пока это идущий прогон,
 * `false` — иначе (не прогон, терминален, данных ещё нет). Функция чистая — её и проверяет
 * тест; подключение — useEntityDetail (экран прогона) и useTicketRuns (последний прогон
 * рутины/тикета: от него зависит блок состояния и кнопка «Прогнать сейчас»).
 */
export function runPollInterval(aspects: Record<string, unknown> | undefined): number | false {
  const run = aspects?.[RUN_ASPECT];
  if (typeof run !== 'object' || run === null) return false;
  return (run as { outcome?: unknown }).outcome === 'running' ? RUN_POLL_MS : false;
}
