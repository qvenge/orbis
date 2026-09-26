/**
 * Кнопка «Обновить» — одна на два экрана: «Обновите приложение» (`auth/AuthProvider.tsx`, сервер
 * ответил 412 — клиент устарел) и кадр ошибки экрана (`app/ChunkErrorBoundary.tsx`).
 *
 * Почему не голый `location.reload()` (Л-5 живой приёмки 1а, Ф-1б-26): приложением управляет
 * сервис-воркер плагина PWA (`vite.config.ts`, `registerType: 'autoUpdate'`), а навигацию он отдаёт
 * из прекеша (`navigateFallback: '/index.html'`). Перезагрузка под СТАРЫМ воркером получает старый
 * `index.html` со старыми чанками — и снова тот же экран «обновите». Новый воркер ставится фоном и
 * берёт управление позже, так что помогала только вторая перезагрузка. Здесь — сначала
 * `registration.update()`, затем ожидание смены контроллера (новый воркер с `skipWaiting` +
 * `clientsClaim` берёт вкладку сам; ожидающему — `SKIP_WAITING`), и только потом перезагрузка.
 *
 * Ожидание — с потолком: воркер, который так и не взял управление (сеть, отказ установки), не
 * должен делать кнопку мёртвой; перезагрузка под старым всё равно лучше, чем ничего. Любой отказ
 * по пути — тоже перезагрузка. Перезагрузка — ровно одна.
 */

/** Потолок ожидания нового воркера: дольше человек решит, что кнопка не работает. */
export const SW_UPDATE_TIMEOUT_MS = 8000;

/** Среда функции — параметром, чтобы тест подставил двойник (в jsdom сервис-воркеров нет). */
export interface FreshReloadEnv {
  sw:
    | Pick<ServiceWorkerContainer, 'getRegistration' | 'addEventListener' | 'removeEventListener'>
    | undefined;
  reload: () => void;
  timeoutMs: number;
}

function browserEnv(): FreshReloadEnv {
  return {
    // Страховка: в небезопасном контексте (http не на localhost) и в старых браузерах поля нет.
    sw: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    reload: () => location.reload(),
    timeoutMs: SW_UPDATE_TIMEOUT_MS,
  };
}

export async function reloadWithFreshWorker(env: FreshReloadEnv = browserEnv()): Promise<void> {
  let done = false;
  const reloadOnce = () => {
    if (done) return;
    done = true;
    env.reload();
  };
  try {
    const reg = await env.sw?.getRegistration();
    if (reg === undefined) return reloadOnce();
    // Новый воркер плагина (`autoUpdate`: skipWaiting + clientsClaim).
    await reg.update();
    const next = reg.installing ?? reg.waiting;
    // Ни ставящегося, ни ждущего — свежий уже управляет, ждать нечего.
    if (next === null) return reloadOnce();
    reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
    const sw = env.sw;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        sw?.removeEventListener('controllerchange', finish);
        resolve();
      };
      const timer = setTimeout(finish, env.timeoutMs);
      sw?.addEventListener('controllerchange', finish);
    });
  } catch {
    // Отказ update() или регистрации — перезагрузка всё равно лучше мёртвой кнопки.
  }
  reloadOnce();
}
