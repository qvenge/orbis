import { currentEntry } from '@orbis/shared/nav';
import { useEffect, useLayoutEffect, useState } from 'react';
import { AppShell } from './app/AppShell';
import { installChunkReload } from './app/chunk-reload';
import { loadDetailScreen } from './app/detail-screen-loader';
import { installHistory, startNavigation } from './app/history';
import { StartupHomeRead, StartupRecordRead } from './app/router';
import { OnboardingGate } from './features/onboarding/OnboardingGate';
import { useRegistry } from './lib/registry/useRegistry';
import { appKeyOf, useNav } from './state/navigation';
import { useRetryFlush } from './state/retry';

function StartupReads() {
  useRegistry();
  const overlay = useNav((state) => state.overlay);
  const address = useNav((state) => currentEntry(state.model).address);
  const pendingCreate = useNav((state) => state.pendingCreate);
  const detailPlace = overlay === null && address.kind !== 'host-screen';
  useEffect(() => {
    if (detailPlace) void loadDetailScreen().catch(() => {});
  }, [detailPlace]);

  if (!detailPlace) return null;
  if (address.kind === 'record')
    return pendingCreate === address.id ? null : <StartupRecordRead id={address.id} />;
  return <StartupHomeRead app={appKeyOf(address.app)} />;
}

export function App({ gated = false }: { gated?: boolean }) {
  // §2.6/§5.3: досыл retry-буфера при старте (онлайн) и переходе offline→online.
  useRetryFlush();

  // Навигация (срез 1б §7.1–§7.3). Порядок — требование, а не стиль:
  //  1. старт — ДО первого кадра экрана (инициализатор состояния, а не эффект): адрес и
  //     `history.state` читаются, пока их никто не переписал, и первый кадр уже рисует место из
  //     ссылки, а не домашнюю, которая мелькнула бы и отправила свои запросы. Под StrictMode
  //     инициализатор зовётся дважды — второй вызов находит свою запись истории и лишь
  //     восстанавливает из неё то же место;
  //  2. порт истории и `popstate` — эффектом (у слушателя есть снятие).
  // Product startup mounts only after the accepted local account has installed its nav scope.
  useState(() => {
    startNavigation();
    return true;
  });
  useEffect(() => installHistory(), []);

  useLayoutEffect(() => installChunkReload(), []);

  return gated ? (
    <>
      <StartupReads />
      <OnboardingGate>
        <AppShell />
      </OnboardingGate>
    </>
  ) : (
    <AppShell />
  );
}
