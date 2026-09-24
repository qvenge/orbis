#!/usr/bin/env bun
// scripts/probe-p3.ts — СТЕНД ЖИВОЙ ПРОВЕРКИ §С8-30: индекс аспектов против полного каталога.
//
// ЗАЧЕМ. Срез 1а заменил в системном канале секцию инструкций аспектов ИНДЕКСОМ — «id, подпись,
// описание»; поля и правила аспекта модель читает в туле `attach_<аспект>` (§Б7-2 спеки реформы).
// Проба П3 (2026-08-25) измерила индекс только по размеру и назвала риск: по сценариям он не
// гонялся. Приёмка §С8-30 — двенадцать сценариев П3 на двух моделях, паритет индекса с полным
// каталогом; регрессия — откат, названный заранее: «каталог аспектов + подгрузка по релевантности».
//
// ОТКУДА СТЕНД. Стенд П3 жил вне git (`.superpowers/probe/p3/`) и умер с реформой: звал снятые
// `parseQuery`, `ASPECT_SCHEMAS` и колонки старого реестра аспектов (Ф-1а-14). Здесь он перенесён в
// дерево по образцу `probe-p4.ts`: скрипт-модуль, чистая часть под тестом (`probe-p3.test.ts`),
// детали — `probe-p3/{world,runner,scenarios,variants}.ts`. Методика — отчёт П3 §3, §4, §9.
//
// РЕЖИМЫ:
//   bun scripts/probe-p3.ts --dry-run
//       Готово ли к прогону: на локальной БД заводит владельца стенда, собирает ОБА варианта
//       обоих каналов для всех 12 сценариев, проверяет мир-заглушку стадией 2. Модель не зовётся.
//   bun scripts/probe-p3.ts --variant=index|catalog --model=<id> --rep=N --out=<каталог> [id …]
//       Живой прогон одной клетки матрицы (вариант × модель × повтор): трассы — в
//       `<каталог>/<вариант>__<модель>__r<N>.json`, по ним — таблица П3 §3 в `<каталог>/report.md`
//       и вердикт. Каталог — вне git (путь аргументом): трассы — данные прогона, не код.
//   bun scripts/probe-p3.ts --report --out=<каталог>
//       Таблица и вердикт по уже снятым трассам — без модели и без БД (пересчёт стоит ноль).
// Матрица §С8-30: оба варианта × две модели (прод — `DEFAULT_OPENAI_MODEL`, вторая —
// `gpt-5.4-mini`, как в П3) × повторы 1..3. Провайдер — как у сервера: ORBIS_LLM_PROVIDER и ключ.
//
// КОДЫ ВЫХОДА (их различает запускающий, не читая исходник):
//   0 — паритет: на прод-модели индекс ниже каталога не более чем на 2 из 36 (разброс, измеренный
//       П3 §3: одна и та же клетка давала 1/3 и 3/3); у --dry-run — «готово к прогону»;
//   3 — паритета нет: индекс ниже каталога больше допуска — решение об откате за владельцем;
//   2 — замер не состоялся: нет провайдера или кредитов, нет локальной БД, матрица на
//       прод-модели ещё неполна (вердикт выносится только по полной);
//   1 — стенд сломался (исключение, неверные флаги, --dry-run нашёл дефект сборки).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetStatusResultSchema, MAX_AGENT_STEPS } from '@orbis/shared';
import { routineById } from '../apps/server/src/agent-loop/queries.ts';
import { chatToolSurface } from '../apps/server/src/ai/send-message.ts';
import type { Db } from '../apps/server/src/db/client.ts';
import { makeDb } from '../apps/server/src/db/client.ts';
import { withIdentity } from '../apps/server/src/db/with-identity.ts';
import { ASPECT_INDEX_HEADING } from '../apps/server/src/llm/aspect-index.ts';
import { buildContext } from '../apps/server/src/llm/context.ts';
import { DEFAULT_OPENAI_MODEL } from '../apps/server/src/llm/openai.ts';
import type { LLMProviderEnv } from '../apps/server/src/llm/provider.ts';
import {
  ROUTINE_MODE_PROPERTY,
  ROUTINE_TOOLS_PROPERTY,
} from '../apps/server/src/policy/confirmation.ts';
import { ROUTINE_MAX_STEPS } from '../apps/server/src/routines/constants.ts';
import { TERMINAL_TOOLS } from '../apps/server/src/routines/runner.ts';
import { buildToolRegistry, routineToolDefs } from '../apps/server/src/tools/registry.ts';
import { replay, runScenario, selectProvider, type Trace } from './probe-p3/runner.ts';
import { commonNotes, SCENARIOS, type Scenario } from './probe-p3/scenarios.ts';
import {
  assembleChannels,
  type Channels,
  isLocalDatabaseUrl,
  type ProbeOwner,
  probeOwner,
  seedTrigger,
  VARIANTS,
  type Variant,
  withCatalog,
} from './probe-p3/variants.ts';
import {
  BUDGET_STATUS,
  probeClock,
  seedWorld,
  triggerEntity,
  type WorldEntity,
} from './probe-p3/world.ts';

