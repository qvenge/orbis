// apps/server/src/llm/context.ts
// Сборка контекста LLM-вызова — пятислойная модель §7.1:
//   слой 1 (промпт v1 + ai_instructions активных аспектов реестра),
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
import { and, desc, eq, sql } from 'drizzle-orm';
import { chatMessages, entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { readEntity } from '../entity-read';
import type { ActionRecord } from '../executor/types';
import { loadAspectToolRows } from '../tools/registry';
import { SYSTEM_PROMPT_V1, TOOL_RESULT_MARKER } from './prompts/v1';
import type { LLMMessage } from './types';

/** Кап памяти §7.4: до ~50 активных memory-сущностей в слое 2. */
export const MEMORY_CAP = 50;
/** Rolling-окно истории треда (решение 6 плана 1b: без summary). */
export const CONTEXT_HISTORY_LIMIT = 30;
/** Превью body memory-сущности в строке слоя 2. */
export const MEMORY_BODY_PREVIEW = 200;
/** Превью body якорной сущности в слое 3 (§7.1: «превью body»). */
export const ANCHOR_BODY_PREVIEW = 500;

const MEMORY_ASPECT = 'orbis/memory';

export interface BuildContextInput {
  ownerId: string;
  threadId: string;
  /** Сущность-якорь (02 §2.2) — передаётся ТОЛЬКО для треда сущности. */
  anchorEntityId?: string;
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
 * SYSTEM_PROMPT_V1 (см. TOOL_RESULT_MARKER). Единственная точка формата:
 * tool-цикл Task 9 обязан доставлять результаты тулов ИМЕННО этим хелпером.
 */
export function toolResultMessage(toolName: string, result: unknown): LLMMessage {
  return { role: 'user', content: `${TOOL_RESULT_MARKER}${toolName}] ${JSON.stringify(result)}` };
}

// ---------------------------------------------------------------------------
// Слой 2: память §7.4
// ---------------------------------------------------------------------------

interface MemoryItem {
  id: string;
  title: string;
  body: string;
  kind: 'rule' | 'fact';
  scope: string;
  updatedAt: Date;
}

/**
 * Активные memory-сущности владельца (RLS текущего tx). Простой SELECT по
 * `aspects ? 'orbis/memory'` вместо прогона через query-компилятор §6 —
 * фильтр тривиален, а сортировка приоритета (§7.4) всё равно доменная:
 * kind=rule раньше fact, scoped раньше глобальных, затем свежесть updated_at.
 * «Недавно использованные» из §7.4 в MVP приближены updated_at (использование
 * памяти отдельно не трекается — осознанное упрощение слайса 1b).
 */
async function loadMemory(tx: Tx): Promise<MemoryItem[]> {
  const rows = await tx
    .select({
      id: entities.id,
      title: entities.title,
      body: entities.body,
      aspects: entities.aspects,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(and(sql`${entities.aspects} ? ${MEMORY_ASPECT}`, eq(entities.archived, false)));

  const items: MemoryItem[] = rows.map((r) => {
    const mem = (r.aspects as Record<string, Record<string, unknown>>)[MEMORY_ASPECT] ?? {};
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
function memoryLine(m: MemoryItem): string {
  const scope = m.scope ? `[${m.scope}]` : '';
  const flatBody = flatten(m.body);
  const body = flatBody ? `: ${preview(flatBody, MEMORY_BODY_PREVIEW)}` : '';
  return `— [${m.kind}]${scope} ${flatten(m.title)}${body}`;
}

// ---------------------------------------------------------------------------
// Слой 3: якорная сущность (02 §2.2)
// ---------------------------------------------------------------------------

/** Компактный блок якоря: id (для тулов), title, tags, аспекты, превью body. */
async function anchorBlock(tx: Tx, ownerId: string, anchorEntityId: string): Promise<string> {
  // include: [] — только сама сущность, без relations/backlinks/треда
  // (историю треда несёт слой 4); невидимая/чужая → NOT_FOUND из readEntity
  const { entity } = await readEntity(tx, ownerId, { id: anchorEntityId, include: [] });
  // title/tags/body — данные владельца (их пишет и внешний агент через MCP): переводы
  // строк из них не должны подделывать строки этого блока (см. flatten).
  const lines = [
    'Якорная сущность треда — текущий разговор идёт о ней:',
    `id: ${entity.id}`,
    `title: ${flatten(entity.title)}`,
  ];
  if (entity.tags.length > 0) lines.push(`tags: ${entity.tags.map(flatten).join(', ')}`);
  const aspectIds = Object.keys(entity.aspects);
  if (aspectIds.length > 0) {
    // Данные аспектов компактным JSON: статус задачи/суммы и т.п. — рабочий контекст
    const parts = aspectIds.map((id) => `${id} ${JSON.stringify(entity.aspects[id])}`);
    lines.push(`аспекты: ${parts.join('; ')}`);
  }
  if (entity.body)
    lines.push(`body (превью): ${preview(flatten(entity.body), ANCHOR_BODY_PREVIEW)}`);
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
 * Инфраструктурные system-строки, невидимые модели (как и клиенту — зеркало фильтра
 * chat.listMessages): processing-маркеры §7.9 и audit СИСТЕМНЫХ действий
 * (source='system' — материализация recurring-инстансов §5.4): «[действие: batch]» на
 * каждый пересчёт агенды — шум, вытесняющий сигнал из rolling-окна. Журнал §7.8 не
 * трогаем — только отображение. JS-предикат NULL-безопасен по построению (урок A1):
 * у строк без ключей type/actions условия ложны; audit chat/fast_path/mcp/ui — остаются.
 */
function isInfraSystemRow(role: string, metadata: Record<string, unknown>): boolean {
  if (role !== 'system') return false;
  if (metadata.type === 'processing') return true;
  const actions = metadata.actions;
  return (
    Array.isArray(actions) &&
    actions.some((a) => (a as ActionRecord | null | undefined)?.source === 'system')
  );
}

/** Последние CONTEXT_HISTORY_LIMIT сообщений треда — В ХРОНОЛОГИЧЕСКОМ ПОРЯДКЕ. */
async function historyMessages(tx: Tx, threadId: string): Promise<LLMMessage[]> {
  const rows = await tx
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      metadata: chatMessages.metadata,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(CONTEXT_HISTORY_LIMIT);
  rows.reverse(); // выборка «последние N» шла с конца — возвращаем хронологию
  const msgs = rows
    // Инфраструктура, не контент: processing-маркер СОБСТВЕННОГО прогона всегда в окне
    // и сжимался бы в пустую строку «[система] »; system-audit — см. isInfraSystemRow
    .filter((r) => !isInfraSystemRow(r.role, r.metadata as Record<string, unknown>))
    .map((r) => {
      if (r.role === 'user' || r.role === 'assistant') {
        return { role: r.role, content: r.content } satisfies LLMMessage;
      }
      return compressSystemRow(r.content, r.metadata as Record<string, unknown>);
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
export async function buildContext(tx: Tx, input: BuildContextInput): Promise<BuiltContext> {
  const sections: string[] = [SYSTEM_PROMPT_V1];

  // Слой 1 (динамическая часть): ai_instructions активных аспектов реестра
  // (builtin + свои кастомные; собственное определение перекрывает builtin — §7.6)
  const aspectRows = await loadAspectToolRows(tx);
  const instructions = aspectRows
    .filter((r) => r.aiInstructions)
    .map((r) => `- ${r.id}: ${r.aiInstructions}`);
  if (instructions.length > 0) {
    sections.push(`Инструкции активных аспектов:\n${instructions.join('\n')}`);
  }

  // Слой 2: память §7.4
  const memory = await loadMemory(tx);
  if (memory.length > 0) {
    sections.push(
      `Память о пользователе (факты и правила; учитывай их в ответах и действиях):\n${memory.map(memoryLine).join('\n')}`,
    );
  }

  // Слой 3: якорная сущность — только для треда сущности
  if (input.anchorEntityId) {
    sections.push(await anchorBlock(tx, input.ownerId, input.anchorEntityId));
  }

  // Слой 4: rolling-история текущего треда (§7.3: скоупится разговор)
  const messages = await historyMessages(tx, input.threadId);

  return { system: sections.join('\n\n'), messages };
}
