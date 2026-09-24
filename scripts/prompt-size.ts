#!/usr/bin/env bun
// scripts/prompt-size.ts — замер размера промпта: слои 1 и 5 таблицы бюджетов
// (`docs/prd/01-architecture.md`, §7.1 «Бюджеты контекста»).
//
// ЧТО МЕРЯЕТСЯ. Слой 1 — системный канал чата ровно тем кодом, что в проде (`buildContext`),
// у свежего владельца после боевого сида (`seedOwner`): промпт линейки v7, дата, проза модулей,
// индекс аспектов, блок продолжений; БЕЗ памяти и якоря (у свежего владельца их нет — это
// проверяется, а не подразумевается). Слой 5 — определения тулов чата: `buildToolRegistry`,
// тот же фильтр поверхности, что у `ai/send-message.ts`, в форме, которую чат отдаёт
// провайдеру (`LLMToolDef`: имя, описание, JSON Schema входа).
//
// БАЙТЫ И ТОКЕНЫ — РАЗНЫЕ ЗАМЕРЫ. Байты — UTF-8 (`Buffer.byteLength`), без провайдера: канал на
// кириллице, и `.length` занизил бы его почти вдвое. Токены меряет ТОЛЬКО сам провайдер
// (оценка «символы ÷ 4» для кириллицы врёт вдвое — П3 §2): методика П3 `size.ts` — разность
// `inputTokens` трёх вызовов с коротким сообщением: пустой канал без тулов (база), канал слоя 1
// без тулов, пустой канал с тулами слоя 5.
//
// Запуск (из корня; `.env` подхватывается bun'ом; БД — только локальная):
//     bun scripts/prompt-size.ts            — байты
//     bun scripts/prompt-size.ts --tokens   — байты и токены (живые вызовы провайдера)
// КОДЫ ВЫХОДА: 0 — замерено; 2 — не замерено (нет провайдера/кредитов при --tokens, нет
// локальной БД); 1 — сломалось.
import { makeDb } from '../apps/server/src/db/client.ts';
import { withIdentity } from '../apps/server/src/db/with-identity.ts';
import { ASPECT_INDEX_HEADING } from '../apps/server/src/llm/aspect-index.ts';
import { buildContext, loadMemory } from '../apps/server/src/llm/context.ts';
import type { LLMProviderEnv } from '../apps/server/src/llm/provider.ts';
import type { LLMProvider, LLMToolDef } from '../apps/server/src/llm/types.ts';
import { buildToolRegistry } from '../apps/server/src/tools/registry.ts';
import { selectProvider } from './probe-p3/runner.ts';
import { chatSurface, isLocalDatabaseUrl, probeOwner } from './probe-p3/variants.ts';
import { probeClock } from './probe-p3/world.ts';

export interface ByteMeasure {
  layer1Bytes: number;
  layer5Bytes: number;
  toolCount: number;
}

/** Байты UTF-8 канала (слой 1) и JSON определений тулов (слой 5). */
export function measureBytes(system: string, tools: readonly LLMToolDef[]): ByteMeasure {
  return {
    layer1Bytes: Buffer.byteLength(system, 'utf8'),
    layer5Bytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
    toolCount: tools.length,
  };
}

/** Секция индекса аспектов внутри канала — отдельной строкой отчёта: её цена и есть новость среза 1а. */
function indexSection(system: string): string {
  const at = system.indexOf(ASPECT_INDEX_HEADING);
  if (at === -1) return '';
  const end = system.indexOf('\n\n', at);
  return system.slice(at, end === -1 ? system.length : end);
}

async function tokens(
  provider: LLMProvider,
  system: string,
  tools: LLMToolDef[],
): Promise<{ layer1: number; layer5: number }> {
  const call = async (s: string, t: LLMToolDef[]) =>
    (
      await provider.chat({
        system: s,
        messages: [{ role: 'user', content: '.' }],
        tools: t,
        maxTokens: 16,
      })
    ).usage.inputTokens;
  const base = await call('', []);
  return { layer1: (await call(system, [])) - base, layer5: (await call('', tools)) - base };
}

export async function main(
  argv: readonly string[],
  env: LLMProviderEnv & { DATABASE_URL?: string },
): Promise<number> {
  const withTokens = argv.includes('--tokens');
  // Провайдер — ДО БД: «токены не замерены» не должно стоить сева владельца.
  let provider: LLMProvider | undefined;
  if (withTokens) {
    const choice = selectProvider(env);
    if (choice.kind === 'unavailable') {
      console.error(`prompt-size: токены не замерены — ${choice.reason}.`);
      return 2;
    }
    provider = choice.provider;
  }
  if (!isLocalDatabaseUrl(env.DATABASE_URL)) {
    console.error(
      'prompt-size: DATABASE_URL не локальный — замер заводит своего владельца и пишет только в локальную БД.',
    );
    return 2;
  }

  const { db, client } = makeDb({ max: 3 });
  try {
    const owner = await probeOwner(db);
    const { system, tools, registryTools, memory } = await withIdentity(
      db,
      owner.who,
      async (tx) => {
        const ctx = await buildContext(tx, {
          graphId: owner.who.graph,
          threadId: owner.threadId,
          clock: probeClock,
        });
        const defs = await buildToolRegistry(tx, owner.who.graph);
        return {
          system: ctx.system,
          tools: chatSurface(defs),
          registryTools: defs.length,
          memory: (await loadMemory(tx)).length,
        };
      },
    );
    if (memory > 0)
      throw new Error(`у свежего владельца ${memory} памятей — слой 1 мерился бы с памятью`);

    const m = measureBytes(system, tools);
    const index = Buffer.byteLength(indexSection(system), 'utf8');
    console.log(
      `prompt-size: ${new Date().toISOString().slice(0, 10)}, канал на ${probeClock().toISOString().slice(0, 10)}`,
    );
    console.log(`слой 1 (системный канал чата, без памяти и якоря): ${m.layer1Bytes} байт`);
    console.log(`  из него индекс аспектов: ${index} байт`);
    console.log(
      `слой 5 (определения тулов чата): ${m.layer5Bytes} байт, тулов ${m.toolCount} (в реестре ${registryTools})`,
    );

    if (provider !== undefined) {
      try {
        const t = await tokens(provider, system, tools);
        console.log(`токены (${provider.modelId}): слой 1 — ${t.layer1}, слой 5 — ${t.layer5}`);
      } catch (e) {
        console.error(
          `prompt-size: токены не замерены — провайдер отказал: ${e instanceof Error ? e.message : String(e)}`,
        );
        return 2;
      }
    }
    return 0;
  } catch (e) {
    console.error('prompt-size: сбой замера —', e);
    return 1;
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env));
}
