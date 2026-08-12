// apps/server/src/oauth/metadata.ts
// Метаданные, по которым MCP-клиент находит вход (спека MCP 2025-06-18):
// RFC 9728 для ресурса и RFC 8414 для authorization server. Оба документа —
// публичные и неаутентифицированные по построению: это точка входа ДО всякого токена.
import { OAUTH_AUTHORIZE_PATH } from '@orbis/shared';
import type { Context, Hono } from 'hono';

/** Подмножество env, которое читает резолвер базы; в тестах инжектится литералом. */
export interface PublicOriginEnv {
  ORBIS_PUBLIC_URL?: string;
  NODE_ENV?: string;
}

/**
 * Настроенная публичная база или null, если переменной нет и это разрешено (вне
 * production). Единственное место, где живут оба условия отказа: и стартовый гейт,
 * и запросный путь спрашивают именно его — иначе о конфигурации завелись бы две правды,
 * расходящиеся ровно тогда, когда одну из них поправят.
 */
function configuredOrigin(env: PublicOriginEnv): string | null {
  const configured = env.ORBIS_PUBLIC_URL?.trim();
  if (configured) return parsePublicOrigin(configured);
  if (env.NODE_ENV === 'production') {
    // Сообщение читают на упавшем деплое, а не в отладчике: одного имени переменной мало,
    // нужен и пример значения, и куда смотреть (манера makeLLMProvider и makeDb).
    throw new Error(
      'ORBIS_PUBLIC_URL обязателен в production (метаданные OAuth): задайте публичный ' +
        'адрес сервиса, например https://orbis-64q4.onrender.com (см. apps/server/.env.example)',
    );
  }
  return null;
}

/**
 * Стартовый гейт конфигурации (index.ts), в манере D28: неоднозначная или заведомо
 * кривая конфигурация роняет ПРОЦЕСС, а не отдельный запрос.
 *
 * Появился по ревью Task 3. С тех пор как 401 на /mcp несёт resource_metadata, бросок
 * `publicOrigin` случается НА ПУТИ ОТКАЗА — и /mcp начинал отвечать 500 вместо 401.
 * Причём не только в production: кривое значение (путь, query, не-http) бракуется при
 * любом NODE_ENV, поэтому опечатка вроде `https://host/mcp` ломала дверь и на локальном
 * стенде. Мягкий откат тут не годится — он вернул бы ровно тот бесполезный 401 без
 * указателя, ради устранения которого затевался слайс. Поэтому: сервер с кривым
 * значением не поднимается, и 500 из-за конфигурации становится недостижим.
 */
export function assertPublicOriginConfigured(env: PublicOriginEnv = process.env): void {
  configuredOrigin(env);
}

/**
 * База всех абсолютных URL. В production берётся ТОЛЬКО из ORBIS_PUBLIC_URL:
 * подменённый заголовок Host увёл бы клиента на чужой authorization server прямо
 * через наши же метаданные. На локальном стенде переменной нет — там база берётся
 * из запроса, и это безопасно: ни владельца, ни данных там нет.
 *
 * Бросить здесь боевой процесс уже не может: стартовый гейт выше не дал бы ему
 * подняться с такой конфигурацией. Проверка остаётся на месте, потому что функция
 * вызывается и в тестах, и из встроенных стендов, минующих index.ts.
 */
export function publicOrigin(c: Context): string {
  return configuredOrigin(process.env) ?? new URL(c.req.url).origin;
}

/**
 * Разбор ORBIS_PUBLIC_URL: наружу выходит только чистый http(s)-origin, всё прочее —
 * отказ. Раньше значение подставлялось как есть, и кривое проезжало молча — это хуже
 * отказа. Худший случай — значение с путём (`https://host/base`): адрес метаданных
 * получался `https://host/base/.well-known/oauth-protected-resource`, такого роута нет
 * ни одного, и запрос уезжал в SPA-fallback — клиент получал index.html с кодом 200 НА
 * ДОКУМЕНТЕ ОБНАРУЖЕНИЯ. Ровно та беззвучная поломка, ради которой пинится порядок
 * роутов, только заходящая через переменную окружения.
 *
 * Фолбэка на адрес запроса тут нет намеренно: кривая переменная обязана падать всюду
 * одинаково, иначе локально «всё работает», а в проде рвётся.
 */
