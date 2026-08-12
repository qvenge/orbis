// Экран согласия (§9.3): единственная страница OAuth-потока, которую видит владелец.
// Стережём три вещи, добытые предыдущими задачами: (а) негодный запрос отсекается ДО
// показа кнопки и БЕЗ обращения к серверу — describeRequest параметров PKCE не видит и
// такой запрос пропустит; (б) адрес отказа строится разбором, а не склейкой; (в) state,
// которого не было в запросе, не появляется в ответе.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { denialUrl, parseAuthorizeRequest } from './authorize-request';
import { ConsentScreen } from './ConsentScreen';

const SEARCH =
  '?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback' +
  `&code_challenge=${'x'.repeat(43)}&code_challenge_method=S256&state=st-1`;

const HANDLER = (path: string) => {
  if (path === 'oauth.describeRequest') return { clientName: 'Claude Code' };
  if (path === 'oauth.consent') {
    return { redirectTo: 'http://localhost:8080/callback?code=orbis_ac_1&state=st-1' };
  }
  return undefined;
};

test('показывает имя клиента и по «Разрешить» уходит на redirect_uri', async () => {
  const navigate = vi.fn();
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={navigate} />, HANDLER);
  expect(await screen.findByText(/Claude Code/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить' }));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      'http://localhost:8080/callback?code=orbis_ac_1&state=st-1',
    ),
  );
});

test('«Отклонить» уводит с access_denied — без обращения к серверу', async () => {
  const navigate = vi.fn();
  const { calls } = renderWithProviders(
    <ConsentScreen search={SEARCH} navigate={navigate} />,
    HANDLER,
  );
  await screen.findByText(/Claude Code/);
  fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(navigate.mock.calls[0]?.[0]).toContain('error=access_denied');
  expect(navigate.mock.calls[0]?.[0]).toContain('state=st-1');
  expect(calls.some((c) => c.path === 'oauth.consent')).toBe(false);
});

