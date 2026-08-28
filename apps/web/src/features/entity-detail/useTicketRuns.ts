// Прогоны тикета (С5, С10): список читается ТЕМ ЖЕ `entity.query`, что и всё остальное в графе —
// своей процедуры у экрана нет и заводить её незачем.
//
// `aspect=orbis/agent-run` в строке — не украшение и не фильтр «на всякий случай». Прогоны это
// СЛУЖЕБНЫЙ аспект: компилятор запросов выкидывает их из любой выдачи, пока запрос сам их не
// назвал (`apps/server/src/query/compile-ast.ts`, `namesServiceAspect`), иначе каждый шаг агента
// поднимал бы прогон в топ «свежего». Без этого узла список тикета был бы пуст ВСЕГДА.
import { type RouterOutputs, trpc } from '../../trpc';
import { runPollInterval } from './run-poll';

/** Прогон в объёме списка — ровно то, что отдаёт `entity.query` (без bodyDoc и связей). */
export type TicketRun = RouterOutputs['entity']['query'][number];

export const RUN_ASPECT = 'orbis/agent-run';

/**
 * Исход прогона по-русски (`outcome` — enum схемы аспекта). Один источник на весь срез:
 * подпись стоит и строкой истории на тикете (RunsList), и бейджем в шапке самого прогона
 * (RunFeed), — разъехавшись, две копии читались бы как РАЗНЫЕ состояния одной записи.
 * Незнакомое значение показываем как есть: догадка тут хуже сырого слова.
 */
export const RUN_OUTCOME_LABELS: Record<string, string> = {
  running: 'идёт',
  checkpoint: 'вопрос',
  finished: 'готово',
  abandoned: 'оборван',
  // Исходы V1: «сбой» отличается от «оборван» причиной (сорвался сам, а не подметён),
  // «отвечено» закрывает прогон ответом владельца, «снят» — устаревшим предложением.
  failed: 'сбой',
  answered: 'отвечено',
  stale: 'снят',
};

/** Аспект прогона у сущности из выдачи; `undefined` — сущность не прогон. */
export function runAspect(run: TicketRun): Record<string, unknown> | undefined {
  return run.aspectsMap[RUN_ASPECT];
}

/**
 * Прогоны тикета: дети роли иерархии с аспектом прогона, последний первым.
 *
 * Именованной функцией, а не литералом внутри хука: текст боевой, и его разбор каноном
 * (§А5-3) пиннится отдельным тестом — иначе непереведённое имя свойства уехало бы в мост
 * старой формы молча, и «экран открылся» доказывало бы ровно ничего.
 */
export function ticketRunsQuery(ticketId: string): string {
  return `children_of=${ticketId}, aspect=${RUN_ASPECT}, sortBy=orbis/created_at:desc, limit=20`;
}

export function useTicketRuns(
  ticketId: string,
  enabled: boolean,
): { runs: TicketRun[]; lastRun: TicketRun | undefined; isLoading: boolean } {
  const q = trpc.entity.query.useQuery(
    { query: ticketRunsQuery(ticketId) },
    // enabled: у записи без назначения прогонов не бывает по построению — платить за них
    // запросом с КАЖДОГО открытия записи не за что.
    //
    // `placeholderData: keepPreviousData` здесь НЕЛЬЗЯ, и это не вкусовщина. Экран монтируется
    // БЕЗ key (router.tsx): переход тикет→тикет меняет только проп, то есть КЛЮЧ запроса, — и
    // прежние данные под новым ключом означали бы чужие прогоны на чужом тикете. Не косметика:
    // `TicketWaitingBlock` берёт из `lastRun` исход (заголовок) и `runId`, с которым уходит
    // ответ владельца, — ответ уехал бы в прогон СОСЕДНЕГО тикета. А ради чего placeholder
    // ставят обычно — «не схлопнуть список на перечитывании» — здесь и без него: после
    // `invalidateGraph` ключ ТОТ ЖЕ, и react-query держит прежние данные до ответа.
    {
      enabled,
      // Последний прогон идёт → список опрашивается (run-poll.ts): от него зависят блок
      // состояния рутины («идёт прогон», кнопка «Прогнать сейчас») и блок ожидания тикета
      refetchInterval: (query) => {
        const rows = query.state.data;
        const last = Array.isArray(rows) ? rows[0] : undefined;
        return last === undefined ? false : runPollInterval(last.aspectsMap);
      },
    },
  );
  // Array.isArray — та же защита, что в TransactionsScreen и CategoryField: секция живёт на
  // общем detail-экране, и неожиданная форма ответа не должна ронять всю страницу.
  const runs = Array.isArray(q.data) ? q.data : [];
  // sortBy=orbis/created_at:desc — последний прогон стоит ПЕРВЫМ.
  return { runs, lastRun: runs[0], isLoading: q.isLoading };
}
