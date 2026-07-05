import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider, getCurrentToken } from './auth/AuthProvider';
import { OnboardingGate } from './features/onboarding/OnboardingGate';
import { registerRetrySend } from './state/retry';
import { makeRetrySend } from './state/retry-send';
import { makeTrpcClient, makeVanillaClient, queryClient, trpc } from './trpc';
import './styles/globals.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

const trpcClient = makeTrpcClient(getCurrentToken);
// Боевая проводка retry-буфера: flush → entity.create(source:'fast_path') через vanilla-клиент.
registerRetrySend(makeRetrySend(makeVanillaClient(getCurrentToken)));

createRoot(rootElement).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <OnboardingGate>
            <App />
          </OnboardingGate>
        </AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
