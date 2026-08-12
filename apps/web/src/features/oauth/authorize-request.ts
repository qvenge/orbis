// Разбор параметров /oauth/authorize. Половинчатого запроса не бывает: не хватает
// любого обязательного поля — считаем запрос негодным целиком и не показываем кнопку.
// Проверка здесь — вежливость к пользователю, а не защита: настоящая проверка
// (клиент, redirect_uri, ресурс) делается на сервере в oauth.describeRequest.
//
// Кроме PKCE: его параметров describeRequest НЕ ВИДИТ (в его входе только clientId,
// redirectUri и resource), поэтому запрос с `plain` или вовсе без челленджа прошёл бы
// серверную проверку и отвалился уже ПОСЛЕ нажатия «Разрешить» — на выдаче кода.
// Ради этого разбор и вынесен вперёд кнопки.
export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string | undefined;
  resource: string | undefined;
}

/**
 * Разбирается ли адрес возврата и есть ли у него хост. Это НЕ вторая правда о границах
 * (какие схемы и хосты допустимы, решают регистрация и `describeRequest`), а ровно то
 * предусловие, на которое опираются оба потребителя разобранного адреса: `denialUrl`
 * строит ответ разбором, а экран показывает хост отдельной строкой. Без проверки
 * относительный `redirect_uri=/cb` прошёл бы клиентский разбор, а серверная схема
 * (`z.string().url()`) свалила бы его — и весь экран стал бы сырым JSON'ом zod-ошибки.
 *
 * Пустой хост проверяется отдельно и не для красоты: `new URL('localhost:1/cb')` НЕ
 * бросает — `localhost:` разбирается как схема, путь становится `1/cb`, а `host` выходит
 * пустым (проверено пробой, тест на этот случай есть). Такой адрес доехал бы до экрана
 * пустой строкой хоста — то есть без единственного признака, по которому владелец и
 * отличает настоящего агента от самозванца.
 *
 * Проверка заодно ЗАМЕНЯЕТ отдельное `!redirectUri` в гварде ниже, а не дополняет его:
 * ни отсутствующий параметр, ни пустая строка `new URL` не переживают, и вторым условием
 * то же самое требование стало бы нерушимой мутацией — строкой, снятие которой ничего не
 * меняет. Отсюда и предикат типа: без него `redirectUri` остался бы `string | null`.
 */
function isUsableRedirect(uri: string | null): uri is string {
  if (uri === null) return false;
  try {
    return new URL(uri).host !== '';
  } catch {
    return false;
  }
}

export function parseAuthorizeRequest(search: string): AuthorizeRequest | null {
  const p = new URLSearchParams(search);
  const clientId = p.get('client_id');
  const redirectUri = p.get('redirect_uri');
  const codeChallenge = p.get('code_challenge');
  // plain не поддержан сервером — отсекаем здесь, чтобы не гонять владельца зря.
  // Пропущенный метод — тоже отказ, а не «на усмотрение»: по RFC 7636 §4.3 умолчание
  // равно plain, то есть клиент без этого параметра просит ровно неподдержанный режим.
  const method = p.get('code_challenge_method');
  if (!clientId || !codeChallenge || method !== 'S256') return null;
  if (!isUsableRedirect(redirectUri)) return null;
  if (p.get('response_type') !== null && p.get('response_type') !== 'code') return null;
  return {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: 'S256',
    // Именно `?? undefined`, а не `?? ''`: пустая строка — это значение, и она уехала бы
    // в адрес возврата как `state=`. Клиент, сверяющий state строкой, счёл бы такой ответ
    // ответом на чужой запрос. Тот же контракт у сервера (routers/oauth.ts: state кладётся
    // в адрес только при `!== undefined`).
    state: p.get('state') ?? undefined,
    resource: p.get('resource') ?? undefined,
  };
}

/**
 * Хост адреса возврата — то, по чему владелец отличает настоящего агента от самозванца:
 * имя клиента выбирает тот, кто регистрируется, а адрес подделать нельзя, код уйдёт ровно
 * туда. Берётся из РАЗОБРАННОГО адреса намеренно: `new URL` приводит хост к punycode, и
 * домен-омограф на экране виден как `xn--…`, а не как знакомое слово.
 *
 * Разбор здесь не бросает по построению: `parseAuthorizeRequest` уже отверг неразбираемое.
 */
export function redirectHost(request: AuthorizeRequest): string {
  return new URL(request.redirectUri).host;
}

/**
 * Отказ владельца — тоже ответ агенту (OAuth 2.1 §4.1.2.1), а не тупик.
 *
 * Адрес строится разбором и `.href`, никакой склейки `${redirectUri}?error=…`: у клиента
 * законно бывает свой query (RFC 6749 §3.1.2, например `…/auth_callback?tenant=acme`) —
 * склейка приклеила бы `error` значением к чужому параметру, и агент отказа не увидел бы.
 * Не-ASCII в адресе (`…/cb?next=привет`) `.href` заодно процентно кодирует: браузер уводит
 * по этому адресу, а на той стороне он попадает в заголовок Location.
 *
 * `new URL` здесь не бросает по построению: кнопка «Отклонить» рисуется только после
 * успешного describeRequest, а тот пропускает лишь адрес, который клиент зарегистрировал
 * — регистрация же разбирает его тем же `new URL` (oauth/register.ts).
 */
export function denialUrl(request: AuthorizeRequest): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set('error', 'access_denied');
  if (request.state !== undefined) url.searchParams.set('state', request.state);
  return url.href;
}
