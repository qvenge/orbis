import { createContext, useContext } from 'react';
import type { LocalDataScope } from './lifecycle';

export type PrivacyActions = {
  shared: boolean;
  scope: LocalDataScope;
  canSeed: boolean;
  message?: string;
  logout(): void;
  toggleShared(): void;
  graphSeeded(scope: LocalDataScope): void;
};

export const PrivacyActionsContext = createContext<PrivacyActions | null>(null);
export const usePrivacyActions = () => useContext(PrivacyActionsContext);
