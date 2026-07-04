// apps/server/src/mcp/transport.ts
// HTTP-клей /mcp (§9.3, решение 2 плана 1b): Streamable HTTP в том же Hono-приложении.
// Транспорт — WebStandardStreamableHTTPServerTransport из SDK: fetch-native (Request →
// Response), работает в Bun/Hono БЕЗ моста node:http. Stateless-режим: транспорт
// одноразовый по контракту SDK («Stateless transport cannot be reused across requests»),
// поэтому Server+transport создаются на КАЖДЫЙ запрос — каждый запрос самодостаточен
// (PAT → владелец → реестр per-request), сессий и push-канала нет (§9.3: polling).
// enableJsonResponse: простой запрос-ответ без SSE-стрима — ответ хендлера собирается
// целиком до Response, пост-обработка/close не нужны (объекты одноразовые, дальше GC).
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import { PAT_PREFIX, verifyPat } from '../pat';
import { type McpDeps, makeMcpServer } from './server';

/**
 * Лимит тела /mcp (Task 10b): 1 МБ — JSON-RPC вызова тула на порядки меньше.
 * Экспортируется для теста (mcp.test.ts).
 */
export const MCP_MAX_BODY_BYTES = 1_000_000;

/** Hono-хендлер /mcp; deps (db, резолвер §8) замыкаются фабрикой — инъекция в тестах. */
export function makeMcpHandler(deps: McpDeps) {
  return async (c: Context): Promise<Response> => {
    // Метод-гейт ДО PAT-проверки (Task 10b): в stateless polling-дизайне (§9.3 — без
    // SSE-стрима и сессий) осмыслен только POST; GET с валидным PAT открывал бы
    // мёртвый SSE-стрим до idle-timeout. Эндпоинт смонтирован app.all (index.ts),
    // поэтому не-POST доходит сюда.
    if (c.req.method !== 'POST') {
      return c.json(
        {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: '/mcp принимает только POST (stateless polling, §9.3)',
          },
        },
        405,
        { Allow: 'POST' },
      );
    }

    // PAT-auth ДО ЛЮБОЙ MCP-логики (§9.3, fail-closed): /mcp — эндпоинт ТОЛЬКО для
    // внешних агентов с PAT. Bearer без префикса orbis_pat_ — в том числе валидный
    // Supabase JWT — здесь не аутентифицирует (401): владельческие поверхности ходят
    // в tRPC с JWT (context.ts), смешение транспортов не даёт обойти атрибуцию 'agent'.
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const pat = token?.startsWith(PAT_PREFIX) ? verifyPat(token) : null;
    if (pat === null) {
      return c.json(
        {
          error: {
            code: 'UNAUTHORIZED',
            message: 'требуется действительный PAT (Bearer orbis_pat_…)',
          },
        },
        401,
        { 'WWW-Authenticate': 'Bearer' },
      );
    }

    // Size-гейт (Task 10b): неограниченное JSON-RPC-тело от недоверенного внешнего
    // агента отсекается по content-length ДО создания Server/transport (и до
    // JSON-парсинга). Остаточный риск: тела, присланные chunked без content-length,
    // здесь не ограничены — системный лимит (реверс-прокси / Hono body-limit
    // middleware) на деплое (Слайс 1c) закрывает это платформенно и для tRPC.
    const contentLength = c.req.header('content-length');
    if (contentLength !== undefined && Number(contentLength) > MCP_MAX_BODY_BYTES) {
      return c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `тело запроса превышает лимит ${MCP_MAX_BODY_BYTES} байт`,
          },
        },
        413,
      );
    }

    const server = makeMcpServer(deps, pat.ownerId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: без сессий и их валидации
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
}
