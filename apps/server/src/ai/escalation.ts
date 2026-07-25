// apps/server/src/ai/escalation.ts
// Эскалация повторных исправлений категории в memory-правило (01-arch §7.8):
// «после ДВУХ одинаковых исправлений AI предлагает создать правило; счётчик
// одинаковых исправлений не хранится отдельным состоянием — он вычисляется сканом
// журнала действий за последние 30 дней».
//
// ГДЕ ЭТО ЖИВЁТ (решение K7). Пост-коммит хуков в executor'е нет и заводить их не
// требуется: execute() открывает собственный withIdentity-tx, поэтому «после коммита»
// — это просто вызов у вызывающего. maybeSuggestRule зовётся из роутера ПОСЛЕ
// успешного execute() и работает ОТДЕЛЬНОЙ транзакцией; её ошибка логируется и не
// пробрасывается (escalateAfterEntityUpdate), иначе провал скана откатил бы саму
// правку категории.
//
// ПОЧЕМУ ОТКАЗ — НОВОЕ СООБЩЕНИЕ (решение K4). chat_messages append-only (§4.6),
// metadata неизменяема — «пометки в metadata карточки» не существует как операции.
// Отказ пишется новым системным сообщением с карточкой memory_rule_declined, и
// подавление повтора идёт тем же 30-дневным сканом, что и подавление по уже
// отправленному предложению (зеркало rejectPending §7.10).
import {
  counterpartySimilarity,
  DUP_SIMILARITY_THRESHOLD,
  type EntityUpdateInput,
  formatRuleTitle,
  memoryRuleDeclinedId,
  memoryRuleSuggestionId,
  normalizeCounterparty,
  parseRuleTitle,
  rulePatternFromTitle,
} from '@orbis/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { appendMessageIdempotent } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import type { ActionRecord } from '../executor/types';
import type { Card } from '../tools/registry';

const FINANCIAL = 'orbis/financial';
const MEMORY = 'orbis/memory';
const CATEGORY = 'orbis/category';
/** Окно скана журнала и окно подавления повторного предложения — §7.8, 30 дней. */
const WINDOW_DAYS = 30;
/** «После двух одинаковых исправлений» (§7.8), считая текущее. */
const MIN_CORRECTIONS = 2;

export interface SuggestRuleResult {
  suggested: boolean;
  /** Почему предложения нет — для диагностики и тестов; наружу (в UI) не уходит. */
  reason?: string;
}

interface Recategorization {
  entityId: string;
  from: string;
  to: string;
}

/** UTC-сутки записи — бакет ключа идемпотентности сообщений, не бизнес-«сегодня». */
function idDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function categoryRefOf(payload: Record<string, unknown>): string | undefined {
  const aspects = payload.aspects as Record<string, Record<string, unknown> | null> | undefined;
  const ref = aspects?.[FINANCIAL]?.category_ref;
  return typeof ref === 'string' ? ref : undefined;
}

/**
 * Пары (прежняя, новая) категории из ОДНОГО action журнала. Решение K5: одинаково
 * разбираются оба типа — 'entity_updated' (одна операция) и 'batch' (плоский
 * operations, агрегированный inverse, entity_id=null); пары сшиваются по payload.id.
 * entity_create в batch отсеивается сам: его inverse — архивация, без аспектов.
 * Опора на форму journal-payload'а executor'а (executor.ts prepareEntityUpdate):
 * changed.aspects/prior.aspects несут ВЕСЬ затронутый аспект-ключ целиком.
 */
function extractRecategorizations(action: ActionRecord): Recategorization[] {
  const before = new Map<string, string>();
  for (const op of action.inverse) {
    if (op.op !== 'entity_update') continue;
    const id = op.payload.id;
    const ref = categoryRefOf(op.payload);
    if (typeof id === 'string' && ref !== undefined) before.set(id, ref);
  }
  const out: Recategorization[] = [];
  for (const op of action.operations) {
    if (op.op !== 'entity_update') continue;
    const id = op.payload.id;
    if (typeof id !== 'string') continue;
    const to = categoryRefOf(op.payload);
    const from = before.get(id);
    if (to === undefined || from === undefined || from === to) continue;
    out.push({ entityId: id, from, to });
  }
  return out;
}

/**
 * Все рекатегоризации журнала владельца за 30 дней, кроме текущего действия.
 * Containment по GIN (chat_messages_metadata_gin) сужает выборку до сообщений, чей
 * action трогал orbis/financial. Отменённые действия исключаются тем же NOT EXISTS,
 * что и в findLastUndoable (undo.ts): «исправил → отменил → исправил» не должно
 * считаться двумя исправлениями.
 */