test('негодный запрос показывает отказ и не даёт кнопки', async () => {
  const { calls } = renderWithProviders(
    <ConsentScreen search="?client_id=abc" navigate={vi.fn()} />,
    HANDLER,
  );
  expect(await screen.findByText(/запрос неполон/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Разрешить' })).toBeNull();
  // Негодный запрос не должен даже спрашивать сервер
  expect(calls).toHaveLength(0);
});

test('метод plain не принимается клиентом', () => {
  const search =
    `?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=${'x'.repeat(43)}` +
    '&code_challenge_method=plain';
  expect(parseAuthorizeRequest(search)).toBeNull();
});

// Отсутствие метода — не то же самое, что plain, но исход обязан быть тот же: по RFC 7636
// §4.3 пропущенный code_challenge_method означает ровно plain, и клиент, положившийся на
// умолчание, отвалился бы на обмене кода. Сервер такой запрос до кнопки не отсекает:
// describeRequest параметров PKCE не получает вовсе.
test('запрос без метода, без челленджа и с чужим response_type негоден', () => {
  const base = `?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb`;
  const challenge = `&code_challenge=${'x'.repeat(43)}`;
  expect(parseAuthorizeRequest(`${base}${challenge}`)).toBeNull();
  expect(parseAuthorizeRequest(`${base}&code_challenge_method=S256`)).toBeNull();
  expect(
    parseAuthorizeRequest(`${base}${challenge}&code_challenge_method=S256&response_type=token`),
  ).toBeNull();
  // Разбор годного запроса — контрольная точка: иначе все проверки выше прошёл бы
  // и разбор, возвращающий null всегда.
  expect(parseAuthorizeRequest(`${base}${challenge}&code_challenge_method=S256`)).toEqual({
    clientId: 'a',
    redirectUri: 'http://localhost:1/cb',
    codeChallenge: 'x'.repeat(43),
    codeChallengeMethod: 'S256',
    state: undefined,
    resource: undefined,
  });
});

// Склейка `${redirectUri}?error=…` тут даёт битый адрес: у клиента законно бывает свой
// query (RFC 6749 §3.1.2), а не-ASCII в нём — непостроимый заголовок Location.
test('адрес отказа достраивает чужой query, а не затирает его', () => {
  const request = parseAuthorizeRequest(
    '?client_id=a&code_challenge=' +
      'x'.repeat(43) +
      '&code_challenge_method=S256&state=st%201' +
      '&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb%3Ftenant%3Dacme%26next%3D%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82',
  );
  if (request === null) throw new Error('запрос должен был разобраться');
  const url = new URL(denialUrl(request));
  expect(url.searchParams.get('tenant')).toBe('acme');
  expect(url.searchParams.get('next')).toBe('привет');
  expect(url.searchParams.get('error')).toBe('access_denied');
  expect(url.searchParams.get('state')).toBe('st 1');
  // Адрес уезжает в заголовок Location — не-ASCII в нём должен быть уже закодирован.
  expect(denialUrl(request)).toContain('next=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82');
});

// state необязателен (RFC 6749 §4.1.1). Пустой `state=` в ответе клиент, сверяющий его
// строкой, счёл бы ответом на чужой запрос — поэтому «не было» обязано остаться «нет».
test('без state в запросе адрес отказа его не выдумывает', () => {
  const request = parseAuthorizeRequest(
    `?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=${'x'.repeat(43)}` +
      '&code_challenge_method=S256',
  );
  if (request === null) throw new Error('запрос должен был разобраться');
  expect(request.state).toBeUndefined();
  expect(denialUrl(request)).not.toContain('state');
});

test('resource и state доезжают до сервера обоими вызовами', async () => {
  const search = `${SEARCH}&resource=https%3A%2F%2Forbis.example.com%2Fmcp`;
  const { calls } = renderWithProviders(
    <ConsentScreen search={search} navigate={vi.fn()} />,
    HANDLER,
  );
  await screen.findByText(/Claude Code/);
  expect(calls.find((c) => c.path === 'oauth.describeRequest')?.input).toEqual({
    clientId: 'abc',
    redirectUri: 'http://localhost:8080/callback',
    resource: 'https://orbis.example.com/mcp',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить' }));
  await waitFor(() => expect(calls.some((c) => c.path === 'oauth.consent')).toBe(true));
  expect(calls.find((c) => c.path === 'oauth.consent')?.input).toEqual({
    clientId: 'abc',
    redirectUri: 'http://localhost:8080/callback',
    codeChallenge: 'x'.repeat(43),
    codeChallengeMethod: 'S256',
    state: 'st-1',
    resource: 'https://orbis.example.com/mcp',
  });
});

// Пока код выдаётся, кнопка обязана быть заблокирована: второй клик выписал бы второй
// одноразовый код на тот же запрос — лишняя строка в таблице и лишний живой код.
// `isPending` поднимается НЕ синхронно с кликом (react-query дотягивается до состояния
// через микрозадачу), поэтому ждём: от двойного клика в один тик кнопка не защищает,
// от человеческого повтора — защищает.
test('«Разрешить» блокируется на время выдачи — второго кода не заказать', async () => {
  const { calls } = renderWithProviders(
    <ConsentScreen search={SEARCH} navigate={vi.fn()} />,
    (path) => (path === 'oauth.consent' ? new Promise(() => {}) : HANDLER(path)),
  );
  await screen.findByText(/Claude Code/);
  const allow = screen.getByRole('button', { name: 'Разрешить' });
  fireEvent.click(allow);
  await waitFor(() => expect(allow).toBeDisabled());
  fireEvent.click(allow);
  expect(calls.filter((c) => c.path === 'oauth.consent')).toHaveLength(1);
});

// Проглоченный отказ выдачи кода — молча мёртвая кнопка: владелец жмёт «Разрешить»,
// ничего не происходит, и причины не видно ни ему, ни агенту.
test('отказ сервера на «Разрешить» виден, а не проглатывается', async () => {
  const navigate = vi.fn();
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={navigate} />, (path) => {
    if (path === 'oauth.consent') throw trpcError('BAD_REQUEST', 'клиент не зарегистрирован');
    return HANDLER(path);
  });
  await screen.findByText(/Claude Code/);
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить' }));
  expect(await screen.findByText(/клиент не зарегистрирован/)).toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
});

test('отказ сервера до кнопки показывает причину вместо согласия', async () => {
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={vi.fn()} />, (path) => {
    if (path === 'oauth.describeRequest') {
      throw trpcError('BAD_REQUEST', 'redirect_uri не зарегистрирован этим клиентом');
    }
    return HANDLER(path);
  });
  expect(await screen.findByText(/redirect_uri не зарегистрирован/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Разрешить' })).toBeNull();
});
