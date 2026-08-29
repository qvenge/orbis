// apps/server/src/tools/registry-tools.ts
//
// ПЯТЬ ТУЛОВ РЕЕСТРА (§А10-2, §А2-7, §А3-2): завести своё свойство, поправить его, слить два
// в одно, поставить и снять дельту аспекта. Это первая поверхность, которой владелец и
// модель МЕНЯЮТ САМУ СИСТЕМУ, а не данные в ней.
//
// ДВА ПРЕДСТАВЛЕНИЯ, КАК У ОСТАЛЬНЫХ CORE-ТУЛОВ (`tools/registry.ts`): zod-envelope
// валидирует вход на исполнении, JSON Schema уезжает модели. Живут они здесь ВМЕСТЕ —
// у core-тулов их развело по пакетам исторически (`@orbis/shared/contracts`), и парность
// приходится сторожить отдельным тестом; у новых тулов сторожить нечего, потому что оба
// представления стоят в одном файле друг под другом.
//
// `fullScopeOnly: true` У ВСЕХ ПЯТИ (§А9-4, РП-14). Фоновому исполнителю (`worker`) реестр
// не адресован вовсе: он работает над ЗАДАЧЕЙ владельца, а не над устройством его системы.
// Флаг — не «мутации фону закрыты» (это и так держит `WORKER_SCOPE_TOOLS`), а ответ на
// другой вопрос: кому этот тул вообще предназначен.
//
// ЧЕГО ЗДЕСЬ НЕТ. Гейта уровня подтверждения (§7.10: `proposed` из чата — `preview`,
// слияние и дельта — `explicit-confirmation`, та же операция от рутины — отложенная
// единица) — он приезжает Задачей 16 вместе с минимальной правкой §7.10. До неё уровень
// этим тулам назначает общая таблица `classifyToolCall`, то есть одиночная мутация
// исполняется сразу. Это ЗНАЕМАЯ дыра одной задачи, а не забытая: приёмка §С8-11 закрывает
// её тестом на каждый ряд.
import { PROPERTY_KINDS } from '@orbis/shared';
import { queryAstJsonSchema } from '@orbis/shared/query';
import { z } from 'zod';
import { aspectDeltaSchema } from '../registry/deltas';
import type { OrbisToolDef } from './registry';

/** Подпись/смысл в локалях — та же форма, что в реестре (`localizedTextSchema`). */
const localizedJsonSchema = {
  type: 'object',
  description: 'подпись по локалям, например {"ru":"Усилие","en":"Effort"}',
  additionalProperties: { type: 'string' },
} as const;

/**
 * Тип свойства описан модели ПРОЗОЙ плюс перечнем `kind`, а не полной JSON Schema союза.
 *
 * Разложить `propertyTypeSchema` в JSON Schema механически нечем (двенадцать веток со своим
 * конфигом у каждой), а написать руками — значит завести ВТОРОЕ описание типа рядом с
 * реестром: разъедутся они молча, и первым это заметит владелец, у которого свойство
 * завелось не тем типом. Форму проверяет zod на исполнении и отвечает модели точным
 * `issues`-путём — тем же способом самокоррекции, что у остальных тулов.
 */
const propertyTypeJsonSchema = {
  type: 'object',
  description:
    'тип значения: {"kind":"text"} | {"kind":"number","min":0,"integer":true} | ' +
    '{"kind":"decimal","min":"0"} | {"kind":"boolean"} | {"kind":"date"} | {"kind":"timestamp"} | ' +
    '{"kind":"time"} | {"kind":"select","options":[{"key":"low","label":{"ru":"Низкое"},"rank":1}]} | ' +
    '{"kind":"ref","target":<дерево запроса>} | {"kind":"json","schema":{…}}. ' +
    'Тип потом НЕ меняется — под ним лежат записанные значения.',
  properties: { kind: { type: 'string', enum: [...PROPERTY_KINDS] } },
  required: ['kind'],
} as const;

// ---------------------------------------------------------------------------
// property_create (§А2-4, §А2-7)
// ---------------------------------------------------------------------------

