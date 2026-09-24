// Стенд §С8-30 — tool-цикл и заглушка исполнителя (перенос `.superpowers/probe/p3/runner.ts`).
//
// ЧТО ИЗ ПРОДА, А ЧТО СВОЁ. Цикл повторяет боевой (`ai/send-message.ts`): тот же провайдер,
// тот же потолок ответа (`MAX_OUTPUT_TOKENS`), тот же потолок шагов, тот же сериализатор
// результата тула (`toolResultMessage`) и та же форма ответа (`{status, result|error}`).
// Своё здесь ровно одно — ИСПОЛНИТЕЛЬ: вместо БД — мир в памяти (`world.ts`), потому что
// детерминированный мир — единственный способ сделать расхождение двух каналов расхождением
// каналов, а не данных.
//
// СТАДИЯ 2 НЕ ПОДДЕЛАНА. Заглушка не судит запись сама: она собирает патч, проверяет права и
// валидирует ИТОГОВОЕ состояние теми же функциями, что и исполнитель (`propsPatchFromInput`,
// `replaceAspectProps`, `assertPropsWritable`, `assertEntityProps` — `executor/`). Прежний
// стенд звал снятые реформой zod-схемы аспектов (`ASPECT_SCHEMAS`); после реформы вторая,
// «стендовая» валидация разошлась бы с боевой на первом же новом свойстве. Запросы
// разбираются настоящим разбором (`parseQueryAst` — вместо снятого `parseQuery`).
//
// ЧЕГО ЗАГЛУШКА НЕ ДЕЛАЕТ (и почему это не искажает сравнение): отношения, реестровые тулы и
// прочие мутации, которых нет в сценариях, отвечают `{ok: true}`; реляционные узлы, контракты
// и date-токены запроса выборку НЕ сужают (трёхзначная логика ниже) — мир из шести сущностей,
// и лишняя строка выдачи обоим вариантам одинакова.
import {
  attachToolName,
  MAX_AGENT_STEPS,
  OWNER_LOCALE,
  type PropertyDefinition,
  queryAstSchema,
} from '@orbis/shared';
import {
  normalizeQueryAst,
  type ParseRegistry,
  parseQueryAst,
  type QueryAst,
  type QueryFilterNode,
  toParseRegistry,
} from '@orbis/shared/query';
import { MAX_OUTPUT_TOKENS } from '../../apps/server/src/ai/send-message.ts';
import { SUGGEST_MARKER_RE } from '../../apps/server/src/ai/suggestions.ts';
import { ExecError } from '../../apps/server/src/errors.ts';
import { assertEntityProps } from '../../apps/server/src/executor/aspects-validate.ts';
import {
  applyPropsPatch,
  assertPropsWritable,
  type EntityState,
  type PropsPatch,
  propsPatchFromInput,
  replaceAspectProps,
  resolvePropertyRef,
  touchedProperties,
  writableOnly,
} from '../../apps/server/src/executor/props.ts';
import { toolResultMessage } from '../../apps/server/src/llm/context.ts';
import { type LLMProviderEnv, makeLLMProvider } from '../../apps/server/src/llm/provider.ts';
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMToolDef,
} from '../../apps/server/src/llm/types.ts';
import type { RegistrySnapshot } from '../../apps/server/src/registry/load.ts';
import { BUDGET_STATUS, seedWorld, type WorldEntity } from './world.ts';

// ---------------------------------------------------------------------------
// Провайдер: два исхода вместо трёх
// ---------------------------------------------------------------------------

export type ProviderChoice =
  | { kind: 'live'; provider: LLMProvider }
  | { kind: 'unavailable'; reason: string };

/**
 * Выбор провайдера, приведённый к двум исходам (образец — `chooseProvider` пробы П4).
 *
 * `makeLLMProvider` отвечает на «ключа нет» двумя способами: вне production без ключей отдаёт
 * `EchoProvider`, а при ЯВНОМ `ORBIS_LLM_PROVIDER` без ключа — БРОСАЕТ. Боевой `.env`
 * провайдер прописывает, то есть живьём срабатывает вторая ветка, и непойманное исключение
 * дало бы код 1 («стенд сломался») там, где правда — код 2 («мерить нечем»). Echo мерить тоже
 * нечем: он не зовёт тулы и не считает токены.
 */
