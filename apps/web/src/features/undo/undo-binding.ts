import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import { trpc } from '../../trpc';

/**
 * Клиент tRPC и кеш запросов для отмены ВНЕ React (спека §7.5 п. 1): плашка живёт в оболочке и переживает экран, который
 * её показал, а к нажатию «Отменить» его хуков уже нет. Ставит `UndoBinder` — один в приложении (`main.tsx`) и в обвязке
 * тестов (`renderWithProviders`: каждый рендер — свой клиент и свой мок сети).
 */
export type UndoUtils = ReturnType<typeof trpc.useUtils>;
let bound: { utils: UndoUtils; queryClient?: QueryClient } | null = null;
export function bindUndo(utils: UndoUtils | null, queryClient?: QueryClient): void {
  bound = utils && { utils, queryClient };
}
export function boundUndoUtils(): UndoUtils | null {
  return bound?.utils ?? null;
}
export function boundUndoQueryClient(): QueryClient | undefined {
  return bound?.queryClient;
}
export function UndoBinder(): null {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  useLayoutEffect(() => {
    bindUndo(utils, queryClient);
    const binding = bound;
    return () => {
      if (bound === binding) bindUndo(null);
    };
  }, [utils, queryClient]);
  return null;
}
