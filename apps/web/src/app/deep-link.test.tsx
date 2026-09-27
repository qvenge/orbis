/**
 * Вход снаружи (срез 1б §7.1–§7.3; 02-core-os §1.3): приложение, открытое по ссылке, показывает
 * нужное место в рамке; ссылка на удалённую/чужую запись — честный экран «не найдено», а не вечный
 * скелетон. Разбор адресов и старые ссылки — `app/nav.test.tsx`; здесь — старт с восстановленной
 * навигацией, двойной старт и «не найдено».
 *
 * jsdom держит ОДНУ сессионную историю на файл: «сколько записей добавилось» меряем числом вызовов
 * `pushState`, а не длиной истории.
 */
import { NAV_STORAGE_KEY } from '@orbis/shared/nav';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { DetailScreen } from '../features/entity-detail/DetailScreen';
import { useNav } from '../state/navigation';
import { renderWithProviders, trpcError, wireEntity } from '../test/harness';
import { recordAddress, topAddress } from '../test/nav';
import { registryReply } from '../test/registry';
import { resetFrame, stubLaunchMode, unstubLaunchMode } from './frame/frame-fixtures';

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333333';
const APP = '44444444-4444-4444-8444-444444444444';

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

beforeEach(() => {
  stubLaunchMode('site');
  resetFrame('/');
});

afterEach(() => {
  vi.restoreAllMocks();
  unstubLaunchMode();
  resetFrame('/');
});

test('вход по ссылке кладёт запись поверх восстановленного места раздела; чужие стопки целы', async () => {
  // Сохранение v2: раздел S1 хоста — последний, у своего приложения — своя домашняя.
  localStorage.setItem(
    NAV_STORAGE_KEY,
    JSON.stringify({
      v: 2,
      activeApp: 'host',
      apps: {
        host: { activeSection: S1, last: { [S1]: recordAddress(S1) } },
        [APP]: {
          activeSection: 'home',
          last: { home: { kind: 'home', app: { kind: 'app', ref: APP } } },
        },
      },
    }),
  );
  window.history.replaceState(null, '', `/r/${E1}`);
  renderWithProviders(<App />, handler);
  await screen.findByRole('heading', { level: 1, name: `Запись ${E1}` });
  const model = useNav.getState().model;
  expect(model.apps.host?.stacks[S1]).toEqual([
    { address: recordAddress(S1) },
    { address: recordAddress(E1) },
  ]);
  expect(model.apps[APP]?.stacks.home).toHaveLength(1);
  // Первый «‹» после входа по ссылке ведёт на место раздела, а не прочь из Orbis.
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  await screen.findByRole('heading', { level: 1, name: `Запись ${S1}` });
});

test('двойной старт (StrictMode) не плодит записи истории и не дублирует место', async () => {
  window.history.replaceState(null, '', `/r/${E1}`);
  const pushes = vi.spyOn(window.history, 'pushState');
  renderWithProviders(
    <StrictMode>
      <App />
    </StrictMode>,
    handler,
  );
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(E1)));
  // Второй прогон старта находит свою запись истории и лишь восстанавливает из неё то же место.
  expect(pushes).not.toHaveBeenCalled();
  expect(useNav.getState().model.apps.host?.stacks.home).toHaveLength(2);
});

test('чужой id — экран «не найдено»; «На главную» — корень раздела', async () => {
  window.history.replaceState(null, '', `/r/${E1}`);
  renderWithProviders(<App />, (path, input) => {
    if (path === 'entity.get') throw trpcError('NOT_FOUND');
    return handler(path, input);
  });
  expect(await screen.findByRole('heading', { name: 'Не найдено' })).toBeInTheDocument();
  expect(screen.getByText('Запись удалена или недоступна')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'На главную' }));
  await waitFor(() => expect(topAddress()).toEqual({ kind: 'home', app: { kind: 'host' } }));
});

test('не-NOT_FOUND ошибка экраном «не найдено» не подменяется', async () => {
  // Оба экрана рендерятся вместе и падают в одном такте — когда «не найдено» появилось у
  // NOT_FOUND-экрана, второй запрос уже упал, и отсутствие второго заголовка — факт, а не гонка.
  renderWithProviders(
    <>
      <DetailScreen entityId={E1} />
      <DetailScreen entityId={E2} />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        const id = (input as { id: string }).id;
        throw trpcError(id === E1 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR');
      }
      return handler(path, input);
    },
  );
  await screen.findByRole('heading', { name: 'Не найдено' });
  expect(screen.getAllByRole('heading', { name: 'Не найдено' })).toHaveLength(1);
  // Сеть и 500 «не найдено» не означают: экран остаётся прежним (скелетон с шапкой «…»).
  expect(screen.getByRole('heading', { name: '…' })).toBeInTheDocument();
});
