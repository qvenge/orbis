import {
  type AppKey,
  currentEntry,
  HOME_SECTION,
  type NavModel,
  type StackEntry,
} from '@orbis/shared/nav';
import type { CaptureContext } from '../../features/browser/QuickCapture';
import { appKeyOf } from '../../state/navigation';

/** Место, про которое открыт чат: запись (или страница), домашняя приложения или ничего. */
export type ChatPlace = { kind: 'record'; id: string } | { kind: 'home'; app: AppKey } | null;

/**
 * Ключ состояния экрана чата (`StackEntry.view`, спека 1б §7.1): `'none'` — чат позван с экрана хоста.
 * Экран хоста поверх экрана хоста встаёт ВМЕСТО него (§7.3), и под чатом оказывается место, откуда
 * звали уже не его: 💬 на «Настройках» иначе принёс бы чип «Про: Домой». Метку ставит 💬 телефона
 * (`HostButtons`); она живёт в истории вместе с экраном и переживает «назад»/«вперёд».
 */
export const CHAT_ABOUT_VIEW = 'about';

function placeOf(entry: StackEntry | undefined): ChatPlace {
  if (entry === undefined) return null;
  const a = entry.address;
  if (a.kind === 'record') return { kind: 'record', id: a.id };
  if (a.kind === 'home') return { kind: 'home', app: appKeyOf(a.app) };
  // Экраны хоста — без контекста (§6.4): чип «Про: Настройки» агенту ничего не скажет.
  return null;
}

/**
 * Про что открыт чат (спека 1б §6.4, РП-27):
 *  - `'screen'` — экран чата телефона: место под ним в стопке текущего раздела (экран хоста лежит
 *    поверх раздела, §7.3);
 *  - `'side'` — боковой чат десктопа (он не в стопке): текущее место основной области.
 * Домашняя приложения — `home` (запись домашней знает оболочка, `useChatContext`).
 */
export function chatContextOf(model: NavModel, where: 'screen' | 'side'): ChatPlace {
  if (where === 'side') return placeOf(currentEntry(model));
  const app = model.activeApp;
  const nav = Object.hasOwn(model.apps, app) ? model.apps[app] : undefined;
  const section = nav?.activeSection ?? HOME_SECTION;
  const stack = nav !== undefined && Object.hasOwn(nav.stacks, section) ? nav.stacks[section] : [];
  const top = stack?.[stack.length - 1];
  if (top === undefined) return null;
  if (top.address.kind !== 'host-screen') return placeOf(top);
  if (top.view?.[CHAT_ABOUT_VIEW] === 'none') return null;
  return placeOf(stack?.[stack.length - 2]);
}

/**
 * Контекст «＋» (спека 1б §6.4, РП-9, В-6): на записи, не странице, — подзадача этой записи (как
 * сегодня внутри записи); на странице, домашней и экранах хоста — без контекста. Страница — место, а
 * не дело: подзадача «Upcoming» никому не нужна.
 */
export function captureContextOf(place: ChatPlace, isPage: boolean): CaptureContext {
  if (place?.kind === 'record' && !isPage) return { kind: 'entity', parentId: place.id };
  return { kind: 'root' };
}
