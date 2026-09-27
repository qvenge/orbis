import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from '../App';
import { useNav } from '../state/navigation';
import { renderWithProviders, wireEntity } from '../test/harness';
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
    return { entity: wireEntity({ id, title: `Запись ${id}` }), relations: [], thread: null };
  }
  if (path === 'user.getSettings')
    return { timezone: 'Europe/Moscow', defaultCurrency: 'RUB', weekStartDay: 1 };
  if (path === 'entity.query') return [];
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

async function openSettingsFromMenu() {
  fireEvent.click(screen.getByTestId('screen-menu'));
  const host = await screen.findByRole('group', { name: 'Хост' });
  fireEvent.click(within(host).getByRole('menuitem', { name: 'Настройки' }));
  await screen.findByRole('heading', { level: 1, name: 'Настройки' });
}

test('«⋯ → Настройки» открывает настройки поверх раздела; «‹» — обратно в раздел', async () => {
  renderWithProviders(<App />, handler);
  await screen.findByRole('heading', { level: 1, name: `Запись ${E1}` });
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