function parsePublicOrigin(raw: string): string {
  // Хвостовой слэш прощаем: `https://host/` и `https://host` — одно и то же.
  const trimmed = raw.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `ORBIS_PUBLIC_URL не разбирается как URL: ${JSON.stringify(raw)} — нужен абсолютный ` +
        'адрес со схемой, например https://orbis.example.com',
    );
  }
  // Не-http(s) сюда доходить не должен: у нестандартных схем origin — строка "null",
  // и она молча уехала бы в метаданные.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `ORBIS_PUBLIC_URL должен быть http(s): ${JSON.stringify(raw)} (схема ${url.protocol})`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `ORBIS_PUBLIC_URL должен быть чистым origin, без пути, query и фрагмента: ${JSON.stringify(raw)}`,
    );
  }
  return url.origin;
}

/** Канонический URI ресурса (RFC 8707 §2): без хвостового слэша и без фрагмента. */
export function canonicalResource(c: Context): string {
  return resourceOf(publicOrigin(c));
}

/** Путь ресурса живёт в одной строке: и метаданные, и обе проверки берут его отсюда. */
function resourceOf(origin: string): string {
  return `${origin}/mcp`;
}

/**
 * Канонический ресурс ВНЕ Hono-контекста — для tRPC-роутера согласия (routers/oauth.ts),
 * у процедуры которого нет `c`. Своё чтение ORBIS_PUBLIC_URL там завело бы вторую правду
 * об одном и том же ресурсе, поэтому правда остаётся здесь, а наружу выходит функция без
 * контекста.
 *
 * null означает ровно одно: публичная база не настроена. Фолбэка на адрес запроса тут
 * нет — брать его неоткуда, и подставлять сюда хост из запроса нельзя по тем же причинам,
 * по которым он не годится для метаданных. Следствие названо честно: на локальном стенде
 * без ORBIS_PUBLIC_URL сверять присланный `resource` не с чем, и проверка пропускается.
 * В production такой ветки не бывает — без переменной процесс не поднимается
 * (assertPublicOriginConfigured), поэтому пропуск ограничен стендом, где нет ни владельца,
 * ни данных.
 */
export function configuredCanonicalResource(env: PublicOriginEnv = process.env): string | null {
  const origin = configuredOrigin(env);
  return origin === null ? null : resourceOf(origin);
}

/**
 * Сверка присланного клиентом `resource` с нашим каноническим (RFC 8707 §2): хвостовой
 * слэш — тот же ресурс. Правило одно на оба места, где resource проверяется (/oauth/token
 * и экран согласия): разъехавшись, они дали бы клиенту зелёный свет на одном шаге входа
 * и отказ на другом.
 */
export function isOurResource(resource: string, canonical: string): boolean {
  return resource.replace(/\/+$/, '') === canonical;
}

/**
 * Адрес, который /mcp кладёт в `WWW-Authenticate: Bearer resource_metadata=…` (RFC 9728
 * §5.1). Форма — path-aware: по §3.1 адрес метаданных ресурса с путём получается вставкой
 * `/.well-known/oauth-protected-resource` МЕЖДУ хостом и путём, то есть из нашего
 * `<origin>/mcp` клиент сам вывел бы `<origin>/.well-known/oauth-protected-resource/mcp`.
 * Указывать иную форму, чем клиент вычислил бы сам, значит без нужды разводить две
 * правды об одном документе; корневой адрес остаётся смонтированным как совместимость
 * с клиентами, которые пробуют только его.
 */
export function protectedResourceMetadataUrl(c: Context): string {
  return `${publicOrigin(c)}/.well-known/oauth-protected-resource/mcp`;
}

export function mountOAuthMetadata(app: Hono): void {
  const resource = (c: Context) =>
    c.json({
      resource: canonicalResource(c),
      authorization_servers: [publicOrigin(c)],
      bearer_methods_supported: ['header'],
      resource_name: 'Orbis',
    });

  app.get('/.well-known/oauth-protected-resource', resource);
  // RFC 9728 §3.1 разрешает вставлять путь ресурса в адрес метаданных; клиенты
  // пробуют оба варианта, поэтому отдаём и path-aware форму.
  app.get('/.well-known/oauth-protected-resource/mcp', resource);

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = publicOrigin(c);
    return c.json({
      issuer: origin,
      // Путь — из shared, а не литералом: серверного роута под ним нет по построению
      // (GET доходит до SPA-fallback), и распознаёт его СПА — apps/web/src/main.tsx.
      // Пока строка была записана в двух местах, согласованное переименование здесь
      // вместе с этим тестом оставляло SPA со старой копией, и владелец по ссылке из
      // метаданных видел обычное приложение вместо экрана согласия.
      authorization_endpoint: `${origin}${OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // plain намеренно не поддержан: RFC его допускает, мы — нет
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['full'],
    });
  });
}
