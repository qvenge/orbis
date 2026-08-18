// История прогонов тикета (С5, приёмка 9): что агент делал, чем это кончилось и сколько шагов
// заняло. Строки — ссылки на сами прогоны: подробности (лента шагов, откат) живут на их
// собственных экранах, а не здесь.
import { formatDate } from '../../lib/format';
import { trpc } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { RUN_OUTCOME_LABELS, runAspect, type TicketRun } from './useTicketRuns';

/** Русское множественное: 1 шаг, 2–4 шага, 5–20 шагов (и 11–14 — «шагов»). */
function stepsLabel(n: number): string {
  const teen = n % 100;
  const last = n % 10;
  if (teen >= 11 && teen <= 14) return `${n} шагов`;
  if (last === 1) return `${n} шаг`;
  if (last >= 2 && last <= 4) return `${n} шага`;
  return `${n} шагов`;
}

export function RunsList({
  runs,
  onOpen,
}: {
  /** Часть контракта секции; сама выборка уже скоуплена тикетом (useTicketRuns). */
  ticketId: string;
  runs: TicketRun[];
  onOpen: (id: string) => void;
}) {
  // Оба чтения — ПО УЖЕ ЖИВЫМ ключам кэша: часовой пояс тянет сам экран (DetailScreen), список
  // доступов — карточка назначения агентского тикета. Своей сети секция не добавляет; `enabled`
  // страхует случай «тикет назначен человеку, а прогоны от прежнего агента остались».
  const tz = trpc.user.getSettings.useQuery().data?.timezone;
  const grants = trpc.oauth.listGrants.useQuery(undefined, { enabled: runs.length > 0 });

  // Прогонов нет — секции нет вовсе: пустая «Прогоны (0)» на каждом тикете, которому агент ещё
  // не начал работать, — шум, а не сведения.
  if (runs.length === 0) return null;

  return (
    <div data-testid="runs-list" className="flex flex-col gap-1">
      <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">
        Прогоны ({runs.length})
      </p>
      <ul className="flex flex-col">
        {runs.map((run) => {
          const a = runAspect(run) ?? {};
          const outcome = typeof a.outcome === 'string' ? a.outcome : '';
          const startedAt = typeof a.started_at === 'string' ? a.started_at : run.createdAt;
          const steps = typeof a.step_count === 'number' ? a.step_count : 0;
          // Грант — ПОДПИСЬЮ: сырой uuid в строке истории не отвечает на вопрос «кто это делал».
          const grant = grants.data?.find((g) => g.id === a.grant_id);
          return (
            <li key={run.id}>
              <button
                type="button"
                data-testid={`run-${run.id}`}
                onClick={() => onOpen(run.id)}
                className="flex w-full cursor-pointer flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-surface-2/60"
              >
                <span className="text-text-secondary">{formatDate(startedAt, tz)}</span>
                <Badge>{RUN_OUTCOME_LABELS[outcome] ?? outcome}</Badge>
                <span className="text-text-secondary">· {stepsLabel(steps)}</span>
                {grant !== undefined && (
                  <span className="break-words text-text-secondary">· {grant.label}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
