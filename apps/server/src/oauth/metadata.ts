// apps/server/src/oauth/metadata.ts
// Метаданные, по которым MCP-клиент находит вход (спека MCP 2025-06-18):
// RFC 9728 для ресурса и RFC 8414 для authorization server. Оба документа —
// публичные и неаутентифицированные по построению: это точка входа ДО всякого токена.
import type { Context, Hono } from 'hono';

/**
 * База всех абсолютных URL. В production берётся ТОЛЬКО из ORBIS_PUBLIC_URL:
 * подменённый заголовок Host увёл бы клиента на чужой authorization server прямо
 * через наши же метаданные. На локальном стенде переменной нет — там база берётся
 * из запроса, и это безопасно: ни владельца, ни данных там нет.
 */
export function publicOrigin(c: Context): string {
  const configured = process.env.ORBIS_PUBLIC_URL?.trim();
  if (configured) return parsePublicOrigin(configured);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ORBIS_PUBLIC_URL обязателен в production (метаданные OAuth)');
  }
  return new URL(c.req.url).origin;
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
  return `${publicOrigin(c)}/mcp`;
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
      authorization_endpoint: `${origin}/oauth/authorize`,
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
