// apps/server/src/tools/registry.ts
// Реестр LLM/MCP-тулов — единый публичный контракт §9.2: core-набор + по одному
// attach_<aspect> на каждый активный аспект реестра (§7.6). Потребители: tool-цикл
// внутреннего чата (Task 9) и MCP-адаптер (Task 10; internalOnly-тулы туда не отдаются).
//
// JSON Schema core-тулов написаны вручную дословно по табличной нотации §9.2 РЯДОМ
// с zod-envelope shared (contracts/tools.ts): zod валидирует вход на исполнении,
// JSON Schema уходит в определения тулов LLM/MCP. Парность двух представлений
// (ключи и required) закреплена тестом registry.test.ts — рассинхрон падает в CI.

import { PROPOSAL_ALLOWED_TOOLS, RELATION_TYPES, SERVICE_ASPECT_IDS } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { aspectDefinitions } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { MAX_PROPOSAL_OPERATIONS } from '../routines/constants';

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
  /**
   * Глагол исполнителя (§9.3, С7): виден ТОЛЬКО вызову с грантом (MCP). У чата гранта
   * нет — прогон адресуется конкретному доступу, и без гранта глагол не к кому отнести;
   * поэтому реестр чата такие дефы отсекает (ai/send-message.ts), а dispatch держит
   * вторую линию (вызов без субъекта — ни гранта, ни рутины — → VALIDATION; рутина стала
   * вторым субъектом глаголов в V1.10, см. ROUTINE_BASE_TOOLS).
   */
  agentOnly?: boolean;
  /**
   * Зеркало `internalOnly` с другой стороны (V1.10): тул существует ТОЛЬКО для
   * внутреннего исполнителя рутины (`orbis_propose`, Задача 8). Чат и MCP его не видят
   * (фильтры ai/send-message.ts и mcp/server.ts) и не зовут (гейт tools/dispatch.ts):
   * предложение адресуется прогону, и вне прогона его некуда положить.
   */
  routineOnly?: boolean;
}

/**
 * Глаголы исполнителя (§9.3, С7) — единый список имён. Сами дефы появятся в реестре
 * позже (Задача 10); имена объявлены здесь, потому что на них уже ссылается гейт
 * скоупа: правило доступа и набор имён обязаны жить в одном месте, иначе новый глагол
 * молча окажется недоступен своему же исполнителю.
 */
export const AGENT_VERB_NAMES = [
  'orbis_my_queue',
  'orbis_claim_task',
  'orbis_run_step',
  'orbis_checkpoint',
  'orbis_finish',
] as const;

/** Что доступно скоупу worker сверх read-тулов (С7): глаголы + thread_post. Всё прочее — отказ. */
export const WORKER_SCOPE_TOOLS: ReadonlySet<string> = new Set([
  ...AGENT_VERB_NAMES,
  'thread_post',
]);

/**
 * Что доступно рутине ВСЕГДА, в любом режиме (V1.10, рулинг В2): чекпойнт — единственный
 * способ прогона остановиться и спросить владельца. Отнять его у режима `propose` значило
 * бы оставить рутину без выхода из тупика: предложить она может только правку графа,
 * а вопрос — не правка.
 */
export const ROUTINE_BASE_TOOLS: ReadonlySet<string> = new Set(['orbis_checkpoint']);

/**
 * Глаголы круга исполнителя, закрытые рутине НАГЛУХО (V1.5) — даже вписанные владельцем в
 * `allowed_tools`. Причины разные у двух пар, но обе про «этим распоряжается не модель»:
 *
 * - `orbis_run_step` и `orbis_finish` — бухгалтерия прогона. Шаги пишет раннер, и итог
 *   прогона подводит тоже он (`closeRoutineRun`) — напрямую, минуя dispatch, в том числе
 *   когда модель кончилась отказом или дедлайном. Модель, закрывшая прогон сама, обнулила
 *   бы итог раннера: тот пришёл бы к уже терминальному прогону и получил CONFLICT на своём
 *   же прогоне, а владелец увидел бы отчёт вместо настоящего исхода.
 * - `orbis_my_queue` и `orbis_claim_task` — грантовые по устройству (у прогона рутины нет
 *   ни очереди, ни тикета, agent-loop/verbs.ts): показывать их рутине значило бы обещать
 *   ей отказ.
 *
 * `orbis_checkpoint` в список НЕ входит: он остаётся её единственным способом остановиться
 * и спросить владельца (ROUTINE_BASE_TOOLS, рулинг В2).
 */
