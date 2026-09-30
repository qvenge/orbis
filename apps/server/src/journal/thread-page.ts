// apps/server/src/journal/thread-page.ts
// Выдача треда (спека скорости §11.3): сообщения треда и карточки журнала этого треда, объединённые НА ЧТЕНИИ одной
// процедурой с общим составным курсором `(время, id)`. Сообщения журнал не копируют — журнал живёт своей таблицей
// (§11.2), и тред складывается из двух выборок. Читатели — `chat.listMessages`, тред в `entity.get` и окно истории
// контекста модели: одна процедура на три места, иначе они разошлись бы фильтрами (так уже было до задачи 5 —
// `entity.get` отдавал тред без фильтра маркеров и целиком).
//
// Провод прежний (РП-10, новое поведение тредов — задача 6): карточка журнала — system-строка с заголовком и
// `metadata {actions: [сводка], cards: [карточка ленты]}` (id строки — производный id элемента треда, рулинг R-12;
// id действия — в сводке), но БЕЗ тел действия (§9 приватность): ни операций, ни
// данных отмены, ни результатов пачки, ни актора-аккаунта. Сводка несёт ровно то, что читают лента
// (`authorLabel`: actor_kind, actor_grant_id, source) и сжатие строк контекста (`compressSystemRow`: type,
// entity_id, source, actor_kind).
import type { GraphId } from '@orbis/shared';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { excludeInfraSystemRows, type WireChatMessage } from '../chat/messages';
import { chatMessages } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { feedCard } from '../executor/journal';
import { type JournalEntry, threadFeed } from '../executor/journal-read';
import { toWireChatMessage } from '../wire';

/** Курсор выдачи: `<iso>` (легаси-клиент 1c-1 — строго раньше по времени) или `<iso>|<id>` (составной). */
function parseBefore(before: string | undefined): { at: Date; key?: string } | undefined {
  if (before === undefined) return undefined;
  const sep = before.indexOf('|');
  if (sep === -1) return { at: new Date(before) };
  return { at: new Date(before.slice(0, sep)), key: before.slice(sep + 1) };
}

/** Сводка действия в проводе — прежние поля `metadata.actions[0]` без тел (§9). */
function actionSummary(e: JournalEntry): Record<string, unknown> {
  return {
    id: e.id,
    type: e.type,
    entity_id: e.entityId,
    actor_kind: e.actorKind,
    source: e.source,
    ...(e.actorGrantId !== undefined && { actor_grant_id: e.actorGrantId }),
    ...(e.runId !== undefined && { run_id: e.runId }),
  };
}

/**
 * Запись журнала → строка треда прежней формы провода. id строки — производный id элемента треда (`itemId`, рулинг
 * R-12: у одобренной единицы id записи совпал бы с PK её карточки-запроса в том же треде); id ДЕЙСТВИЯ — в сводке
 * `actions[0].id` и в `undoActionId` карточки ленты — по нему отмена.
 */
function journalItem(e: JournalEntry & { itemId: string }, threadId: string): WireChatMessage {
  const card = { tool: e.cardTool, entity_id: e.entityId, title: e.title };
  return {
    id: e.itemId,
    threadId,
    role: 'system',
    content: e.title,
    metadata: {
      actions: [actionSummary(e)],
      cards: [feedCard({ id: e.id, source: e.source }, card)],
    },
    createdAt: e.createdAt.toISOString(),
  };
}

/**
 * Порядок выдачи `(created_at DESC, id DESC)` по id НА ПРОВОДЕ — тот же, что у каждой выборки в SQL (сообщения — по PK,
 * журнал — по производному id элемента). Время — ISO с миллисекундами (обе колонки `timestamptz(3)`), id — каноничный
 * uuid в нижнем регистре (текст PG): лексикографика строк совпадает с порядком PG (`uuid` сравнивается побайтно),
 * поэтому слияние в TS не расходится с курсором SQL, а id элементов потока уникальны — курсор однозначен.
 */
function newerFirst(a: WireChatMessage, b: WireChatMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Страница треда: до `limit` строк новее курсора `before` — сообщений (без инфраструктурных строк
 * `excludeInfraSystemRows`) и карточек журнала треда (`journal-read.threadFeed`: без записей отмены и `system`).
 * Каждая выборка берёт до `limit` своих строк тем же курсором, слияние — первые `limit` общего порядка: страница
 * не пропускает и не повторяет строк на стыке двух таблиц, потому что следующая страница стартует с курсора
 * последней отданной строки, а он строг в обеих выборках.
 */
export async function threadPage(
  tx: Tx,
  graph: GraphId,
  threadId: string,
  page: { before?: string; limit: number },
): Promise<WireChatMessage[]> {
  const before = parseBefore(page.before);
  const conds: (SQL | undefined)[] = [
    eq(chatMessages.threadId, threadId),
    ...excludeInfraSystemRows(),
  ];
  if (before !== undefined) {
    conds.push(
      before.key === undefined
        ? lt(chatMessages.createdAt, before.at)
        : or(
            lt(chatMessages.createdAt, before.at),
            and(eq(chatMessages.createdAt, before.at), lt(chatMessages.id, before.key)),
          ),
    );
  }
  const messages = (
    await tx
      .select()
      .from(chatMessages)
      .where(and(...conds))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(page.limit)
  ).map(toWireChatMessage);
  const journal = (
    await threadFeed(tx, graph, threadId, {
      ...(before !== undefined && { before }),
      limit: page.limit,
    })
  ).map((e) => journalItem(e, threadId));
  return [...messages, ...journal].sort(newerFirst).slice(0, page.limit);
}