export function selectProvider(env: LLMProviderEnv): ProviderChoice {
  let provider: LLMProvider;
  try {
    provider = makeLLMProvider(env);
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
  if (provider.modelId === 'echo') {
    return {
      kind: 'unavailable',
      reason: 'выбран EchoProvider — он не зовёт тулы и не считает токены (inputTokens = 0)',
    };
  }
  return { kind: 'live', provider };
}

// ---------------------------------------------------------------------------
// Трасса
// ---------------------------------------------------------------------------

export interface TraceQuery {
  /** Путь в аргументах вызова: `entity_query.query`, `batch_execute.operations.0.input.ast`. */
  where: string;
  /** Текст запроса либо JSON дерева `ast`. */
  text: string;
  ok: boolean;
  error?: string;
  /** Разобранное и приведённое к id дерево — по нему судят предикаты, а не по тексту. */
  ast?: QueryAst;
}

export interface TraceCall {
  turn: number;
  step: number;
  name: string;
  args: Record<string, unknown>;
  queries: TraceQuery[];
  /** У `attach_*` — id аспекта: имя тула обратно в id не нормализуется («-» и «/» склеены). */
  aspect?: string;
  /** Отказ заглушки в форме `КОД: сообщение` (VALIDATION, COMPUTED_WRITE, NOT_FOUND). */
  error?: string;
  /** Шаг пришёл внутри batch_execute — в счёт шагов цикла не идёт. */
  viaBatch?: boolean;
}

export interface TraceTurn {
  user: string;
  final: string;
  converged: boolean;
  /** Сырые чипы продолжений (до капов боевого разбора); null — маркера нет. */
  chips: string[] | null;
}

export interface Trace {
  scenario: string;
  variant: string;
  channel: 'chat' | 'routine';
  model: string;
  rep: number;
  /** id сущностей мира ДО прогона: «создано» = всё, чего здесь нет. */
  seeded: string[];
  calls: TraceCall[];
  turns: TraceTurn[];
  entities: WorldEntity[];
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
}

// ---------------------------------------------------------------------------
// Оценка запроса на мире: трёхзначная логика
// ---------------------------------------------------------------------------

/** true / false — узел решён; undefined — заглушка его не моделирует (не сужает выборку). */
type Tri = boolean | undefined;

function scalarEq(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    // decimal-строки: «500» и «500.00» — одна сумма (правило типа, `comparePropertyValue`)
    const x = Number(a);
    const y = Number(b);
    if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y)) {
      return x === y;
    }
  }
  return String(a) === String(b);
}

function valueEq(entityValue: unknown, wanted: unknown): boolean {
  if (Array.isArray(entityValue)) return entityValue.some((v) => scalarEq(v, wanted));
  return entityValue !== undefined && scalarEq(entityValue, wanted);
}

function evalNode(node: QueryFilterNode, e: WorldEntity): Tri {
  if ('and' in node) {
    const vs = node.and.map((n) => evalNode(n, e));
    if (vs.includes(false)) return false;
    return vs.includes(undefined) ? undefined : true;
  }
  if ('or' in node) {
    const vs = node.or.map((n) => evalNode(n, e));
    if (vs.includes(true)) return true;
    return vs.includes(undefined) ? undefined : false;
  }
  if ('not' in node) {
    const v = evalNode(node.not, e);
    return v === undefined ? undefined : !v;
  }
  if ('aspect' in node) return e.aspects.includes(node.aspect);
  if ('tag' in node) return e.tags.includes(node.tag);
  if ('has' in node) return e.props[node.has] !== undefined;
  if ('search' in node) {
    const hay = [
      e.title,
      e.body,
      ...Object.values(e.props)
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .map(String),
    ]
      .join(' ')
      .toLowerCase();
    return node.search
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w !== '' && hay.includes(w));
  }
  if ('archived' in node) return node.archived === 'any';
  if ('prop' in node) {
    const v = e.props[node.prop];
    switch (node.op) {
      case 'eq':
        return typeof node.value === 'object' ? undefined : valueEq(v, node.value);
      case 'ne':
        return typeof node.value === 'object' ? undefined : !valueEq(v, node.value);
      case 'in':
        return Array.isArray(node.value) ? node.value.some((x) => valueEq(v, x)) : undefined;
      case 'contains':
        if (Array.isArray(v)) return v.some((x) => scalarEq(x, node.value));
        return typeof v === 'string'
          ? v.toLowerCase().includes(String(node.value).toLowerCase())
          : false;
      default:
        // gt/lt/range и date-токены — не моделируются: зависят от «сегодня» и типа, а
        // сценарии о них не спрашивают.
        return undefined;
    }
  }
  // rel, class — рёбер и контрактов у мира-заглушки нет
  return undefined;
}

