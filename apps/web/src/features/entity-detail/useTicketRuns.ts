// Прогоны тикета (С5, С10): список читается ТЕМ ЖЕ `entity.query`, что и всё остальное в графе —
// своей процедуры у экрана нет и заводить её незачем.
//
// `aspect=orbis/agent-run` в строке — не украшение и не фильтр «на всякий случай». Прогоны это
// СЛУЖЕБНЫЙ аспект: компилятор грамматики выкидывает их из любой выдачи, пока запрос сам их не
// назвал (apps/server/src/query/compile.ts:206-216), иначе каждый шаг агента поднимал бы прогон в
// топ «свежего». Без этого узла список тикета был бы пуст ВСЕГДА.
import { keepPreviousData } from '@tanstack/react-query';
import { type RouterOutputs, trpc } from '../../trpc';

/** Прогон в объёме списка — ровно то, что отдаёт `entity.query` (без bodyDoc и связей). */
export type TicketRun = RouterOutputs['entity']['query'][number];

export const RUN_ASPECT = 'orbis/agent-run';

/** Аспект прогона у сущности из выдачи; `undefined` — сущность не прогон. */
export function runAspect(run: TicketRun): Record<string, unknown> | undefined {
  return run.aspects[RUN_ASPECT];
}

export function useTicketRuns(
  ticketId: string,
  enabled: boolean,
): { runs: TicketRun[]; lastRun: TicketRun | undefined; isLoading: boolean } {
  const q = trpc.entity.query.useQuery(
    {
      query: `children_of=${ticketId}, aspect=${RUN_ASPECT}, sortBy=created_at:desc, limit=20`,
    },
    // enabled: у записи без назначения прогонов не бывает по построению — платить за них
    // запросом с КАЖДОГО открытия записи не за что.
    // placeholderData: обновление списка после ответа на чекпойнт (invalidateGraph) не должно
    // схлопывать секцию в пустоту на время перечитывания — тот же приём, что у списков бюджета
    // (TransactionsScreen.tsx:113-115).
    { enabled, placeholderData: keepPreviousData },
  );
  // Array.isArray — та же защита, что в TransactionsScreen и CategoryField: секция живёт на
  // общем detail-экране, и неожиданная форма ответа не должна ронять всю страницу.
  const runs = Array.isArray(q.data) ? q.data : [];
  // sortBy=created_at:desc — последний прогон стоит ПЕРВЫМ.
  return { runs, lastRun: runs[0], isLoading: q.isLoading };
}
