// apps/server/test/journal-helpers.ts
// Журнал в тестах читается ТОЛЬКО здесь (глобальное ограничение плана А): хранилище журнала меняет задача 5, и
// тест, знающий, где лежит журнал, сломался бы вместе с ним, ничего не проверив. Помощники ходят через API
// журнала (`src/executor/journal-read.ts`) под идентичностью владельца графа — как читают боевые пути.
//
// Пул — на вызов, как у прочих общих помощников (`finance-on.ts`, `surfaces.ts`): модуль общий на весь процесс
// bun test (модули кешируются), и пул, закрытый хуком одного файла, был бы отнят у следующих.
import type { GraphId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { type Tx, withIdentity } from '../src/db/with-identity';
import * as J from '../src/executor/journal-read';
import { appDb, personal } from './helpers';

async function read<T>(graph: GraphId, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { db, client } = appDb();
  try {
    return await withIdentity(db, personal(graph), fn);
  } finally {
    await client.end();
  }
}

/** Действие по id (не запись отмены); `undefined` — такого действия в журнале графа нет. */
export function journalOf(graph: GraphId, actionId: string) {
  return read(graph, (tx) => J.findAction(tx, graph, actionId));
}

/** Все действия графа по времени, без записей отмены. */
export function actionsOf(graph: GraphId) {
  return read(graph, async (tx) =>
    (await J.exportJournal(tx, graph)).filter((e) => e.type !== 'undo'),
  );
}

/** Запись отмены действия; `undefined` — действие не отменено. */
export function undoRecordOf(graph: GraphId, actionId: string) {
  return read(graph, (tx) => J.undoRecordOf(tx, graph, actionId));
}

/** Журнал треда (действия и записи отмены), новые первыми. */
export function threadJournal(graph: GraphId, threadId: string) {
  return read(graph, (tx) => J.threadActions(tx, graph, threadId, { limit: 200 }));
}

/** Весь журнал графа по времени, ВКЛЮЧАЯ записи отмены (счёт отмен, порядок «действие → отмена»). */
export function wholeJournalOf(graph: GraphId) {
  return read(graph, (tx) => J.exportJournal(tx, graph));
}

/**
 * Записи графа, затронутые действием, — строки БОКОВОЙ таблицы `action_journal_entities` (РП-8), по времени записи.
 * Единственное место в тестах, где хранилище читается мимо API журнала, и это не случайность: боковая таблица —
 * индекс проб «по затронутой записи», у API нет читателя её строк как таковых (пробы отдают записи журнала). Сверить,
 * что синк и перенос положили её строки ТОЙ ЖЕ транзакцией, по каждой затронутой записи, можно только прямо.
 */
export async function journalEntitiesOf(graph: GraphId, actionId: string): Promise<string[]> {
  const rows = await read(graph, (tx) =>
    tx.execute(
      sql`SELECT entity_id::text AS id FROM action_journal_entities
           WHERE graph_id = ${graph}::uuid AND action_id = ${actionId}::uuid ORDER BY entity_id`,
    ),
  );
  return (rows as unknown as Array<{ id: string }>).map((r) => r.id);
}
