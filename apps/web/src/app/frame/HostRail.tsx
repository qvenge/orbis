import { HOST_APP } from '@orbis/shared/nav';
import { House, Settings } from 'lucide-react';
import { useApps } from '../../features/apps/useApps';
import { openSettings } from '../../features/settings/settings-tab';
import { useNav } from '../../state/navigation';

/**
 * Мишень рейки — 40 px (§6.3), тёмная сплошная, как присутствие хоста: токены `host` дают контраст
 * текста ≥ 4.5:1 в обеих темах (`styles/tokens.css`). Активное — светлая подложка и кольцо.
 */
const RAIL_BUTTON =
  'relative inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-control text-host-foreground transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 aria-[current=page]:bg-white/15 aria-[current=page]:ring-1 aria-[current=page]:ring-host-foreground/60';

/**
 * Тёмная рейка хоста «куда» слева на десктопе (спека 1б §6.3): ⌂ — «Домой» хоста (роль `home` —
 * тот же элемент хоста, что ⌂ в строке присутствия телефона, R-23), иконки приложений — переключатель
 * в одно нажатие, внизу «Настройки».
 *
 * Список приложений — тот же, что у блока «Приложения» (`AppsBlock`, решение плана 15): без оболочки
 * хоста и архивных, выключенные приглушены и нажимаются (адрес покажет плашку «выключено —
 * [включить]»). Эмодзи — из строки записи (`byId.get(id).row.emoji`: у `AppInfo` его нет), без
 * эмодзи — первая буква имени. Подпись — `aria-label` и `title` (иконке без текста нужна обе).
 */
export function HostRail() {
  const activeApp = useNav((s) => s.model.activeApp);
  const { apps } = useApps();
  const shown = apps.filter((a) => !a.archived);
  return (
    <nav
      aria-label="Приложения"
      data-testid="host-rail"
      className="flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto bg-host py-2"
    >
      <button
        type="button"
        aria-label="Домой"
        title="Домой"
        data-host="home"
        aria-current={activeApp === HOST_APP ? 'page' : undefined}
        onClick={() => useNav.getState().goHome()}
        className={RAIL_BUTTON}
      >
        <House size={18} aria-hidden />
      </button>
      <span aria-hidden className="my-1 h-px w-6 shrink-0 bg-white/20" />
      {shown.map((a) => {
        // Приложение без имени (заведено через MCP или пачкой) — не невидимая безымянная кнопка
        // (WCAG 4.1.2, гейт 25 m-7): подпись «Без названия», глиф — заглушка, как у плитки `AppsBlock`.
        const title = a.title.trim();
        const name = title === '' ? 'Без названия' : title;
        const label = a.disabled ? `${name}, выключено` : name;
        return (
          <button
            key={a.id}
            type="button"
            aria-label={label}
            title={label}
            data-testid={`rail-app-${a.id}`}
            data-disabled={a.disabled ? '' : undefined}
            aria-current={activeApp === a.id ? 'page' : undefined}
            onClick={() => useNav.getState().switchApp(a.id)}
            className={`${RAIL_BUTTON} ${a.disabled ? 'opacity-50' : ''}`}
          >
            <span aria-hidden className="text-lg leading-none">
              {a.row.emoji || title.charAt(0).toUpperCase() || '▫️'}
            </span>
          </button>
        );
      })}
      <span className="flex-1" />
      <button
        type="button"
        aria-label="Настройки"
        title="Настройки"
        onClick={() => openSettings('general')}
        className={RAIL_BUTTON}
      >
        <Settings size={18} aria-hidden />
      </button>
    </nav>
  );
}

/**
 * Кадр упавшей рейки (гейт 25, I-1): та же тёмная колонка, ⌂ и «Настройки» — элементы хоста рисуются
 * всегда (§6.6); без списка приложений (он и упал). Приложения остаются в «⋯ → Все приложения».
 */
export function HostRailFallback() {
  return (
    <nav
      aria-label="Приложения"
      data-testid="host-rail"
      data-failed=""
      className="flex w-14 shrink-0 flex-col items-center gap-1 bg-host py-2"
    >
      <button
        type="button"
        aria-label="Домой"
        title="Домой"
        data-host="home"
        onClick={() => useNav.getState().goHome()}
        className={RAIL_BUTTON}
      >
        <House size={18} aria-hidden />
      </button>
      <span className="flex-1" />
      <button
        type="button"
        aria-label="Настройки"
        title="Настройки"
        onClick={() => openSettings('general')}
        className={RAIL_BUTTON}
      >
        <Settings size={18} aria-hidden />
      </button>
    </nav>
  );
}
