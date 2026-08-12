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

export function parseAuthorizeRequest(search: string): AuthorizeRequest | null {
  const p = new URLSearchParams(search);
  const clientId = p.get('client_id');
  const redirectUri = p.get('redirect_uri');
  const codeChallenge = p.get('code_challenge');
  // plain не поддержан сервером — отсекаем здесь, чтобы не гонять владельца зря.
  // Пропущенный метод — тоже отказ, а не «на усмотрение»: по RFC 7636 §4.3 умолчание
  // равно plain, то есть клиент без этого параметра просит ровно неподдержанный режим.
  const method = p.get('code_challenge_method');
  if (!clientId || !redirectUri || !codeChallenge || method !== 'S256') return null;
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
