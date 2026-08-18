// История прогонов (С5, приёмка 9; V1.14, приёмка 2): что исполнитель делал, чем это кончилось
// и сколько шагов заняло. Строки — ссылки на сами прогоны: подробности (лента шагов, откат)
// живут на их собственных экранах, а не здесь.
//
// Секция одна на тикет и на рутину, и это не экономия: прогон устроен одинаково (тот же аспект,
// те же исходы, тот же запрос по детям), а различает их РОВНО одно — исполнитель. У тикета он
// внешний, и грант отвечает на вопрос «кто это делал»; у рутины исполнитель внутренний и всегда
// один, поэтому колонки у неё нет вовсе (Р-8) — пустой столбец на каждой строке сообщал бы, что
// исполнителя не знают, а его знают.
import { formatDate } from '../../lib/format';
import { trpc } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { RUN_OUTCOME_LABELS, runAspect, type TicketRun } from './useTicketRuns';

/**
 * Судьба предложения строкой истории (V1.6). Исход прогона о ней не говорит НИЧЕГО: «готово»
 * значит лишь «модель отработала», а решает предложение владелец — иногда через день, иногда
 * никогда. Без этого бейджа он не увидел бы в списке ни того, что от него чего-то ждут, ни
 * того, чем кончилось вчерашнее предложение.
 */
const PROPOSAL_LABELS: Record<string, string> = {
  // «Ждёт решения», а не «ждёт ответа»: ответа ждёт ВОПРОС рутины (outcome `checkpoint`), и
  // одно слово на два разных ожидания слило бы в списке «Рутины» два разных блока.
  pending: 'ждёт решения',
  approved: 'принято',
  rejected: 'отклонено',
  superseded: 'заменено',
  stale: 'устарело',
};

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
  showGrant = true,
  onOpen,
}: {
  /** Часть контракта секции; сама выборка уже скоуплена родителем (useTicketRuns). */
  parentId: string;
  runs: TicketRun[];
  /** Показывать ли исполнителя. `false` у рутины: исполнитель внутренний и всегда один. */
  showGrant?: boolean;
  onOpen: (id: string) => void;
}) {
  // Оба чтения — ПО УЖЕ ЖИВЫМ ключам кэша: часовой пояс тянет сам экран (DetailScreen), список
  // доступов — карточка назначения агентского тикета. Своей сети секция не добавляет; `enabled`
  // страхует случай «тикет назначен человеку, а прогоны от прежнего агента остались» — и
  // закрывает список доступов у рутины, которой он не нужен ни для одной строки.
  const tz = trpc.user.getSettings.useQuery().data?.timezone;
  const grants = trpc.oauth.listGrants.useQuery(undefined, {
    enabled: showGrant && runs.length > 0,
  });

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
          // Статус предложения — из аспекта прогона (он источник правды о судьбе, V1.6):
          // отдельного запроса строка истории не стоит. Незнакомое значение печатаем сырым —
          // та же честная деградация, что у исходов.
          const proposal =
            typeof a.proposal === 'object' && a.proposal !== null
              ? (a.proposal as { status?: unknown }).status
              : undefined;
          const proposalLabel =
            typeof proposal === 'string' ? (PROPOSAL_LABELS[proposal] ?? proposal) : undefined;
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
                {proposalLabel !== undefined && (
                  // Нерешённое предложение — акцентом: это единственная строка списка, по
                  // которой владельцу НАДО что-то сделать.
                  <Badge tone={proposal === 'pending' ? 'accent' : 'default'}>
                    предложение: {proposalLabel}
                  </Badge>
                )}
                <span className="text-text-secondary">· {stepsLabel(steps)}</span>
                {showGrant && grant !== undefined && (
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
