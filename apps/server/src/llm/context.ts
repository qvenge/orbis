// apps/server/src/llm/context.ts
// Сборка контекста LLM-вызова — пятислойная модель §7.1:
//   слой 1 (промпт v4 + дата владельца §Б7-6-1 + ai_instructions активных аспектов реестра),
//   слой 2 (память §7.4: активные orbis/memory, кап MEMORY_CAP, приоритет rule/scope),
//   слой 3 (якорная сущность треда — 02 §2.2, только если тред сущности),
//   слой 4 (rolling-история треда) — слои 1–3 склеиваются в ПОЛЕ system,
//   слой 5 (определения тулов) сюда не входит — его передаёт Task 9 из реестра §9.2.
//
// Контракт Task 7: system-роль в messages ЗАПРЕЩЕНА (AnthropicProvider бросает) —
// системный канал ровно один: поле system. Все system-строки chat_messages
// (audit §7.8, undo, pending, reject) в историю попадают СЖАТО под user/assistant.
//
// Решение 6 плана 1b: summary НЕ реализуется — rolling-окно последних
// CONTEXT_HISTORY_LIMIT сообщений треда (в выдаче — хронологический порядок);
// summary отложен до реального переполнения (кандидат — слайс 2, фиксируется в §12).
//
// Токен-бюджеты §7.1 — ориентиры, не жёсткие константы: капы ниже (50 памятей,
// превью 200/500, окно 30) — их механическое воплощение для MVP.
//
// V1.5: слои 1(динамика)–3 переиспользует контекст прогона рутины (routines/context.ts) —
// у него свой промпт и своя история вместо треда, но инструкции аспектов, память, дата и
// якорь обязаны выглядеть для модели ТЕМ ЖЕ, чем в чате. Поэтому aspectInstructionsSection,
// todaySection/todaySectionFor, loadMemory/memoryLine/MEMORY_SECTION_HEADER и anchorBlock
// экспортируются, а не копируются.
//
// §Б7-6: промпт v4 приезжает в канал ДВУМЯ кусками (PROMPT_BODY + CONTINUATIONS_BLOCK) —
// блок продолжений обязан быть последним для модели, а не последним в тексте константы.
import { and, desc, eq, sql } from 'drizzle-orm';
import { excludeInfraSystemRows } from '../chat/messages';
import { chatMessages, entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { readEntity } from '../entity-read';
import type { ActionRecord } from '../executor/types';
import { ownerTimeZone, todayInTimeZone } from '../query/context';
import { loadRegistry } from '../registry/load';
import { loadAspectToolRows } from '../tools/registry';
import { toLlmEntity } from '../wire';
import { SYSTEM_PROMPT_V4, TOOL_RESULT_MARKER } from './prompts/v4';
import type { LLMMessage } from './types';

/** Разделитель секций системного канала — пустая строка между абзацами. */
const SECTION_SEPARATOR = '\n\n';

/** Кап памяти §7.4: до ~50 активных memory-сущностей в слое 2. */
export const MEMORY_CAP = 50;
/** Rolling-окно истории треда (решение 6 плана 1b: без summary). */
export const CONTEXT_HISTORY_LIMIT = 30;
/** Превью body memory-сущности в строке слоя 2. */
export const MEMORY_BODY_PREVIEW = 200;
/** Превью body якорной сущности в слое 3 (§7.1: «превью body»). */
export const ANCHOR_BODY_PREVIEW = 500;
/**
 * Потолок тела, которое идёт в якорь ЦЕЛИКОМ (`instruction`, V1.5): у рутины тело — это
 * задание, и урезать его превью значило бы урезать задание. Потолок всё же есть: тело
 * колонки не ограничено, а системный канал — ресурс прогона.
 */
export const ANCHOR_INSTRUCTION_CAP = 8000;

const MEMORY_ASPECT = 'orbis/memory';

/**
 * Заголовок блока продолжений — точная подстрока SYSTEM_PROMPT_V4.
 *
 * По нему промпт делится на тело и хвост, потому что блок продолжений обязан замыкать
 * СОБРАННЫЙ канал (§Б7-6-2): его инструкция «в КОНЦЕ ответа отдельной последней строкой»
 * теряет силу примера, когда после неё модель видит ещё четыре секции — дату, инструкции
 * аспектов, память и якорь.
 */
export const CONTINUATIONS_HEADING = 'Продолжения разговора:';

const CONTINUATIONS_START = SYSTEM_PROMPT_V4.indexOf(CONTINUATIONS_HEADING);
// Проверка на загрузке модуля, а не «когда-нибудь в тесте»: при -1 slice(0, -1) молча
// отрезал бы последний символ промпта, и канал ушёл бы к модели покалеченным.
if (CONTINUATIONS_START < 0) {
  throw new Error(`SYSTEM_PROMPT_V4 не содержит заголовка «${CONTINUATIONS_HEADING}»`);
}

/**
 * Тело промпта — всё до блока продолжений, ВКЛЮЧАЯ разделитель абзаца перед ним.
 *
 * Обе части ВЫЧИСЛЯЮТСЯ из SYSTEM_PROMPT_V4, а не выписаны текстом: правка промпта — это
 * новая линейка (v5, правило v4.ts:2-4), и копия здесь тихо разошлась бы с оригиналом.
 * Пин конкатенации — llm/context.test.ts.
 */
export const PROMPT_BODY = SYSTEM_PROMPT_V4.slice(0, CONTINUATIONS_START);
/** Блок продолжений — хвост промпта; в канале идёт ПОСЛЕДНЕЙ секцией (§Б7-6-2). */
export const CONTINUATIONS_BLOCK = SYSTEM_PROMPT_V4.slice(CONTINUATIONS_START);

/** Дни недели по индексу Date#getUTCDay (0 — воскресенье). */
const WEEKDAYS_RU = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
];