export const propertyCreateInput = z
  .object({
    key: z
      .string()
      .regex(/^(orbis|user|[a-z][a-z0-9-]*)\/[a-z][a-z0-9_-]*$/, 'namespaced ASCII-слаг')
      .optional(),
    label: z.record(z.string(), z.string().min(1)),
    description: z.record(z.string(), z.string().min(1)),
    type: z.record(z.string(), z.unknown()),
    status: z.enum(['active', 'proposed']),
    scope: z.unknown().optional(),
  })
  .strict();
export type PropertyCreateInput = z.infer<typeof propertyCreateInput>;

const propertyCreateJsonSchema = {
  type: 'object',
  properties: {
    key: {
      type: 'string',
      description:
        'машинная ручка вида user/effort — ею свойство адресуют в запросах. Не задан — ' +
        'соберётся из английской подписи.',
    },
    label: localizedJsonSchema,
    description: {
      ...localizedJsonSchema,
      description: 'смысл свойства: по нему ты сама и будешь решать, что сюда писать',
    },
    type: propertyTypeJsonSchema,
    status: {
      type: 'string',
      enum: ['active', 'proposed'],
      description:
        'proposed — предложение владельцу (в промпт такие не попадают, ждут разбора); ' +
        'active — свойство сразу в работе. Заводя от себя, ставь proposed.',
    },
    scope: {
      ...queryAstJsonSchema,
      description:
        'где свойство показывается колонкой: только формы aspect= и tags=, например ' +
        '{"filter":{"aspect":"orbis/task"}}. Не задан — свойство живёт через аспекты.',
    },
  },
  required: ['label', 'description', 'type', 'status'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// property_update (§А2-7, §А10-3)
// ---------------------------------------------------------------------------

export const propertyUpdateInput = z
  .object({
    id: z.string().min(1),
    label: z.record(z.string(), z.string().min(1)).optional(),
    description: z.record(z.string(), z.string().min(1)).optional(),
    scope: z.unknown().optional(),
    rank: z.number().int().optional(),
    status: z.enum(['active', 'deprecated']).optional(),
  })
  .strict();
export type PropertyUpdateInput = z.infer<typeof propertyUpdateInput>;

const propertyUpdateJsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'id или key своего свойства' },
    label: localizedJsonSchema,
    description: localizedJsonSchema,
    scope: { ...queryAstJsonSchema, description: 'новая область показа; null — снять' },
    rank: { type: 'integer', description: 'место в порядке полей' },
    status: {
      type: 'string',
      enum: ['active', 'deprecated'],
      description:
        'active — принять предложенное; deprecated — отклонить или спрятать. Отклонённое ' +
        'предложение, которым ещё никто не пользовался, удаляется совсем.',
    },
  },
  required: ['id'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// property_merge (§А10-2)
// ---------------------------------------------------------------------------

export const propertyMergeInput = z
  .object({ source: z.string().min(1), into: z.string().min(1) })
  .strict();
export type PropertyMergeInput = z.infer<typeof propertyMergeInput>;

const propertyMergeJsonSchema = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      description: 'поглощаемое свойство (id или key) — только своё, встроенные не сливаются',
    },
    into: { type: 'string', description: 'свойство, в которое переносятся значения' },
  },
  required: ['source', 'into'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// aspect_delta_set / aspect_delta_remove (§А3-2)
// ---------------------------------------------------------------------------

export const aspectDeltaSetInput = z
  .object({ aspect: z.string().min(1), delta: aspectDeltaSchema })
  .strict();
export type AspectDeltaSetInput = z.infer<typeof aspectDeltaSetInput>;

export const aspectDeltaRemoveInput = z.object({ aspect: z.string().min(1) }).strict();
export type AspectDeltaRemoveInput = z.infer<typeof aspectDeltaRemoveInput>;

const aspectDeltaJsonSchema = {
  type: 'object',
  description:
    'настройка поверх системного определения: label, description, icon, ' +
    'properties.add/hide/relaxRequired/rank, selectOptions.<свойство>.add',
  properties: {
    label: localizedJsonSchema,
    description: localizedJsonSchema,
    icon: { type: 'string' },
    properties: {
      type: 'object',
      properties: {
        add: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              propertyId: { type: 'string' },
              required: { type: 'boolean' },
              rank: { type: 'integer' },
            },
            required: ['propertyId', 'required', 'rank'],
            additionalProperties: false,
          },
        },
        hide: { type: 'array', items: { type: 'string' } },
        relaxRequired: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
} as const;

const aspectDeltaSetJsonSchema = {
  type: 'object',
  properties: {
    aspect: { type: 'string', description: 'id аспекта, например orbis/task' },
    delta: aspectDeltaJsonSchema,
  },
  required: ['aspect', 'delta'],
  additionalProperties: false,
} as const;

const aspectDeltaRemoveJsonSchema = {
  type: 'object',
  properties: { aspect: { type: 'string', description: 'id аспекта' } },
  required: ['aspect'],
  additionalProperties: false,
} as const;

/**
 * Дефы пяти тулов. Порядок — тот, в котором их видит модель и эталон снимка
 * (`test/golden/tool-registry.json`): создание, правка, слияние, дельта, снятие дельты.
 */
export const REGISTRY_TOOLS: OrbisToolDef[] = [
  {
    name: 'property_create',
    description:
      'Завести НОВОЕ свойство — поле, которым можно описывать записи. Заводи только то, по ' +
      'чему будут фильтровать или считать; всё прочее оставляй текстом в теле записи. ' +
      'Сперва посмотри property_catalog: подходящее свойство скорее всего уже есть, и второе ' +
      'такое же придётся потом сливать. От себя заводи со status=proposed — владелец разберёт; ' +
      'неразобранных предложений не больше 20, дальше отказ «разберите пачку».',
    inputJsonSchema: propertyCreateJsonSchema,
    kind: 'mutate',
    fullScopeOnly: true,
  },
  {
    name: 'property_update',
    description:
      'Поправить своё свойство: подпись, смысл, область показа, порядок, статус. Тип и key ' +
      'не меняются — под типом лежат уже записанные значения. Подпись ВСТРОЕННОГО свойства ' +
      'правится не здесь, а дельтой аспекта (aspect_delta_set).',
    inputJsonSchema: propertyUpdateJsonSchema,
    kind: 'mutate',
    fullScopeOnly: true,
  },
  {
    name: 'property_merge',
    description:
      'Слить два свойства в одно: значения записей переезжают из source в into, source ' +
      'помечается поглощённым, ссылки в сохранённых запросах переписываются. Типы обязаны ' +
      'совпадать. Если у какой-то записи заполнены ОБА свойства разными значениями — слияние ' +
      'не выполняется вовсе, а владельцу приходит карточка разбора.',
    inputJsonSchema: propertyMergeJsonSchema,
    kind: 'mutate',
    fullScopeOnly: true,
  },
  {
    name: 'aspect_delta_set',
    description:
      'Настроить встроенный аспект под владельца: переименовать, сменить иконку, добавить или ' +
      'скрыть свойство, переставить порядок, добавить вариант select. Само системное ' +
      'определение не меняется — настройка живёт поверх него и переживает обновления.',
    inputJsonSchema: aspectDeltaSetJsonSchema,
    kind: 'mutate',
    fullScopeOnly: true,
  },
  {
    name: 'aspect_delta_remove',
    description: 'Снять настройку аспекта: он возвращается к системному определению.',
    inputJsonSchema: aspectDeltaRemoveJsonSchema,
    kind: 'mutate',
    fullScopeOnly: true,
  },
];

/** Имена пяти тулов — гейты и тесты спрашивают их у реестра, а не переписывают литералами. */
export const REGISTRY_TOOL_NAMES: ReadonlySet<string> = new Set(REGISTRY_TOOLS.map((d) => d.name));

/** Envelope-схемы пяти тулов — вход `MUTATION_ENVELOPES` диспатча и стадии 1 исполнителя. */
export const REGISTRY_TOOL_ENVELOPES: Record<string, z.ZodTypeAny> = {
  property_create: propertyCreateInput,
  property_update: propertyUpdateInput,
  property_merge: propertyMergeInput,
  aspect_delta_set: aspectDeltaSetInput,
  aspect_delta_remove: aspectDeltaRemoveInput,
};
