// Стенд §С8-30 — два варианта системного канала: ИНДЕКС (прод) и полный КАТАЛОГ (откат).
//
// ЧТО СРАВНИВАЕТСЯ (§Б7-2 спеки реформы, спека 1а §10 п. 4). Прод после среза 1а кладёт в канал
// индекс аспектов — «id, подпись, описание»; поля и правила аспекта модель читает в описании и
// схеме тула `attach_<аспект>`. Названный риск (П3 §7.4): индекс не гонялся по сценариям.
// Приёмка — паритет индекса с ПОЛНЫМ КАТАЛОГОМ (в П3 полный каталог держал 34/36 на прод-модели);
// регрессия, не лечимая рамкой, — откат, названный заранее: «каталог аспектов + подгрузка по
// релевантности».
//
// ВАРИАНТЫ ОТЛИЧАЮТСЯ РОВНО ОДНОЙ СЕКЦИЕЙ. `index` — это прод-канал без единой правки: тот
// самый `buildContext` (чат) и `buildRoutineContext` (рутина) на графе владельца стенда. `catalog`
// — он же плюс секция каталога сразу за индексом; всё прочее побайтно равно (`withCatalog`,
// тест (б)). Сравнивать с каталогом, собранным ДРУГОЙ рамкой (как `gen` П3), значило бы
// мерить рамку, а не индекс.
//
// СЕКЦИЯ КАТАЛОГА — по образцу `aspectCatalogSection` черновика П3 (`gen-prompt.ts`), но из
// ЭФФЕКТИВНОГО реестра после реформы: тип поля рендерится из словаря свойств (`PropertyType`), а
// не угадывается по регулярке схемы, дискриминируемый союз — из схемы json-свойства (Б7-3),
// порядок аспектов и полей — `rank` (§Б7-3), маска модулей и граница служебных — те же, что у
// индекса и тулов. Вычисляемые сервером свойства не печатаются — их нет и в схеме `attach_*`.
import {
  type AspectDefinition,
  AUTHORING_DEFERRED_ASPECTS,
  effectiveLabel,
  isModuleEnabled,
  OWNER_LOCALE,
  type PropertyType,
  writableFromTool,
} from '@orbis/shared';
import { routineById } from '../../apps/server/src/agent-loop/queries.ts';
import { chatToolSurface } from '../../apps/server/src/ai/send-message.ts';
import { ensureGlobalThread } from '../../apps/server/src/chat/threads.ts';
import type { Db } from '../../apps/server/src/db/client.ts';
import { withIdentity } from '../../apps/server/src/db/with-identity.ts';
import { execute } from '../../apps/server/src/executor/executor.ts';
import { type Identity, identityOfPerson, parseAccountId } from '../../apps/server/src/identity.ts';
import { ASPECT_INDEX_HEADING } from '../../apps/server/src/llm/aspect-index.ts';
import { buildContext } from '../../apps/server/src/llm/context.ts';
import type { LLMMessage, LLMToolDef } from '../../apps/server/src/llm/types.ts';
import {
  ROUTINE_MODE_PROPERTY,
  ROUTINE_TOOLS_PROPERTY,
} from '../../apps/server/src/policy/confirmation.ts';
import { effectiveRegistry } from '../../apps/server/src/registry/cache.ts';
import type { RegistrySnapshot } from '../../apps/server/src/registry/load.ts';
import { disabledModulesOf } from '../../apps/server/src/registry/modules.ts';
import { buildRoutineContext } from '../../apps/server/src/routines/context.ts';
import { routineHistory } from '../../apps/server/src/routines/lifecycle.ts';
import { seedRoutineId } from '../../apps/server/src/seed/gardener.ts';
import { seedOwner } from '../../apps/server/src/seed/onboarding.ts';
import {
  buildToolRegistry,
  type OrbisToolDef,
  type RoutineRef,
  routineToolDefs,
} from '../../apps/server/src/tools/registry.ts';
import { PROBE_NOW, probeClock, TRIGGER_PROPS, TRIGGER_TITLE } from './world.ts';