const ROUTINE_CLOSED_VERBS: ReadonlySet<string> = new Set(
  AGENT_VERB_NAMES.filter((n) => !ROUTINE_BASE_TOOLS.has(n)),
);

/**
 * Мутации, закрытые рутине ВСЕГДА — даже вписанные владельцем в `allowed_tools`:
 * - `batch_execute` — обёртка провозила бы внутрь что угодно, а политика даёт группе
 *   `preview` ≠ `execute` (подробно — в routineToolAllowed);
 * - `undo_last` — «отмени последнее» снимает последнее ВИДИМОЕ действие журнала владельца,
 *   чьё бы оно ни было: фоновый прогон, отменяющий правку владельца, — не работа рутины, а
 *   дыра в инварианте 7 (чужое не затирается). Своё рутина не отменяет тоже: её правки
 *   откатывает владелец кнопкой (Undo карточки, откат прогона).
 */
const ROUTINE_CLOSED_TOOLS: ReadonlySet<string> = new Set(['batch_execute', 'undo_last']);

/**
 * Рутина и её прогон в контексте вызова (V1.10) — вторая половина атрибуции рядом с
 * грантом (`GrantRef`): грант отвечает за внешнего исполнителя, это — за внутреннего.
 * `allowedTools` — белый список режима `act` из аспекта `orbis/routine.allowed_tools`,
 * уже разобранный в множество: гейт зовётся на каждый вызов.
 */
export interface RoutineRef {
  id: string;
  runId: string;
  mode: 'propose' | 'act';
  allowedTools: ReadonlySet<string>;
}

/**
 * Правило доступа рутины к тулу (V1.10) — ОДНО на реестр раннера и на гейт диспатча:
 * реестр решает, что показать модели, гейт — что исполнить, и разойтись эти два ответа
 * не имеют права (иначе модель зовёт показанное и получает отказ, либо наоборот —
 * скрытое всё-таки исполняется).
 *
 * Чтения открыты все: рутина работает над графом владельца и обязана его видеть.
 * Мутации: база (`ROUTINE_BASE_TOOLS`) плюс — в `propose` РОВНО `orbis_propose`
 * (правку рутина не пишет, а предлагает), в `act` РОВНО белый список владельца.
 * Сверх того из белого списка вычитаются `batch_execute` и круг внешнего исполнителя
 * (`ROUTINE_CLOSED_VERBS`): их владелец не вправе открыть рутине даже намеренно.
 */
export function routineToolAllowed(
  def: Pick<OrbisToolDef, 'name' | 'kind'>,
  routine: RoutineRef,
): boolean {
  if (def.kind === 'read') return true;
  // batch_execute закрыт рутине ВСЕГДА — даже вписанный владельцем в allowed_tools.
  // Во-первых, он всё равно неисполним: по §7.10 группа получает уровень preview, а
  // preview ≠ execute, и инвариант 5 отклонит её уже в runMutation — показывать модели
  // тул, который ей гарантированно откажут, значит нарушить «показанное = исполняемое».
  // Во-вторых, разрешить его было бы дырой: гейт режима сверяет с белым списком только
  // ВНЕШНЕЕ имя вызова, вложенные операции батча им не проверяются, — одна обёртка
  // провозила бы внутрь что угодно. undo_last — там же и по своей причине (см. набор).
  if (ROUTINE_CLOSED_TOOLS.has(def.name)) return false;
  if (ROUTINE_BASE_TOOLS.has(def.name)) return true;
  // Круг внешнего исполнителя рутине закрыт целиком, кроме чекпойнта (см. ROUTINE_CLOSED_VERBS)
  if (ROUTINE_CLOSED_VERBS.has(def.name)) return false;
  // Имя строкой, а не ссылкой на деф: правило доступа не должно зависеть от того, собран
  // ли уже реестр (гейт зовётся и на дефах, подложенных тестом).
  return routine.mode === 'propose'
    ? def.name === 'orbis_propose'
    : routine.allowedTools.has(def.name);
}

