import { isOAuthAuthorizePath } from '@orbis/shared';
import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, StrictMode, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider, configureProductToken, getCurrentToken, useAuth } from './auth/AuthProvider';
import { clearLocalMessages } from './features/chat/local-messages';
import { ConsentScreen } from './features/oauth/ConsentScreen';
import { UndoBinder } from './features/undo/undo-binding';
import { bindFreshnessRuntime } from './lib/freshness/provenance';
import { createFreshnessRuntime } from './lib/freshness/runtime';
import { FreshnessContext } from './lib/freshness/screen';
import { createFreshnessTransport } from './lib/freshness/transport';
import { createBrowserLocalData } from './lib/local-data/browser-lifecycle';
import { bindQueryResponses } from './lib/local-data/query-responses';
import { QueryBatchProvider } from './lib/query-blocks/batch';
import { resetRegistryObservation } from './lib/registry/useRegistry';
import { initTheme } from './lib/theme';
import { perfBuffer } from './perf/collector';
import { registerRetrySend } from './state/retry';
import { makeRetrySend } from './state/retry-send';
import {
  configureProductTransport,
  makeTrpcClient,
  makeVanillaClient,
  queryClient,
  trpc,
} from './trpc';
import { Toaster } from './ui/Toast';
import './styles/globals.css';

initTheme();
const privacy = createBrowserLocalData();
configureProductToken(privacy.getToken);
configureProductTransport(privacy.getLease);
onlineManager.setEventListener((setOnline) => {
  const update = () => setOnline(navigator.onLine && !!privacy.getToken());
  update();
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  const unsubscribe = privacy.subscribe(update);
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
    unsubscribe();
  };
});
void privacy.start();
// Полевые замеры (спека скорости §3.2) — ленивым чанком: входной чанк входит в эагерное замыкание экрана записи, и там
// только склейка — метки и буфер (гейт задачи 3, I-1). Потерь нет: замеры до загрузки чанка ждут в буфере, наблюдатели
// Resource Timing и Web Vitals подписываются с `buffered`. Буфер — аргументом (`PerfBuffer`). Отказ загрузки (сеть) — без
// замеров, приложение живёт.
void import('./perf/boot').then((m) => m.startPerf(perfBuffer)).catch(() => {});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

const trpcClient = makeTrpcClient(getCurrentToken);
// Боевая проводка retry-буфера: flush → entity.create(source:'fast_path') через vanilla-клиент.
registerRetrySend(makeRetrySend(makeVanillaClient(getCurrentToken)));

function FreshnessSession({ children }: { children: ReactNode }) {
  const { scope, shared } = useAuth();
  const [runtime, setRuntime] = useState<ReturnType<typeof createFreshnessRuntime>>();
  useLayoutEffect(() => {
    const lease = privacy.getLease();
    if (!scope || !lease?.isCurrent()) return;
    const next = createFreshnessRuntime({
      queryClient,
      scope,
      transport: createFreshnessTransport({ getToken: getCurrentToken }),
      isCurrent: lease.isCurrent,
    });
    const unbind = bindFreshnessRuntime(queryClient, next);
    const responses = bindQueryResponses(queryClient, next, shared ? { enabled: false } : {});
    setRuntime(next);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      responses.close();
      next.dispose();
      unbind();
      void queryClient.cancelQueries();
      queryClient.clear();
      clearLocalMessages(queryClient);
      resetRegistryObservation();
    }
    const unregister = privacy.registerRuntimeFreeze(close);
    return () => {
      unregister();
      close();
    };
  }, [scope, shared]);
  if (!runtime || runtime.scope.epoch !== scope?.epoch) return null;
  return <FreshnessContext.Provider value={runtime}>{children}</FreshnessContext.Provider>;
}

createRoot(rootElement).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/* Собиратель пачки блоков данных (спека страниц 1а §6.3) — под клиентом кеша: ключи
            блоков живут в нём, а пачка уходит клиентом tRPC. Один на приложение: блоки всех
            экранов, появившиеся одновременно, делят одну пачку. */}
        <QueryBatchProvider>
          <AuthProvider privacy={privacy}>
            {/* Экран согласия OAuth — внутри AuthProvider (незалогиненного он сам уводит на
              вход), но ВНЕ OnboardingGate: выдача доступа агенту не требует пройденного
              онбординга. Серверного роута под этим путём нет — GET доходит до SPA-fallback
              (server/app.ts), поэтому ветка решается здесь по pathname.
              Путь и терпимость к хвостовому слэшу — из контракта маршрутов (@orbis/shared):
              ту же строку сервер кладёт в `authorization_endpoint` метаданных, и пока копий
              было две, переименование на сервере молча оставляло владельца на этом экране
              без согласия. */}
            {isOAuthAuthorizePath(window.location.pathname) ? (
              <ConsentScreen />
            ) : (
              <FreshnessSession>
                <App gated />
              </FreshnessSession>
            )}
            {/* Тосты доступны и до прохождения онбординга, поэтому вне гейта. */}
            <UndoBinder />
            <Toaster />
          </AuthProvider>
        </QueryBatchProvider>
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
