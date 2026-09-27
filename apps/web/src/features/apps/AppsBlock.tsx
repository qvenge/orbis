import { useNav } from '../../state/navigation';
import { useApps } from './useApps';

/**
 * Блок «Приложения» `{{apps}}` — переключатель приложений (срез 1б §6.2 п. 3): плитки своих
 * приложений владельца (эмодзи, имя; выключенное — приглушённо, с подписью). Стоит на «Домой» и на
 * любой странице; второй блок на странице — второй список, без плашки (R-27). Тот же список — в
 * «⋯ → Все приложения» (`AllAppsSheet`).
 *
 * Оболочки хоста среди плиток нет (хост — ⌂), архивных — тоже: архив и есть «удалить приложение»
 * (§8.6). Выключенное нажимается: его адрес покажет плашку «выключено — [включить]».
 *
 * `onPick` — хозяину плиток (лист «Все приложения» закрывается выбором).
 */
export function AppsBlock({ onPick }: { onPick?: () => void }) {
  const { apps, status } = useApps();
  const shown = apps.filter((a) => !a.archived);
  if (status === 'ok' && shown.length === 0) {
    return (
      <p data-testid="apps-block" className="text-sm text-text-muted">
        Своих приложений пока нет
      </p>
    );
  }
  return (
    <div data-testid="apps-block" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {shown.map((a) => (
        <button
          key={a.id}
          type="button"
          data-testid={`app-tile-${a.id}`}
          data-disabled={a.disabled ? '' : undefined}
          onClick={() => {
            onPick?.();
            useNav.getState().switchApp(a.id);
          }}
          className={`flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-card border border-line bg-surface p-2 text-center text-sm transition hover:bg-surface-2 ${
            a.disabled ? 'opacity-50' : ''
          }`}
        >
          <span aria-hidden className="text-2xl">
            {a.row.emoji ?? '▫️'}
          </span>
          <span className="line-clamp-2">{a.title}</span>
          {a.disabled && <span className="text-2xs text-text-muted"> выключено</span>}
        </button>
      ))}
    </div>
  );
}
