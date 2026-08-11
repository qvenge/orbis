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
  if (configured) return configured.replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ORBIS_PUBLIC_URL обязателен в production (метаданные OAuth)');
  }
  return new URL(c.req.url).origin;
}

/** Канонический URI ресурса (RFC 8707 §2): без хвостового слэша и без фрагмента. */
export function canonicalResource(c: Context): string {
  return `${publicOrigin(c)}/mcp`;
}

export function protectedResourceMetadataUrl(c: Context): string {
  return `${publicOrigin(c)}/.well-known/oauth-protected-resource`;
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
