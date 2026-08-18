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
  // Пинится и действенный хвост: без «вернитесь в агента» сообщение говорит владельцу,
  // что всё плохо, но не говорит, что делать, — а сделать он может только это.
  expect(await screen.findByRole('alert')).toHaveTextContent(/запрос неполон.*вернитесь в агента/i);
  expect(screen.queryByRole('button', { name: 'Разрешить' })).toBeNull();
  // Негодный запрос не должен даже спрашивать сервер
  expect(calls).toHaveLength(0);
});

// Имя клиента подделывается в одну строку: /oauth/register публичен, `client_name` сервер
// только режет до 64 символов. Единственный признак, который подделать нельзя, — адрес
// возврата: код уйдёт ровно туда, и зарегистрирован он тем, кто прислал ссылку.
test('адрес возврата показан целиком и отдельно хостом', async () => {
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={vi.fn()} />, HANDLER);
  await screen.findByText(/Claude Code/);
  expect(screen.getByText('http://localhost:8080/callback')).toBeInTheDocument();
  expect(screen.getByText('localhost:8080')).toBeInTheDocument();
  expect(screen.getByText(/[Кк]од доступа уйдёт/)).toBeInTheDocument();
});

// Ради этого хост и берётся из РАЗОБРАННОГО адреса, а не подстрокой: `аррӏе.com` набран
// кириллицей и в сыром виде читается как `apple.com`, а `new URL().host` показывает его
// punycode-формой — подделка становится видна. Наивная подстрока (`split('/')[2]`) на
// фикстуре с `localhost:8080` неотличима от разбора, поэтому проверять надо здесь.
// Заодно пин второй половины: адрес целиком показывается ТОЙ строкой, что зарегистрировал
// клиент, а не нормализованным `href` (в нём домен тоже стал бы punycode, и владелец не
// увидел бы, что именно записано у клиента).
test('омографный хост показан в punycode, а адрес — сырой строкой клиента', async () => {
  const raw = 'http://аррӏе.com/cb';
  const search =
    `?client_id=abc&redirect_uri=${encodeURIComponent(raw)}` +
    `&code_challenge=${'x'.repeat(43)}&code_challenge_method=S256`;
  renderWithProviders(<ConsentScreen search={search} navigate={vi.fn()} />, HANDLER);
  await screen.findByText(/Claude Code/);
  expect(screen.getByText('xn--80ak6aa92e.com')).toBeInTheDocument();
  expect(screen.getByText(raw)).toBeInTheDocument();
  expect(screen.queryByText('http://xn--80ak6aa92e.com/cb')).toBeNull();
});

// Владелец решает по тому, что ему сказано: чей это агент и что именно он сможет делать.
test('экран называет агента заголовком и объясняет, что разрешается', async () => {
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={vi.fn()} />, HANDLER);
  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
    'Claude Code просит доступ к Orbis',
  );
  expect(screen.getByText(/читать и изменять ваши сущности/)).toBeInTheDocument();
  expect(screen.getByText(/потребуют подтверждения в чате/)).toBeInTheDocument();
  expect(screen.getByText(/отзывается/)).toBeInTheDocument();
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
test('каждый обязательный параметр запроса проверяется поодиночке', () => {
  const client = 'client_id=a';
  const redirect = 'redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb';
  const challenge = `code_challenge=${'x'.repeat(43)}`;
  const method = 'code_challenge_method=S256';
  const req = (...parts: string[]) => parseAuthorizeRequest(`?${parts.join('&')}`);

  expect(req(redirect, challenge, method)).toBeNull(); // без client_id
  expect(req(client, challenge, method)).toBeNull(); // без redirect_uri
  expect(req(client, redirect, method)).toBeNull(); // без code_challenge
  expect(req(client, redirect, challenge)).toBeNull(); // без code_challenge_method
  expect(req(client, redirect, challenge, method, 'response_type=token')).toBeNull();
  // Неразбираемый адрес возврата: относительный `/cb` клиентскую проверку прошёл бы,
  // а серверная схема (z.string().url()) валит его — и владелец видел бы сырой JSON zod
  // вместо экрана. Заодно это предусловие denialUrl, который строит ответ разбором.
  expect(req(client, 'redirect_uri=%2Fcb', challenge, method)).toBeNull();
  // `localhost:1/cb` НЕ бросает в new URL: `localhost:` — схема, `1/cb` — путь, хост пуст.
  // Такой адрес показал бы владельцу пустую строку вместо хоста (проверено пробой).
  expect(req(client, 'redirect_uri=localhost%3A1%2Fcb', challenge, method)).toBeNull();
  expect(req(client, 'redirect_uri=mailto%3Aa%40b.c', challenge, method)).toBeNull();

  // Разбор годного запроса — контрольная точка: иначе все проверки выше прошёл бы
  // и разбор, возвращающий null всегда.
  expect(req(client, redirect, challenge, method)).toEqual({
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
    // Область выбирается на этом же экране (Задача 8, §4.14) и едет тем же вызовом:
    // отдельного шага «сузить доступ» после выдачи кода нет и быть не может.
    scope: 'full',
  });
});

