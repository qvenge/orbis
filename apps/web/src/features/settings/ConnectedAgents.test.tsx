import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { ConnectedAgents } from './ConnectedAgents';

// Таймзона владельца — не украшение: 10:00Z в Europe/Moscow это 13:00, и любая проверка
// ниже покраснеет, если экран начнёт форматировать даты в зоне машины прогона.
const SETTINGS = { timezone: 'Europe/Moscow', defaultCurrency: 'RUB', pinnedEntities: [] };

const GRANT = {
  id: '5f0a4a6c-1b2c-4d3e-8f90-0123456789ab',
  kind: 'oauth',
  label: 'Claude Code',
  connected: true,
  createdAt: '2026-08-01T10:00:00.000Z',
  lastUsedAt: '2026-08-10T09:00:00.000Z',
  revokedAt: null,
};

/** Ответы сервера по умолчанию: список доступов подменяется поштучно. */
function handler(grants: unknown[], revoke: unknown = { revoked: true }) {
  return (path: string) => {
    if (path === 'user.getSettings') return SETTINGS;
    if (path === 'oauth.listGrants') return grants;
    if (path === 'oauth.revokeGrant') return revoke;
    return {};
  };
}

test('подключённый агент показан меткой, видом доступа и датами в зоне владельца', async () => {
  renderWithProviders(<ConnectedAgents />, handler([GRANT]));
  expect(await screen.findByText('Claude Code')).toBeInTheDocument();
  // Одной строкой и дословно: вид доступа человеческими словами, а не 'oauth', и обе даты
  // в зоне владельца. Проверка по подстроке пропустила бы и сырой kind, и сдвиг зоны.
  expect(
    screen.getByText('браузерный вход · подключён 01 авг., 13:00 · последний вызов 10 авг., 12:00'),
  ).toBeInTheDocument();
});

test('headless-токен назван человеческими словами, а не kind из базы', async () => {
  renderWithProviders(
    <ConnectedAgents />,
    handler([{ ...GRANT, kind: 'pat', label: 'CI', lastUsedAt: null }]),
  );
  expect(await screen.findByText('токен для CI · подключён 01 авг., 13:00')).toBeInTheDocument();
});

test('отзыв дёргает мутацию с тем же id и перезапрашивает список', async () => {
  const { calls } = renderWithProviders(<ConnectedAgents />, handler([GRANT]));
  fireEvent.click(await screen.findByRole('button', { name: 'Отозвать' }));
  await waitFor(() => {
    const call = calls.find((c) => c.path === 'oauth.revokeGrant');
    // Именно id этой строки: мутация с чужим или пустым id тоже «дёрнулась бы».
    expect(call?.input).toEqual({ grantId: GRANT.id });
  });
  // Без перезапроса кнопка осталась бы на месте, и владелец не увидел бы, что отзыв прошёл.
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'oauth.listGrants').length).toBeGreaterThan(1),
  );
});

test('отозванный доступ помечен датой отзыва и кнопки не имеет', async () => {
  renderWithProviders(
    <ConnectedAgents />,
    handler([{ ...GRANT, kind: 'pat', label: 'CI', revokedAt: '2026-08-05T10:00:00.000Z' }]),
  );
  expect(await screen.findByText('отозван 05 авг., 13:00')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Отозвать' })).toBeNull();
});

// Строка гранта создаётся в момент согласия владельца, ДО обмена кода на токены. Агент,
// который до обмена не дошёл, оставляет строку навсегда — и без отдельной пометки она
// выглядит как подключённый агент с доступом к данным.
test('брошенная попытка авторизации не выдаётся за подключённого агента', async () => {
  renderWithProviders(<ConnectedAgents />, handler([{ ...GRANT, connected: false }]));
  expect(
    await screen.findByText('браузерный вход · согласие дано 01 авг., 13:00'),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Агент не забрал доступ — повторите подключение в агенте.'),
  ).toBeInTheDocument();
  expect(screen.queryByText(/подключён/)).toBeNull();
  // Отзыв в эти секунды — единственный способ погасить ещё не обменянный код,
  // и сервер такой отзыв чтит (grants.ts: exchangeAuthorizationCode).
  expect(screen.getByRole('button', { name: 'Отозвать' })).toBeInTheDocument();
});

test('пустой список объясняет, как подключить агента, адресом этого стенда', async () => {
  renderWithProviders(<ConnectedAgents />, handler([]));
  // Адрес — не литерал в вёрстке: на проде это публичный адрес сервиса, локально — стенд.
  expect(
    await screen.findByText(`claude mcp add --transport http orbis ${window.location.origin}/mcp`),
  ).toBeInTheDocument();
  // Одной команды мало: без второго шага владелец выполнит add и решит, что подключение
  // не работает, — вход открывается только по /mcp в агенте.
  expect(
    screen.getByText('Ни одного доступа не выдано. Чтобы подключить агента, выполните:'),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Дальше выполните в агенте команду /mcp — вход откроется в браузере.'),
  ).toBeInTheDocument();
});

test('пока отзыв идёт, кнопка не принимает второе нажатие', async () => {
  renderWithProviders(<ConnectedAgents />, (path) => {
    // Мутация, которая не завершится: единственный способ увидеть промежуточное состояние.
    if (path === 'oauth.revokeGrant') return new Promise(() => {});
    return handler([GRANT])(path);
  });
  const button = await screen.findByRole('button', { name: 'Отозвать' });
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeDisabled());
});

test('несостоявшийся отзыв не молчит', async () => {
  // revoked:false — грант не найден (например, уже удалён): без сообщения владелец видел бы
  // нажатую кнопку и живую строку, не понимая, отозван доступ или нет.
  renderWithProviders(<ConnectedAgents />, handler([GRANT], { revoked: false }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отозвать' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Доступ не найден — возможно, он уже отозван.',
  );
});

test('отказ сервера на отзыве показан текстом отказа', async () => {
  renderWithProviders(<ConnectedAgents />, (path) => {
    if (path === 'oauth.revokeGrant') throw trpcError('INTERNAL_SERVER_ERROR', 'база недоступна');
    return handler([GRANT])(path);
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Отозвать' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('база недоступна');
});

test('несостоявшийся список — отказ, а не вечный скелетон', async () => {
  renderWithProviders(<ConnectedAgents />, (path) => {
    if (path === 'oauth.listGrants') throw trpcError('INTERNAL_SERVER_ERROR', 'список не отдан');
    return handler([])(path);
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('список не отдан');
  // Скелетон на месте отказа выдавал бы вечную загрузку за пустоту.
  expect(screen.queryByRole('status')).toBeNull();
});