/**
 * Реестр тулов для раннера рутины (V1.10): что видит модель прогона. Гейт диспатча —
 * ВТОРОЙ рубеж на том же правиле (`routineToolAllowed`), а не единственный: список
 * тулов — подсказка модели, доступ решает сервер на вызове.
 */
export function routineToolDefs(defs: OrbisToolDef[], routine: RoutineRef): OrbisToolDef[] {
  return defs.filter((d) => routineToolAllowed(d, routine));
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
  // V1.6: предложение рутины. Своя карточка, а не confirmation_card, потому что вопрос
  // другой: не «подтвердить действие, которое я сейчас сделаю», а «принять предложение,
  // сделанное ночью» — с объяснением прозой, ссылкой на рутину и её прогон и статусом,
  // который приезжает с СЕРВЕРА (routine.proposal), а не считается клиентом по времени.
  // Поля обязаны дословно совпадать с web-типом (chat/cards/types.ts) — union'ы сервера и
  // web намеренно не общие.
  | {
      kind: 'proposal_card';
      pendingId: string;
      runId: string;
      routineId: string;
      summary: string;
      explanation: string;
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

// undo_last (хвост V1, Д-1) — вход без полей: «отмени последнее» адресует последнее
// видимое действие журнала владельца, выбирать модели нечего (§7.8 undoLast); точечный
// undo по id остаётся кнопкой карточки (ai.undo), модели он не отдаётся.
export const undoLastInput = z.object({}).strict();

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

const undoLastJsonSchema = {
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

// ---------------------------------------------------------------------------
// JSON Schema глаголов исполнителя (§9.3, С7) — парны zod-схемам
// @orbis/shared/contracts/agent-loop (тест парности в registry.test.ts).
// ---------------------------------------------------------------------------

/** Ключ идемпотентности вызова = batch_id action'а §7.8: повтор не делает вторую работу. */
const verbCallId = {
  ...uuid,
  description: 'id вызова: повтор с тем же значением безопасен — работа не делается заново',
} as const;

const sessionUrl = {
  type: 'string',
  format: 'uri',
  description: 'ссылка на сессию исполнителя — владелец сможет посмотреть, как шла работа',
} as const;

/** usage: агент сообщает расход сам, сервер его не проверяет (С2) — все поля опциональны. */
const runUsageJsonSchema = {
  type: 'object',
  properties: {
    input_tokens: { type: 'integer', minimum: 0 },
    output_tokens: { type: 'integer', minimum: 0 },
    cost_usd: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

const myQueueJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const claimTaskJsonSchema = {
  type: 'object',
  properties: {
    ticket_id: uuid,
    id: verbCallId,
    session_url: sessionUrl,
  },
  required: ['ticket_id'],
  additionalProperties: false,
};

const runStepJsonSchema = {
  type: 'object',
  properties: {
    run_id: uuid,
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'что сделано на этом шаге — одной фразой, для человека',
    },
    external: {
      type: 'boolean',
      description:
        'true, если шаг тронул внешнее: ветка, файлы, сеть — всё вне Orbis. По этому признаку сервер решает, можно ли безопасно перезапустить оборванный прогон',
    },
    id: verbCallId,
  },
  required: ['run_id', 'summary'],
  additionalProperties: false,
};

const checkpointJsonSchema = {
  type: 'object',
  properties: {
    run_id: uuid,
    question: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description: 'вопрос владельцу: чего не хватает для продолжения',
    },
    usage: runUsageJsonSchema,
    session_url: sessionUrl,
    id: verbCallId,
  },
  required: ['run_id', 'question'],
  additionalProperties: false,
};

const finishJsonSchema = {
  type: 'object',
  properties: {
    run_id: uuid,
    report: {
      type: 'string',
      minLength: 1,
      maxLength: 20000,
      description: 'что сделано и что проверить — это читает владелец, а не другой агент',
    },
    usage: runUsageJsonSchema,
    session_url: sessionUrl,
    id: verbCallId,
  },
  required: ['run_id', 'report'],
  additionalProperties: false,
};

/**
 * Предложение рутины (V1.6) — вход `orbis_propose`, парный zod-схеме `proposeInput`
 * (@orbis/shared/contracts/agent-loop; парность закреплена registry.test.ts).
 *
 * `input` операции описан как `type: 'object'` без свойств намеренно: форма зависит от
 * тула операции, и повторять здесь четыре схемы значило бы завести им второе,
 * расходящееся определение. Разбирает их строгими схемами сервер (routines/propose.ts) —
 * то же разделение, что у `batch_execute`.
 */
const proposeJsonSchema = {
  type: 'object',
  properties: {
    run_id: uuid,
    explanation: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description:
        'зачем это нужно — прозой, для владельца: он читает объяснение, а не список операций',
    },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PROPOSAL_OPERATIONS,
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: [...PROPOSAL_ALLOWED_TOOLS] },
          input: { type: 'object' },
        },
        required: ['tool', 'input'],
        additionalProperties: false,
      },
      description:
        'правки, которые предлагается применить одной группой; предусловия сервер снимает сам — передавать их не нужно и нельзя',
    },
    id: verbCallId,
  },
  required: ['run_id', 'explanation', 'operations'],
  additionalProperties: false,
};

