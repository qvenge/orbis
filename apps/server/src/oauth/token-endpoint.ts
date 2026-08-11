// apps/server/src/oauth/token-endpoint.ts
// POST /oauth/token — единственная точка, где код и refresh превращаются в доступ.
// Тело — application/x-www-form-urlencoded (OAuth 2.1 §4.1.3), ответ — no-store:
// токены не должны осесть ни в одном кэше по пути.
//
// АВТОМАТИЧЕСКИХ ПОВТОРОВ ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. Модуль грантов трактует повторное
// предъявление кода и уже ротированного refresh как перехват (OAuth 2.1 §7.5) и гасит
// грант ЦЕЛИКОМ. Следствие неприятное, но неизбежное: потерянный по дороге ответ и
// обычный ретрай клиента для нас неотличимы от атаки. Значит любой повтор — наш ли
// внутри хендлера, клиентский ли снаружи — стоит владельцу всего доступа агента.
// Внутренний ретрай был бы худшей его формой: он сжигал бы грант молча, ещё до того, как
// клиент узнал об ошибке.
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Db } from '../db/client';
import { OAuthError } from './errors';
import { exchangeAuthorizationCode, rotateRefresh } from './grants';
import { canonicalResource, isOurResource } from './metadata';

/**
 * Потолок тела. Эндпоинт публичный и неаутентифицированный — ровно как /oauth/register
 * (16 КиБ), и оставлять его без потолка нельзя: тело разбирается целиком, а позвать его
 * может кто угодно.
 *
 * 4 КиБ выбраны от ЗАМЕРА законного тела (проба): обмен кода — 402 байта, он же с
 * размещённым клиентом и длинным `redirect_uri` — 473, ротация refresh — 208. Все поля
 * здесь короткие и по большей части наши собственные: `code` — 73 символа, `client_id` —
 * 32, `code_verifier` ограничен 128 (RFC 7636 §4.1), `resource` — наш же канонический URI.
 * Единственное поле без потолка — `redirect_uri`, и запас оставлен под него: 4 КиБ дают
 * ему больше трёх килобайт, тогда как практический предел адреса, по которому браузер
 * возвращает код, — около двух. Потолок регистрации выше нашего намеренно: там законно
 * приезжает `software_statement` (JWT в пару КБ), здесь такого поля нет.
 */
export const TOKEN_MAX_BODY_BYTES = 4 * 1024;

/**
 * Гейт размера тела в манере /mcp и /oauth/register: считает по ФАКТИЧЕСКИ прочитанным
 * байтам, поэтому режет и chunked-тело без content-length. Форма отказа —
 * спецификационная { error, error_description }, а НЕ структурная { error: { code } }
 * из /mcp и tRPC. Инстанс модульного уровня переиспользуется между запросами.
 */
const tokenBodyLimit = bodyLimit({
  maxSize: TOKEN_MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      {
        error: 'invalid_request',
        error_description: `тело запроса превышает лимит ${TOKEN_MAX_BODY_BYTES} байт`,
      },
      413,
    ),
});

const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/**
 * Разбор тела руками, а НЕ через `c.req.parseBody()`. Причина — живая проба Hono 4.12.27,
 * а не вкус:
 *
 *  • `parseBody()` зовёт `request.formData()` и на битом multipart БРОСАЕТ TypeError
 *    («FormData parse error missing final boundary», «incorrect MIME type/boundary»).
 *    В хендлере этот бросок попал бы в общий catch и стал бы 500 с записью в серверный
 *    лог — то есть кто угодно, без единого токена, дёргал бы нам пятисотки двумя
 *    строками тела. Отказ по спеке обязан быть отказом, а не сбоем (та же гигиена, что
 *    у /oauth/register с битым JSON).
 *  • `parseBody()` сверяет медиатип через case-sensitive `startsWith`, а медиатип
 *    регистронезависим (RFC 9110 §8.3): `APPLICATION/X-WWW-FORM-URLENCODED` давал бы
 *    ПУСТУЮ форму и невнятный отказ клиенту, поступающему строго по спеке.
 *  • `parseBody()` принимает и `multipart/form-data`, которого OAuth 2.1 §4.1.3 на этом
 *    эндпоинте не разрешает вовсе, а заодно тянет соглашения Hono про ключи с `[]` —
 *    к параметрам OAuth они отношения не имеют.
 *
 * `URLSearchParams` ничего из этого не делает: не бросает никогда (битый percent-encoding
 * даёт U+FFFD, а не исключение — проверено), и берёт ПЕРВОЕ вхождение повторённого
 * параметра. Повтор спекой запрещён (OAuth 2.1 §1.5); из двух исходов «первое» — тот, при
 * котором дописанное в хвост значение не переопределяет уже собранный клиентом запрос.
 */