/**
 * День недели по дате YYYY-MM-DD. Считается от полуночи UTC: `today` УЖЕ приведён к зоне
 * владельца, и вторая примерка зоны сдвинула бы день. Имена — списком, а не Intl с
 * локалью ru: строка канала пиннится тестом дословно, а набор локальных данных ICU
 * зависит от сборки рантайма.
 */
function weekdayRu(today: string): string {
  const name = WEEKDAYS_RU[new Date(`${today}T00:00:00Z`).getUTCDay()];
  if (name === undefined) throw new Error(`не дата формата YYYY-MM-DD: «${today}»`);
  return name;
}

/**
 * Строка даты в таймзоне владельца — динамическая секция канала (§Б7-6-1), НЕ часть
 * промпта: у промпта версия и побайтная фикстура, а дата меняется каждые сутки.
 *
 * Без неё модель считает «сегодня» от даты своего обучения — и «задачи на сегодня»,
 * «перенеси на завтра», «просрочено» разъезжаются с тем, что видит владелец на экране.
 */
export function todaySection(input: { today: string; timeZone: string }): string {
  return `Сегодня: ${input.today} (${weekdayRu(input.today)}), таймзона владельца: ${input.timeZone}.`;
}

/**
 * Секция даты для канала: зона владельца из user_settings + «сегодня» в ней.
 *
 * Экспортируется, а не копируется в оба сборщика по той же причине, что и остальные слои
 * (см. шапку файла): дата, собранная дважды, разъехалась бы форматом — и фоновый прогон
 * видел бы «сегодня» иначе, чем чат.
 */
export async function todaySectionFor(tx: Tx, ownerId: string, now: Date): Promise<string> {
  const timeZone = await ownerTimeZone(tx, ownerId);
  return todaySection({ today: todayInTimeZone(timeZone, now), timeZone });
}

export interface BuildContextInput {
  ownerId: string;
  threadId: string;
  /** Сущность-якорь (02 §2.2) — передаётся ТОЛЬКО для треда сущности. */
  anchorEntityId?: string;
  /** Часы вызова (§Б7-6-1) — те же, что у метеринга и гейта; по умолчанию системные. */
  clock?: () => Date;
}

