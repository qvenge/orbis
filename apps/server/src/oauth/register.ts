// apps/server/src/oauth/register.ts
// Динамическая регистрация клиентов (RFC 7591). Эндпоинт публичный по построению —
// именно он избавляет владельца от ручного client_id. Регистрация сама по себе не даёт
// ничего: без согласия владельца на /oauth/authorize клиент не получит ни кода, ни
// токена. Единственный реальный риск — засорение таблицы, поэтому стоит суточный потолок.
import { randomBytes } from 'node:crypto';
import { count, gte } from 'drizzle-orm';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/client';
import { oauthClients } from '../db/schema';

/** Потолок регистраций в сутки на весь сервис: у одного владельца агентов единицы. */
export const MAX_REGISTRATIONS_PER_DAY = 50;

/**
 * Потолок тела. До него это был единственный публичный POST без лимита (/trpc/* — 4 МиБ,
 * /mcp — 1 МБ), причём с НЕАУТЕНТИФИЦИРОВАННЫМ отправителем: тело на 20 млн символов
 * принималось и разбиралось целиком. Суточный потолок в 50 строк этого не закрывал —
 * 50 записей по десятку мегабайт складываются в гигабайты.
 *
 * 16 КиБ выбраны от законной заявки: `{client_name, redirect_uris}` — это 81 байт, а с
 * необязательными полями Claude Code — 269 (замерено). Запас оставлен под поля RFC 7591
 * (`logo_uri`, `client_uri`, `jwks`, `software_statement` — последний JWT в пару КБ),
 * которые мы игнорируем, но которыми строгий клиент вправе представиться. Худший случай
 * принятых тел за сутки — 16 КиБ × 50 = 800 КиБ.
 */
export const REGISTER_MAX_BODY_BYTES = 16 * 1024;

/**
 * Гейт размера тела в манере /mcp: считает по ФАКТИЧЕСКИ прочитанным байтам, поэтому
 * режет и chunked-тело без content-length. Форма отказа — спецификационная
 * { error, error_description } (это OAuth-поверхность), а НЕ структурная { error: { code } }
 * из /mcp и tRPC. Инстанс модульного уровня переиспользуется между запросами.
 */
const registerBodyLimit = bodyLimit({
  maxSize: REGISTER_MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      {
        error: 'invalid_client_metadata',
        error_description: `тело запроса превышает лимит ${REGISTER_MAX_BODY_BYTES} байт`,
      },
      413,
    ),
});

/** Подпись клиента, когда он не назвался: пустая строка на экране согласия хуже. */
const DEFAULT_CLIENT_NAME = 'внешний агент';

/**
 * Хосты локальной петли. Обе формы — из RFC 8252 §7.3: там приведены и
 * `http://127.0.0.1:{port}/{path}`, и `http://[::1]:{port}/{path}`, а клиенту прямо
 * рекомендовано пробовать оба стека и брать доступный. Без `[::1]` клиент, поступающий
 * ровно по спеке, у нас бы не зарегистрировался. Скобки — часть `hostname` в разборе URL,
 * и развёрнутая запись `[0:0:0:0:0:0:0:1]` нормализуется в ту же строку.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Пробелы и управляющие символы в ИСХОДНОЙ строке. Проверять приходится до разбора:
 * `new URL` вырезает TAB/CR/LF внутри и обрезает края, поэтому `http://loc\nalhost/cb`
 * проходит проверку хоста (host выходит `localhost`), а в таблицу ложится строка с
 * переводом строки. Последствие не теоретическое: `c.redirect()` с таким значением
 * бросает «Header 'Location' has invalid value» — 500 вместо возврата кода владельцу.
 *
 * Починить нормализацией (`parsed.href`) нельзя: обмен кода сверяет `redirect_uri`
 * ТОЧНОЙ строкой (grants.ts), и нормализация развела бы зарегистрированный адрес с
 * предъявленным. Значит — отказ.
 */
function hasUnsafeChars(uri: string): boolean {
  for (const ch of uri) {
    const code = ch.codePointAt(0) ?? 0;
    // C0-управляющие, пробел и DEL
    if (code <= 0x20 || code === 0x7f) return true;
  }
  // Прочие пробельные (U+00A0, U+2028, U+FEFF …): в исходнике их не видно, а URL
  // percent-кодирует их только в пути — в таблицу опять уедет мусор.
  return /\s/u.test(uri);
}

/**
 * Куда разрешено возвращать код. Локальная петля — это Claude Code и родня
 * (они слушают http://localhost:PORT/callback), https — размещённые клиенты.
 * Всё остальное — способ увести код на чужой хост.
 *
 * Сверка идёт по РАЗОБРАННОМУ hostname, а не по подстроке: `http://localhost.evil.com/cb`
 * и `http://evil.com/localhost` содержат «localhost», но петлёй не являются.
 */