async function journalRecategorizations(
  tx: Tx,
  exceptActionId: string,
): Promise<Recategorization[]> {
  const probe = (type: string): string =>
    JSON.stringify({
      actions: [{ type, operations: [{ payload: { aspects: { [FINANCIAL]: {} } } }] }],
    });
  const rows = await tx.execute(
    sql`SELECT m.metadata FROM chat_messages m
        WHERE m.created_at > now() - make_interval(days => ${WINDOW_DAYS})
          AND (m.metadata @> ${probe('entity_updated')}::jsonb
               OR m.metadata @> ${probe('batch')}::jsonb)
          AND NOT EXISTS (
            SELECT 1 FROM chat_messages u
            WHERE u.metadata @> jsonb_build_object(
              'type', 'undo', 'undoes', m.metadata->'actions'->0->>'id')
          )`,
  );
  const out: Recategorization[] = [];
  for (const row of rows) {
    const action = (row.metadata as { actions?: ActionRecord[] }).actions?.[0];
    if (!action || action.id === exceptActionId) continue;
    out.push(...extractRecategorizations(action));
  }
  return out;
}

async function titleOf(tx: Tx, id: string): Promise<string | undefined> {
  const rows = await tx.select({ title: entities.title }).from(entities).where(eq(entities.id, id));
  return rows[0]?.title;
}

/** Название категории — оно и есть связь правила с категорией (см. shared/memory/rule.ts). */
async function categoryTitleOf(tx: Tx, id: string): Promise<string | undefined> {
  const rows = await tx
    .select({ title: entities.title })
    .from(entities)
    .where(and(eq(entities.id, id), sql`${entities.aspects} ? ${CATEGORY}`));
  return rows[0]?.title;
}

async function titlesOf(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ title: entities.title })
    .from(entities)
    .where(inArray(entities.id, ids));
  return rows.map((r) => r.title);
}

/**
 * Активное (неархивное — §7.4) правило того же смысла уже есть. Эквивалентность:
 * тот же паттерн после normalizeCounterparty (той же нормализации, которой D4 будет
 * сопоставлять правило со входом, K12) и то же название категории без учёта регистра.
 */
async function hasEquivalentRule(tx: Tx, pattern: string, categoryTitle: string): Promise<boolean> {
  const rows = await tx
    .select({ title: entities.title })
    .from(entities)
    .where(
      and(
        sql`${entities.aspects} ? ${MEMORY}`,
        eq(entities.archived, false),
        sql`${entities.aspects} -> ${MEMORY} ->> 'kind' = 'rule'`,
        sql`${entities.aspects} -> ${MEMORY} ->> 'scope' = ${FINANCIAL}`,
      ),
    );
  return rows.some((r) => {
    const parsed = parseRuleTitle(r.title);
    if (parsed === null) return false;
    return (
      normalizeCounterparty(parsed.pattern) === pattern &&
      parsed.categoryTitle.trim().toLowerCase() === categoryTitle.trim().toLowerCase()
    );
  });
}

/** Предложение по этой паре уже отправлено ИЛИ отклонено за последние 30 дней (K4). */
async function alreadyOffered(tx: Tx, pattern: string, rc: Recategorization): Promise<boolean> {
  const probe = (kind: string): string =>
    JSON.stringify({
      cards: [{ kind, pattern, fromCategoryId: rc.from, toCategoryId: rc.to }],
    });
  const rows = await tx.execute(
    sql`SELECT 1 AS hit FROM chat_messages
        WHERE created_at > now() - make_interval(days => ${WINDOW_DAYS})
          AND (metadata @> ${probe('memory_rule_suggestion')}::jsonb
               OR metadata @> ${probe('memory_rule_declined')}::jsonb)
        LIMIT 1`,
  );
  return rows.length > 0;
}