function matches(ast: QueryAst, e: WorldEntity): boolean {
  return ast.filter === null || evalNode(ast.filter, e) !== false;
}

// ---------------------------------------------------------------------------
// Разбор запросов в аргументах
// ---------------------------------------------------------------------------

type Parsed = { ok: true; ast: QueryAst } | { ok: false; error: string };

function parseText(text: string, parseReg: ParseRegistry): Parsed {
  const r = parseQueryAst(text, parseReg);
  return r.ok
    ? { ok: true, ast: r.ast }
    : { ok: false, error: `${r.error.code}: ${r.error.message}` };
}

function parseTree(raw: unknown, parseReg: ParseRegistry): Parsed {
  const r = queryAstSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: `дерево не по канону: ${r.error.issues[0]?.message}` };
  try {
    return { ok: true, ast: normalizeQueryAst(r.data, parseReg) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Все запросы в аргументах вызова: строки `query` (текст грамматики) и объекты `ast` (дерево
 * входа `entity_query`). Дерево ВНУТРИ значения свойства (`orbis/progress_source.query`) сюда не
 * попадает: его судит стадия 2 записи, а не разбор запроса.
 */
export function collectQueries(parseReg: ParseRegistry, name: string, args: unknown): TraceQuery[] {
  const out: TraceQuery[] = [];
  const walk = (n: unknown, path: string) => {
    if (n === null || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      const where = `${path}.${k}`;
      if (k === 'query' && typeof v === 'string') {
        const p = parseText(v, parseReg);
        out.push(
          p.ok
            ? { where, text: v, ok: true, ast: p.ast }
            : { where, text: v, ok: false, error: p.error },
        );
        continue;
      }
      if (k === 'ast' && typeof v === 'object' && v !== null) {
        const p = parseTree(v, parseReg);
        const text = JSON.stringify(v);
        out.push(
          p.ok ? { where, text, ok: true, ast: p.ast } : { where, text, ok: false, error: p.error },
        );
        continue;
      }
      // Значения свойств не обходятся: дерево цели — не запрос выборки (см. докблок).
      if (k === 'props' || k === 'data') continue;
      walk(v, where);
    }
  };
  walk(args, name);
  return out;
}

// ---------------------------------------------------------------------------
// Заглушка исполнителя
// ---------------------------------------------------------------------------

export type ToolPayload =
  | { status: 'ok'; result: unknown }
  | { status: 'error'; error: { code: string; message: string } };

interface SubCall {
  name: string;
  args: Record<string, unknown>;
  error?: string;
}

/** Механизм записи чата и рутины — тот же, под которым их правку судит гейт прав (§А2-5). */
const MECHANISM = 'user';

export class StubExecutor {
  readonly parseReg: ParseRegistry;
  /** Имя `attach_*`-тула → id аспекта (та же формула имени, что у реестра тулов). */
  private readonly attachAspect: Map<string, string>;
  /** Операции последнего batch_execute — трасса судит о шагах, а не об имени обёртки. */
  subCalls: SubCall[] = [];

  constructor(
    readonly reg: RegistrySnapshot,
    public world: Map<string, WorldEntity>,
  ) {
    this.parseReg = toParseRegistry(reg, OWNER_LOCALE);
    this.attachAspect = new Map(
      [...reg.aspects.values()].filter((a) => !a.service).map((a) => [attachToolName(a.key), a.id]),
    );
  }

  aspectOfTool(name: string): string | undefined {
    return this.attachAspect.get(name);
  }

  /** Вызов тула в форме боевого ответа (`{status, result|error}` — `runToolCall`). */
  call(name: string, args: Record<string, unknown>): ToolPayload {
    try {
      return { status: 'ok', result: this.run(name, args) };
    } catch (e) {
      if (e instanceof ExecError)
        return { status: 'error', error: { code: e.code, message: e.message } };
      throw e;
    }
  }

  /** Проекция сущности для модели — плоско по key (`toLlmEntity`). */
  project(e: WorldEntity) {
    const props: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(e.props))
      props[this.reg.properties.get(id)?.key ?? id] = v;
    return {
      id: e.id,
      title: e.title,
      emoji: null,
      body: e.body,
      tags: e.tags,
      props,
      aspects: e.aspects,
      archived: false,
    };
  }

  private run(name: string, args: Record<string, unknown>): unknown {
    if (name === 'batch_execute') return this.batch(args);
    if (name === 'entity_query') return this.query(args);
    if (name === 'user_query') return this.aggregate(args);
    if (name === 'budget_status') return BUDGET_STATUS;
    if (name === 'entity_get') return this.project(this.entity(args.id));
    if (name === 'entity_create') return this.create(args);
    if (name === 'entity_update') return this.update(args);
    const aspectId = this.attachAspect.get(name);
    if (aspectId !== undefined) return this.attach(aspectId, args);
    return { ok: true };
  }

  private entity(id: unknown): WorldEntity {
    const e = typeof id === 'string' ? this.world.get(id) : undefined;
    if (e === undefined) throw new ExecError('NOT_FOUND', `сущности с id ${String(id)} нет`);
    return e;
  }

  private queryAst(args: Record<string, unknown>): QueryAst {
    const p =
      typeof args.query === 'string'
        ? parseText(args.query, this.parseReg)
        : args.ast !== undefined
          ? parseTree(args.ast, this.parseReg)
          : ({ ok: false, error: 'нужен query либо ast' } as const);
    if (!p.ok) throw new ExecError('VALIDATION', `запрос не разбирается: ${p.error}`);
    return p.ast;
  }

  private query(args: Record<string, unknown>): unknown {
    const ast = this.queryAst(args);
    const hits = [...this.world.values()].filter((e) => matches(ast, e));
    return hits.slice(0, ast.limit ?? hits.length).map((e) => this.project(e));
  }

  private aggregate(args: Record<string, unknown>): unknown {
    const hits = [...this.world.values()].filter((e) => matches(this.queryAst(args), e));
    if (args.aggregate === 'count') return hits.length;
    const field =
      typeof args.field === 'string' ? resolvePropertyRef(this.reg, args.field)?.id : undefined;
    if (field === undefined)
      throw new ExecError('VALIDATION', 'user_query: aggregate=sum требует field');
    return String(hits.reduce((s, e) => s + (Number(e.props[field]) || 0), 0));
  }

  /**
   * Стадия 2 на итоговом состоянии + существование ссылок. Ссылка проверяется на наличие в мире и,
   * где цель — один аспект (`orbis/finance_category` → `orbis/category`), на членство в цели:
   * исполнитель компилирует `ref.target` полностью, у мира заглушки есть только аспекты.
   */
  private settle(cur: EntityState, patch: PropsPatch): EntityState {
    assertPropsWritable(this.reg, MECHANISM, patch);
    const next = applyPropsPatch(cur, patch);
    assertEntityProps(this.reg, next, touchedProperties(patch));
    for (const id of Object.keys(patch.set ?? {})) {
      const def = this.reg.properties.get(id);
      if (def?.type.kind === 'ref') this.assertRefs(def, next.props[id]);
    }
    return next;
  }

  private assertRefs(def: PropertyDefinition, value: unknown): void {
    if (def.type.kind !== 'ref') return;
    const target = def.type.target;
    const aspect =
      target !== undefined &&
      !Array.isArray(target) &&
      target.filter !== null &&
      'aspect' in target.filter
        ? target.filter.aspect
        : undefined;
    for (const ref of Array.isArray(value) ? value : [value]) {
      const e = typeof ref === 'string' ? this.world.get(ref) : undefined;
      if (e === undefined) {
        throw new ExecError(
          'VALIDATION',
          `«${def.key}»: сущности с id ${String(ref)} не существует`,
        );
      }
      if (aspect !== undefined && !e.aspects.includes(aspect)) {
        throw new ExecError(
          'VALIDATION',
          `«${def.key}»: сущность ${e.id} не из множества цели (${aspect})`,
        );
      }
    }
  }

  private create(args: Record<string, unknown>): unknown {
    if (typeof args.title !== 'string' || args.title === '') {
      throw new ExecError('VALIDATION', 'entity_create: title обязателен');
    }
    if (args.aspects !== undefined && !Array.isArray(args.aspects)) {
      throw new ExecError('VALIDATION', 'entity_create: aspects — список id аспектов');
    }
    const id = typeof args.id === 'string' ? args.id : crypto.randomUUID();
    const existing = this.world.get(id);
    // Идемпотентность повтора по id — как у боевого исполнителя: второй раз не заводится.
    if (existing !== undefined) return this.project(existing);
    const patch = propsPatchFromInput(this.reg, {
      props: args.props as Record<string, unknown> | undefined,
      aspects: args.aspects as string[] | undefined,
    });
    const state = this.settle({ props: {}, aspects: [] }, patch);
    const e: WorldEntity = {
      id,
      title: args.title,
      body: typeof args.body === 'string' ? args.body : '',
      tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
      ...state,
    };
    this.world.set(id, e);
    // Боевой исполнитель возвращает ЦЕЛУЮ сущность: без неё модель не видит записанного и
    // «подтверждает» его лишним attach (наблюдалось в П3 до этой правки).
    return this.project(e);
  }

  private update(args: Record<string, unknown>): unknown {
    const e = this.entity(args.id);
    const patch = propsPatchFromInput(this.reg, {
      props: args.props as Record<string, unknown> | undefined,
      unset: args.unset as string[] | undefined,
      aspects: args.aspects as { attach?: string[]; detach?: string[] } | undefined,
    });
    const state = this.settle({ props: e.props, aspects: e.aspects }, patch);
    if (typeof args.title === 'string') e.title = args.title;
    if (typeof args.body === 'string') e.body = args.body;
    if (Array.isArray(args.tags)) e.tags = args.tags as string[];
    e.props = state.props;
    e.aspects = state.aspects;
    return this.project(e);
  }

  private attach(aspectId: string, args: Record<string, unknown>): unknown {
    const e = this.entity(args.entity_id);
    const data = (args.data ?? {}) as Record<string, unknown>;
    const patch = replaceAspectProps(
      this.reg,
      { props: e.props, aspects: e.aspects },
      aspectId,
      data,
    );
    // Замена носителя снимает только то, чем механизм вправе распоряжаться (`writableOnly`).
    patch.replaced = writableOnly(this.reg, MECHANISM, patch.replaced);
    const state = this.settle({ props: e.props, aspects: e.aspects }, patch);
    e.props = state.props;
    e.aspects = state.aspects;
    return this.project(e);
  }

  /**
   * batch_execute — настоящий тул, и модель им пользуется. Атомарно, как боевой: операция с
   * отказом откатывает всю группу. Заглушка `{ok: true}` молча теряла бы операции, и модель
   * рапортовала бы о несделанном (наблюдалось в П3).
   */
  private batch(args: Record<string, unknown>): unknown {
    const ops = (Array.isArray(args.operations) ? args.operations : []) as {
      tool?: unknown;
      input?: unknown;
    }[];
    const before = structuredClone(this.world);
    const results: unknown[] = [];
    this.subCalls = [];
    for (const [i, op] of ops.entries()) {
      const tool = String(op.tool);
      const input = (op.input ?? {}) as Record<string, unknown>;
      const r = this.call(tool, input);
      this.subCalls.push({
        name: tool,
        args: input,
        ...(r.status === 'error' && { error: `${r.error.code}: ${r.error.message}` }),
      });
      if (r.status === 'error') {
        this.world = before;
        throw new ExecError(
          r.error.code as ExecError['code'],
          `операция ${i + 1} (${tool}): ${r.error.message}`,
        );
      }
      results.push(r.result);
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Цикл
// ---------------------------------------------------------------------------

/** Чипы продолжений — маркером боевого разбора, но СЫРЫЕ: капы меряются, а не применяются. */
export function chipsOf(text: string): string[] | null {
  const body = SUGGEST_MARKER_RE.exec(text)?.[1];
  if (body === undefined) return null;
  return body
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function record(
  exec: StubExecutor,
  trace: Trace,
  at: { turn: number; step: number },
  name: string,
  args: Record<string, unknown>,
): ToolPayload {
  exec.subCalls = [];
  const payload = exec.call(name, args);
  const aspect = exec.aspectOfTool(name);
  trace.calls.push({
    ...at,
    name,
    args,
    queries: collectQueries(exec.parseReg, name, args),
    ...(aspect !== undefined && { aspect }),
    ...(payload.status === 'error' && { error: `${payload.error.code}: ${payload.error.message}` }),
  });
  for (const sub of name === 'batch_execute' ? exec.subCalls : []) {
    const subAspect = exec.aspectOfTool(sub.name);
    trace.calls.push({
      ...at,
      name: sub.name,
      args: sub.args,
      queries: collectQueries(exec.parseReg, sub.name, sub.args),
      ...(subAspect !== undefined && { aspect: subAspect }),
      ...(sub.error !== undefined && { error: sub.error }),
      viaBatch: true,
    });
  }
  return payload;
}

function emptyTrace(world: Map<string, WorldEntity>, meta: Partial<Trace>): Trace {
  return {
    scenario: meta.scenario ?? '(replay)',
    variant: meta.variant ?? '-',
    channel: meta.channel ?? 'chat',
    model: meta.model ?? '-',
    rep: meta.rep ?? 1,
    seeded: [...world.keys()],
    calls: [],
    turns: [],
    entities: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/**
 * Проигрывание заданных вызовов через заглушку — без модели. Нужен тесту предикатов: трасса
 * строится тем же исполнителем, что в живом прогоне, а не руками, и предикат судит настоящее
 * состояние мира после стадии 2.
 */
export function replay(
  reg: RegistrySnapshot,
  calls: readonly { name: string; args: Record<string, unknown> }[],
  opts: { world?: Map<string, WorldEntity> } = {},
): Trace {
  const exec = new StubExecutor(reg, opts.world ?? seedWorld());
  const trace = emptyTrace(exec.world, {});
  for (const [i, c] of calls.entries())
    record(exec, trace, { turn: 0, step: i + 1 }, c.name, c.args);
  trace.turns.push({ user: '', final: '', converged: true, chips: null });
  trace.entities = [...exec.world.values()];
  return trace;
}

export interface RunOptions {
  provider: LLMProvider;
  reg: RegistrySnapshot;
  world: Map<string, WorldEntity>;
  system: string;
  tools: LLMToolDef[];
  /** Начало разговора от канала: пусто у чата, история и «сработала рутина» — у рутины. */
  opening: LLMMessage[];
  /** Реплики владельца; null — ход без реплики (его открыл канал). */
  turns: (string | null)[];
  maxSteps?: number;
  meta: Pick<Trace, 'scenario' | 'variant' | 'channel' | 'rep'>;
}

/**
 * Прогон сценария: боевой цикл `sendMessage` над заглушкой. Сбой провайдера не бросается, а
 * ложится в `trace.error`: стенд обязан отличить «модель ответила плохо» от «модель не
 * ответила» — второе не замер (код 2), а не провал сценария.
 */
export async function runScenario(opts: RunOptions): Promise<Trace> {
  const exec = new StubExecutor(opts.reg, opts.world);
  const trace = emptyTrace(exec.world, { ...opts.meta, model: opts.provider.modelId });
  const messages: LLMMessage[] = [...opts.opening];
  const maxSteps = opts.maxSteps ?? MAX_AGENT_STEPS;

  try {
    for (const [t, user] of opts.turns.entries()) {
      if (user !== null) messages.push({ role: 'user', content: user });
      let converged = false;
      let final = '';
      for (let step = 1; ; step++) {
        const res: LLMResponse = await opts.provider.chat({
          system: opts.system,
          messages,
          tools: opts.tools,
          maxTokens: MAX_OUTPUT_TOKENS,
        });
        trace.usage.inputTokens += res.usage.inputTokens;
        trace.usage.outputTokens += res.usage.outputTokens;
        if (res.stopReason !== 'tool_use' || res.toolCalls.length === 0) {
          converged = res.stopReason !== 'max_tokens';
          final = res.content;
          messages.push({ role: 'assistant', content: res.content });
          break;
        }
        // Шаг-нарушитель лимита не исполняется — как в бою (`STEP_LIMIT_NOTE`).
        if (step >= maxSteps) {
          final = res.content;
          break;
        }
        if (res.content) messages.push({ role: 'assistant', content: res.content });
        for (const call of res.toolCalls) {
          const payload = record(exec, trace, { turn: t, step }, call.name, call.input);
          messages.push(toolResultMessage(call.name, payload));
        }
      }
      trace.turns.push({
        user: user ?? '(сработала рутина)',
        final,
        converged,
        chips: chipsOf(final),
      });
    }
  } catch (e) {
    trace.error = e instanceof Error ? `${e.name}: ${e.message.slice(0, 400)}` : String(e);
  }
  trace.entities = [...exec.world.values()];
  return trace;
}