// Радио — единственное место, где владелец выбирает, СКОЛЬКО отдаёт. Умолчание — полный
// доступ: подключение агента общего назначения не должно молча ломаться сужением.
test('область по умолчанию — полный доступ', async () => {
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={vi.fn()} />, HANDLER);
  expect(await screen.findByRole('radio', { name: 'Полный доступ' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Только исполнитель (worker)' })).not.toBeChecked();
});

// Выбор обязан доехать до сервера: радио, не влияющее на вызов, — обещание сужения,
// которого в базе не будет, и владелец узнает об этом только по чужим действиям агента.
test('выбор исполнителя уезжает в согласие как scope=worker', async () => {
  const { calls } = renderWithProviders(
    <ConsentScreen search={SEARCH} navigate={vi.fn()} />,
    HANDLER,
  );
  fireEvent.click(await screen.findByRole('radio', { name: 'Только исполнитель (worker)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить' }));
  await waitFor(() => expect(calls.some((c) => c.path === 'oauth.consent')).toBe(true));
  expect(calls.find((c) => c.path === 'oauth.consent')?.input).toMatchObject({ scope: 'worker' });
});

// Что именно означает сужение — словами: «worker» само по себе владельцу ничего не
// говорит, а решение он принимает один раз и без возможности переспросить.
test('исполнитель объяснён словами, а не одним лишь термином', async () => {
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={vi.fn()} />, HANDLER);
  await screen.findByText(/Claude Code/);
  expect(screen.getByText(/пишет только через глаголы задач/)).toBeInTheDocument();
  // Не «закрыть не может»: may_close владелец выставляет в назначении, и с ним orbis_finish
  // тикет закрывает (С8). Экран согласия — единственное место, где владелец читает, что
  // означает область, и обещать здесь больше, чем делает сервер, нельзя.
  expect(
    screen.getByText(/закрывает тикет только с явного разрешения владельца \(may_close\)/),
  ).toBeInTheDocument();
});

// Пока код выдаётся, обе кнопки обязаны быть заблокированы: повтор «Разрешить» выписал бы
// второй одноразовый код, а «Отклонить» уведёт владельца с access_denied уже ПОСЛЕ выдачи —
// строка гранта с живым кодом останется, и в «Агентах» он увидит агента, которого считает
// отклонённым. `isPending` поднимается НЕ синхронно с кликом (react-query дотягивается до
// состояния через микрозадачу), поэтому ждём: от двойного клика в один тик это не защищает,
// от человеческого повтора — защищает.
test('на время выдачи гаснут обе кнопки — ни второго кода, ни отказа поверх выдачи', async () => {
  const navigate = vi.fn();
  const { calls } = renderWithProviders(
    <ConsentScreen search={SEARCH} navigate={navigate} />,
    (path) => (path === 'oauth.consent' ? new Promise(() => {}) : HANDLER(path)),
  );
  await screen.findByText(/Claude Code/);
  const allow = screen.getByRole('button', { name: 'Разрешить' });
  const deny = screen.getByRole('button', { name: 'Отклонить' });
  fireEvent.click(allow);
  await waitFor(() => expect(allow).toBeDisabled());
  expect(deny).toBeDisabled();
  fireEvent.click(allow);
  fireEvent.click(deny);
  expect(calls.filter((c) => c.path === 'oauth.consent')).toHaveLength(1);
  expect(navigate).not.toHaveBeenCalled();
});

// Успех мутации кнопки НЕ отпускает: браузер в этот момент только начинает уходить,
// и клик по «Отклонить» в это окно отправил бы access_denied по уже выданному коду.
test('после выдачи кода «Отклонить» уже ничего не отменяет', async () => {
  const navigate = vi.fn();
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={navigate} />, HANDLER);
  await screen.findByText(/Claude Code/);
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  const deny = screen.getByRole('button', { name: 'Отклонить' });
  expect(deny).toBeDisabled();
  fireEvent.click(deny);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate.mock.calls[0]?.[0]).not.toContain('access_denied');
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
  // role="alert" — конвенция проекта для отказов: экран согласия появляется ПОДМЕНОЙ
  // содержимого, и без роли скринридер о нём просто молчит.
  expect(await screen.findByRole('alert')).toHaveTextContent(/клиент не зарегистрирован/);
  expect(navigate).not.toHaveBeenCalled();
});

test('отказ сервера до кнопки показывает причину вместо согласия', async () => {
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={vi.fn()} />, (path) => {
    if (path === 'oauth.describeRequest') {
      throw trpcError('BAD_REQUEST', 'redirect_uri не зарегистрирован этим клиентом');
    }
    return HANDLER(path);
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(/redirect_uri не зарегистрирован/);
  expect(screen.queryByRole('button', { name: 'Разрешить' })).toBeNull();
});
