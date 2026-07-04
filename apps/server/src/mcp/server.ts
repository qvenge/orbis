// apps/server/src/mcp/server.ts
// MCP-сервер — ТОНКИЙ адаптер над реестром тулов (§9.3): транслирует MCP-вызовы в тулы
// §9.2 один в один, без собственной бизнес-логики (карта 00-арх, п. 7–8). Вся семантика —
// в dispatchTool (политика §7.10, executor §9.2, журнал §7.8); здесь только:
// tools/list = реестр per-request под withIdentity (custom-аспекты владельца) минус
// internalOnly; tools/call = rate-гейт §8 → dispatchTool → сериализация результата в
// text-контент MCP. Низкоуровневый Server SDK (не McpServer): реестр отдаёт готовые
// JSON Schema (§9.2 дословно), конверсия в zod была бы лишним слоем с потерями.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { type EntitlementResolver, resolveEntitlement } from '../entitlements';
import { dispatchTool, type ToolDispatchResult } from '../tools/dispatch';
import { buildToolRegistry } from '../tools/registry';

/** Ключ entitlements §8, который гейтит каждый tools/call (по аналогии с гейтом Task 9). */
const AGENT_REQUESTS_KEY = 'agents.requests_per_day';

/**
 * Зависимости MCP-адаптера: db процесса (как у роутеров) и резолвер §8 —
 * инжектируются фабрикой (тесты подставляют резолвер с лимитом).
 */
export interface McpDeps {
  db: Db;
  /** Резолвер §8; по умолчанию — боевой resolveEntitlement (план dev безлимитен). */
  entitlements?: EntitlementResolver;
  clock?: () => Date;
}

/**
 * Свежий SDK-Server на ЗАПРОС (stateless-контракт транспорта, transport.ts) от имени
 * владельца PAT. Каждый tools/call — свежий tx-цикл dispatchTool; реестр tools/list
 * строится per-request под withIdentity — агент видит и custom-аспекты владельца (§7.6).
 */
export function makeMcpServer(deps: McpDeps, ownerId: string): Server {
  const resolve = deps.entitlements ?? resolveEntitlement;
  const server = new Server({ name: 'orbis', version: '0.0.0' }, { capabilities: { tools: {} } });

  // tools/list: публичный реестр §9.2 — имена/описания/inputSchema как в реестре,
  // internalOnly (user_query) не публикуется; вторая линия — fail-closed в dispatchTool
  server.setRequestHandler(
    ListToolsRequestSchema,
    sanitized(async (): Promise<ListToolsResult> => {
      const defs = await withIdentity(deps.db, ownerId, (tx) => buildToolRegistry(tx));
      return {
        tools: defs
          .filter((d) => d.internalOnly !== true)
          .map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: d.inputJsonSchema as Tool['inputSchema'],
          })),
      };
    }),
  );

  // tools/call: rate-гейт §8 ДО dispatch; дальше — трансляция один в один
  server.setRequestHandler(
    CallToolRequestSchema,
    sanitized(async (req: CallToolRequest): Promise<CallToolResult> => {
      const gate = gateAgentRequest(resolve, ownerId);
      if (gate !== null) return toCallToolResult(gate);

      const result = await dispatchTool(
        {
          db: deps.db,
          actorUserId: ownerId,
          actorKind: 'agent', // честная атрибуция внешнего агента (§7.8, D11)
          source: 'mcp',
          explicitCommand: false, // §7.10: в 1b всегда false
          // threadId не передаётся → audit ложится в глобальный тред владельца (§7.8):
          // действия агентов видимы владельцу, inline-правка и Undo работают (02 §2.3)
          ...(deps.clock !== undefined && { clock: deps.clock }),
        },
        req.params.name,
        req.params.arguments ?? {},
      );
      return toCallToolResult(result);
    }),
  );

  return server;
}

/**
 * Гигиена ошибок MCP-хендлеров: доменные отказы dispatch отдаёт структурными
 * error-результатами (ExecError → { error } с isError), сюда долетают только
 * инфраструктурные сбои и баги. SDK кладёт message брошенной ошибки в JSON-RPC-ответ —
 * errorFormatter-гигиена tRPC сюда не достаёт, поэтому наружу уходит обезличенная
 * ошибка (без SQL, стеков и внутренностей), оригинал — в серверный лог.
 */
function sanitized<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error('[mcp] внутренняя ошибка хендлера:', e);
      throw new Error('внутренняя ошибка сервера — подробности в серверном логе');
    }
  };
}

/**
 * Гейт agents.requests_per_day (§8) ДО dispatch: отказ резолвера или исчерпанный
 * по построению лимит (<= 0) → структурный LIMIT. Положительный конечный лимит
 * требует счётчика агентских запросов — метеринга агентских вызовов в 1b нет
 * (ai_usage §4.7 — про LLM-токены), а план dev отдаёт limit null (безлимит);
 * положительные лимиты появятся вместе с метерингом (§8, Future).
 */
function gateAgentRequest(
  resolve: EntitlementResolver,
  ownerId: string,
): ToolDispatchResult | null {
  const decision = resolve(ownerId, AGENT_REQUESTS_KEY);
  if (!decision.allowed || (decision.limit !== null && decision.limit <= 0)) {
    return {
      status: 'error',
      error: {
        code: 'LIMIT',
        message: `лимит «${AGENT_REQUESTS_KEY}» исчерпан`,
        details: { key: AGENT_REQUESTS_KEY, limit: decision.limit },
      },
    };
  }
  return null;
}

/**
 * ToolDispatchResult → MCP CallToolResult: единственный text-контент с JSON-строкой.
 * - ok → { result, card? } (card — данные карточки 02 §2.3, агенту тоже полезна);
 * - pending_confirmation → честный НЕ-error ответ (§9.3: ожидание подтверждения
 *   владельца — не сбой) с протоколом «не повторяй» (как pendingNote Task 9);
 * - error → { error: { code, message, details } } с isError: true — структурная ошибка
 *   для самокоррекции агента; сырых ошибок здесь нет по построению (dispatch отдаёт
 *   только структурные, инфраструктурные летят throw'ом в JSON-RPC-ошибку SDK).
 */
function toCallToolResult(r: ToolDispatchResult): CallToolResult {
  if (r.status === 'ok') {
    return textContent({ result: r.result, ...(r.card !== undefined && { card: r.card }) });
  }
  if (r.status === 'pending_confirmation') {
    return textContent({
      status: 'pending_confirmation',
      pendingId: r.pendingId,
      note:
        'действие ждёт подтверждения владельца; не повторяй вызов — ' +
        'владелец решит на карточке в чате',
    });
  }
  return { ...textContent({ error: r.error }), isError: true };
}

function textContent(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
