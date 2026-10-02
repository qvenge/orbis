// apps/server/src/journal/thread-page.ts
// Выдача треда (спека скорости §11.3): сообщения треда и карточки журнала этого треда, объединённые НА ЧТЕНИИ одной
// процедурой с общим курсором `(время, id)`. Сообщения журнал не копируют — журнал живёт своей таблицей
// (§11.2), и тред складывается из двух выборок. Читатели — `chat.listMessages` и тред в `entity.get`: одна процедура
// на оба места, иначе они разошлись бы фильтрами (так уже было до задачи 5 — `entity.get` отдавал тред без фильтра
// маркеров и целиком). Контекст модели читает половину сообщений (`threadMessages`) и журнал треда сам (РП-22).
//
// Элемент журнала — system-строка с заголовком и `metadata {journal: JournalCardMeta, cards?: [карточка ленты]}`
// (id строки — производный id элемента треда, рулинг R-12; id действия — `journal.actionId`) БЕЗ тел действия (§9
// приватность): ни операций, ни данных отмены, ни результатов пачки, ни аккаунта актора. Какие действия тред
// показывает и с «Отменить» ли — таблица источников §11.3 (см. `journalCardMeta` и `journal-read.threadFeed`).
// Карточки в сообщениях (ответ ассистента) получают на чтении признак `undone` (R-14, `markUndoneReplyCards`), карточки
// подтверждения — признак `closed` у отказанных (`markClosedConfirmationCards`, гейт задачи 11).
import {
  type GraphId,
  type JournalCardMeta,
  type MutationSourceWire,
  rejectMessageId,
} from '@orbis/shared';
import { and, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm';
import { excludeInfraSystemRows, type WireChatMessage } from '../chat/messages';
import { chatMessages } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { type JournalEntry, threadFeed, undoMarks } from '../executor/journal-read';
import type { MutationSource } from '../executor/types';
import type { Card } from '../tools/registry';
import { toWireChatMessage } from '../wire';

/** Курсор выдачи: `<iso>` (легаси-клиент 1c-1 — строго раньше по времени) или `<iso>|<id>` (составной). */
function parseBefore(before: string | undefined): { at: Date; key?: string } | undefined {
  if (before === undefined) return undefined;
  const sep = before.indexOf('|');
  if (sep === -1) return { at: new Date(before) };
  return { at: new Date(before.slice(0, sep)), key: before.slice(sep + 1) };
}

/**
 * Источники, чья строка журнала несёт КЛИЕНТСКУЮ карточку записи (02-core-os §2.3, с `kind` и «Отменить»): у их
 * действия другого носителя карточки нет.
 * - 'fast_path' — клиентская карточка живёт лишь в кэше react-query (`features/chat/useFastPath.ts`) и при
 *   перечитывании треда заменяется этой;
 * - 'routine' — у правки прогона нет ни ответа ассистента, ни клиентского кэша (владельца в этот момент не было в
 *   приложении): строка журнала — единственное, что он увидит.
 * Остальные: 'chat' — карточку несёт ответ ассистента (`card_in_reply`, такая строка в треде не рисуется) либо это
 * пачка — строка-сводка; 'mcp' — строка-сводка с «Отменить» (Р-16); 'ui' | 'quick_capture' | 'system' — в треде их
 * нет вовсе (Р-12).
 */
const FEED_CARD_SOURCES: ReadonlySet<MutationSource> = new Set<MutationSource>([
  'fast_path',
  'routine',
]);

/**
 * Карточка ленты — ВЕТКА серверного union'а Card (tools/registry.ts), а не копия его полей: копий формы и так две
 * (registry + web types.ts), третья молча отстала бы при добавлении поля. У журнальной карточки `undoActionId` есть
 * ВСЕГДА (в union он опционален — у карточек ответа Undo может не быть).
 */
type FeedEntityCard = Extract<Card, { kind: 'entity_card' }> & { undoActionId: string };

/**
 * Клиентская карточка записи строки журнала — только у источников `FEED_CARD_SOURCES` и только при записи-адресе
 * (у пачки и relation-мутаций `entityId` клиентской карточки был бы враньём). `aspects`/`keyFields` пустые
 * СОЗНАТЕЛЬНО: у журнала нет ни WireEntity, ни viewConfig.keyFields (их собирает `tools/dispatch.ts` из реестра) —
 * обогащать нечем. Карточка беднее живой, зато переживает перезагрузку и несёт «Отменить».
 */
function feedCard(e: JournalEntry): FeedEntityCard | undefined {
  if (!FEED_CARD_SOURCES.has(e.source) || e.entityId === null) return undefined;
  return {
    kind: 'entity_card',
    entityId: e.entityId,
    title: e.title,
    aspects: [],
    keyFields: {},
    // тот же id, что уходит в ai.undo({actionId}) у живых карточек (§7.8)
    undoActionId: e.id,
  };
}

/**
 * Сводка действия для ленты (§11.3). «Отменить» (`undoable`) — у всего, что тред показывает, кроме глаголов прогона
 * агента: правка агента по MCP вне прогона отменяется, как быстрый ввод и рутина (Р-16), а строки прогона (`mcp` с
 * `run_id`) — его протокол, откатывается прогон целиком, не строкой (К-42). Действие с карточкой в ответе строкой
 * треда становится, только если ход оборвался (`orphan`, R-13): тогда строка — его единственная карточка, и
 * «Отменить» у неё есть; условие повторено здесь, чтобы сводка не зависела от того, кто её собрал.
 */
export function journalCardMeta(
  e: JournalEntry,
  marks: { undone: boolean; orphan: boolean },
): JournalCardMeta {
  const undoable =
    (!e.cardInReply || marks.orphan) &&
    (e.source === 'fast_path' ||
      e.source === 'routine' ||
      e.source === 'chat' ||
      (e.source === 'mcp' && e.runId === undefined));
  return {
    actionId: e.id,
    // Перечни источников сервера и провода — один: новый источник без места на проводе — ошибка typecheck здесь
    source: e.source satisfies MutationSourceWire,
    actorKind: e.actorKind,
    ...(e.runId !== undefined && { runId: e.runId }),
    title: e.title,
    tool: e.cardTool,
    entityId: e.entityId,
    undoable,
    undone: marks.undone,
  };
}

/**
 * Запись журнала → строка треда. id строки — производный id элемента треда (`itemId`, рулинг R-12: у одобренной
 * единицы id записи совпал бы с PK её карточки-запроса в том же треде); id ДЕЙСТВИЯ — в `journal.actionId` и в
 * `undoActionId` карточки ленты — по нему отмена.
 */
function journalItem(
  e: JournalEntry & { itemId: string; undone: boolean },
  threadId: string,
): WireChatMessage {
  const card = feedCard(e);
  return {
    id: e.itemId,
    threadId,
    role: 'system',
    content: e.title,
    metadata: {
      // Строка действия с карточкой в ответе в выдаче — только оборванный ход (`journal-read.threadFeed`, R-13)
      journal: journalCardMeta(e, { undone: e.undone, orphan: e.cardInReply }),
      ...(card !== undefined && { cards: [card] }),
    },
    createdAt: e.createdAt.toISOString(),
  };
}

/**
 * Порядок выдачи `(created_at DESC, id DESC)` по id НА ПРОВОДЕ — тот же, что у каждой выборки в SQL (сообщения — по PK,
 * журнал — по производному id элемента, оба — uuid). Время — ISO с миллисекундами (обе колонки `timestamptz(3)`),
 * id — каноничный uuid в нижнем регистре (текст PG): лексикографика строк совпадает с порядком PG (`uuid`
 * сравнивается побайтно), поэтому слияние в TS не расходится с курсором SQL, а id элементов потока уникальны —
 * курсор однозначен.
 */
export function newerFirst(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Сообщения треда (без инфраструктурных строк `excludeInfraSystemRows`) новее курсора, до `limit`, новые первыми —
 * половина выдачи треда. Отдельно её читает контекст модели: его окно сливает сообщения не с карточками треда, а с
 * журналом треда целиком (РП-22).
 */
export async function threadMessages(
  tx: Tx,
  threadId: string,
  page: { before?: { at: Date; key?: string }; limit: number },
): Promise<WireChatMessage[]> {
  const before = page.before;
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
  return (
    await tx
      .select()
      .from(chatMessages)
      .where(and(...conds))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(page.limit)
  ).map(toWireChatMessage);
}

/**
 * Страница треда: до `limit` строк новее курсора `before` — сообщений (`threadMessages`) и карточек журнала треда
 * (`journal-read.threadFeed`: без записей отмены, `system` и действий с карточкой в ответе). Каждая выборка берёт до
 * `limit` своих строк тем же курсором, слияние — первые `limit` общего порядка: страница не пропускает и не повторяет
 * строк на стыке двух таблиц, потому что следующая страница стартует с курсора последней отданной строки, а он строг
 * в обеих выборках.
 */
export async function threadPage(
  tx: Tx,
  graph: GraphId,
  threadId: string,
  page: { before?: string; limit: number },
): Promise<WireChatMessage[]> {
  const before = parseBefore(page.before);
  const cursor = { ...(before !== undefined && { before }), limit: page.limit };
  const messages = await markClosedConfirmationCards(
    tx,
    graph,
    await markUndoneReplyCards(tx, graph, await threadMessages(tx, threadId, cursor)),
  );
  const journal = (await threadFeed(tx, graph, threadId, cursor)).map((e) =>
    journalItem(e, threadId),
  );
  return [...messages, ...journal].sort(newerFirst).slice(0, page.limit);
}

/** `undoActionId` карточек записи сообщения — те, что несут «Отменить» (ответ ассистента, ответ-ошибка). */
function undoActionIdsOf(m: WireChatMessage): string[] {
  const cards = m.metadata.cards;
  if (!Array.isArray(cards)) return [];
  return cards.flatMap((c) => {
    const card = c as { kind?: unknown; undoActionId?: unknown };
    return card.kind === 'entity_card' && typeof card.undoActionId === 'string'
      ? [card.undoActionId]
      : [];
  });
}

/**
 * Признак «отменено» у карточек В СООБЩЕНИЯХ (рулинг R-14): карточка действия разговора живёт в ответе ассистента
 * (К-36), своей строки журнала у неё нет, и `journal.undone` ей никто не отдаст — после перечитывания треда она снова
 * предлагала бы «Отменить» уже отменённое (§11.2: отменённое показывает «отменено»). Признак считается на чтении одной
 * выборкой по странице (`undoMarks`) и в сообщение не пишется: `chat_messages` неизменяемы (§4.6), а отмена случается
 * позже ответа. Ставится только `undone: true` — у неотменённой карточки ключа нет, как и раньше.
 */
async function markUndoneReplyCards(
  tx: Tx,
  graph: GraphId,
  messages: WireChatMessage[],
): Promise<WireChatMessage[]> {
  const ids = messages.flatMap(undoActionIdsOf);
  if (ids.length === 0) return messages;
  const marks = await undoMarks(tx, graph, ids);
  if (marks.size === 0) return messages;
  const isUndone = (id: unknown) => typeof id === 'string' && marks.has(id.toLowerCase());
  return messages.map((m) => {
    if (!undoActionIdsOf(m).some(isUndone)) return m;
    const cards = (m.metadata.cards as Array<Record<string, unknown>>).map((c) =>
      c.kind === 'entity_card' && isUndone(c.undoActionId) ? { ...c, undone: true } : c,
    );
    return { ...m, metadata: { ...m.metadata, cards } };
  });
}

/** pendingId карточек подтверждения сообщения — тех, что несут кнопки (`mode:'explicit'`). */
function confirmationPendingIdsOf(m: WireChatMessage): string[] {
  const cards = m.metadata.cards;
  if (!Array.isArray(cards)) return [];
  return cards.flatMap((c) => {
    const card = c as { kind?: unknown; mode?: unknown; pendingId?: unknown };
    return card.kind === 'confirmation_card' &&
      card.mode === 'explicit' &&
      typeof card.pendingId === 'string'
      ? [card.pendingId]
      : [];
  });
}

/**
 * Признак «закрыта» у карточек подтверждения (гейт задачи 11, I-1; §8.6 строка `undo_of`, К-43): отказанная карточка —
 * отклонённая владельцем, устаревшая или закрытая отказом правила отмены текста (`undo_refused`) — после перечитывания
 * треда не предлагает кнопку, которая откажет снова. Судьба карточки — сообщение отказа с детерминированным ключом
 * (`rejectMessageId`, `policy/pending.ts`); признак считается на чтении одной выборкой по ключам страницы и в сообщение не
 * пишется (`chat_messages` неизменяемы, §4.6), как «отменено» у карточек ответа (`markUndoneReplyCards`). Почему закрыта,
 * называет строка отказа в том же треде; карточке нужен только сам признак. Страница без таких карточек запроса не платит.
 */
async function markClosedConfirmationCards(
  tx: Tx,
  graph: GraphId,
  messages: WireChatMessage[],
): Promise<WireChatMessage[]> {
  const ids = [...new Set(messages.flatMap(confirmationPendingIdsOf))];
  if (ids.length === 0) return messages;
  const byKey = new Map(ids.map((id) => [rejectMessageId(graph, id), id]));
  const rows = await tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(inArray(chatMessages.id, [...byKey.keys()]));
  if (rows.length === 0) return messages;
  const closed = new Set(rows.map((r) => byKey.get(r.id)));
  return messages.map((m) => {
    if (!confirmationPendingIdsOf(m).some((id) => closed.has(id))) return m;
    const cards = (m.metadata.cards as Array<Record<string, unknown>>).map((c) =>
      c.kind === 'confirmation_card' && closed.has(c.pendingId as string)
        ? { ...c, closed: true }
        : c,
    );
    return { ...m, metadata: { ...m.metadata, cards } };
  });
}