export { selectProvider } from './probe-p3/runner.ts';

/**
 * Прод-модель вердикта — дефолт боевого провайдера. Вердикт выносится по ней одной: вторая модель
 * — ось чувствительности (слабая модель того же вендора, П3 §3), а не условие приёмки.
 */
export const PROD_MODEL = DEFAULT_OPENAI_MODEL;
/** Повторов на клетку для вердикта: одна выборка не отличает регрессию от разброса (П3 §3). */
export const PARITY_REPS = 3;
/**
 * Допуск паритета — литералом здесь и нигде больше: 2 из 36 — разброс, который П3 измерил на
 * ОДНОМ промпте (`routine-propose` давал 1/3 и 3/3). Меньший допуск объявлял бы регрессией шум.
 */
export const PARITY_TOLERANCE = 2;

export interface Tally {
  pass: number;
  runs: number;
}

export type ParityVerdict = { code: 0 | 2 | 3; text: string };

/** Вердикт §С8-30 по счёту прогонов прод-модели на повторах 1..PARITY_REPS. */
export function parityVerdict(t: { index: Tally; catalog: Tally }): ParityVerdict {
  const full = SCENARIOS.length * PARITY_REPS;
  if (t.index.runs < full || t.catalog.runs < full) {
    return {
      code: 2,
      text:
        `матрица на прод-модели неполна: index ${t.index.runs}/${full}, catalog ${t.catalog.runs}/${full} ` +
        'прогонов — вердикт выносится только по полной',
    };
  }
  const gap = t.catalog.pass - t.index.pass;
  return gap > PARITY_TOLERANCE
    ? {
        code: 3,
        text:
          `ПАРИТЕТА НЕТ: index ${t.index.pass}/${full} против catalog ${t.catalog.pass}/${full} ` +
          `(ниже на ${gap} > ${PARITY_TOLERANCE}). Откат, названный спекой реформы, — «каталог аспектов + ` +
          'подгрузка по релевантности»; решение за владельцем.',
      }
    : {
        code: 0,
        text: `ПАРИТЕТ: index ${t.index.pass}/${full}, catalog ${t.catalog.pass}/${full} (допуск ${PARITY_TOLERANCE}).`,
      };
}

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  report: boolean;
  variant?: Variant;
  model?: string;
  rep: number;
  out?: string;
  only: string[];
}

const USAGE =
  'usage: bun scripts/probe-p3.ts --dry-run\n' +
  '       bun scripts/probe-p3.ts --variant=index|catalog [--model=<id>] [--rep=N] --out=<каталог> [id сценария …]\n' +
  '       bun scripts/probe-p3.ts --report --out=<каталог>';

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const variant = value('variant');
  if (variant !== undefined && !(VARIANTS as readonly string[]).includes(variant)) {
    throw new Error(`неизвестный вариант «${variant}»`);
  }
  const rep = Number(value('rep') ?? '1');
  if (!Number.isInteger(rep) || rep < 1)
    throw new Error(`--rep — целое ≥ 1, получено «${value('rep')}»`);
  const only = argv.filter((a) => !a.startsWith('--'));
  const unknown = only.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`неизвестные сценарии: ${unknown.join(', ')}`);
  return {
    dryRun: argv.includes('--dry-run'),
    report: argv.includes('--report'),
    variant: variant as Variant | undefined,
    model: value('model'),
    rep,
    out: value('out'),
    only,
  };
}

// ---------------------------------------------------------------------------
// Сборка каналов на локальной БД — общая у --dry-run и живого прогона
// ---------------------------------------------------------------------------

const ROUTINE_SCENARIO = SCENARIOS.find((s) => s.channel === 'routine');