/**
 * Терминальный глагол режима `propose` (V1.6). В `AGENT_VERB_TOOLS` его нет и в
 * `AGENT_VERB_NAMES` тоже: круг внешнего исполнителя он не расширяет — это единственный
 * способ ВНУТРЕННЕГО исполнителя тронуть граф, и адресован он только прогону рутины.
 */
const PROPOSE_TOOL: OrbisToolDef = {
  name: 'orbis_propose',
  description:
    'Предложить владельцу правки и закончить прогон. Это ЕДИНСТВЕННЫЙ способ что-то ' +
    'изменить в режиме propose: сам ты не пишешь — предложение ложится в тред рутины и ждёт ' +
    'кнопки владельца. В explanation объясни прозой, зачем это нужно: владелец читает ' +
    'объяснение, а не список операций. Операции — entity_create, entity_update, ' +
    'relation_create, relation_delete (до 50); предусловия («пока значение такое») сервер ' +
    'снимает сам с текущих значений, передавать их не нужно. Рутины и назначения ' +
    '(orbis/routine, orbis/assignment) предлагать нельзя — отказ. После вызова прогон ' +
    'терминален: это последнее, что ты делаешь. Передавай id (uuid) для безопасного повтора.',
  inputJsonSchema: proposeJsonSchema,
  kind: 'mutate',
  routineOnly: true,
};

/**
 * Глаголы исполнителя (§9.3, С7). `kind: 'mutate'` у всех пяти — включая orbis_my_queue,
 * который по смыслу читающий: он подметает брошенные прогоны по дороге (С6), то есть
 * пишет. Классификация §7.10 даёт им всем уровень execute (одиночная не-архивирующая
 * мутация), и это инвариант 4 спеки: фоновому прогону некому подтверждать pending.
 *
 * Описания — ИНСТРУКЦИИ агенту, а не пересказ сигнатуры: у внешнего исполнителя нет ни
 * спецификации, ни системного промпта Orbis, и единственное место, где он узнаёт правила
 * круга (не закрывать тикет самому, не повторять отказ CONFLICT, слать id для
 * идемпотентности), — вот эти строки.
 */
