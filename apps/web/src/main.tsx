import { isOAuthAuthorizePath } from '@orbis/shared';
import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, StrictMode, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider, getCurrentToken, useAuth } from './auth/AuthProvider';
import { clearLocalMessages } from './features/chat/local-messages';
import { resetEnsuredThreads } from './features/chat/useEnsuredThread';
import { ConsentScreen } from './features/oauth/ConsentScreen';
import { OnboardingGate } from './features/onboarding/OnboardingGate';
import { UndoBinder } from './features/undo/undo-binding';
import { isUndoEpoch, subscribeUndoEpoch, undoEpoch } from './features/undo/undo-epoch';
import { bindFreshnessRuntime } from './lib/freshness/provenance';
import { createFreshnessRuntime } from './lib/freshness/runtime';
import { FreshnessContext } from './lib/freshness/screen';
import { createFreshnessTransport } from './lib/freshness/transport';
import { bindQueryResponses } from './lib/local-data/query-responses';
import { QueryBatchProvider } from './lib/query-blocks/batch';
import { resetRegistryObservation } from './lib/registry/useRegistry';
import { initTheme } from './lib/theme';
import { perfBuffer } from './perf/collector';
import { registerRetrySend } from './state/retry';
import { makeRetrySend } from './state/retry-send';
import { makeTrpcClient, makeVanillaClient, queryClient, trpc } from './trpc';
import { Toaster } from './ui/Toast';
import './styles/globals.css';

initTheme();
onlineManager.setOnline(navigator.onLine);
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
  const { userId } = useAuth();
  const epoch = useSyncExternalStore(subscribeUndoEpoch, undoEpoch);
  const [runtime, setRuntime] = useState<ReturnType<typeof createFreshnessRuntime>>();
  useLayoutEffect(() => {
    if (!userId) return;
    const accountId = userId.toLowerCase();
    // Owner JWTs resolve to their personal graph, whose id equals owner_ref
    // (server identityOfPerson, graphs_personal_identity). Grants use a different resolver.
    const scope = { accountId, graphId: accountId, epoch };
    const next = createFreshnessRuntime({
      queryClient,
      scope,
      transport: createFreshnessTransport({ getToken: getCurrentToken }),
      isCurrent: () => isUndoEpoch(epoch),
    });
    const unbind = bindFreshnessRuntime(queryClient, next);
    const responses = bindQueryResponses(queryClient, next);
    setRuntime(next);
    return () => {
      responses.close();
      next.dispose();
      unbind();
      queryClient.clear();
      clearLocalMessages(queryClient);
      resetEnsuredThreads();
      resetRegistryObservation();
    };
  }, [userId, epoch]);
  if (!runtime || runtime.scope.epoch !== epoch) return null;
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
          <AuthProvider>
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
                <OnboardingGate>
                  <App />
                </OnboardingGate>
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