interface Stand {
  channels: Channels;
  /** Эталон прода, собранный НЕЗАВИСИМО от `assembleChannels`, — им dry-run сверяет стенд. */
  prod: () => Promise<ProdReference>;
  /** Мир сценария: у канала рутины в нём ещё и рутина-триггер (её id модель видит в якоре). */
  worldFor: (s: Scenario) => Map<string, WorldEntity>;
}

async function withStand<T>(fn: (stand: Stand) => Promise<T>): Promise<T> {
  if (ROUTINE_SCENARIO === undefined) throw new Error('в наборе нет сценария канала рутины');
  const request = ROUTINE_SCENARIO.turns[0] ?? '';
  const { db, client } = makeDb({ max: 3 });
  try {
    const owner = await probeOwner(db);
    const triggerId = await seedTrigger(db, owner.who, request);
    const channels = await assembleChannels(db, owner, triggerId);
    const trigger = triggerEntity(triggerId, request);
    return await fn({
      channels,
      prod: () => prodReference(db, owner, triggerId),
      worldFor: (s) => seedWorld(s.channel === 'routine' ? [trigger] : []),
    });
  } finally {
    await client.end();
  }
}

interface ProdReference {
  chatIndex: string;
  chatTools: string[];
  routineTools: string[];
  routineMode: unknown;
}

/**
 * То, что прод отдаёт модели, — собранное боевыми функциями напрямую, мимо сборки стенда: чат —
 * `buildContext` и `chatToolSurface` (`ai/send-message.ts`), рутина — `routineToolDefs` со ссылкой,
 * собранной ровно как в `routines/runner.ts`. Сверка со стендом ловит подмену канала или тулов
 * внутри `assembleChannels`, которую ни один тест чистой части не видит (мутации гейт-ревью).
 */
async function prodReference(db: Db, owner: ProbeOwner, triggerId: string): Promise<ProdReference> {
  return withIdentity(db, owner.who, async (tx) => {
    const defs = await buildToolRegistry(tx, owner.who.graph);
    const chat = await buildContext(tx, {
      graphId: owner.who.graph,
      threadId: owner.threadId,
      clock: probeClock,
    });
    const routine = await routineById(tx, triggerId);
    if (routine === null) throw new Error('рутина-триггер не найдена — сев не отработал');
    const routineTools = routineToolDefs(defs, {
      id: routine.id,
      runId: crypto.randomUUID(),
      mode: routine.props[ROUTINE_MODE_PROPERTY],
      allowedTools: new Set(routine.props[ROUTINE_TOOLS_PROPERTY] ?? []),
    });
    return {
      chatIndex: chat.system,
      chatTools: chatToolSurface(defs).map((d) => d.name),
      routineTools: routineTools.map((d) => d.name),
      routineMode: routine.props[ROUTINE_MODE_PROPERTY],
    };
  });
}

/** Расхождение двух списков имён тулов — словами, а не «не равно». */
function toolDiff(channel: string, got: readonly string[], want: readonly string[]): string[] {
  const extra = got.filter((n) => !want.includes(n));
  const missing = want.filter((n) => !got.includes(n));
  if (extra.length === 0 && missing.length === 0 && got.length === want.length) return [];
  return [
    `тулы канала ${channel} не совпадают с продом: лишние [${extra.join(', ')}], ` +
      `недостающие [${missing.join(', ')}], стенд ${got.length} против прода ${want.length}`,
  ];
}

/** Мир проходит стадию 2 по эффективному реестру: иначе модель спорила бы с миром, а не с каналом. */
function worldDefects(stand: Stand): string[] {
  const world = [...stand.worldFor(ROUTINE_SCENARIO as Scenario).values()];
  const trace = replay(
    stand.channels.reg,
    world.map((e) => ({
      name: 'entity_create',
      args: {
        id: e.id,
        title: e.title,
        body: e.body,
        tags: e.tags,
        aspects: e.aspects,
        props: e.props,
      },
    })),
    { world: new Map() },
  );
  const out = trace.calls.flatMap((c) =>
    c.error === undefined ? [] : [`мир: ${String(c.args.title)} — ${c.error}`],
  );
  if (!budgetStatusResultSchema.safeParse(BUDGET_STATUS).success) {
    out.push('ответ budget_status заглушки не по контракту тула');
  }
  return out;
}