export const VARIANTS = ['index', 'catalog'] as const;
export type Variant = (typeof VARIANTS)[number];

/** Разделитель секций канала — тот же, что у обоих сборщиков (`llm/context.ts`, `routines/context.ts`). */
const SECTION_SEPARATOR = '\n\n';

export const CATALOG_HEADING =
  'Аспекты реестра, их поля и правила (звёздочка — поле обязательно; поля, которого здесь нет, не изобретай — валидация отвергнет запись):';

// ---------------------------------------------------------------------------
// Секция каталога (чистая часть)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Плоская форма ветки союза из JSON-схемы: «query*, aggregate*=count». */
function shape(o: Json): string {
  const props = (o.properties ?? {}) as Record<string, Json>;
  const required = new Set((o.required ?? []) as string[]);
  return Object.entries(props)
    .map(([name, p]) => {
      const star = required.has(name) ? '*' : '';
      if (p.const !== undefined) return `${name}${star}=${String(p.const)}`;
      if (Array.isArray(p.enum)) return `${name}${star} enum ${p.enum.join('|')}`;
      return `${name}${star}`;
    })
    .join(', ');
}

/** Цель ссылки, когда она — один аспект (`orbis/finance_category` → `orbis/category`). */
function refAspect(type: Extract<PropertyType, { kind: 'ref' }>): string | undefined {
  const t = type.target;
  if (t === undefined || Array.isArray(t) || t.filter === null) return undefined;
  return 'aspect' in t.filter ? t.filter.aspect : undefined;
}

/** Человеческое имя типа — из словаря свойств, а не из регулярки схемы (Б7-3). */
export function typeLabel(type: PropertyType): string {
  const base = ((): string => {
    switch (type.kind) {
      case 'text':
        return type.format === undefined ? 'текст' : `текст (${type.format})`;
      case 'number':
        return `${type.integer === true ? 'целое' : 'число'}${type.min === undefined ? '' : ` ≥ ${type.min}`}`;
      case 'decimal':
        if (type.exclusiveMin !== undefined) return `decimal-строка > ${type.exclusiveMin}`;
        return type.min === undefined ? 'decimal-строка' : `decimal-строка ≥ ${type.min}`;
      case 'boolean':
        return 'boolean';
      case 'date':
        return 'дата YYYY-MM-DD';
      case 'timestamp':
        return 'момент ISO 8601 с таймзоной';
      case 'time':
        return 'время ЧЧ:ММ';
      case 'select':
        return `enum ${type.options.map((o) => o.key).join('|')}`;
      case 'ref': {
        const aspect = refAspect(type);
        return aspect === undefined ? 'ссылка uuid' : `ссылка uuid на ${aspect}`;
      }
      case 'json': {
        const branches = type.schema?.anyOf;
        return Array.isArray(branches)
          ? `один из ${(branches as Json[]).map((b) => `{${shape(b)}}`).join(' ИЛИ ')}`
          : 'объект';
      }
      case 'grant':
        return 'доступ';
      case 'registry_ref':
        return `ссылка на ${type.target} реестра`;
    }
  })();
  const many = 'cardinality' in type && type.cardinality === 'many';
  return many ? `список<${base}>` : base;
}

/**
 * Аспекты, которые видит модель: неслужебные, не отложенные для модели (`AUTHORING_DEFERRED_ASPECTS`,
 * РП-1 — страница), включённого модуля, по rank — как у индекса (`aspectIndexLines`).
 */
function visibleAspects(reg: RegistrySnapshot, disabled: readonly string[]): AspectDefinition[] {
  return [...reg.aspects.values()]
    .filter((a) => !a.service)
    .filter((a) => !AUTHORING_DEFERRED_ASPECTS.includes(a.id))
    .filter((a) => isModuleEnabled(a.module, disabled))
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
}

