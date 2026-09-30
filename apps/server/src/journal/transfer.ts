// apps/server/src/journal/transfer.ts
// Перенос прежнего журнала графа — системных сообщений чата (`metadata.actions`, отмены `{type:'undo'}`) — в таблицу
// `action_journal` (спека скорости §11.4, план А задача 5). Зовёт прод-операция задачи 21 в окне простоя; сообщения
// перенос НЕ трогает — их снос отдельным проходом после проверки (задача 21), и до него повторный перенос безопасен:
// всё идёт `ON CONFLICT DO NOTHING` по ключам таблицы. Перенос — не тихая запись в граф (§0.2 п. 8): он перекладывает
// уже существующие записи журнала в новое хранилище, ничего не выдумывая.
//
// Три прохода одной транзакцией вызывающего:
//  1. действия — строка на элемент `metadata.actions` (у прежнего синка их ровно один на сообщение): id — id
//     ДЕЙСТВИЯ, а не сообщения (Д-4; у пачки — batch_id, а не uuidv5-PK сообщения); время — время сообщения;
//  2. отмены — строка `type:'undo'` на сообщение отмены, чьё отменённое действие перенесено;
//  3. боковая таблица — из колонки `entity_ids` перенесённых строк.
// Запись без обязательного поля (`id`, `type`, `actor_kind`, `source`, `actor_user_id`, `operations`, `inverse`) или
// с не-uuid там, где колонка uuid, не переносится и не подменяется умолчанием: её считает `skipped`, а отчёт задачи 21
// (`missingRequired`) останавливает операцию до окна. Умолчание одно — `mechanism: 'user'` у записей, сделанных до
// появления поля (§А4-4): тогда механизм был только один.
import type { GraphId } from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

export interface TransferReport {
  /** Перенесено действий (строк `type <> 'undo'`) этим вызовом. */
  moved: number;
  /** Перенесено записей отмены этим вызовом. */
  undo: number;
  /**
   * Прежних записей (действий и отмен), которых нет в таблице и после вызова: обязательное поле отсутствует или
   * не той формы, отмена указывает на неперенесённое действие или повторяет уже перенесённую отмену того же
   * действия. Повторный вызов даёт тот же счёт — он про данные, а не про этот вызов.
   */
  skipped: number;
}

/** Каноничный uuid — то же правило, что у `touchedEntityIds` синка (`executor/journal-read.ts`). */
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** Необязательное поле uuid: нет его, JSON null или каноничный uuid. */
const optionalUuid = (field: string): SQL => sql`COALESCE((l.a ->> ${field}) ~* ${UUID}, true)`;

/**
 * Элементы `metadata.actions` прежних audit-сообщений графа (`l`): сообщение, элемент и его номер (карточка —
 * по тому же номеру, как у прежних читателей). `CASE` — `jsonb_array_elements` на не-массиве падает, а фильтр
 * WHERE по сообщению не обязан исполниться раньше функции.
 */
const LEGACY_ACTIONS = (graph: GraphId): SQL => sql`
  SELECT m.id AS message_id, m.thread_id, m.content, m.created_at, m.metadata, a.value AS a, a.ord
    FROM chat_messages m
    JOIN chat_threads t ON t.id = m.thread_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(m.metadata -> 'actions') = 'array' THEN m.metadata -> 'actions' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS a(value, ord)
   WHERE t.graph_id = ${graph}::uuid AND m.role = 'system'
     AND NOT (m.metadata @> '{"type": "undo"}'::jsonb)`;

/** Обязательные поля записи действия — есть и нужной формы (иначе запись не переносится). */
const COMPLETE = sql`jsonb_typeof(l.a -> 'id') = 'string' AND (l.a ->> 'id') ~* ${UUID}
  AND jsonb_typeof(l.a -> 'type') = 'string'
  AND jsonb_typeof(l.a -> 'actor_kind') = 'string'
  AND jsonb_typeof(l.a -> 'source') = 'string'
  AND jsonb_typeof(l.a -> 'actor_user_id') = 'string' AND (l.a ->> 'actor_user_id') ~* ${UUID}
  AND jsonb_typeof(l.a -> 'operations') = 'array'
  AND jsonb_typeof(l.a -> 'inverse') = 'array'
  AND ${optionalUuid('entity_id')} AND ${optionalUuid('actor_grant_id')}
  AND ${optionalUuid('run_id')} AND ${optionalUuid('edited_from')}`;

