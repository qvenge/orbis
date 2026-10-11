import { useLayoutEffect } from 'react';
import { trpc } from '../../trpc';

/**
 * Клиент tRPC и кеш запросов для отмены ВНЕ React (спека §7.5 п. 1): плашка живёт в оболочке и переживает экран, который
 * её показал, а к нажатию «Отменить» его хуков уже нет. Ставит `UndoBinder` — один в приложении (`main.tsx`) и в обвязке
 * тестов (`renderWithProviders`: каждый рендер — свой клиент и свой мок сети).
 */
export type UndoUtils = ReturnType<typeof trpc.useUtils>;
let bound: UndoUtils | null = null;
export function bindUndo(u: UndoUtils | null): void {
  bound = u;
}
export function boundUndoUtils(): UndoUtils | null {
  return bound;
}
export function UndoBinder(): null {
  const utils = trpc.useUtils();
  useLayoutEffect(() => {
    bindUndo(utils);
    return () => {
      if (boundUndoUtils() === utils) bindUndo(null);
    };
  }, [utils]);
  return null;
}
