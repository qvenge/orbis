import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react';
import type { createFreshnessRuntime } from './runtime';

export const FreshnessContext = createContext<
  ReturnType<typeof createFreshnessRuntime> | undefined
>(undefined);

const Visible = createContext(true);

export function FreshnessVisibility({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return createElement(Visible.Provider, { value: useContext(Visible) && visible }, children);
}

export function useFreshnessVisible(): boolean {
  return useContext(Visible);
}

const subscribeEmpty = () => () => {};
const empty = () => undefined;

export function useFreshnessScreen() {
  const runtime = useContext(FreshnessContext);
  return useSyncExternalStore(
    runtime?.subscribeScreen ?? subscribeEmpty,
    runtime?.getScreen ?? empty,
  );
}