async function dryRun(): Promise<number> {
  return withStand(async (stand) => {
    const defects = worldDefects(stand);
    const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
    const { channels } = stand;
    const prod = await stand.prod();
    console.log(`probe-p3 --dry-run: секция каталога ${bytes(channels.catalogSection)} байт`);
    console.log('сценарий                 канал    index, Б  catalog, Б  тулов');
    for (const s of SCENARIOS) {
      const ch = channels[s.channel];
      for (const v of VARIANTS) {
        if (!ch.system[v].includes(ASPECT_INDEX_HEADING))
          defects.push(`${s.id}/${v}: в канале нет индекса`);
      }
      // Инвариант сравнения: catalog — это index плюс секция каталога, и больше ничего.
      if (ch.system.catalog !== withCatalog(ch.system.index, channels.catalogSection)) {
        defects.push(
          `${s.id}: catalog ≠ index + секция каталога — варианты отличаются не только каталогом`,
        );
      }
      if (ch.tools.length === 0) defects.push(`${s.id}: у канала нет тулов`);
      console.log(
        `${s.id.padEnd(24)} ${s.channel.padEnd(8)} ${String(bytes(ch.system.index)).padStart(8)}  ` +
          `${String(bytes(ch.system.catalog)).padStart(10)}  ${String(ch.tools.length).padStart(5)}`,
      );
    }
    // Инвариант «index — ровно прод-канал»: у чата канал детерминирован (часы стенда, тот же тред),
    // и сверяется побайтно. У рутины в канал входит id прогона — её сверяют тулы и режим ниже.
    if (channels.chat.system.index !== prod.chatIndex) {
      defects.push('канал чата варианта index не равен прод-каналу buildContext');
    }
    defects.push(
      ...toolDiff(
        'чата',
        channels.chat.tools.map((t) => t.name),
        prod.chatTools,
      ),
    );
    defects.push(
      ...toolDiff(
        'рутины',
        channels.routine.tools.map((t) => t.name),
        prod.routineTools,
      ),
    );
    // Сценарий routine-propose меряет В-6: канал propose-рутины, где attach_* не видны вовсе.
    if (prod.routineMode !== 'propose') {
      defects.push(
        `рутина-триггер в режиме ${String(prod.routineMode)}, а не propose — В-6 не меряется`,
      );
    }
    if (channels.routine.tools.some((t) => t.name.startsWith('attach_'))) {
      defects.push('канал propose-рутины видит attach_* — В-6 не меряется');
    }
    if (!channels.routine.tools.some((t) => t.name === 'orbis_propose')) {
      defects.push('канал рутины не видит orbis_propose — сценарий routine-propose неисполним');
    }
    if (defects.length > 0) {
      console.error('\nСТЕНД НЕ ГОТОВ:');
      for (const d of defects) console.error(`  ${d}`);
      return 1;
    }
    console.log(
      `\nГОТОВО К ПРОГОНУ: ${SCENARIOS.length} сценариев × ${VARIANTS.length} варианта собраны, модель не вызывалась.`,
    );
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Отчёт по трассам: таблица П3 §3 и метрики П3 §4
// ---------------------------------------------------------------------------

type TraceFile = Record<string, Trace>;

function loadTraces(out: string): Trace[] {
  let files: string[];
  try {
    files = readdirSync(out).filter((f) => /^(index|catalog)__.+__r\d+\.json$/.test(f));
  } catch {
    return [];
  }
  return files.flatMap((f) =>
    Object.values(JSON.parse(readFileSync(join(out, f), 'utf8')) as TraceFile),
  );
}

/** Шаг цикла = ход модели с вызовами; операции внутри batch_execute шагом не считаются. */
function stepsOf(t: Trace): number {
  return new Set(t.calls.filter((c) => !c.viaBatch).map((c) => `${c.turn}:${c.step}`)).size;
}

interface Cell extends Tally {
  fails: string[];
  steps: number;
  calls: number;
  refusals: number;
  badQueries: number;
  noChips: number;
  notConverged: number;
  inputTokens: number;
  outputTokens: number;
}

function report(traces: readonly Trace[]): { markdown: string; verdict: ParityVerdict } {
  const key = (t: Trace) => `${t.variant} · ${t.model}`;
  const keys = [...new Set(traces.map(key))].sort();
  const table = new Map<string, Map<string, Cell>>();
  const prod: Record<Variant, Tally> = {
    index: { pass: 0, runs: 0 },
    catalog: { pass: 0, runs: 0 },
  };
  for (const t of traces) {
    const s = SCENARIOS.find((x) => x.id === t.scenario);
    if (s === undefined || t.error !== undefined) continue; // несостоявшийся прогон — не прогон
    const v = s.check(t);
    const notes = commonNotes(t);
    const row = table.get(s.id) ?? new Map<string, Cell>();
    table.set(s.id, row);
    const c: Cell = row.get(key(t)) ?? {
      pass: 0,
      runs: 0,
      fails: [],
      steps: 0,
      calls: 0,
      refusals: 0,
      badQueries: 0,
      noChips: 0,
      notConverged: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    row.set(key(t), c);
    c.runs += 1;
    if (v.pass) c.pass += 1;
    else c.fails.push(...v.fails);
    c.steps += stepsOf(t);
    c.calls += t.calls.length;
    c.refusals += t.calls.filter((x) => x.error?.startsWith('VALIDATION')).length;
    c.badQueries += t.calls.flatMap((x) => x.queries.filter((q) => !q.ok)).length;
    c.noChips += notes.filter((n) => n === 'чипов нет').length;
    c.notConverged += t.turns.filter((x) => !x.converged).length;
    c.inputTokens += t.usage.inputTokens;
    c.outputTokens += t.usage.outputTokens;
    if (
      t.model === PROD_MODEL &&
      t.rep <= PARITY_REPS &&
      (t.variant === 'index' || t.variant === 'catalog')
    ) {
      prod[t.variant].runs += 1;
      if (v.pass) prod[t.variant].pass += 1;
    }
  }
  const verdict = parityVerdict(prod);

  const md: string[] = ['# §С8-30 — индекс аспектов против полного каталога', ''];
  md.push(`| Сценарий | Нормативный блок | ${keys.join(' | ')} |`);
  md.push(`|---|---|${keys.map(() => '---').join('|')}|`);
  const total = new Map<string, Tally>();
  for (const s of SCENARIOS) {
    const cells = keys.map((k) => {
      const c = table.get(s.id)?.get(k);
      if (c === undefined) return '—';
      const t = total.get(k) ?? { pass: 0, runs: 0 };
      total.set(k, { pass: t.pass + c.pass, runs: t.runs + c.runs });
      const mark = c.pass === c.runs ? 'OK' : c.pass === 0 ? '**FAIL**' : 'флак';
      return `${mark} ${c.pass}/${c.runs}`;
    });
    md.push(`| \`${s.id}\` | ${s.block} | ${cells.join(' | ')} |`);
  }
  md.push(
    `| **ИТОГО** | | ${keys.map((k) => `**${total.get(k)?.pass ?? 0}/${total.get(k)?.runs ?? 0}**`).join(' | ')} |`,
  );

  const metrics: [string, (c: Cell) => number][] = [
    ['шагов цикла', (c) => c.steps],
    ['вызовов тулов', (c) => c.calls],
    ['отказов стадии 2', (c) => c.refusals],
    ['неразбираемых запросов', (c) => c.badQueries],
    ['ходов без чипов', (c) => c.noChips],
    ['не сошлось за потолок шагов', (c) => c.notConverged],
    ['input-токенов', (c) => c.inputTokens],
    ['output-токенов', (c) => c.outputTokens],
  ];
  md.push(
    '',
    `| Метрика (сумма по клетке) | ${keys.join(' | ')} |`,
    `|---|${keys.map(() => '---:').join('|')}|`,
  );
  for (const [name, fn] of metrics) {
    const vals = keys.map((k) =>
      [...table.values()].reduce((sum, row) => sum + (row.has(k) ? fn(row.get(k) as Cell) : 0), 0),
    );
    md.push(`| ${name} | ${vals.join(' | ')} |`);
  }

  md.push('', '## Причины падений', '');
  for (const s of SCENARIOS) {
    for (const k of keys) {
      const c = table.get(s.id)?.get(k);
      if (c === undefined || c.fails.length === 0) continue;
      md.push(`- \`${s.id}\` @ ${k} (${c.pass}/${c.runs}): ${[...new Set(c.fails)].join('; ')}`);
    }
  }
  md.push(
    '',
    `## Вердикт (прод-модель ${PROD_MODEL}, повторы 1..${PARITY_REPS})`,
    '',
    verdict.text,
  );
  return { markdown: md.join('\n'), verdict };
}

function printReport(out: string): number {
  const { markdown, verdict } = report(loadTraces(out));
  writeFileSync(join(out, 'report.md'), `${markdown}\n`);
  console.log(markdown);
  return verdict.code;
}

// ---------------------------------------------------------------------------
// Живой прогон
// ---------------------------------------------------------------------------

async function live(args: Args, env: LLMProviderEnv & { DATABASE_URL?: string }): Promise<number> {
  const variant = args.variant as Variant;
  const out = args.out as string;
  // Провайдер — ПЕРВЫМ, до БД: «мерить нечем» не должно стоить сева владельца.
  const choice = selectProvider(
    args.model === undefined ? env : { ...env, ORBIS_LLM_MODEL: args.model },
  );
  if (choice.kind === 'unavailable') {
    console.error(`probe-p3: живого провайдера нет — ${choice.reason}.`);
    console.error('Замер не состоялся (код 2, а не сбой стенда): мерить нечем.');
    return 2;
  }
  if (!isLocalDatabaseUrl(env.DATABASE_URL)) {
    console.error(
      'probe-p3: DATABASE_URL не локальный — стенд заводит своего владельца и пишет только в локальную БД.',
    );
    return 2;
  }
  const provider = choice.provider;
  const list = args.only.length > 0 ? SCENARIOS.filter((s) => args.only.includes(s.id)) : SCENARIOS;
  mkdirSync(out, { recursive: true });
  const path = join(out, `${variant}__${provider.modelId}__r${args.rep}.json`);
  let saved: TraceFile = {};
  try {
    saved = JSON.parse(readFileSync(path, 'utf8')) as TraceFile;
  } catch {
    // файла ещё нет — первая клетка
  }

  const failed = await withStand(async (stand) => {
    console.log(
      `probe-p3: ${variant} · ${provider.modelId} · повтор ${args.rep} · сценариев ${list.length}`,
    );
    for (const s of list) {
      const ch = stand.channels[s.channel];
      const started = Date.now();
      const trace = await runScenario({
        provider,
        reg: stand.channels.reg,
        world: stand.worldFor(s),
        system: ch.system[variant],
        tools: ch.tools,
        opening: ch.opening,
        turns: s.channel === 'routine' ? [null] : s.turns,
        maxSteps: s.channel === 'routine' ? ROUTINE_MAX_STEPS : MAX_AGENT_STEPS,
        ...(s.channel === 'routine' && { terminalTools: TERMINAL_TOOLS }),
        meta: { scenario: s.id, variant, channel: s.channel, rep: args.rep },
      });
      saved[s.id] = trace;
      writeFileSync(path, JSON.stringify(saved, null, 1));
      if (trace.error !== undefined) {
        // Сбой провайдера — не провал сценария: следующие сценарии упали бы так же и стоили бы
        // только времени. Трасса сохранена, отчёт её не считает.
        console.error(`  ${s.id}: ПРОВАЙДЕР — ${trace.error}`);
        return true;
      }
      const v = s.check(trace);
      const notes = commonNotes(trace);
      console.log(
        `${v.pass ? '  OK  ' : ' FAIL '} ${s.id.padEnd(24)} вызовов:${String(trace.calls.length).padStart(2)} ` +
          `in:${trace.usage.inputTokens} out:${trace.usage.outputTokens} ${((Date.now() - started) / 1000).toFixed(0)}s` +
          (v.fails.length > 0 ? `\n        ${v.fails.join('\n        ')}` : '') +
          (notes.length > 0 ? `\n        [прим.] ${notes.join('; ')}` : ''),
      );
    }
    return false;
  });
  if (failed) {
    console.error(
      'Замер не состоялся (код 2): провайдер отказал (кредиты, лимиты, сеть). Повторите клетку целиком.',
    );
    return 2;
  }
  return printReport(out);
}

export async function main(
  argv: readonly string[],
  env: LLMProviderEnv & { DATABASE_URL?: string },
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`probe-p3: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 1;
  }
  try {
    if (args.report) {
      if (args.out === undefined) throw new Error(`--report требует --out\n${USAGE}`);
      return printReport(args.out);
    }
    if (args.dryRun) {
      if (!isLocalDatabaseUrl(env.DATABASE_URL)) {
        console.error(
          'probe-p3: DATABASE_URL не локальный — стенд пишет своего владельца только в локальную БД.',
        );
        return 2;
      }
      return await dryRun();
    }
    if (args.variant === undefined || args.out === undefined) {
      console.error(`probe-p3: живому прогону нужны --variant и --out\n${USAGE}`);
      return 1;
    }
    return await live(args, env);
  } catch (e) {
    console.error('probe-p3: сбой стенда —', e);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env));
}
