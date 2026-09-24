import { isOAuthAuthorizePath } from '@orbis/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider, getCurrentToken } from './auth/AuthProvider';
import { ConsentScreen } from './features/oauth/ConsentScreen';
import { OnboardingGate } from './features/onboarding/OnboardingGate';
import { QueryBatchProvider } from './lib/query-blocks/batch';
import { initTheme } from './lib/theme';
import { registerRetrySend } from './state/retry';
import { makeRetrySend } from './state/retry-send';
import { makeTrpcClient, makeVanillaClient, queryClient, trpc } from './trpc';
import { Toaster } from './ui/Toast';
import './styles/globals.css';

initTheme();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

const trpcClient = makeTrpcClient(getCurrentToken);
// Боевая проводка retry-буфера: flush → entity.create(source:'fast_path') через vanilla-клиент.
registerRetrySend(makeRetrySend(makeVanillaClient(getCurrentToken)));

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
              <OnboardingGate>
                <App />
              </OnboardingGate>
            )}
            {/* Тосты доступны и до прохождения онбординга, поэтому вне гейта. */}
            <Toaster />
          </AuthProvider>
        </QueryBatchProvider>
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
