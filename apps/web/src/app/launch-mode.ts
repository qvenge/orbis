import { type LaunchMode, launchModeOf } from '@orbis/shared/nav';

/**
 * Способ запуска в этом окне (спека 1б §7.3, РП-5): установленное приложение (PWA, окно на десктопе —
 * `display-mode: standalone`; iOS — `navigator.standalone`) или WebView обёртки (метка в user agent)
 * ведут себя как приложение, вкладка браузера — как сайт. Решение — чистая `launchModeOf` shared;
 * здесь только чтение окружения, одним местом: в экранах «если PWA» нет (§7.3).
 *
 * `matchMedia` — не данность: в jsdom и в старых WebView её нет, а падение на старте хуже честного
 * «сайт» (страховка та же, что у `lib/theme.ts`).
 */
export function readLaunchMode(): LaunchMode {
  const standalone =
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return launchModeOf({ standalone, userAgent: navigator.userAgent });
}
