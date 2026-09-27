import { MessageSquare, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { QuickCapture } from '../../features/browser/QuickCapture';
import { useSearchDialog } from '../../features/search/search-dialog-store';
import { useNav } from '../../state/navigation';
import { useRetryBuffer } from '../../state/retry';
import { NavBadge } from '../../ui/NavBadge';
import { useIsDesktop } from './useViewport';

const BUTTON =
  'relative inline-flex size-11 cursor-pointer items-center justify-center rounded-full text-host-foreground transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60';

/**
 * Кнопки хоста внизу справа (спека 1б §6.2 п. 4, §6.4): [🔍 | 💬 | ＋] на всех экранах — одно место в
 * `AppShell` на месте прежнего нижнего ряда вкладок (РП-19). Капсула тёмная сплошная, как присутствие
 * хоста (доверие, §6.2 п. 5); отступ от низа — не меньше безопасной зоны.
 *
 *  - 🔍 — поиск хоста: на телефоне — экран хоста поверх текущего раздела (§7.3), на десктопе — окно
 *    вверху по центру, которое не элемент истории (то же, что ⌘K, §6.3);
 *  - 💬 — общий чат хоста экраном хоста поверх текущего раздела (§7.3); бейдж — очередь офлайн-записей
 *    (они уходят из чата);
 *  - ＋ — сегодняшний быстрый ввод без контекста (`root`); контекст записи — задача 25 (РП-9).
 */
export function HostButtons() {
  const pending = useRetryBuffer((s) => s.size);
  const [capture, setCapture] = useState(false);
  const desktop = useIsDesktop();
  return (
    <div
      data-testid="host-buttons"
      className="pointer-events-none fixed right-4 bottom-[max(16px,env(safe-area-inset-bottom))] z-30 flex flex-col items-end gap-2"
    >
      {capture && (
        <div
          data-testid="host-capture"
          className="pointer-events-auto w-[min(92vw,28rem)] rounded-card border border-line bg-surface pt-3 shadow-pop"
        >
          <QuickCapture context={{ kind: 'root' }} />
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-host p-1 shadow-pop">
        <button
          type="button"
          aria-label="Поиск"
          data-testid="host-search"
          onClick={() =>
            desktop ? useSearchDialog.getState().show() : useNav.getState().openHostScreen('search')
          }
          className={BUTTON}
        >
          <Search size={18} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={pending > 0 ? `Чат, ${pending} ждут отправки` : 'Чат'}
          data-testid="host-chat"
          onClick={() => useNav.getState().openHostScreen('chat')}
          className={BUTTON}
        >
          <MessageSquare size={18} aria-hidden />
          <NavBadge
            count={pending}
            label="ждут отправки"
            data-testid="chat-badge"
            className="absolute -top-0.5 -right-0.5"
          />
        </button>
        <button
          type="button"
          aria-label="Новая запись"
          aria-expanded={capture}
          data-testid="host-new"
          onClick={() => setCapture((v) => !v)}
          className={BUTTON}
        >
          <Plus size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}
