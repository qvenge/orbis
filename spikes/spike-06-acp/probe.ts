/**
 * ВЫБРАСЫВАЕМЫЙ КОД. Спайк 06.
 *
 * Вопрос: может ли внешний процесс (в перспективе — Orbis) прогнать задачу через
 * локально установленного агента по ACP, под подпиской пользователя, и получить
 * поток, достаточный для ленты прогресса?
 *
 * Клиент написан на сыром ndjson JSON-RPC намеренно: цель — увидеть провод,
 * а не спрятать его за SDK.
 *
 * Запуск: bun probe.ts <команда адаптера...>
 *   bun probe.ts node_modules/.bin/claude-agent-acp
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("нужна команда адаптера, например: bun probe.ts node_modules/.bin/claude-agent-acp");
  process.exit(2);
}

const LOG = join(import.meta.dir, `raw-${argv[0].split("/").pop()}.log`);
writeFileSync(LOG, "");
const log = (dir: "→" | "←", obj: unknown) =>
  appendFileSync(LOG, `${dir} ${JSON.stringify(obj)}\n`);

// ── рабочий каталог-игрушка ────────────────────────────────────────────────
const WS = mkdtempSync(join(tmpdir(), "acp-spike-"));
writeFileSync(
  join(WS, "README.md"),
  "# Игрушечный проект\n\nЗдесь ничего нет. Пока.\n",
);
console.log(`воркспейс: ${WS}\nлог провода: ${LOG}\n`);

// ── подъём агента ──────────────────────────────────────────────────────────
// cwd процесса — воркспейс, поэтому путь к адаптеру резолвим заранее
const bin = argv[0].includes("/") ? resolve(argv[0]) : argv[0];
const child = spawn(bin, argv.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: WS,
  env: { ...process.env },
});
child.on("error", (e) => {
  console.error(`✗ не удалось запустить адаптер: ${e.message}`);
  finish(1);
});
child.on("exit", (code, sig) => {
  if (!done) {
    console.error(`✗ адаптер завершился раньше времени: code=${code} sig=${sig}`);
    finish(1);
  }
});
child.stderr.on("data", (b) => {
  const s = String(b).trimEnd();
  if (s) appendFileSync(LOG, `⚠ stderr: ${s}\n`);
});

let done = false;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function send(obj: Record<string, unknown>) {
  log("→", obj);
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function call(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function reply(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

// ── счётчики: что именно приезжает в потоке ────────────────────────────────
const updateKinds = new Map<string, number>();
const clientCalls = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

let sawText = "";

/** Обработка входящего сообщения от агента. */
function handle(msg: any) {
  log("←", msg);

  // ответ на наш запрос
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    return;
  }

  // запрос или нотификация ОТ агента К нам
  const method: string = msg.method;
  bump(clientCalls, method);

  switch (method) {
    case "session/update": {
      const u = msg.params?.update ?? {};
      const kind = u.sessionUpdate ?? "?";
      bump(updateKinds, kind);
      if (kind === "agent_message_chunk" && u.content?.type === "text") {
        sawText += u.content.text;
      }
      // человекочитаемая лента
      if (kind === "plan") {
        const entries = u.entries ?? [];
        console.log(`  [план] ${entries.length} пунктов: ` +
          entries.map((e: any) => `${e.status}:${e.content?.slice(0, 40)}`).join(" | "));
      } else if (kind === "tool_call") {
        console.log(`  [инструмент] ${u.title ?? u.kind} (${u.status})`);
      } else if (kind === "tool_call_update") {
        console.log(`  [инструмент→] ${u.toolCallId} → ${u.status}`);
      } else if (kind === "current_mode_update") {
        console.log(`  [режим] ${u.currentModeId}`);
      }
      return; // нотификация, ответа не требует
    }

    case "session/request_permission": {
      const opts = msg.params?.options ?? [];
      const allow = opts.find((o: any) => o.kind === "allow_always")
        ?? opts.find((o: any) => o.kind === "allow_once")
        ?? opts[0];
      console.log(`  [РАЗРЕШЕНИЕ] спрашивает: ${msg.params?.toolCall?.title ?? "?"} `
        + `— варианты: ${opts.map((o: any) => o.kind).join(", ")} → отвечаю ${allow?.kind}`);
      reply(msg.id, { outcome: { outcome: "selected", optionId: allow?.optionId } });
      return;
    }

    case "terminal/create": {
      console.log(`  [ТЕРМИНАЛ] агент просит выполнить: ${msg.params?.command} ${(msg.params?.args ?? []).join(" ")}`);
      reply(msg.id, { terminalId: "term-1" });
      return;
    }

    case "fs/read_text_file": {
      const text = readFileSync(msg.params.path, "utf8");
      reply(msg.id, { content: text });
      return;
    }

    case "fs/write_text_file": {
      writeFileSync(msg.params.path, msg.params.content);
      reply(msg.id, null);
      return;
    }

    default:
      if (msg.id !== undefined) {
        // неподдержанный запрос — честно отвечаем ошибкой
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `не реализовано: ${method}` } });
      }
  }
}

