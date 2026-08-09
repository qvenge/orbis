// apps/server/src/tools/registry.ts
// Реестр LLM/MCP-тулов — единый публичный контракт §9.2: core-набор + по одному
// attach_<aspect> на каждый активный аспект реестра (§7.6). Потребители: tool-цикл
// внутреннего чата (Task 9) и MCP-адаптер (Task 10; internalOnly-тулы туда не отдаются).
//
// JSON Schema core-тулов написаны вручную дословно по табличной нотации §9.2 РЯДОМ
// с zod-envelope shared (contracts/tools.ts): zod валидирует вход на исполнении,
// JSON Schema уходит в определения тулов LLM/MCP. Парность двух представлений
// (ключи и required) закреплена тестом registry.test.ts — рассинхрон падает в CI.

import { RELATION_TYPES } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { aspectDefinitions } from '../db/schema';
import type { Tx } from '../db/with-identity';

export interface OrbisToolDef {
  name: string; // 'entity_query' | ... | 'attach_orbis_task' | ...
  description: string; // для LLM/MCP; у attach_* — ai_instructions аспекта
  inputJsonSchema: Record<string, unknown>; // JSON Schema (для LLM tool defs и MCP)
  kind: 'read' | 'mutate';
  internalOnly?: boolean; // user_query: true — не отдаётся MCP
  /**
   * Только у attach_*: id исходного аспекта. Маппинг имя→aspect_id хранит реестр
   * (решение 3 плана 1b) — обратная нормализация имени невозможна («-» и «/»
   * склеиваются в «_»), а executor ждёт форму attach_<id c заменой только «/»>.
   */
  aspectId?: string;
}

/** Карточка чата (02 §2.3) — собирается сервером как данные, рендерит 1c. */
export type Card =
  | {
      kind: 'entity_card';
      entityId: string;
      title: string;
      aspects: string[];
      keyFields: Record<string, unknown>;
      undoActionId?: string;
    }
  | {
      kind: 'query_result';
      title?: string;
      count: number;
      entityIds: string[];
      aggregate?: { op: 'sum' | 'count'; value: string };
    }
  | {
      kind: 'confirmation_card';
      mode: 'preview' | 'explicit';
      pendingId?: string;
      summary: string;
      diff?: Record<string, { before: unknown; after: unknown }>;
    }
  // 03-budget §3.4 (Task C4c): вход в импорт из чата — карточка ведёт на экран импорта
  // (файл выбирается локально в браузере и через ленту не проходит). Поля обязаны
  // дословно совпадать с web-типом ImportReviewData (chat/cards/types.ts) — типы
  // карточек сервера и web намеренно не общие. Поле title убрано в фикс-раунде C:
  // производитель его не слал, и web-ветка рендера была мёртвой
  | { kind: 'import_review' }
  // 00-product §8 (уборочная фаза, E13): сводка завершённого импорта. Пишется сервером
  // в глобальный тред после confirm и служит ЕДИНСТВЕННЫМ следом чисел выписки: `skipped`
  // (строка уже была в Orbis) в графе не остаётся ничем — сущностей по таким строкам
  // не создаётся. Без этой записи метрику «покрытие транзакций» измерить нечем.
  | {
      kind: 'import_summary';
      namespace: string;
      total: number;
      created: number;
      adopted: number;
      skipped: number;
    }
  // 01-arch §7.8 (Task D3a): эскалация повторных исправлений категории. Обе карточки
  // пишет ai/escalation.ts; поля обязаны ДОСЛОВНО совпадать с web-типами, которые
  // объявит D3b (chat/cards/types.ts) — union'ы сервера и web намеренно не общие.
  // ruleText — готовый заголовок будущей memory-сущности (formatRuleTitle), кнопка
  // «Запомнить» отправляет его обычным entity.create; categoryTitle показывается в тексте.
  | {
      kind: 'memory_rule_suggestion';
      ruleText: string;
      pattern: string;
      fromCategoryId: string;
      toCategoryId: string;
      categoryTitle: string;
    }
  // Отказ от предложения — новое системное сообщение, а не правка metadata (K4, §4.6);
  // эта же карточка подавляет повтор предложения в 30-дневном скане
  | {
      kind: 'memory_rule_declined';
      pattern: string;
      fromCategoryId: string;
      toCategoryId: string;
    }
  | { kind: 'error_card'; code: string; message: string };

