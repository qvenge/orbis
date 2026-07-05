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
import { bodyLimit } from 'hono/body-limit';
import { PAT_PREFIX, verifyPat } from '../pat';
import { type McpDeps, makeMcpServer } from './server';

/**
 * Лимит тела /mcp (Task 10b): 1 МБ — JSON-RPC вызова тула на порядки меньше.
 * Экспортируется для теста (mcp.test.ts).
 */
export const MCP_MAX_BODY_BYTES = 1_000_000;

/**
 * Платформенный body-limit /mcp (Task 4, слайс 1c-2). Считает лимит по ФАКТИЧЕСКИ
 * прочитанным байтам, не доверяя заголовку: bodyLimit из hono/body-limit при наличии
 * content-length (и без transfer-encoding) режет по заголовку сразу (быстрый пред-чек),
 * иначе стримит тело и суммирует байты — этим закрыт остаточный обход Task 10b, когда
 * chunked-тело без content-length проскакивало заголовочный гейт. onError отдаёт нашу
 * структурную форму 413 { error.code: PAYLOAD_TOO_LARGE } (контракт mcp.test.ts).
 * Stateless — инстанс модульного уровня переиспользуем между запросами.
 */
const mcpBodyLimit = bodyLimit({
  maxSize: MCP_MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `тело запроса превышает лимит ${MCP_MAX_BODY_BYTES} байт`,
        },
      },
      413,
    ),
});

/** Hono-хендлер /mcp; deps (db, резолвер §8) замыкаются фабрикой — инъекция в тестах. */
export function makeMcpHandler(deps: McpDeps) {
  return async (c: Context): Promise<Response> => {
    // Метод-гейт ДО PAT-проверки (Task 10b): в stateless polling-дизайне (§9.3 — без
    // SSE-стрима и сессий) осмыслен только POST; GET с валидным PAT открывал бы
    // мёртвый SSE-стрим до idle-timeout. Эндпоинт смонтирован app.all (app.ts),
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

    // Size-гейт (Task 4): неограниченное JSON-RPC-тело от недоверенного внешнего агента
    // отсекается ДО создания Server/transport (и до JSON-парсинга). Платформенный
    // bodyLimit считает по фактически прочитанным байтам — закрывает и chunked-тело без
    // content-length (остаточный обход Task 10b). Вызываем middleware вручную с no-op
    // next, сохраняя порядок 405 → 401 → 413 (fail-closed: PAT ДО чтения тела): при
    // превышении onError возвращает 413-Response, иначе bodyLimit при стриминге
    // перевешивает буфер тела в c.req.raw — transport читает его ниже.
    const limitResponse = await mcpBodyLimit(c, async () => {});
    if (limitResponse instanceof Response) return limitResponse;

    const server = makeMcpServer(deps, pat.ownerId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: без сессий и их валидации
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
}
