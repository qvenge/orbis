import type { AppKey } from '@orbis/shared/nav';
import { useAppShell } from '../../app/frame/useAppShell';
import { useNav } from '../../state/navigation';

/**
 * Разделы формы «домашняя как центр» (срез 1б §6.2 п. 2): постоянной навигации нет, разделы —
 * плитки-ссылки на домашней приложения, над её содержимым. Разделов у формы нет и в истории (§7.3:
 * «одна стопка»), поэтому плитка — обычный переход по ссылке из домашней, а не смена раздела.
 * Архивный раздел — плиткой-плашкой «в архиве», не пустотой (§4.4).
 */
export function NavTiles({ app }: { app: AppKey }) {
  const shell = useAppShell(app);
  if (shell.sections.length === 0) return null;
  return (
    <nav
      aria-label="Разделы"
      data-testid="nav-tiles"
      className="mx-auto grid w-full max-w-3xl grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-3 md:px-6"
    >
      {shell.sections.map((s) => (
        <button
          key={s.id}
          type="button"
          disabled={s.archived}
          onClick={() => useNav.getState().openRecord(s.id, { app })}
          className="flex min-h-14 cursor-pointer items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 text-left text-sm transition hover:bg-surface-2 disabled:cursor-default disabled:text-text-muted"
        >
          {s.emoji && <span aria-hidden>{s.emoji}</span>}
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          {s.archived && <span className="text-2xs">в архиве</span>}
        </button>
      ))}
    </nav>
  );
}