// ---------------------------------------------------------------------------
// Envelope-схемы тулов, отсутствующих в shared/contracts/tools.ts:
// user_query — внутренний хелпер чат-LLM, в публичный реестр §9.2 НЕ входит
// (MCP-агенты агрегируют сами); thread_post — минимальное расширение реестра
// §9.2 (сценарий 9 из 02 §5), фиксируется PRD-заплаткой Task 11. Оба исполняются
// только через dispatchTool — в wire-контракт tRPC не выходят, поэтому живут здесь.
// ---------------------------------------------------------------------------

export const userQueryInput = z
  .object({
    query: z.string().min(1),
    aggregate: z.enum(['sum', 'count']),
    field: z.string().optional(), // обязателен при aggregate=sum — проверяет dispatch
  })
  .strict();

export const threadPostInput = z
  .object({
    // client-UUID сообщения (§2.1): повтор с тем же id — идемпотентный ретрай (ON CONFLICT),
    // второй пост не создаётся; без id — серверный uuidv7 (ретрай неотличим → новый пост)
    id: z.string().uuid().optional(),
    entity_id: z.string().uuid(),
    content: z.string().min(1),
  })
  .strict();

// import_csv_start (Task C4c) — вход без полей НАМЕРЕННО: тул ничего не делает,
// он лишь показывает карточку-вход в флоу импорта; strict — лишние поля отклоняются
export const importCsvStartInput = z.object({}).strict();

export type UserQueryInput = z.infer<typeof userQueryInput>;
export type ThreadPostInput = z.infer<typeof threadPostInput>;

// ---------------------------------------------------------------------------
// Рукописные JSON Schema core-тулов — дословно табличная нотация §9.2
// (`*` — обязательное поле, `?` — опциональное). expectedUpdatedAt в entity_update —
// решение 4 плана 1a: таблица §9.2 поле не показывает, но §5.2 требует его при
// правке body; в envelope оно есть, поэтому парность с zod требует его и здесь.
// ---------------------------------------------------------------------------

const uuid = { type: 'string', format: 'uuid' } as const;

const entityQueryJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'строка в грамматике запросов Orbis §6, включая sortBy и limit',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

const entityGetJsonSchema = {
  type: 'object',
  properties: {
    id: uuid,
    include: {
      type: 'array',
      items: { type: 'string', enum: ['body', 'relations', 'backlinks', 'thread'] },
      description:
        'по умолчанию body+relations; backlinks — кто ссылается: явные related_to (via "relation") и упоминания через body_refs (via "mention"), без архивных, до 100; thread — сообщения треда сущности',
    },
  },
  required: ['id'],
  additionalProperties: false,
};

const entityCreateJsonSchema = {
  type: 'object',
  properties: {
    id: { ...uuid, description: 'опционален; передавай для идемпотентности повторов' },
    title: { type: 'string', minLength: 1 },
    emoji: { type: 'string' },
    body: { type: 'string' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'обязателен (может быть пустым)',
    },
    meta: { type: 'object' },
    aspects: {
      type: 'object',
      additionalProperties: { type: 'object' },
      description: 'значения валидируются JSON-схемами реестра аспектов',
    },
  },
  required: ['title', 'tags'],
  additionalProperties: false,
};

const entityUpdateJsonSchema = {
  type: 'object',
  properties: {
    id: uuid,
    expectedUpdatedAt: {
      type: 'string',
      format: 'date-time',
      description: 'updated_at сущности, которую видел клиент; обязателен при правке body (§5.2)',
    },
    title: { type: 'string', minLength: 1 },
    emoji: { type: ['string', 'null'] },
    body: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    meta: { type: 'object' },
    aspects: {
      type: 'object',
      additionalProperties: { type: ['object', 'null'] },
      description:
        'мержится по aspect-id, внутри аспекта — по полям (shallow merge; поле null удаляется); null вместо объекта снимает аспект целиком (detach)',
    },
    archived: { type: 'boolean' },
  },
  required: ['id'],
  additionalProperties: false,
};

const relationJsonSchema = {
  type: 'object',
  properties: {
    source_id: uuid,
    target_id: uuid,
    relation_type: { type: 'string', enum: [...RELATION_TYPES] },
  },
  required: ['source_id', 'target_id', 'relation_type'],
  additionalProperties: false,
};

const batchExecuteJsonSchema = {
  type: 'object',
  properties: {
    batch_id: uuid,
    operations: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { tool: { type: 'string' }, input: { type: 'object' } },
        required: ['tool', 'input'],
        additionalProperties: false,
      },
      description:
        'мутирующие core- и attach_*-тулы, кроме самого batch_execute; порядок значим — весь batch валидируется до начала и выполняется одной транзакцией',
    },
  },
  required: ['batch_id', 'operations'],
  additionalProperties: false,
};

const userQueryJsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, description: 'строка в грамматике §6' },
    aggregate: { type: 'string', enum: ['sum', 'count'] },
    field: {
      type: 'string',
      description: 'обязателен при aggregate=sum: числовое поле аспекта (например amount)',
    },
  },
  required: ['query', 'aggregate'],
  additionalProperties: false,
};

const budgetStatusJsonSchema = {
  type: 'object',
  properties: {
    month: {
      type: 'string',
      pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
      description: 'месяц YYYY-MM; по умолчанию — текущий месяц пользователя',
    },
  },
  additionalProperties: false,
};

const importCsvStartJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const threadPostJsonSchema = {
  type: 'object',
  properties: {
    id: {
      ...uuid,
      description:
        'client-UUID сообщения: повтор с тем же id — идемпотентный ретрай (не плодит второй пост)',
    },
    entity_id: uuid,
    content: { type: 'string', minLength: 1 },
  },
  required: ['entity_id', 'content'],
  additionalProperties: false,
};

/** Core-тулы §9.2 (+ user_query как internal-only, + thread_post — расширение Task 11). */
const CORE_TOOLS: OrbisToolDef[] = [
  {
    name: 'entity_query',
    // Примеры грамматики в description (fix round Task 8): модель не видит
    // спецификацию §6 — без образцов синтаксиса холодный резолв category_ref
    // (инструкция системного промпта v1) гарантированно бился бы о парсер.
    // Третий пример — про aliases: синтаксис фильтра по полю-массиву ничем не
    // отличается от обычного равенства, и без образца модель не догадается, что
    // «такси» ищется среди синонимов категории, а не в её названии. Описание
    // тула живёт ЗДЕСЬ, в коде, а не в `aspect_definitions.ai_instructions`,
    // поэтому правка примера не требует пересева реестра на проде.
    description:
      'Поиск/фильтрация сущностей грамматикой запросов Orbis (§6). Возвращает список сущностей (core-поля + tags + aspects). Примеры: «aspect=orbis/category, search=Еда»; «aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, limit=20»; «aspect=orbis/category, aliases=такси» (резолв категории по синониму: aliases — массив, фильтр ищет вхождение).',
    inputJsonSchema: entityQueryJsonSchema,
    kind: 'read',
  },
  {
    name: 'entity_get',
    description: 'Полное чтение одной сущности: body, связи, backlinks, тред.',
    inputJsonSchema: entityGetJsonSchema,
    kind: 'read',
  },
  {
    name: 'entity_create',
    description: 'Создание сущности.',
    inputJsonSchema: entityCreateJsonSchema,
    kind: 'mutate',
  },
  {
    name: 'entity_update',
    description: 'Частичное обновление сущности: передаются только изменяемые поля.',
    inputJsonSchema: entityUpdateJsonSchema,
    kind: 'mutate',
  },
  {
    name: 'relation_create',
    description: 'Создание связи между сущностями.',
    inputJsonSchema: relationJsonSchema,
    kind: 'mutate',
  },
  {
    name: 'relation_delete',
    description: 'Удаление связи между сущностями.',
    inputJsonSchema: relationJsonSchema,
    kind: 'mutate',
  },
  {
    name: 'batch_execute',
    description: 'Атомарная группа мутаций с единым Undo.',
    inputJsonSchema: batchExecuteJsonSchema,
    kind: 'mutate',
  },
  {
    name: 'user_query',
    description:
      'Вопрос-агрегация по выборке («сколько потрачено на еду за месяц»): sum/count поверх запроса грамматики §6.',
    inputJsonSchema: userQueryJsonSchema,
    kind: 'read',
    internalOnly: true, // §9.2: в публичный реестр не входит, MCP не отдаётся
  },
  {
    // Task A6 (03-budget §4.3/§4.5/§4.7): готовые агрегаты Budget для финансовых
    // вопросов — модель НЕ пересчитывает конверты сама через entity_query/user_query.
    // Доступен и MCP (§9.3 — тот же реестр); политика §7.10: чтение → execute.
    name: 'budget_status',
    description:
      'Готовые агрегаты бюджета месяца (03-budget): конверты (spent/effectiveLimit/remaining/dailyPace), баланс периода, comingUp (recurring-инстансы на 14 дней), planned (ручные запланированные покупки), unbudgeted и spend_class категорий. Используй для финансовых вопросов («что по бюджету?», «могу позволить X?», остатки конвертов). planned и comingUp уже включают будущие recurring-оттоки — НЕ суммируй recurring отдельно (двойной вычет).',
    inputJsonSchema: budgetStatusJsonSchema,
    kind: 'read',
  },
  {
    // Task C4c (03-budget §3.4): импорт инициируется и из чата — тул-аффорданс, чей
    // единственный результат — карточка import_review, ведущая на экран импорта.
    // Файл выписки живёт в браузере владельца и разбирается локально (§3.4 шаг 1):
    // модель его не видит, роутер import.* зовёт только владелец (C2) — поэтому
    // kind 'read' и никаких побочных эффектов.
    name: 'import_csv_start',
    description:
      'Вход в импорт банковской выписки (CSV): показывает пользователю карточку, с которой он откроет экран импорта. Вызывай, когда пользователь просит импортировать выписку/CSV из банка («импортируй выписку»). Сам тул НИЧЕГО не импортирует и файла не видит — выписка выбирается и разбирается локально в браузере пользователя.',
    inputJsonSchema: importCsvStartJsonSchema,
    kind: 'read',
    internalOnly: true, // у внешнего агента (MCP) нет экрана — «открой импорт» ему бессмысленен
  },
  {
    name: 'thread_post',
    description: 'Сообщение в тред сущности (заметка о ходе/результате работы). Не мутирует граф.',
    inputJsonSchema: threadPostJsonSchema,
    kind: 'mutate', // для политики §7.10 — уровень одиночной мутации
  },
];