function readForm(contentType: string, text: string): URLSearchParams {
  // Медиатип — часть до ';', без учёта регистра и краевых пробелов.
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== FORM_MEDIA_TYPE) {
    throw new OAuthError(
      'invalid_request',
      `тело запроса должно быть ${FORM_MEDIA_TYPE} (OAuth 2.1 §4.1.3)`,
    );
  }
  return new URLSearchParams(text);
}

export function makeTokenHandler(deps: { db: Db }) {
  return async (c: Context): Promise<Response> => {
    // no-store выставляется ПЕРВЫМ делом, до всякой развилки: свойство принадлежит
    // эндпоинту, а не одной удачной ветке — заголовок обязан быть и на 413 от гейта ниже,
    // и на любом отказе. Хвостовое `c.json(..., { 'Cache-Control': ... })` пришлось бы
    // повторять в каждом return, и первый же новый выход остался бы без него.
    c.header('Cache-Control', 'no-store');

    // Size-гейт ПЕРЕД чтением тела. Middleware зовётся вручную с no-op next (манера /mcp
    // и /oauth/register): так потолок принадлежит самому модулю, и его нельзя потерять,
    // смонтировав хендлер без обёртки.
    const tooLarge = await tokenBodyLimit(c, async () => {});
    if (tooLarge instanceof Response) return tooLarge;

    try {
      const form = readForm(c.req.header('content-type') ?? '', await c.req.text());
      const field = (k: string): string => form.get(k) ?? '';

      // RFC 8707: клиент обязан назвать ресурс, для которого просит токен. Пустое
      // значение терпим (не все клиенты его шлют), чужое — нет: токен, выписанный
      // «для другого сервера», у нас не действует по определению. Сверка идёт с
      // canonicalResource — тем же, что стоит в метаданных; своё чтение
      // ORBIS_PUBLIC_URL завело бы вторую правду об одном и том же ресурсе.
      const resource = field('resource');
      if (resource && !isOurResource(resource, canonicalResource(c))) {
        throw new OAuthError('invalid_target', 'токен запрошен для другого ресурса');
      }

      // Порядок проверок: сначала «что просят», потом «кто просит». Обратный порядок
      // отвечал бы `invalid_client` на запрос вида `grant_type=password` без client_id —
      // то есть указывал бы разработчику чужого агента не на ту половину его ошибки.
      const grantType = field('grant_type');
      if (!grantType) throw new OAuthError('invalid_request', 'grant_type обязателен');
      if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
        throw new OAuthError('unsupported_grant_type', `grant_type «${grantType}» не поддержан`);
      }

      // Клиенты у нас публичные (`token_endpoint_auth_method: 'none'`), секрета нет, и
      // аутентификации клиента на этом эндпоинте не происходит вовсе — защита обмена
      // держится на PKCE. Поэтому отсутствующий client_id отдаётся кодом 400, а не 401:
      // 401 обязывает выслать WWW-Authenticate (RFC 9110 §15.5.2), а схемы, которую там
      // назвать, у нас нет; MUST на 401 из RFC 6749 §5.2 касается только клиента,
      // попытавшегося аутентифицироваться заголовком Authorization, — наш не пытается.
      const clientId = field('client_id');
      if (!clientId) throw new OAuthError('invalid_client', 'client_id обязателен');

      const pair =
        grantType === 'authorization_code'
          ? await exchangeAuthorizationCode(deps.db, {
              code: field('code'),
              codeVerifier: field('code_verifier'),
              redirectUri: field('redirect_uri'),
              clientId,
            })
          : await rotateRefresh(deps.db, { refreshToken: field('refresh_token'), clientId });

      return c.json({
        access_token: pair.accessToken,
        token_type: 'Bearer',
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        // Единственная область, объявленная в метаданных (`scopes_supported: ['full']`).
        scope: 'full',
      });
    } catch (e) {
      if (e instanceof OAuthError) {
        return c.json(e.toResponseBody(), e.status as ContentfulStatusCode);
      }
      // Инфраструктурный сбой наружу не течёт: клиенту — обезличенная ошибка,
      // оригинал — в серверный лог (та же гигиена, что у /mcp).
      console.error('[oauth] сбой обмена токена:', e);
      return c.json({ error: 'server_error', error_description: 'внутренняя ошибка сервера' }, 500);
    }
  };
}