function isAllowedRedirect(uri: string): boolean {
  if (hasUnsafeChars(uri)) return false;
  // Фрагмент запрещён RFC 6749 §3.1.2 («MUST NOT include a fragment component») — и это
  // ЕДИНСТВЕННОЕ основание запрета, соответствие спеке.
  //
  // Прежнее обоснование («склейка `${uri}?code=…` уводит код во фрагмент») было верным
  // ровно до Task 7: адрес возврата давно строится разбором и `.href` (routers/oauth.ts),
  // и фрагмент ему не мешает. Проверено пробой: `http://localhost:8080/cb#frag` даёт
  // `http://localhost:8080/cb?code=…#frag` — код лежит в query и до клиента доезжает.
  // Ложное обоснование в безопасностном комментарии дороже обычного: оно и переживает
  // правку, которая его отменила, и защищает от того, чего уже нет.
  //
  // По СТРОКЕ, а не по `parsed.hash`: у `…/cb#` hash пуст, но фрагментный компонент в
  // адресе присутствует — спека запрещает именно его, а не непустое содержимое.
  if (uri.includes('#')) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  // Учётные данные в URL аллоулист хоста НЕ обходят (`https://claude.ai@evil.com/cb` имеет
  // hostname evil.com), но обманывают человека на экране согласия — а вся защита слайса
  // держится на нём. `client_name` полностью подконтролен тому, кто регистрируется:
  // назваться «Claude Code» может кто угодно, и `redirect_uri` остаётся единственным,
  // по чему владелец отличает своего агента от чужого. Вводить его в заблуждение нельзя.
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
}

export function makeRegisterHandler(deps: { db: Db }) {
  return async (c: Context): Promise<Response> => {
    // Size-гейт ПЕРВЫМ делом — до чтения и разбора тела. Middleware зовётся вручную с
    // no-op next (манера /mcp): так потолок принадлежит самому модулю, и его нельзя
    // потерять, смонтировав хендлер без обёртки.
    const tooLarge = await registerBodyLimit(c, async () => {});
    if (tooLarge instanceof Response) return tooLarge;

    // Тело формирует неаутентифицированный клиент, то есть кто угодно: битый JSON обязан
    // давать отказ по спеке, а не 500 с трейсом. Не-объект (`null`, `[]`) проваливается
    // в ту же ветку — у него нет ни одного нужного поля.
    const body = (await c.req.json().catch(() => null)) as {
      client_name?: unknown;
      redirect_uris?: unknown;
    } | null;
    // Не-строка в списке — такой же негодный элемент, как негодный адрес: прежний
    // `filter` молча усекал список (`[адрес, 42]` давал 201 с одним адресом), что прямо
    // противоречило принципу строкой ниже. Любой негодный элемент — отказ целиком.
    const declared = body?.redirect_uris;
    const uris =
      Array.isArray(declared) && declared.every((u): u is string => typeof u === 'string')
        ? declared
        : [];
    const name =
      typeof body?.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim()
        : DEFAULT_CLIENT_NAME;

    if (uris.length === 0) {
      return c.json(
        {
          error: 'invalid_client_metadata',
          // Сообщение читает разработчик чужого агента, и оно — его единственный канал
          // отладки: «обязателен» не объяснило бы отказ на `[адрес, 42]`, где поле есть.
          error_description: 'redirect_uris обязателен: непустой список строк',
        },
        400,
      );
    }
    // Один негодный адрес в списке — отказ целиком: иначе клиент считал бы себя
    // зарегистрированным с адресом, которого мы у него не приняли.
    if (!uris.every(isAllowedRedirect)) {
      return c.json(
        {
          error: 'invalid_redirect_uri',
          // За этим отказом стоят ЧЕТЫРЕ разных правила, и одно «разрешены https и петля»
          // отправило бы разработчика с фрагментом в адресе проверять схему и хост, где
          // всё в порядке. Перечисление — самый дешёвый способ не молчать о причине;
          // отдельный код на каждое правило спека не предусматривает.
          error_description:
            'разрешены только https и локальная петля (localhost, 127.0.0.1, [::1]), ' +
            'без фрагмента, пробелов, управляющих символов и учётных данных в URL',
        },
        400,
      );
    }

    // Потолок считается по ВРЕМЕНИ СОЗДАНИЯ строк, а не по их общему числу: израсходованная
    // сутки назад квота обязана возвращаться сама, без ручной чистки таблицы. Считается он
    // на весь сервис: у одного владельца агентов единицы, а различать клиентов за прокси
    // Render нечем — заголовку с адресом снаружи веры нет.
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const rows = await deps.db
      .select({ value: count() })
      .from(oauthClients)
      .where(gte(oauthClients.createdAt, since));
    // Явная развилка вместо деструктуризации: при noUncheckedIndexedAccess `rows[0]` — это
    // `T | undefined`, а пустой ответ у агрегата и так означает ноль строк.
    const recent = rows[0]?.value ?? 0;
    if (recent >= MAX_REGISTRATIONS_PER_DAY) {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'слишком много регистраций' },
        429,
      );
    }

    const clientId = randomBytes(16).toString('hex');
    await deps.db.insert(oauthClients).values({ clientId, clientName: name, redirectUris: uris });
    return c.json(
      {
        client_id: clientId,
        client_name: name,
        redirect_uris: uris,
        // Публичный клиент: секрета нет, защита обмена — на PKCE
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  };
}
