import { currentEntry } from '@orbis/shared/nav';
import { afterEach, expect, test } from 'vitest';
import {
  configureNavigation,
  readPersistedNav,
  resetNavForTests,
  useNav,
} from '../state/navigation';
import { freezeNavigationHistory, installHistory, startNavigation } from './history';

const scope = (accountId: string, shared = false) => ({
  accountId,
  graphId: accountId,
  generation: 'gen',
  shared,
  isCurrent: () => true,
});

afterEach(() => {
  freezeNavigationHistory();
  configureNavigation(undefined);
  resetNavForTests();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

test('shared browser history contains opaque references and keeps navigation off persistent storage', () => {
  configureNavigation(scope('a', true));
  startNavigation();
  const uninstall = installHistory();
  try {
    useNav.getState().openRecord('secret-record');
    expect(currentEntry(useNav.getState().model).address).toMatchObject({ id: 'secret-record' });
    expect(JSON.stringify(history.state)).not.toContain('secret-record');
    expect(location.pathname + location.search).toBe('/');
    useNav.getState().openHostScreen('search');
    useNav.getState().replacePlace({ kind: 'host-screen', screen: 'search', q: 'secret-query' });
    expect(currentEntry(useNav.getState().model).address).toMatchObject({ q: 'secret-query' });
    expect(location.pathname + location.search).toBe('/');
    expect(JSON.stringify(history.state)).not.toContain('secret-query');
    expect(localStorage.length).toBe(0);
  } finally {
    uninstall();
  }
});

test('account B cannot restore the former owner from a browser history entry', () => {
  configureNavigation(scope('a'));
  startNavigation();
  const uninstall = installHistory();
  useNav.getState().openRecord('former-record');
  const former = history.state;
  uninstall();
  freezeNavigationHistory();
  configureNavigation(scope('b'));
  startNavigation();
  const remove = installHistory();
  try {
    history.replaceState(former, '', '/r/former-record');
    window.dispatchEvent(new PopStateEvent('popstate', { state: former }));
    expect(currentEntry(useNav.getState().model).address.kind).toBe('home');
    expect(JSON.stringify(readPersistedNav())).not.toContain('former-record');
  } finally {
    remove();
  }
});

test('pending creation shares neither its identity nor a history entry with shared navigation', () => {
  configureNavigation(scope('a', true));
  startNavigation();
  const uninstall = installHistory();
  try {
    const before = history.length;
    const state = history.state;
    useNav.getState().openPendingCreate('private-pending');
    expect(useNav.getState().pendingCreate).toBe('private-pending');
    expect(history.state).toEqual(state);
    expect(history.length).toBe(before);
    useNav.getState().confirmPendingCreate('other');
    expect(history.length).toBe(before);
    useNav.getState().back();
    expect(useNav.getState().pendingCreate).toBeNull();
    useNav.getState().openPendingCreate('private-pending');
    useNav.getState().confirmPendingCreate('private-pending');
    expect(history.length).toBe(before + 1);
    expect(location.pathname).toBe('/');
    expect(JSON.stringify(history.state)).not.toContain('private-pending');
  } finally {
    uninstall();
  }
});