/** Полный каталог: по аспекту — строка индекса, его поля с типами и обязательностью, правила. */
export function catalogSection(reg: RegistrySnapshot, disabled: readonly string[]): string {
  const lines = [CATALOG_HEADING];
  for (const a of visibleAspects(reg, disabled)) {
    lines.push(
      `- ${a.id} — ${effectiveLabel(a.label, OWNER_LOCALE)}: ${effectiveLabel(a.description, OWNER_LOCALE)}`,
    );
    const fields = [...a.properties]
      .sort((x, y) => x.rank - y.rank)
      .flatMap((ref) => {
        const def = reg.properties.get(ref.propertyId);
        if (def === undefined || !writableFromTool(def)) return [];
        return [`${def.key}${ref.required ? '*' : ''} ${typeLabel(def.type)}`];
      });
    if (fields.length > 0) lines.push(`  поля: ${fields.join('; ')}`);
    if (a.aiInstructions) lines.push(`  правила: ${a.aiInstructions}`);
  }
  return lines.join('\n');
}

/**
 * Канал варианта `catalog`: секция каталога встаёт СРАЗУ за индексом, всё прочее — байт в байт.
 *
 * Канал без индекса (или с двумя) — отказ, а не «каталог куда-нибудь»: вариант без индекса
 * сравнивал бы каталог с пустотой, и паритет получался бы из воздуха.
 */
export function withCatalog(system: string, section: string): string {
  const at = system.indexOf(ASPECT_INDEX_HEADING);
  if (at === -1 || system.indexOf(ASPECT_INDEX_HEADING, at + 1) !== -1) {
    throw new Error('withCatalog: в канале нет ровно одной секции индекса аспектов');
  }
  const end = system.indexOf(SECTION_SEPARATOR, at);
  const cut = end === -1 ? system.length : end;
  return `${system.slice(0, cut)}${SECTION_SEPARATOR}${section}${system.slice(cut)}`;
}

// ---------------------------------------------------------------------------
// Граница БД
// ---------------------------------------------------------------------------

/**
 * Стенд заводит СВОЕГО владельца (сид мира, рутина-триггер) — то есть пишет. Поэтому он работает
 * только на локальной базе: владелец пробы в проде — мусор в данных, которые прод не чистит.
 */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface ProbeOwner {
  who: Identity;
  /** Глобальный тред владельца — тред, в котором идёт разговор канала чата. */
  threadId: string;
}

/**
 * Свежий владелец стенда: боевой сид мира (`seedOwner`) на СЛУЧАЙНОМ графе — чужих данных стенд
 * не трогает. `seeded: false` значило бы, что граф не наш, и канал собрался бы по чужому реестру.
 */
export async function probeOwner(db: Db): Promise<ProbeOwner> {
  const who = identityOfPerson(parseAccountId(crypto.randomUUID()));
  const seeded = await seedOwner(db, who);
  if (!seeded.seeded) throw new Error('сид владельца стенда вернул seeded: false — граф не наш');
  const threadId = await withIdentity(db, who, (tx) => ensureGlobalThread(tx, who.graph));
  return { who, threadId };
}

/**
 * Рутина-триггер канала рутины (диагностика В-6): её тело — инструкция сценария, и
 * `buildRoutineContext` ставит её якорем. Заводится исполнителем, как садовник: якорь канал
 * читает из БД (`anchorBlock`), и рутина, которой нет в графе, канал бы не собрала.
 */
export async function seedTrigger(db: Db, who: Identity, body: string): Promise<string> {
  const id = seedRoutineId(who.graph, 'probe-p3-trigger');
  const r = await execute(db, {
    identity: who,
    actorKind: 'owner',
    source: 'system',
    mechanism: 'seed',
    operations: [
      {
        tool: 'entity_create',
        input: {
          id,
          title: TRIGGER_TITLE,
          body,
          tags: ['routine'],
          aspects: ['orbis/routine'],
          props: { ...TRIGGER_PROPS },
        },
      },
    ],
  });
  if (!r.ok) throw new Error(`сев рутины-триггера: ${r.error.code} ${r.error.message}`);
  return id;
}