/**
 * SQL-двойник `touchedEntityIds` (`executor/journal-read.ts`) — тот же отбор в том же порядке: `entity_id` действия,
 * затем uuid-строки под ключами `id`/`source_id`/`target_id`/`entity_id` в операциях, потом в inverse, без повторов.
 * Колонка `entity_ids` и строки боковой таблицы обязаны совпасть с тем, что записал бы синк: на них стоят пробы R-18
 * и окно конфликтов отката (тест переноса сверяет с `touchedEntityIds`).
 */
const ENTITY_IDS = sql`ARRAY(
    SELECT v.id::uuid FROM (
      SELECT x.id, min(x.ord) AS ord FROM (
        SELECT l.a ->> 'entity_id' AS id, 0::bigint AS ord
        UNION ALL
        SELECT o.value -> 'payload' ->> k.key, o.ord * 10 + k.ord
          FROM jsonb_array_elements((l.a -> 'operations') || (l.a -> 'inverse')) WITH ORDINALITY AS o(value, ord)
          CROSS JOIN unnest(ARRAY['id', 'source_id', 'target_id', 'entity_id']) WITH ORDINALITY AS k(key, ord)
         WHERE jsonb_typeof(o.value -> 'payload' -> k.key) = 'string'
      ) x
      WHERE x.id ~* ${UUID}
      GROUP BY x.id
    ) v ORDER BY v.ord)`;

/** Карточка элемента — по номеру элемента (`cards[i]`), как у прежних читателей. */
const CARD = sql`(l.metadata -> 'cards' -> (l.ord - 1)::int)`;

/**
 * Тул карточки: у карточек ленты `fast_path`/`routine` (клиентская форма с kind) поля `tool` нет — тул по типу
 * действия, тем же соответствием, что у прежнего читателя; прочие типы — имя типа.
 */
const CARD_TOOL = sql`COALESCE(${CARD} ->> 'tool', CASE l.a ->> 'type'
    WHEN 'entity_created' THEN 'entity_create'
    WHEN 'entity_updated' THEN 'entity_update'
    WHEN 'relation_created' THEN 'relation_create'
    WHEN 'relation_deleted' THEN 'relation_delete'
    WHEN 'batch' THEN 'batch_execute'
    WHEN 'action' THEN 'batch_execute'
    ELSE l.a ->> 'type' END)`;

const castUuid = (field: string): SQL => sql`(l.a ->> ${field})::uuid`;

/** Прежние сообщения отмены графа (`u`) — по времени: из повторных отмен одного действия переносится первая. */
const LEGACY_UNDOS = (graph: GraphId): SQL => sql`
  SELECT m.id, m.created_at, m.metadata ->> 'undoes' AS undoes
    FROM chat_messages m
    JOIN chat_threads t ON t.id = m.thread_id
   WHERE t.graph_id = ${graph}::uuid AND m.role = 'system' AND m.metadata @> '{"type": "undo"}'::jsonb`;

