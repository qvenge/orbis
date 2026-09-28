import { PAGE_ASPECT } from '@orbis/shared';
import { currentEntry } from '@orbis/shared/nav';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { MessageSquare, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { QuickCapture } from '../../features/browser/QuickCapture';
import { openSearch } from '../../features/search/open-search';
import { useNav } from '../../state/navigation';
import { useRetryBuffer } from '../../state/retry';
import { type RouterOutputs, trpc } from '../../trpc';
import { NavBadge } from '../../ui/NavBadge';
import { CHAT_ABOUT_VIEW, captureContextOf, chatContextOf } from './chat-context';
import { useSideChat } from './side-chat-store';
import { useIsDesktop } from './useViewport';

const BUTTON_BASE =
  'relative inline-flex size-11 cursor-pointer items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60';
const BUTTON = `${BUTTON_BASE} text-host-foreground hover:bg-white/10`;
/**
 * Активное 💬 десктопа (боковой чат открыт): фон светлее — цвет текста хоста, иконка — цвет хоста.
 * Контраст состояния с капсулой — тот же, что у текста хоста (≥ 4.5:1 в обеих темах, `tokens.css`),
 * то есть с запасом выше 3:1 (WCAG 1.4.11).
 */
const BUTTON_PRESSED = `${BUTTON_BASE} bg-host-foreground text-host hover:opacity-90`;

/**
 * 💬 телефона: общий чат — экраном хоста поверх текущего раздела (§7.3). С экрана хоста (настройки,
 * поиск) чат встаёт ВМЕСТО него, и место под чатом — уже не то, откуда звали: метка
 * `CHAT_ABOUT_VIEW` говорит экрану чата «без чипа» (§6.4: экраны хоста — без контекста). Метку
 * ставит только новый экран чата: повторное 💬 на чате модель не меняет.
 */
function openChatScreen(): void {
  const nav = useNav.getState();
  const before = currentEntry(nav.model).address;
  if (nav.overlay === null && before.kind === 'host-screen' && before.screen === 'chat') return;
  nav.openHostScreen('chat');
  const after = currentEntry(useNav.getState().model).address;
  if (before.kind === 'host-screen' && after.kind === 'host-screen' && after.screen === 'chat') {
    useNav.getState().setView({ [CHAT_ABOUT_VIEW]: 'none' });
  }
}

/**
 * Быстрый ввод «＋» с контекстом места основной области (§6.4, РП-9, В-6): на записи — подзадача, на
 * странице, домашней и экранах хоста — без контекста. Страница ли это — по аспектам записи из кеша
 * `entity.get` (экран записи его уже прочёл); отдельного запроса «＋» не делает.
 */
function HostCapture() {
  const model = useNav((s) => s.model);
  const queryClient = useQueryClient();
  const place = chatContextOf(model, 'side');
  // Ключ `entity.get` экрана записи несёт ещё и `include` — берём любой ответ по этому id
  // (частичное совпадение ключа), а не точный ключ экрана: его форма — дело экрана записи.
  const isPage =
    place?.kind === 'record' &&
    queryClient
      .getQueriesData<RouterOutputs['entity']['get']>({
        queryKey: getQueryKey(trpc.entity.get, { id: place.id }, 'query'),
      })
      .some(([, data]) => data?.entity.aspects.includes(PAGE_ASPECT) === true);
  return <QuickCapture context={captureContextOf(place, isPage)} />;
}

/**
 * Кнопки хоста внизу справа (спека 1б §6.2 п. 4, §6.3, §6.4): [🔍 | 💬 | ＋] на всех экранах и на
 * обеих ширинах — одно место на месте прежнего нижнего ряда вкладок (РП-19). Капсула тёмная сплошная,
 * как присутствие хоста (доверие, §6.2 п. 5); отступ от низа — не меньше безопасной зоны. Телефон —
 * `fixed` у края экрана; десктоп — `absolute` в правом нижнем углу основной колонки
 * (`DesktopFrame`): открытый боковой чат капсулу не закрывает (§6.3, «капсула на месте»).
 *
 *  - 🔍 — поиск хоста: на телефоне — экран хоста поверх текущего раздела (§7.3), на десктопе — окно
 *    вверху по центру, которое не элемент истории (то же, что ⌘K, §6.3);
 *  - 💬 — телефон: общий чат экраном хоста поверх текущего раздела (§7.3); десктоп: открывает и
 *    закрывает боковой чат (`useSideChat`, не элемент истории), активное подсвечено. Бейдж — очередь
 *    офлайн-записей (они уходят из чата);
 *  - ＋ — быстрый ввод с контекстом места (`HostCapture`).
 *
 * Роли — `data-host` (`host-elements.ts`, тест двух ширин).
 */
export function HostButtons() {
  const pending = useRetryBuffer((s) => s.size);
  const [capture, setCapture] = useState(false);
  const desktop = useIsDesktop();
  const sideChat = useSideChat((s) => s.open);
  return (
    <div
      data-testid="host-buttons"
      className={`pointer-events-none ${desktop ? 'absolute' : 'fixed'} right-4 bottom-[max(16px,env(safe-area-inset-bottom))] z-30 flex flex-col items-end gap-2`}
    >
      {capture && (
        <div
          data-testid="host-capture"
          className="pointer-events-auto w-[min(92vw,28rem)] rounded-card border border-line bg-surface pt-3 shadow-pop"
        >
          <HostCapture />
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-host p-1 shadow-pop">
        <button
          type="button"
          aria-label="Поиск"
          data-testid="host-search"
          data-host="search"
          onClick={() => openSearch(desktop)}
          className={BUTTON}
        >
          <Search size={18} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={pending > 0 ? `Чат, ${pending} ждут отправки` : 'Чат'}
          data-testid="host-chat"
          data-host="chat"
          aria-pressed={desktop ? sideChat : undefined}
          aria-controls={desktop ? 'side-chat' : undefined}
          onClick={desktop ? () => useSideChat.getState().toggle() : openChatScreen}
          className={desktop && sideChat ? BUTTON_PRESSED : BUTTON}
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
          data-host="new"
          onClick={() => setCapture((v) => !v)}
          className={BUTTON}
        >
          <Plus size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}
