import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from '../App';
import { useNav } from '../state/navigation';
import { renderWithProviders, wireEntity } from '../test/harness';
import { recordAddress, topAddress } from '../test/nav';
import { registryReply } from '../test/registry';
import { resetFrame, stubLaunchMode, unstubLaunchMode } from './frame/frame-fixtures';

// «‹» присутствия хоста — на ОДИН уровень стопки раздела (не сброс до корня), в обоих режимах запуска
// (срез 1б §7.3): сайт — через историю браузера (асинхронно, popstate следующим тиком), приложение —
// по модели сразу.
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';

const handler = (path: string, input: unknown) => {
  const reg = registryReply(path);
  if (reg !== undefined) return reg;
  if (path === 'entity.get') {
    const id = (input as { id: string }).id;
    return { entity: wireEntity({ id, title: `Запись ${id}` }), relations: [], thread: null };
  }
  if (path === 'entity.query') return [];
  if (path === 'chat.ensureThread') return { threadId: 't1' };
  if (path === 'chat.listMessages') return [];
  return {};
};

beforeEach(() => resetFrame('/'));

afterEach(() => {
  unstubLaunchMode();
  resetFrame('/');
});

const backButton = () =>
  within(screen.getByTestId('host-presence')).queryByRole('button', { name: 'Назад' });

test.each([
  'site',
  'app',
] as const)('«‹» снимает верх стопки (%s) — на уровень, не до корня', async (mode) => {
  stubLaunchMode(mode);
  renderWithProviders(<App />, handler);
  await screen.findByTestId('host-presence');
  useNav.getState().openRecord(E1);
  useNav.getState().openRecord(E2);
  await screen.findByRole('heading', { level: 1, name: `Запись ${E2}` });

  fireEvent.click(backButton() as HTMLElement);
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(E1)));
  fireEvent.click(backButton() as HTMLElement);
  await waitFor(() => expect(topAddress()).toEqual({ kind: 'home', app: { kind: 'host' } }));
  // Корень хоста: идти некуда — «‹» нет.
  await waitFor(() => expect(backButton()).toBeNull());
});