// ── разбор ndjson ──────────────────────────────────────────────────────────
let buf = "";
child.stdout.on("data", (b) => {
  buf += String(b);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch { appendFileSync(LOG, `⚠ не JSON: ${line}\n`); }
  }
});

// ── сценарий ───────────────────────────────────────────────────────────────
const started = Date.now();
const secs = () => ((Date.now() - started) / 1000).toFixed(1);

const timeout = setTimeout(() => {
  console.error(`\n✗ таймаут 240 с`);
  finish(1);
}, 240_000);

function finish(code: number) {
  if (done) return;
  done = true;
  clearTimeout(timeout);
  console.log(`\n════ ИТОГ (${secs()} с) ════`);
  console.log("виды session/update:", updateKinds.size ? [...updateKinds].map(([k, v]) => `${k}×${v}`).join(", ") : "— ничего —");
  console.log("вызовы агента к клиенту:", [...clientCalls].filter(([k]) => k !== "session/update").map(([k, v]) => `${k}×${v}`).join(", ") || "— ничего —");
  console.log("текст ответа:", sawText.slice(0, 300).replace(/\n/g, " ⏎ ") || "— пусто —");
  console.log(`воркспейс: ${WS}`);
  console.log(`лог: ${LOG}`);
  child.kill();
  process.exit(code);
}

try {
  console.log("① initialize");
  const init = await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });
  console.log("   ответ:", JSON.stringify(init).slice(0, 400));

  const authMethods = init?.authMethods ?? [];
  console.log(`   методы аутентификации: ${authMethods.length ? authMethods.map((a: any) => a.id).join(", ") : "— не требуется —"}`);

  console.log("② session/new");
  const mcpServers: any[] = [];
  if (process.env.ORBIS_MCP === "stdio") {
    mcpServers.push({
      name: "orbis",
      command: resolve(process.execPath),
      args: [resolve(import.meta.dir, "fake-orbis-mcp.ts")],
      env: [],
    });
    console.log("   подключаю Orbis как MCP-сервер (транспорт stdio)");
  } else if (process.env.ORBIS_MCP === "acp") {
    mcpServers.push({ type: "acp", name: "orbis", serverId: "orbis-1" });
    console.log("   подключаю Orbis как MCP-сервер (транспорт acp — по каналу ACP)");
  }
  const sess = await call("session/new", { cwd: WS, mcpServers });
  const sessionId = sess.sessionId;
  console.log("   sessionId:", sessionId);
  if (sess.modes) console.log("   режимы:", JSON.stringify(sess.modes).slice(0, 200));

  const wantMode = process.env.ACP_MODE;
  if (wantMode) {
    console.log(`②′ session/set_mode → ${wantMode}`);
    await call("session/set_mode", { sessionId, modeId: wantMode });
  }

  console.log("③ session/prompt — задача агенту");
  const res = await call("session/prompt", {
    sessionId,
    prompt: [{
      type: "text",
      text: process.env.ACP_TASK
        ?? "Прочитай README.md в текущем каталоге. Затем создай файл HELLO.txt "
           + "с одной строкой — приветствием на русском. Больше ничего не делай.",
    }],
  });
  console.log("   stopReason:", res?.stopReason);

  const hello = join(WS, "HELLO.txt");
  try {
    console.log("   HELLO.txt:", JSON.stringify(readFileSync(hello, "utf8")));
    console.log("\n✓ агент реально изменил файловую систему");
  } catch {
    console.log("\n✗ HELLO.txt не создан");
  }
  finish(0);
} catch (e) {
  console.error("\n✗ ошибка:", (e as Error).message);
  finish(1);
}