async function count(tx: Tx, query: SQL): Promise<number> {
  const rows = (await tx.execute(query)) as unknown as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Перенос журнала графа из сообщений чата в таблицу — идемпотентно, сообщения не трогает. Транзакция и
 * идентичность — вызывающего: под RLS владельцу графа видны его сообщения и его строка членства (владелец записи
 * отмены), прод-операция идёт ролью с BYPASSRLS; граф в каждом запросе задан явно.
 */
export async function transferJournal(tx: Tx, graph: GraphId): Promise<TransferReport> {
  // 1. Действия. Тред не присваивается ui, quick_capture и system (§11.4: их правки — не разговор); прочим — тред
  //    сообщения. «Карточка в ответе» — у действия чата, чью карточку с тем же `undoActionId` уже несёт ответ
  //    ассистента того же треда: иначе рядом с карточкой ответа появилась бы вторая из журнала (§11.3).
  const moved = await count(
    tx,
    sql`WITH ins AS (
      INSERT INTO action_journal (graph_id, id, created_at, type, entity_id, actor_user_id, actor_kind, source,
                                  mechanism, actor_grant_id, run_id, action_id, module, edited_from, thread_id, title,
                                  card_tool, entity_ids, operations, inverse, results, card_in_reply)
      SELECT ${graph}::uuid, ${castUuid('id')}, l.created_at, l.a ->> 'type', ${castUuid('entity_id')},
             ${castUuid('actor_user_id')}, l.a ->> 'actor_kind', l.a ->> 'source',
             COALESCE(l.a ->> 'mechanism', 'user'), ${castUuid('actor_grant_id')}, ${castUuid('run_id')},
             l.a ->> 'action_id', l.a ->> 'module', ${castUuid('edited_from')},
             CASE WHEN l.a ->> 'source' IN ('ui', 'quick_capture', 'system') THEN NULL ELSE l.thread_id END,
             COALESCE(${CARD} ->> 'title', l.content), ${CARD_TOOL}, ${ENTITY_IDS},
             l.a -> 'operations', l.a -> 'inverse', l.metadata -> 'results',
             (l.a ->> 'source' = 'chat' AND EXISTS (
               SELECT 1 FROM chat_messages r
                WHERE r.thread_id = l.thread_id AND r.role = 'assistant'
                  AND r.metadata -> 'cards' @> jsonb_build_array(jsonb_build_object('undoActionId', l.a ->> 'id'))))
        FROM (${LEGACY_ACTIONS(graph)}) l
       WHERE ${COMPLETE}
       ORDER BY l.created_at, l.message_id, l.ord
      ON CONFLICT DO NOTHING
      RETURNING 1)
    SELECT count(*) AS n FROM ins`,
  );

  // 2. Отмены. Актор — владелец графа (у прежней записи отмены своего актора не было, Д-5), путь — `ui` (В-3):
  //    других путей отмены до задачи 5 у владельца не было, кроме «отмени последнее» в чате, который прежняя запись
  //    не отличала. Тред — тред ПЕРЕНЕСЁННОЙ строки отменённого (К-45), операции — копия его inverse (применённый
  //    inverse), свой inverse пуст (отмена неотменяема).
  const legacyUndos = await count(tx, sql`SELECT count(*) AS n FROM (${LEGACY_UNDOS(graph)}) u`);
  let undo = 0;
  if (legacyUndos > 0) {
    const owners = (await tx.execute(
      sql`SELECT account_id::text AS id FROM graph_members
           WHERE graph_id = ${graph}::uuid AND grant_kind = 'owner' AND revoked_at IS NULL`,
    )) as unknown as Array<{ id: string }>;
    const owner = owners[0]?.id;
    if (owner === undefined || owners.length !== 1) {
      throw new Error(
        `перенос журнала: у графа ${graph} не один видимый владелец (${owners.length}) — актор записей отмены не определён`,
      );
    }
    undo = await count(
      tx,
      sql`WITH ins AS (
        INSERT INTO action_journal (graph_id, id, created_at, type, entity_id, actor_user_id, actor_kind, source,
                                    mechanism, thread_id, title, card_tool, entity_ids, operations, inverse, undoes)
        SELECT ${graph}::uuid, u.id, u.created_at, 'undo', NULL, ${owner}::uuid, 'owner', 'ui', 'user',
               j.thread_id, 'Отменено: ' || j.title, 'undo', j.entity_ids, j.inverse, '[]'::jsonb, j.id
          FROM (${LEGACY_UNDOS(graph)}) u
          JOIN action_journal j
            ON j.graph_id = ${graph}::uuid AND j.type <> 'undo'
           AND j.id = CASE WHEN u.undoes ~* ${UUID} THEN u.undoes::uuid END
         ORDER BY u.created_at, u.id
        ON CONFLICT DO NOTHING
        RETURNING 1)
      SELECT count(*) AS n FROM ins`,
    );
  }

  // 3. Боковая таблица — из `entity_ids` строк графа (и перенесённых, и уже записанных синком: у тех строки есть,
  //    конфликт ключа — ничего). Время — время строки журнала.
  await tx.execute(sql`
    INSERT INTO action_journal_entities (graph_id, action_id, entity_id, created_at)
    SELECT DISTINCT j.graph_id, j.id, e.entity_id, j.created_at
      FROM action_journal j CROSS JOIN LATERAL unnest(j.entity_ids) AS e(entity_id)
     WHERE j.graph_id = ${graph}::uuid
    ON CONFLICT DO NOTHING`);

  // Не перенесённые — те прежние записи, чьего id нет в таблице и после переноса (сравнение текстом: у сломанной
  // записи id может быть не uuid).
  const skipped = await count(
    tx,
    sql`SELECT
      (SELECT count(*) FROM (${LEGACY_ACTIONS(graph)}) l
        WHERE NOT EXISTS (SELECT 1 FROM action_journal j
                           WHERE j.graph_id = ${graph}::uuid AND j.id::text = lower(l.a ->> 'id')))
      + (SELECT count(*) FROM (${LEGACY_UNDOS(graph)}) u
          WHERE NOT EXISTS (SELECT 1 FROM action_journal j WHERE j.graph_id = ${graph}::uuid AND j.id = u.id))
      AS n`,
  );
  return { moved, undo, skipped };
}
