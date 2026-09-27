import type { AppKey } from '@orbis/shared/nav';
import { createContext } from 'react';

/**
 * Приложение рамки, в которой нарисован экран, и откуда на нём ведут ссылки (спека 1б §7.2):
 *  - `content` — содержимое записи или страницы: ссылка несёт приложение рамки;
 *  - `host-screen` — экран хоста (чат, поиск, настройки, память): ссылка открывается из хоста — дальше
 *    правило открытия (§5.2 п. 4, задача 20), а экран хоста снимается (§7.3).
 *
 * Ставит роутер над содержимым `<main>` по верху стопки. Вне роутера (тест экрана без рамки) контекста
 * нет — `null`, и `useOpenRecord` берёт активное приложение модели как содержимое.
 */
export interface FrameApp {
  app: AppKey;
  via: 'content' | 'host-screen';
}

export const FrameAppContext = createContext<FrameApp | null>(null);
