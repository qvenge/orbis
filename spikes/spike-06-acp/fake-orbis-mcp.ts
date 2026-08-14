/**
 * ВЫБРАСЫВАЕМЫЙ КОД. Спайк 06.
 * Игрушечный MCP-сервер в форме Orbis: отдаёт спеку и принимает отчёт о ходе работы.
 * Транспорт — stdio, протокол MCP поверх ndjson JSON-RPC.
 * Всё, что видит «Orbis», пишется в stderr — его ловит probe.ts.
 */
import { appendFileSync } from "node:fs";

const TRACE = process.env.ORBIS_TRACE ?? "/dev/stderr";
const trace = (s: string) => appendFileSync(TRACE, `[fake-orbis] ${s}\n`);

const SPEC = `# Спека REQ-042 — приветствие

## Контракт
- Файл GREETING.txt ДОЛЖЕН существовать в корне воркспейса.
- Он ДОЛЖЕН содержать ровно одну строку.
- Строка ДОЛЖНА начинаться со слова «Здравствуй».

## Приёмочный критерий
КОГДА файл прочитан, СИСТЕМА ДОЛЖНА увидеть строку, начинающуюся со «Здравствуй».`;

const TOOLS = [
  {
    name: "orbis_get_spec",
    description: "Получить текст спеки требования из Orbis по его идентификатору.",
    inputSchema: {
      type: "object",
      properties: { requirementId: { type: "string", description: "например REQ-042" } },
      required: ["requirementId"],
    },
  },
  {
    name: "orbis_report_progress",
    description: "Отчитаться в Orbis о ходе работы над требованием: статус и короткая заметка.",
    inputSchema: {
      type: "object",
      properties: {
        requirementId: { type: "string" },
        status: { type: "string", enum: ["in_progress", "done", "blocked"] },
        note: { type: "string" },
      },
      required: ["requirementId", "status"],
    },
  },
];

function send(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buf = "";
process.stdin.on("data", (b) => {
  buf += String(b);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function handle(msg: any) {
  const { id, method, params } = msg;
  if (id === undefined) return; // нотификации игнорируем

  switch (method) {
    case "initialize":
      trace(`initialize от ${params?.clientInfo?.name} (протокол ${params?.protocolVersion})`);
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "orbis-fake", version: "0.0.0" },
        },
      });

    case "tools/list":
      trace("tools/list — агент спрашивает, что умеет Orbis");
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      if (name === "orbis_get_spec") {
        trace(`✱ агент ЗАПРОСИЛ СПЕКУ ${args?.requirementId}`);
        return send({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: SPEC }] },
        });
      }
      if (name === "orbis_report_progress") {
        trace(`✱ агент ОТЧИТАЛСЯ: ${args?.requirementId} → ${args?.status} — ${args?.note ?? ""}`);
        return send({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: "Принято, статус записан в Orbis." }] },
        });
      }
      return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `нет такого инструмента: ${name}` } });
    }

    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `не реализовано: ${method}` } });
  }
}