const AGENT_VERB_TOOLS: OrbisToolDef[] = [
  {
    name: 'orbis_my_queue',
    description:
      'Что мне назначено: список тикетов этого доступа с их статусом, проектом и сводкой ' +
      'последнего прогона. Брать в работу можно только тикеты с claimable=true (статус inbox ' +
      'или planned) — остальные ждут владельца. По дороге сервер помечает брошенные прогоны ' +
      '(поле swept: сколько подмёл) и возвращает их тикеты в очередь. Начинай круг с этого ' +
      'вызова и бери ОДИН тикет за раз.',
    inputJsonSchema: myQueueJsonSchema,
    kind: 'mutate',
    agentOnly: true,
  },
  {
    name: 'orbis_claim_task',
    description:
      'Атомарно взять назначенный мне тикет в работу: тикет → in_progress, создаётся прогон ' +
      '(сущность). Возвращает задание (title, body, аспекты), body проекта с описанием ' +
      'процесса и историю прошлых прогонов (их отчёты, вопросы и ответы владельца). Отказ ' +
      'CONFLICT — тикет уже в работе или не мой: не повторяй, возьми другой из orbis_my_queue. ' +
      'Передавай id (uuid) — повтор с тем же id безопасен. Работай над одним тикетом за раз; ' +
      'шаги фиксируй orbis_run_step, вопросы — orbis_checkpoint, итог — orbis_finish (тикет не ' +
      'закрывай сам).',
    inputJsonSchema: claimTaskJsonSchema,
    kind: 'mutate',
    agentOnly: true,
  },
  {
    name: 'orbis_run_step',
    description:
      'Зафиксировать шаг прогона: короткая сводка того, что сделано. Ставь external=true, если ' +
      'шаг тронул внешнее (создал ветку, изменил файлы, сходил в сеть) — по этому признаку ' +
      'сервер решает, можно ли безопасно перезапустить прогон, если он оборвётся. Зови ' +
      'регулярно: прогон без шагов дольше получаса считается брошенным. Возвращает step_count. ' +
      'Отказ CONFLICT — прогон уже завершён или чужой: не повторяй, начни с orbis_my_queue. ' +
      'Передавай id (uuid) для безопасного повтора.',
    inputJsonSchema: runStepJsonSchema,
    kind: 'mutate',
    agentOnly: true,
  },
  {
    name: 'orbis_checkpoint',
    description:
      'Остановиться и спросить владельца: тикет уходит в waiting с твоим вопросом, прогон ' +
      'закрывается. Зови, когда без решения человека дальше идти нельзя (выбор подхода, ' +
      'доступ, противоречие в задании) — и заканчивай работу, ответ придёт в историю ' +
      'следующего orbis_claim_task. После чекпойнта прогон терминален: шаги в него больше не ' +
      'принимаются. Передавай id (uuid) для безопасного повтора.',
    inputJsonSchema: checkpointJsonSchema,
    kind: 'mutate',
    agentOnly: true,
  },
  {
    name: 'orbis_finish',
    description:
      'Итог прогона: «готово, проверь». В report опиши, что сделано и что проверить — это ' +
      'читает владелец. Тикет НЕ закрывается: он уходит в waiting на проверку (в done — только ' +
      'если владелец заранее разрешил это назначением). Сам статус тикета не меняй. После ' +
      'orbis_finish прогон терминален. Передавай id (uuid) для безопасного повтора.',
    inputJsonSchema: finishJsonSchema,
    kind: 'mutate',
    agentOnly: true,
  },
];

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
    // Про регистр сказано отдельно и не зря: containment — это jsonb `@>`, он
    // побайтовый (проверено на живой базе: `["такси"]` НЕ содержит `"Такси"`),
    // а сидированные синонимы все строчные. Модель, «причесавшая» ввод
    // пользователя до «Такси», получила бы пустую выдачу без единой подсказки
    // почему — ровно та тихая ложь, ради которой затевалась эта ветка.
    // Нормализация регистра в самом предикате требует функционального
    // GIN-индекса, то есть новой миграции, и вынесена в бэклог.
    description:
      'Поиск/фильтрация сущностей грамматикой запросов Orbis (§6). Возвращает список сущностей (core-поля + tags + aspects). Примеры: «aspect=orbis/category, search=Еда»; «aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, limit=20»; «aspect=orbis/category, aliases=такси» (резолв категории по синониму: aliases — массив, фильтр ищет точное вхождение — регистр важен, синонимы строчные).',
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
    // Хвост V1 (Д-1 смоука): «отмени последнее» словами в чате. До него у чат-модели не было
    // undo-тула вовсе — на фразу она правила граф вручную (второе действие вместо снятия
    // первого). Тул — обёртка над undoLast §7.8: последнее ВИДИМОЕ действие журнала
    // владельца (системные пропускаются), undo-запись в тот же тред; нового action не
    // порождает — потому в ToolDispatchResult не отдаёт actionId (undo неотменяем).
    // internalOnly: MCP-агент отменяет своё точечно (ai.undo — поверхность владельца; у
    // агента — обратные операции); рутине закрыт наглухо (ROUTINE_CLOSED_TOOLS): фоновый
    // прогон не вправе снимать действия владельца. Вторая линия — сам диспатч: только
    // source 'chat' и актор 'ai'.
    name: 'undo_last',
    description:
      'Отменить ПОСЛЕДНЕЕ действие в графе (Undo §7.8): «отмени последнее», «отмени», «верни как было», «убери, что только что сделал». Откатывает последнее видимое действие журнала пользователя — своё или пользователя, — независимо от того, в этом ли треде оно случилось. Вызывай ТОЛЬКО по явной просьбе пользователя отменить последнее; не чини правкой то, что нужно отменить, и не зови повторно ради «ещё раз отменить», не переспросив. Ответ: что именно отменено (actionId, тип, заголовок) либо «отменять нечего».',
    inputJsonSchema: undoLastJsonSchema,
    kind: 'mutate', // меняет граф (inverse через executor) — для политики и гейтов это мутация
    internalOnly: true,
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

