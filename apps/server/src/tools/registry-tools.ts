// apps/server/src/tools/registry-tools.ts
//
// ВОСЕМЬ ТУЛОВ РЕЕСТРА (§А10-2, §А2-7, §А3-2, §Б2-1): завести своё свойство, поправить его,
// слить два в одно, поставить и снять дельту аспекта, завести СВОЙ аспект и переписать либо
// снять его привязки к контрактам. Это первая поверхность, которой владелец и модель МЕНЯЮТ
// САМУ СИСТЕМУ, а не данные в ней.
//
// Три последних заводит срез Б-1: аспект перестал быть только «набором полей» — привязка
// (`implements`) включает его в Повестку, Бюджет и строку списка ДЕКЛАРАЦИЕЙ, без строки
// кода (§Б2-1), и завести такую декларацию владелец и модель обязаны тем же путём, что
// остальное устройство системы, — тулом через исполнителя, а не правкой базы.
//
// ДВА ПРЕДСТАВЛЕНИЯ, КАК У ОСТАЛЬНЫХ CORE-ТУЛОВ (`tools/registry.ts`): zod-envelope
// валидирует вход на исполнении, JSON Schema уезжает модели. Живут они здесь ВМЕСТЕ —
// у core-тулов их развело по пакетам исторически (`@orbis/shared/contracts`), и парность
// приходится сторожить отдельным тестом; у новых тулов сторожить нечего, потому что оба
// представления стоят в одном файле друг под другом.
//
// `fullScopeOnly: true` У ВСЕХ ВОСЬМИ (§А9-4, РП-14). Фоновому исполнителю (`worker`) реестр
// не адресован вовсе: он работает над ЗАДАЧЕЙ владельца, а не над устройством его системы.
// Флаг — не «мутации фону закрыты» (это и так держит `WORKER_SCOPE_TOOLS`), а ответ на
// другой вопрос: кому этот тул вообще предназначен.
//
// УРОВЕНЬ ПОДТВЕРЖДЕНИЯ ЭТИМ ВОСЬМИ НАЗНАЧАЕТ §7.10, И НАЗНАЧАЕТ ПО ОБЪЕКТУ (§С2-1, Задача 16):
// своя строка владельца от AI — `preview` (исполнено и показано карточкой), перенастройка
// поведения (статус, слияние, дельта) — `explicit-confirmation` для любого актора, а от
// рутины та же операция становится отложенной единицей пачки D42. Встроенные строки реестра
// — `system-object`: фону они запрещены ПО ОБЪЕКТУ и не откладываются никогда. Правило живёт
// в `policy/confirmation.ts` (`reconfiguresOf` + ряды 4a/4b), запрет фону — в
// `tools/dispatch.ts` (`routineDeferForbidden`); приёмка §С8-11 — тест на каждый ряд.
// Прежняя редакция этой шапки называла отсутствие гейта знаемой дырой одной задачи; дыра
// закрыта, и абзац снят вместе с ней.
import { aspectImplementsSchema, localizedTextSchema, PROPERTY_KINDS } from '@orbis/shared';
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
    'properties.add/hide/relaxRequired/rank, selectOptions.<свойство>.add, ' +
    'classMap.<свойство> — отнесение КАЖДОГО добавленного варианта к классу контракта ' +
    '(без него вариант отвергается)',
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
        rank: { type: 'object', additionalProperties: { type: 'integer' } },
      },
      additionalProperties: false,
    },
    selectOptions: {
      type: 'object',
      description: 'по id свойства: добавляемые варианты select',
      additionalProperties: {
        type: 'object',
        properties: {
          add: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                label: localizedJsonSchema,
                rank: { type: 'integer' },
              },
              required: ['key', 'label', 'rank'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    // Обязательность `classMap` — ОПИСАНИЕМ, а не `required`/`dependencies` схемы: она
    // УСЛОВНА (нужна только варианту свойства, связанного со слотом-статусом контракта;
    // варианты `orbis/priority` без карты законны), и схема JSON её не выражает. Закон §Б2-2
    // держит проверка записи (`checkClassMap` → `VARIANT_UNMAPPED`), конверт — говорит о нём
    // вслух, чтобы модель не узнавала о правиле отказом.
    classMap: {
      type: 'object',
      description:
        'по id свойства: [{contract, slot, variant, class}] — например ' +
        '{"orbis/task_status":[{"contract":"orbis/completable","slot":"status",' +
        '"variant":"in_review","class":"active"}]}. ОБЯЗАТЕЛЕН для каждого варианта из ' +
        'selectOptions.add у свойства, связанного со слотом-статусом контракта (§Б2-2) — иначе отказ ' +
        'VARIANT_UNMAPPED; у свойства вне привязок (orbis/priority) не нужен',
      additionalProperties: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            contract: { type: 'string' },
            slot: { type: 'string' },
            variant: { type: ['string', 'boolean'] },
            class: { type: 'string' },
          },
          required: ['contract', 'slot', 'variant', 'class'],
          additionalProperties: false,
        },
      },
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

// ---------------------------------------------------------------------------
// aspect_create / aspect_implements_set / aspect_implements_remove (§Б2-1, §С3)
// ---------------------------------------------------------------------------

/** Привязка к контракту (§Б2-1) — одна схема на три тула; форму даёт shared (задача 2). */
const aspectImplementsJsonSchema = {
  type: 'array',
  description:
    'какие КОНТРАКТЫ реализует аспект: bind — слот контракта → своё свойство, value_map — ' +
    'вариант значения → класс контракта, fixed — слот, заданный константой. Именно привязка ' +
    'включает аспект в Повестку, Бюджет и строку списка — без строки кода.',
  items: {
    type: 'object',
    required: ['contract', 'value_map'],
    additionalProperties: false,
    properties: {
      contract: { type: 'string', description: 'id контракта, например orbis/completable' },
      bind: { type: 'object', additionalProperties: { type: 'string' } },
      value_map: {
        type: 'array',
        description:
          'ОБЯЗАТЕЛЕН: отнесение КАЖДОГО варианта слота-статуса к классу контракта (§Б2-2); ' +
          'у контракта без слота-статуса (orbis/when) — пустой массив',
        items: {
          type: 'object',
          required: ['slot', 'variant', 'class'],
          additionalProperties: false,
          properties: { slot: { type: 'string' }, variant: {}, class: { type: 'string' } },
        },
      },
      fixed: { type: 'object' },
    },
  },
} as const;

/**
 * Конверт привязки для ТУЛОВ: `value_map` ОБЯЗАТЕЛЕН (§Б2-2). Обязательность живёт в конверте, а не в
 * строке реестра (`aspectImplementsSchema`, задача 2: там `.default([])` держит форму строки, замер П1):
 * модель, забывшая отнесения, получает отказ схемы с именем поля, а не `VARIANT_UNMAPPED` из глубины
 * `checkImplements`; для контракта без слота-статуса (`orbis/when`) поле передаётся пустым массивом.
 */
export const aspectImplementsToolSchema = aspectImplementsSchema
  .extend({ value_map: aspectImplementsSchema.shape.value_map.removeDefault() })
  .strict();

export const aspectCreateInput = z
  .object({
    // ПОТОЛОК ДЛИНЫ — не косметика: ключ аспекта это его id И имя `attach_*`-тула
    // (`attachToolName`), а имя тула уезжает провайдеру КАК ЕСТЬ — ни `toSdkTools`
    // (`llm/ai-sdk.ts`), ни адаптеры Anthropic/OpenAI его не режут и не проверяют.
    //
    // ЧИСЛО 56 ВЫВЕДЕНО ИЗ МЕНЬШЕГО ИЗ ДВУХ ПРЕДЕЛОВ, а не из запаса «на глаз»: у Anthropic
    // имя функции — до 128 символов, у OpenAI — до 64 (Function calling). Префикс `attach_`
    // стоит 7, значит `7 + 56 = 63 ≤ 64` — влезает у ОБОИХ, и добавление второго провайдера
    // не потребует пересдавать уже заведённые владельцем аспекты (переименовать их нечем:
    // ключ аспекта — это его адрес). Считается ВЕСЬ ключ вместе с `user/`: `attachToolName`
    // сворачивает «/» в «_», длины не меняя.
    //
    // Без потолка ключ на 200 символов положил бы ВЕСЬ ход разговора: тулы уезжают одним
    // запросом, и провайдер отверг бы его целиком — вместе с остальными сорока.
    key: z
      .string()
      .regex(/^user\/[a-z][a-z0-9_-]*$/, 'свой аспект живёт в namespace user/')
      .max(56, 'ключ аспекта — не длиннее 56 символов: из него собирается имя тула'),
    label: localizedTextSchema,
    description: localizedTextSchema,
    properties: z
      .array(z.object({ propertyId: z.string().min(1), required: z.boolean() }).strict())
      .min(1),
    implements: z.array(aspectImplementsToolSchema).default([]),
    viewConfig: z
      .object({ keyFields: z.array(z.string()), icon: z.string().optional() })
      .strict()
      .optional(),
    tagMappings: z.array(z.string()).default([]),
  })
  .strict();
export type AspectCreateInput = z.infer<typeof aspectCreateInput>;

export const aspectImplementsSetInput = z
  .object({ aspect: z.string().min(1), implements: z.array(aspectImplementsToolSchema).min(1) })
  .strict();
export type AspectImplementsSetInput = z.infer<typeof aspectImplementsSetInput>;

export const aspectImplementsRemoveInput = z
  .object({ aspect: z.string().min(1), contract: z.string().min(1) })
  .strict();
export type AspectImplementsRemoveInput = z.infer<typeof aspectImplementsRemoveInput>;

const aspectCreateJsonSchema = {
  type: 'object',
  required: ['key', 'label', 'description', 'properties'],
  additionalProperties: false,
  properties: {
    key: {
      type: 'string',
      maxLength: 56,
      description:
        'ручка вида user/sleep-log — она же адрес аспекта и имя его attach_*-тула; ' +
        'не длиннее 56 символов, «-» и «_» в имени тула НЕ различаются',
    },
    label: localizedJsonSchema,
    description: {
      ...localizedJsonSchema,
      description: 'что аспект означает — по нему ты решаешь, вешать ли его',
    },
    properties: {
      type: 'array',
      description:
        'поля аспекта: propertyId — id или key УЖЕ заведённого свойства (см. property_catalog)',
      items: {
        type: 'object',
        required: ['propertyId', 'required'],
        additionalProperties: false,
        properties: { propertyId: { type: 'string' }, required: { type: 'boolean' } },
      },
    },
    implements: aspectImplementsJsonSchema,
    viewConfig: {
      type: 'object',
      required: ['keyFields'],
      additionalProperties: false,
      properties: {
        keyFields: { type: 'array', items: { type: 'string' } },
        icon: { type: 'string' },
      },
    },
    tagMappings: { type: 'array', items: { type: 'string' } },
  },
} as const;

const aspectImplementsSetJsonSchema = {
  type: 'object',
  required: ['aspect', 'implements'],
  additionalProperties: false,
  properties: {
    aspect: { type: 'string', description: 'id своего аспекта' },
    implements: aspectImplementsJsonSchema,
  },
} as const;

const aspectImplementsRemoveJsonSchema = {
  type: 'object',
  required: ['aspect', 'contract'],
  additionalProperties: false,
  properties: {
    aspect: { type: 'string' },
    contract: { type: 'string', description: 'id контракта, привязку к которому снимаем' },
  },
} as const;

/**
 * Дефы восьми тулов. Порядок — тот, в котором их видит модель и эталон снимка
 * (`test/golden/tool-registry.json`): создание, правка, слияние, дельта, снятие дельты,
 * заведение своего аспекта и две операции его привязок.
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
  {
    name: 'aspect_create',
    description:
      'Завести СВОЙ аспект — новую интерпретацию записи («тренировка», «созвон»). Поля берутся ' +
      'из уже заведённых свойств: сперва property_catalog, и только потом property_create на ' +
      'недостающее. implements — привязки к контрактам: именно они, а не код, включают аспект ' +
      'в Повестку, Бюджет и строку списка.',
    inputJsonSchema: aspectCreateJsonSchema,
    kind: 'mutate',
    fullScopeOnly: true,
  },
  {
    name: 'aspect_implements_set',
    description:
      'Переписать привязки своего аспекта к контрактам ЦЕЛИКОМ: список замещает прежний. Слот ' +
      'связывается со свойством того же типа, варианты статуса — с классами контракта; ' +
      'несовпадение типа или непокрытый вариант — отказ ДО записи.',
    inputJsonSchema: aspectImplementsSetJsonSchema,
    kind: 'mutate',
    fullScopeOnly: true,
  },
  {
    name: 'aspect_implements_remove',
    description:
      'Снять привязку своего аспекта к одному контракту: аспект перестаёт участвовать в его ' +
      'потребителях, остальные привязки остаются.',
    inputJsonSchema: aspectImplementsRemoveJsonSchema,
    kind: 'mutate',
    fullScopeOnly: true,
  },
];

/** Имена восьми тулов — гейты и тесты спрашивают их у реестра, а не переписывают литералами. */
export const REGISTRY_TOOL_NAMES: ReadonlySet<string> = new Set(REGISTRY_TOOLS.map((d) => d.name));

/** Envelope-схемы восьми тулов — вход `MUTATION_ENVELOPES` диспатча и стадии 1 исполнителя. */
export const REGISTRY_TOOL_ENVELOPES: Record<string, z.ZodTypeAny> = {
  property_create: propertyCreateInput,
  property_update: propertyUpdateInput,
  property_merge: propertyMergeInput,
  aspect_delta_set: aspectDeltaSetInput,
  aspect_delta_remove: aspectDeltaRemoveInput,
  aspect_create: aspectCreateInput,
  aspect_implements_set: aspectImplementsSetInput,
  aspect_implements_remove: aspectImplementsRemoveInput,
};
