import { appendFileSync } from 'node:fs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { loadDetailScreen } from './detail-screen-loader';
import { useNav } from '../state/navigation';
import { queryReply, renderWithProviders, wireEntity } from '../test/harness';
import { recordAddress, topAddress } from '../test/nav';
import { registryReply } from '../test/registry';
import { resetFrame, stubLaunchMode, unstubLaunchMode } from './frame/frame-fixtures';

// Настройки — экран хоста (срез 1б §6.4, §7.3): открываются пунктом «Настройки» раздела «Хост» меню
// «⋯» и ложатся поверх текущего раздела; «‹» возвращает в раздел. Отдельной иконки настроек в шапке
// нет.
const E1 = '11111111-1111-4111-8111-111111111111';

const handler = (path: string, input: unknown) => {
  const reg = registryReply(path);
  if (reg !== undefined) return reg;
  if (path === 'entity.get') {
    const id = (input as { id: string }).id;
    trace('get:entered', { id });
    const reply = { entity: wireEntity({ id, title: `Запись ${id}` }), relations: [], thread: null };
    trace('get:response', { id });
    return reply;
  }
  if (path === 'user.getSettings')
    return { timezone: 'Europe/Moscow', defaultCurrency: 'RUB', weekStartDay: 1 };
  if (path === 'entity.query') return queryReply([]);
  return {};
};

beforeEach(() => {
  stubLaunchMode('app');
  resetFrame(`/r/${E1}`);
});

afterEach(() => {
  unstubLaunchMode();
  resetFrame('/');
});

const pendingLoads: Promise<unknown>[] = [];
const trace = (event: string, detail: object = {}) => {
  appendFileSync(process.env.B13_NAV_TRACE!, JSON.stringify({
    event, at: performance.now(), ...detail,
  }) + '\n');
};

vi.mock('./detail-screen-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./detail-screen-loader')>();
  return {
    ...actual,
    loadDetailScreen: () => {
      trace('loader:start');
      const result = actual.loadDetailScreen().then(
        (module) => {
          trace('loader:resolved');
          return module;
        },
        (error) => {
          trace('loader:rejected', { error: String(error) });
          throw error;
        },
      );
      pendingLoads.push(result);
      return result;
    },
  };
});

let unsubscribe: (() => void) | undefined;
beforeEach(async () => {
  trace('fixture:prepared', { address: topAddress(), pathname: window.location.pathname });
  unsubscribe = useNav.subscribe(() => trace('address', { address: topAddress() }));
  if (process.env.B13_NAV_WARM === '1') await loadDetailScreen();
  trace('fixture:render-ready');
});
afterEach(async () => {
  unsubscribe?.();
  await Promise.allSettled(pendingLoads);
});

async function openSettingsFromMenu() {
  fireEvent.click(screen.getByTestId('screen-menu'));
  const host = await screen.findByRole('group', { name: 'Хост' });
  fireEvent.click(within(host).getByRole('menuitem', { name: 'Настройки' }));
  await screen.findByRole('heading', { level: 1, name: 'Настройки' });
}

test('«⋯ → Настройки» открывает настройки поверх раздела; «‹» — обратно в раздел', async () => {
  renderWithProviders(<App />, handler);
  trace('heading:wait', { id: E1 });
  try {
    await screen.findByRole('heading', { level: 1, name: `Запись ${E1}` });
    trace('heading:visible', { id: E1 });
  } catch (error) {
    trace('heading:timeout', { id: E1 });
    throw error;
  }
  expect(screen.queryByRole('button', { name: 'Настройки' })).toBeNull();
  await openSettingsFromMenu();
  expect(topAddress()).toEqual({ kind: 'host-screen', screen: 'settings' });
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Назад' }),
  );
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(E1)));
});

test('повторное «Настройки» с экрана настроек не кладёт второй экран в стопку', async () => {
  renderWithProviders(<App />, handler);
  await screen.findByRole('heading', { level: 1, name: `Запись ${E1}` });
  await openSettingsFromMenu();
  const depth = useNav.getState().model.apps.host?.stacks.home?.length;
  await openSettingsFromMenu();
  expect(useNav.getState().model.apps.host?.stacks.home?.length).toBe(depth);
});
