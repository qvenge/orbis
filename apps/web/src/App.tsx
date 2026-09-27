import { useEffect, useState } from 'react';
import { AppShell } from './app/AppShell';
import { installChunkReload } from './app/chunk-reload';
import { installHistory, startNavigation } from './app/history';
import { useRetryFlush } from './state/retry';

export function App() {
  // §2.6/§5.3: досыл retry-буфера при старте (онлайн) и переходе offline→online.
  useRetryFlush();

  // Навигация (срез 1б §7.1–§7.3). Порядок — требование, а не стиль:
  //  1. старт — ДО первого кадра экрана (инициализатор состояния, а не эффект): адрес и
  //     `history.state` читаются, пока их никто не переписал, и первый кадр уже рисует место из
  //     ссылки, а не домашнюю, которая мелькнула бы и отправила свои запросы. Под StrictMode
  //     инициализатор зовётся дважды — второй вызов находит свою запись истории и лишь
  //     восстанавливает из неё то же место;
  //  2. порт истории и `popstate` — эффектом (у слушателя есть снятие).
  // Всё это ниже OnboardingGate: до прохождения гейта App не монтируется, адрес никто не
  // переписывает, и ссылка спокойно дожидается монтирования.
  useState(() => {
    startNavigation();
    return true;
  });
  useEffect(() => installHistory(), []);

  // Провал загрузки ленивого чанка → один автоматический перезаход (см. chunk-reload.ts).
  // Здесь же, ниже OnboardingGate: ленивые чанки грузятся только внутри приложения,
  // до гейта грузить нечему.
  useEffect(() => installChunkReload(), []);

  return <AppShell />;
}