export interface BuiltContext {
  system: string;
  /** История треда; system-роли нет по построению (контракт Task 7). */
  messages: LLMMessage[];
}

/**
 * Обрезка превью: до cap символов, дальше — многоточие. Режем по code points,
 * а не по UTF-16-юнитам (fix round Task 8): String.slice на границе рвал бы
 * суррогатную пару (emoji и пр.) — в контекст утекал бы одиночный битый юнит.
 */
function preview(text: string, cap: number): string {
  const points = [...text];
  return points.length <= cap ? text : `${points.slice(0, cap).join('')}…`;
}

/**
 * Сериализация tool-результата в user-сообщение — протокол MVP, описанный в
 * действующем системном промпте (см. TOOL_RESULT_MARKER). Единственная точка формата:
 * tool-цикл Task 9 обязан доставлять результаты тулов ИМЕННО этим хелпером.
 */
export function toolResultMessage(toolName: string, result: unknown): LLMMessage {
  return { role: 'user', content: `${TOOL_RESULT_MARKER}${toolName}] ${JSON.stringify(result)}` };
}

// ---------------------------------------------------------------------------
// Слой 2: память §7.4
// ---------------------------------------------------------------------------

export interface MemoryItem {
  id: string;
  title: string;
  body: string;
  kind: 'rule' | 'fact';
  scope: string;
  updatedAt: Date;
}

/**
 * Заголовок слоя 2. Константой, а не литералом в двух местах: тот же слой собирает
 * контекст прогона рутины (routines/context.ts, V1.5), и разъехавшийся заголовок
 * означал бы, что «память» в фоне выглядит для модели не тем же блоком, что в чате.
 */
export const MEMORY_SECTION_HEADER =
  'Память о пользователе (факты и правила; учитывай их в ответах и действиях):';

/**
 * Активные memory-сущности владельца (RLS текущего tx). Простой SELECT по
 * `aspects_legacy ? 'orbis/memory'` вместо прогона через query-компилятор §6 —
 * фильтр тривиален, а сортировка приоритета (§7.4) всё равно доменная:
 * kind=rule раньше fact, scoped раньше глобальных, затем свежесть updated_at.
 * «Недавно использованные» из §7.4 в MVP приближены updated_at (использование
 * памяти отдельно не трекается — осознанное упрощение слайса 1b).
 */