/**
 * Сборка реестра из загруженных строк аспектов (синхронная часть — для dispatch).
 *
 * Служебные аспекты (`SERVICE_ASPECT_IDS`, сегодня — orbis/agent-run) attach_*-тула НЕ
 * получают: прогон правит только сервер (С5/С7) глаголами orbis_claim_task / orbis_run_step
 * / orbis_checkpoint / orbis_finish. Без attach_*-тула ПРЯМОГО способа править прогон у
 * модели нет; core-тулы (`entity_create`/`entity_update`, `batch_execute`) аспект принимают
 * по-прежнему — их удерживает aiInstructions аспекта, см. «Известные границы» спеки.
 * Фильтр стоит здесь, а не в `loadAspectToolRows`: этим же путём идут `buildToolRegistry`
 * и `scripts/llm-smoke.ts` — отсечение одно на всех потребителей.
 */
export function buildToolDefs(aspectRows: AspectToolRow[]): OrbisToolDef[] {
  const attachable = aspectRows.filter(
    (r) => !(SERVICE_ASPECT_IDS as readonly string[]).includes(r.id),
  );
  return [...CORE_TOOLS, ...AGENT_VERB_TOOLS, PROPOSE_TOOL, ...attachable.map(attachToolDef)];
}

/** Собирает реестр: core-тулы §9.2 + attach_<aspect> для каждого активного аспекта (§7.6). */
export async function buildToolRegistry(tx: Tx): Promise<OrbisToolDef[]> {
  return buildToolDefs(await loadAspectToolRows(tx));
}