async function considerOne(
  tx: Tx,
  ownerId: string,
  actionId: string,
  rc: Recategorization,
): Promise<SuggestRuleResult> {
  const title = await titleOf(tx, rc.entityId);
  if (title === undefined) return { suggested: false, reason: 'entity_not_found' };
  const pattern = rulePatternFromTitle(title);
  // «SBOL 1234» → пустой паттерн: правилом такое стать не может, и без этого гейта
  // две «пустые» строки дали бы counterpartySimilarity === 1 (normalize.ts §7)
  if (pattern === '') return { suggested: false, reason: 'empty_pattern' };
  const categoryTitle = await categoryTitleOf(tx, rc.to);
  if (categoryTitle === undefined) return { suggested: false, reason: 'category_not_found' };

  // «Одинаковое исправление» — та же пара категорий И похожий counterparty. Считаем по
  // РАЗНЫМ сущностям: правки одной и той же транзакции туда-обратно — сомнения
  // пользователя, а не повторяющийся паттерн.
  const others = (await journalRecategorizations(tx, actionId)).filter(
    (c) => c.from === rc.from && c.to === rc.to && c.entityId !== rc.entityId,
  );
  const otherTitles = await titlesOf(tx, [...new Set(others.map((c) => c.entityId))]);
  const same = otherTitles.filter(
    (t) => counterpartySimilarity(title, t) >= DUP_SIMILARITY_THRESHOLD,
  ).length;
  if (same + 1 < MIN_CORRECTIONS) return { suggested: false, reason: 'not_repeated' };

  if (await hasEquivalentRule(tx, pattern, categoryTitle)) {
    return { suggested: false, reason: 'rule_exists' };
  }
  if (await alreadyOffered(tx, pattern, rc)) {
    return { suggested: false, reason: 'already_suggested' };
  }

  const ruleText = formatRuleTitle({ pattern, categoryTitle });
  // Решение K3: дискриминант карточки — kind. Поля обязаны дословно совпадать с
  // web-типом MemoryRuleSuggestionData (задача D3b) — union'ы намеренно не общие.
  const card: Card = {
    kind: 'memory_rule_suggestion',
    ruleText,
    pattern,
    fromCategoryId: rc.from,
    toCategoryId: rc.to,
    categoryTitle,
  };
  const threadId = await ensureGlobalThread(tx, ownerId);
  await appendMessageIdempotent(tx, {
    id: memoryRuleSuggestionId({
      ownerId,
      pattern,
      fromCategoryId: rc.from,
      toCategoryId: rc.to,
      date: idDate(),
    }),
    threadId,
    role: 'system',
    content: `Вы уже второй раз переносите это в «${categoryTitle}». Запомнить правило «${ruleText}»?`,
    metadata: { cards: [card] },
  });
  return { suggested: true };
}

/**
 * Вызывается ПОСЛЕ успешного execute() рекатегоризации (K7). Счётчик нигде не
 * хранится — считается сканом журнала за 30 дней (§7.8). Действие с несколькими
 * рекатегоризациями (batch) рассматривается по порядку до первого предложения:
 * одно системное сообщение на действие.
 */
export async function maybeSuggestRule(deps: {
  db: Db;
  ownerId: string;
  action: ActionRecord;
}): Promise<SuggestRuleResult> {
  const recats = extractRecategorizations(deps.action);
  if (recats.length === 0) return { suggested: false, reason: 'not_recategorization' };
  return withIdentity(deps.db, deps.ownerId, async (tx) => {
    let last: SuggestRuleResult = { suggested: false, reason: 'not_recategorization' };
    for (const rc of recats) {
      last = await considerOne(tx, deps.ownerId, deps.action.id, rc);
      if (last.suggested) return last;
    }
    return last;
  });
}

/** Записанный action по id — containment по GIN, как в undo.ts. */
async function findAction(tx: Tx, actionId: string): Promise<ActionRecord | undefined> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await tx.execute(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  const md = rows[0]?.metadata as { actions?: ActionRecord[] } | undefined;
  return md?.actions?.find((a) => a.id === actionId);
}

/**
 * Точка вызова для роутера entity.update (K7): читает записанный action и зовёт
 * эскалацию отдельной транзакцией. Ошибка ЛОГИРУЕТСЯ и не пробрасывается — правка
 * категории уже закоммичена, и провал предложения не имеет права её ронять.
 * Дешёвый гейт по input: журнал читаем, только если патч трогал category_ref, —
 * entity.update зовётся на каждую правку заголовка/тега.
 */
export async function escalateAfterEntityUpdate(
  db: Db,
  args: { ownerId: string; actionId: string; input: EntityUpdateInput },
): Promise<void> {
  if (typeof args.input.aspects?.[FINANCIAL]?.category_ref !== 'string') return;
  try {
    const action = await withIdentity(db, args.ownerId, (tx) => findAction(tx, args.actionId));
    if (action) await maybeSuggestRule({ db, ownerId: args.ownerId, action });
  } catch (e) {
    console.error('[ai.escalation] предложение правила не записано:', e);
  }
}

/**
 * Отказ от предложения (кнопка «Не надо», D3b). Журнал append-only (§4.6) — карточка
 * предложения не правится, пишется НОВОЕ системное сообщение с карточкой
 * memory_rule_declined (K4). Идемпотентность — детерминированный PK по паре, паттерну
 * и дате: повтор в те же сутки возвращает исходное сообщение вместо второй карточки.
 */
export async function declineRuleSuggestion(
  db: Db,
  args: { ownerId: string; pattern: string; fromCategoryId: string; toCategoryId: string },
): Promise<{ alreadyDeclined: boolean }> {
  const card: Card = {
    kind: 'memory_rule_declined',
    pattern: args.pattern,
    fromCategoryId: args.fromCategoryId,
    toCategoryId: args.toCategoryId,
  };
  return withIdentity(db, args.ownerId, async (tx) => {
    const threadId = await ensureGlobalThread(tx, args.ownerId);
    const { replayed } = await appendMessageIdempotent(tx, {
      id: memoryRuleDeclinedId({ ...args, date: idDate() }),
      threadId,
      role: 'system',
      content: 'Правило не создаём',
      metadata: { cards: [card] },
    });
    return { alreadyDeclined: replayed };
  });
}