export async function loadMemory(tx: Tx): Promise<MemoryItem[]> {
  const rows = await tx
    .select({
      id: entities.id,
      title: entities.title,
      body: entities.body,
      aspectsLegacy: entities.aspectsLegacy,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(and(sql`${entities.aspectsLegacy} ? ${MEMORY_ASPECT}`, eq(entities.archived, false)));

  const items: MemoryItem[] = rows.map((r) => {
    const mem = (r.aspectsLegacy as Record<string, Record<string, unknown>>)[MEMORY_ASPECT] ?? {};
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      // Схема аспекта §3.7 гарантирует enum на attach-пути; прямые записи
      // сводим fail-safe к 'fact' (не к потере строки)
      kind: mem.kind === 'rule' ? 'rule' : 'fact',
      scope: typeof mem.scope === 'string' ? mem.scope : '',
      updatedAt: r.updatedAt,
    };
  });

  items.sort((a, b) => {
    const kind = Number(a.kind !== 'rule') - Number(b.kind !== 'rule'); // rule первым
    if (kind !== 0) return kind;
    const scoped = Number(a.scope === '') - Number(b.scope === ''); // scoped первым
    if (scoped !== 0) return scoped;
    const recency = b.updatedAt.getTime() - a.updatedAt.getTime(); // свежие первыми
    if (recency !== 0) return recency;
    return a.id < b.id ? 1 : -1; // детерминированный tie-break (uuidv7 ~ время)
  });
  return items.slice(0, MEMORY_CAP);
}

/**
 * Схлопывает пробельные прогоны в один пробел. Данные графа (title, tags, body) попадают
 * в system-канал, где структуру задают переводы строк: многострочный title дописал бы в
 * промпт произвольные строки — например, поддельные секции или «инструкции».
 * Экранирование доверия это не заменяет, но держит заявленный формат блоков.
 */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Компактная строка памяти: «— [rule|fact][scope] title: превью body».
 * Инвариант формата — одна memory = одна строка списка: пробельные прогоны
 * (включая переводы строк body и title) схлопываются в один пробел ДО обрезки превью.
 */
export function memoryLine(m: MemoryItem): string {
  const scope = m.scope ? `[${m.scope}]` : '';
  const flatBody = flatten(m.body);
  const body = flatBody ? `: ${preview(flatBody, MEMORY_BODY_PREVIEW)}` : '';
  return `— [${m.kind}]${scope} ${flatten(m.title)}${body}`;
}

// ---------------------------------------------------------------------------
// Слой 3: якорная сущность (02 §2.2)
// ---------------------------------------------------------------------------

/** Как якорь показывает тело сущности. */
export interface AnchorBlockOptions {
  /**
   * Первая строка блока. У треда это «о чём разговор», у прогона рутины — «вот твоё
   * задание»: одна и та же сущность стоит в контексте по разным причинам, и молчаливо
   * назвать инструкцию «якорной сущностью треда» значило бы соврать про её роль.
   */
  intro?: string;
  /**
   * Тело — ЦЕЛИКОМ и с переводами строк (V1.5). Для чата тело якоря — справка, и
   * схлопнутое превью в 500 символов там уместно; для рутины тело — задание, а задание
   * из списка пунктов, схлопнутое в одну строку и обрезанное на полуслове, перестаёт
   * быть заданием. Защита `flatten` здесь не теряется зря: строки инструкции пишет сам
   * владелец, а правка тела/заголовка рутины в режиме `act` кем-то кроме него идёт через
   * карточку подтверждения (tools/dispatch.ts, C1b-1) — инструкция и должна выглядеть
   * инструкцией. У рутины в `propose` тело может править и чат-AI без карточки, но её
   * работа всё равно упирается в решение владельца по предложению.
   */
  instruction?: boolean;
}

/** Компактный блок якоря: id (для тулов), title, tags, аспекты, тело. */
export async function anchorBlock(
  tx: Tx,
  ownerId: string,
  anchorEntityId: string,
  opts: AnchorBlockOptions = {},
): Promise<string> {
  // include: [] — только сама сущность, без relations/backlinks/треда
  // (историю треда несёт слой 4); невидимая/чужая → NOT_FOUND из readEntity
  const { entity } = await readEntity(tx, ownerId, { id: anchorEntityId, include: [] });
  // title/tags/body — данные владельца (их пишет и внешний агент через MCP): переводы
  // строк из них не должны подделывать строки этого блока (см. flatten).
  const lines = [
    opts.intro ?? 'Якорная сущность треда — текущий разговор идёт о ней:',
    `id: ${entity.id}`,
    `title: ${flatten(entity.title)}`,
  ];
  if (entity.tags.length > 0) lines.push(`tags: ${entity.tags.map(flatten).join(', ')}`);
  /**
   * Значения — ПЛОСКО и ПО KEY (§А9-2, Р12 «key для машин»), той же проекцией, что печатает
   * сущность в ответе любого тула (`toLlmEntity`). Прежде здесь стояла старая карта
   * `{аспект: {поле: значение}}`; она ушла из wire-формы вместе с последним читателем
   * (Задача 13c), и второй, свой перевод «свойство → имя для модели» здесь означал бы,
   * что модель читает поле одним именем в якоре и пишет другим в туле.
   *
   * Реестр читается прямо здесь, а не приезжает параметром: якорь собирается один раз на
   * ход разговора (и один раз на прогон рутины), а проносить снимок через две чужих
   * сигнатуры ради одной строки значило бы связать сборщик контекста с порядком загрузки
   * реестра у обоих вызывающих.
   */
  const llm = toLlmEntity(entity, await loadRegistry(tx, ownerId));
  if (llm.aspects.length > 0) lines.push(`аспекты: ${llm.aspects.join(', ')}`);
  if (Object.keys(llm.props).length > 0) {
    // Компактным JSON: статус задачи, суммы и сроки — рабочий контекст, а не украшение.
    lines.push(`свойства: ${JSON.stringify(llm.props)}`);
  }
  if (entity.body) {
    lines.push(
      opts.instruction === true
        ? `Инструкция рутины (тело сущности):\n${preview(entity.body, ANCHOR_INSTRUCTION_CAP)}`
        : `body (превью): ${preview(flatten(entity.body), ANCHOR_BODY_PREVIEW)}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Слой 4: rolling-история треда
// ---------------------------------------------------------------------------

/**
 * Сжатие system-строк журнала в LLM-историю. Роли — РЕШЕНИЕ Task 8:
 * - audit СВОЕГО действия (metadata.actions[0].actor_kind === 'ai') → role
 *   'assistant': действие исполняла модель, она должна видеть его как своё
 *   («[действие: <type> <entity_id> (<source>)]»);
 * - audit действий агента/владельца, undo, pending, reject → role 'user'
 *   с префиксом «[система]»: для модели это наблюдаемые события среды.
 * Протокол Anthropic чередования не требует (маппер Task 7 транслирует как есть).
 * Сырой metadata-JSON (operations/inverse/payload) в контекст НЕ попадает.
 */
function compressSystemRow(content: string, metadata: Record<string, unknown>): LLMMessage {
  const actions = metadata.actions;
  const action = Array.isArray(actions) ? (actions[0] as ActionRecord | undefined) : undefined;
  if (action) {
    const entityRef = action.entity_id ? ` ${action.entity_id}` : '';
    const line = `[действие: ${action.type}${entityRef} (${action.source})]`;
    if (action.actor_kind === 'ai') return { role: 'assistant', content: line };
    return { role: 'user', content: `[система] ${line}` };
  }
  // undo/pending/reject и будущие служебные записи: content — короткий
  // человекочитаемый текст (undo.ts / pending.ts), metadata не тащим
  return { role: 'user', content: `[система] ${content}` };
}

/**
 * Пометка автора для поста в тред НЕ от владельца (thread_post, tools/dispatch.ts
 * runThreadPost): пост ложится `role: 'user'` с `metadata.author_kind`, и без пометки чат-модель
 * читала бы слова ночной рутины или внешнего агента как реплику владельца — и отвечала бы
 * «ему». Роль остаётся `user` (провайдер знает только user/assistant/system, а system в
 * messages запрещена — контракт Task 7): автор помечается в тексте. Правило то же, что у
 * маркера ленты на экране (web authorLabel): рутина (ai + прогон) → «рутина», агент →
 * «агент», внутренний AI без прогона → «AI»; у владельца пометки нет — сообщать модели,
 * что автор владелец, нечего.
 */
function authorPrefix(metadata: Record<string, unknown>): string {
  const kind = metadata.author_kind;
  if (kind === 'ai' && (metadata.routine_id !== undefined || metadata.run_id !== undefined)) {
    return '[рутина]: ';
  }
  if (kind === 'agent') return '[агент]: ';
  if (kind === 'ai') return '[AI]: ';
  return '';
}

/**
 * Последние CONTEXT_HISTORY_LIMIT сообщений треда — В ХРОНОЛОГИЧЕСКОМ ПОРЯДКЕ.
 * Инфраструктурные system-строки (processing-маркеры §7.9, audit системных действий
 * §5.4) невидимы модели, как и клиенту — общий SQL-фрагмент с chat.listMessages
 * (excludeInfraSystemRows). Фильтр — В SQL, до limit (финальное ревью фазы A):
 * JS-фильтр после .limit(30) съедал бы окно плотным системным шумом — 30+ audit-строк
 * материализации новее живого диалога вытесняли бы его из истории целиком.
 */
async function historyMessages(tx: Tx, threadId: string): Promise<LLMMessage[]> {
  const rows = await tx
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      metadata: chatMessages.metadata,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), ...excludeInfraSystemRows()))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(CONTEXT_HISTORY_LIMIT);
  rows.reverse(); // выборка «последние N» шла с конца — возвращаем хронологию
  const msgs = rows.map((r) => {
    const metadata = r.metadata as Record<string, unknown>;
    if (r.role === 'user') {
      return {
        role: 'user',
        content: `${authorPrefix(metadata)}${r.content}`,
      } satisfies LLMMessage;
    }
    if (r.role === 'assistant')
      return { role: 'assistant', content: r.content } satisfies LLMMessage;
    return compressSystemRow(r.content, metadata);
  });
  // Инвариант «messages начинается с user» — требование Anthropic Messages API
  // (fix round Task 8): граница окна на assistant-сообщении или ведущем сжатом
  // ai-audit давала бы 400 на КАЖДЫЙ вызов — ни провайдер, ни SDK не санитизируют.
  // Ведущие assistant отбрасываем; окно может стать короче лимита — приемлемо.
  // В реальном потоке Task 9 результат пустым не бывает: последним в окне всегда
  // стоит только что персистированное user-сообщение.
  const firstUser = msgs.findIndex((m) => m.role === 'user');
  return firstUser === -1 ? [] : msgs.slice(firstUser);
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

/**
 * Контекст LLM-вызова по §7.1. Вызывается под withIdentity (RLS скоупит память,
 * якорь и историю владельцем). anchorEntityId передаётся только для треда
 * сущности (02 §2.2) — глобальный тред слоя 3 не имеет.
 */
/**
 * Слой 1 (динамическая часть): ai_instructions активных аспектов реестра
 * (builtin + свои кастомные; собственное определение перекрывает builtin — §7.6).
 * null — активных инструкций нет, секцию не заводим.
 *
 * Экспортируется целиком, а не в виде «загрузи строки и собери сам»: тот же слой нужен
 * контексту прогона рутины (routines/context.ts, V1.5), а собранный дважды он разъехался
 * бы форматом — и «инструкции аспектов» в фоне выглядели бы для модели иначе, чем в чате.
 */
export async function aspectInstructionsSection(tx: Tx): Promise<string | null> {
  const aspectRows = await loadAspectToolRows(tx);
  const instructions = aspectRows
    .filter((r) => r.aiInstructions)
    .map((r) => `- ${r.id}: ${r.aiInstructions}`);
  return instructions.length === 0
    ? null
    : `Инструкции активных аспектов:\n${instructions.join('\n')}`;
}

export async function buildContext(tx: Tx, input: BuildContextInput): Promise<BuiltContext> {
  // Всё, что дописывается между телом промпта и блоком продолжений (§Б7-6-2)
  const dynamic: string[] = [
    await todaySectionFor(tx, input.ownerId, (input.clock ?? (() => new Date()))()),
  ];

  const instructions = await aspectInstructionsSection(tx);
  if (instructions !== null) dynamic.push(instructions);

  // Слой 2: память §7.4
  const memory = await loadMemory(tx);
  if (memory.length > 0) {
    dynamic.push(`${MEMORY_SECTION_HEADER}\n${memory.map(memoryLine).join('\n')}`);
  }

  // Слой 3: якорная сущность — только для треда сущности
  if (input.anchorEntityId) {
    dynamic.push(await anchorBlock(tx, input.ownerId, input.anchorEntityId));
  }

  // Слой 4: rolling-история текущего треда (§7.3: скоупится разговор)
  const messages = await historyMessages(tx, input.threadId);

  // PROMPT_BODY уже кончается разделителем абзаца (он отрезан по месту заголовка блока
  // продолжений) — первая динамическая секция приклеивается к нему напрямую, иначе между
  // ними встали бы лишние пустые строки. Свойство склейки: при пустом dynamic канал
  // побайтно равен SYSTEM_PROMPT_V4 — переставлена СБОРКА, а не текст промпта (РП-18).
  const system = PROMPT_BODY + [...dynamic, CONTINUATIONS_BLOCK].join(SECTION_SEPARATOR);

  return { system, messages };
}