/**
 * Ссылка рутины для правила доступа к тулам — теми же полями, что собирает раннер
 * (`routines/runner.ts`): режим и белый список из значений рутины. От `runId` правило не
 * зависит; он нужен только форме `RoutineRef`.
 */
export function routineRefOf(
  id: string,
  runId: string,
  // `object`, а не `Record`: значения рутины из БД типизированы интерфейсом (`RoutineProps`), а
  // интерфейс к индексной сигнатуре не присваивается (см. `TicketProps`, agent-loop/queries.ts).
  routineProps: object,
): RoutineRef {
  const props = routineProps as Readonly<Record<string, unknown>>;
  const allowed = props[ROUTINE_TOOLS_PROPERTY];
  return {
    id,
    runId,
    mode: props[ROUTINE_MODE_PROPERTY] === 'act' ? 'act' : 'propose',
    allowedTools: new Set(Array.isArray(allowed) ? allowed.map(String) : []),
  };
}

/** Тулы рутины в форме провайдера — `routineToolDefs` прода, как в `routines/runner.ts`. */
export function routineSurface(defs: readonly OrbisToolDef[], ref: RoutineRef): LLMToolDef[] {
  return routineToolDefs([...defs], ref).map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputJsonSchema,
  }));
}

export interface Channel {
  /** Системный канал по варианту. */
  system: Record<Variant, string>;
  tools: LLMToolDef[];
  /** Начало разговора, которое кладёт сам канал (история треда; «сработала рутина»). */
  opening: LLMMessage[];
}

export interface Channels {
  reg: RegistrySnapshot;
  /** Секция каталога, которой `catalog` отличается от `index`, — dry-run сверяет по ней. */
  catalogSection: string;
  chat: Channel;
  routine: Channel;
}

/**
 * Оба канала в обоих вариантах — ОДНОЙ транзакцией и теми же вызовами, что у боевых путей
 * (`ai/send-message.ts` для чата, `routines/runner.ts` для рутины). Часы — `probeClock`: «сегодня»
 * в канале обязано совпадать с датами мира-заглушки.
 */
export async function assembleChannels(
  db: Db,
  owner: ProbeOwner,
  triggerId: string,
): Promise<Channels> {
  const graphId = owner.who.graph;
  return withIdentity(db, owner.who, async (tx) => {
    const reg = await effectiveRegistry(tx, graphId);
    const section = catalogSection(reg, await disabledModulesOf(tx, graphId));
    const defs = await buildToolRegistry(tx, graphId);

    const chat = await buildContext(tx, { graphId, threadId: owner.threadId, clock: probeClock });

    const routine = await routineById(tx, triggerId);
    if (routine === null) throw new Error('рутина-триггер не найдена — сев не отработал');
    const runId = crypto.randomUUID();
    const bucket = PROBE_NOW.toISOString().slice(0, 16);
    const rctx = await buildRoutineContext(tx, {
      graphId,
      routine,
      run: { id: runId, bucket },
      history: await routineHistory(tx, graphId, routine.id, runId),
      clock: probeClock,
    });
    const routineTools = routineSurface(defs, routineRefOf(routine.id, runId, routine.props));

    return {
      reg,
      catalogSection: section,
      chat: {
        system: { index: chat.system, catalog: withCatalog(chat.system, section) },
        tools: chatToolSurface(defs),
        opening: chat.messages,
      },
      routine: {
        system: { index: rctx.system, catalog: withCatalog(rctx.system, section) },
        tools: routineTools,
        opening: rctx.messages,
      },
    };
  });
}