// ---------------------------------------------------------------------------
// Динамические attach_* из реестра аспектов (§7.6)
// ---------------------------------------------------------------------------

/** Строка реестра аспектов в объёме, нужном тулам и карточкам (02 §2.3 keyFields). */
export interface AspectToolRow {
  id: string;
  description: string | null;
  aiInstructions: string | null;
  schema: Record<string, unknown>;
  viewConfig: Record<string, unknown> | null;
}

/**
 * Аспекты, видимые актору: builtin + собственные кастомные (RLS того же tx).
 * ORDER BY owner_id NULLS FIRST: при коллизии id собственное определение
 * перекрывает builtin — как в loadAspectRegistry executor'а.
 */
export async function loadAspectToolRows(tx: Tx): Promise<AspectToolRow[]> {
  const rows = await tx
    .select({
      id: aspectDefinitions.id,
      description: aspectDefinitions.description,
      aiInstructions: aspectDefinitions.aiInstructions,
      schema: aspectDefinitions.schema,
      viewConfig: aspectDefinitions.viewConfig,
    })
    .from(aspectDefinitions)
    .orderBy(sql`${aspectDefinitions.ownerId} NULLS FIRST`);
  const byId = new Map<string, AspectToolRow>();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      description: row.description,
      aiInstructions: row.aiInstructions,
      schema: row.schema as Record<string, unknown>,
      viewConfig: row.viewConfig as Record<string, unknown> | null,
    });
  }
  return [...byId.values()];
}

/** Имя attach-тула (решение 3 плана): «/» и «-» запрещены в именах тулов LLM/MCP. */
function attachToolName(aspectId: string): string {
  return `attach_${aspectId.replaceAll('/', '_').replaceAll('-', '_')}`;
}

function attachToolDef(row: AspectToolRow): OrbisToolDef {
  return {
    name: attachToolName(row.id),
    // §7.6: описание тула — ai_instructions аспекта (fallback — description)
    description: row.aiInstructions || row.description || '',
    // Envelope §9.2 {entity_id, data} + JSON Schema аспекта ИЗ БД — модель видит
    // точную форму data; на исполнении её валидирует стадия 2 executor'а (ajv)
    inputJsonSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', format: 'uuid' },
        data: row.schema,
      },
      required: ['entity_id', 'data'],
      additionalProperties: false,
    },
    kind: 'mutate',
    aspectId: row.id,
  };
}

/** Сборка реестра из загруженных строк аспектов (синхронная часть — для dispatch). */
export function buildToolDefs(aspectRows: AspectToolRow[]): OrbisToolDef[] {
  return [...CORE_TOOLS, ...aspectRows.map(attachToolDef)];
}

/** Собирает реестр: core-тулы §9.2 + attach_<aspect> для каждого активного аспекта (§7.6). */
export async function buildToolRegistry(tx: Tx): Promise<OrbisToolDef[]> {
  return buildToolDefs(await loadAspectToolRows(tx));
}
