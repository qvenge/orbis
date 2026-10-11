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
// (`missingRequired`) останавливает применение после подготовки схемы, до переноса и сноса. Несовместимый тип
// занятого id или цель отмены тоже делают запись непредставимой. Умолчание одно — `mechanism: 'user'` у записей, сделанных до
// появления поля (§А4-4): тогда механизм был только один.
//
// Шов с задачей 21 — общие проверки представимости: форма и свободный слот для переноса, тип и совпадающая цель
// уже представленной отмены. Их используют перенос (`transferJournal`), отчёт после подготовки схемы
// (`legacyJournalReport` — сколько записей перенос оставит) и снос второго прохода (`transferredLegacyMessageIds` —
// какие сообщения можно удалять). Иначе отчёт мог бы насчитать ноль там, где перенос запись пропустит, а снос —
// оставить её в сообщениях навсегда или упасть 22P02 на не-uuid id прежней записи (id сравниваются ТЕКСТОМ).
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

/**
 * Предикат «переносимая запись действия» (`l`): обязательные поля есть и нужной формы, uuid-поля — каноничные uuid.
 * `COALESCE(…, false)`: у отсутствующего ключа `jsonb_typeof` — NULL, и без него `NOT` в отчёте не счёл бы такую запись
 * непереносимой (NOT NULL = NULL), хотя перенос её пропускает.
 */
const TRANSFERABLE_ACTION = sql`COALESCE(jsonb_typeof(l.a -> 'id') = 'string' AND (l.a ->> 'id') ~* ${UUID}
  AND jsonb_typeof(l.a -> 'type') = 'string'
  AND jsonb_typeof(l.a -> 'actor_kind') = 'string'
  AND jsonb_typeof(l.a -> 'source') = 'string'
  AND jsonb_typeof(l.a -> 'actor_user_id') = 'string' AND (l.a ->> 'actor_user_id') ~* ${UUID}
  AND jsonb_typeof(l.a -> 'operations') = 'array'
  AND jsonb_typeof(l.a -> 'inverse') = 'array'
  AND ${optionalUuid('entity_id')} AND ${optionalUuid('actor_grant_id')}
  AND ${optionalUuid('run_id')} AND ${optionalUuid('edited_from')}, false)`;

/** Запись действия `l` уже в таблице — сравнение ТЕКСТОМ: id сломанной прежней записи может быть не uuid (22P02). */
const ACTION_PRESENT = (graph: GraphId): SQL =>
  sql`EXISTS (SELECT 1 FROM action_journal j
               WHERE j.graph_id = ${graph}::uuid AND j.type <> 'undo' AND j.id::text = lower(l.a ->> 'id'))`;

/** A transferable legacy action also needs its slot free, or an authoritative current action. */
const ACTION_SLOT_FREE = (graph: GraphId): SQL => sql`NOT EXISTS (
  SELECT 1 FROM action_journal j WHERE j.graph_id = ${graph}::uuid AND j.id::text = lower(l.a ->> 'id'))`;

/** Same key alone proves nothing: certify the type and valid matching target before the UUID cast. */
const UNDO_PRESENT = (graph: GraphId, id: SQL, target: SQL): SQL => sql`CASE
  WHEN ${target} ~* ${UUID} THEN EXISTS (
    SELECT 1 FROM action_journal j WHERE j.graph_id = ${graph}::uuid AND j.id = ${id}
      AND j.type = 'undo' AND j.undoes = (${target})::uuid)
  ELSE false END`;

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

/**
 * Заголовок строки — заголовок карточки ЭТОГО элемента (`cards[i].title`), и только без неё — текст сообщения. У
 * прежнего синка сообщение несло ровно одно действие, и `content = card.title` (`legacy-journal.ts`) — для живых данных
 * это тождественно «`title` — `m.content`» брифа; карточка по номеру вернее на сообщении с несколькими действиями, где
 * `content` — заголовок только первого. Тем же правилом заголовок читал прежний читатель журнала (задача 4).
 */
const TITLE = sql`COALESCE(${CARD} ->> 'title', l.content)`;

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
             ${TITLE}, ${CARD_TOOL}, ${ENTITY_IDS},
             l.a -> 'operations', l.a -> 'inverse', l.metadata -> 'results',
             (l.a ->> 'source' = 'chat' AND EXISTS (
               SELECT 1 FROM chat_messages r
                WHERE r.thread_id = l.thread_id AND r.role = 'assistant'
                  AND r.metadata -> 'cards' @> jsonb_build_array(jsonb_build_object('undoActionId', l.a ->> 'id'))))
        FROM (${LEGACY_ACTIONS(graph)}) l
       WHERE ${TRANSFERABLE_ACTION}
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
         WHERE ${UNDO_TRANSFERABLE(graph)}
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

  // Не перенесённые — те прежние записи, которых нет в таблице и после переноса: ровно то, что до него насчитал
  // отчёт (`legacyJournalReport.untransferable`) — тем же предикатом.
  const skipped = (await legacyJournalReport(tx, graph)).untransferable;
  return { moved, undo, skipped };
}

/**
 * Прежняя отмена `u` переносима сейчас: `undoes` — uuid, отменённое действие есть в таблице или переносимо, это первая
 * по времени прежняя отмена этого действия, и записи отмены у него в таблице ещё нет (иначе уникальность `(graph_id,
 * undoes)` её не пропустит). Всё — ровно условия второго прохода `transferJournal`; `COALESCE` — у отмены без `undoes`
 * регэксп даёт NULL, и `NOT` в отчёте иначе её не посчитал бы.
 */
const UNDO_TRANSFERABLE = (graph: GraphId): SQL => sql`COALESCE(u.undoes ~* ${UUID}
  AND NOT EXISTS (SELECT 1 FROM action_journal j WHERE j.graph_id = ${graph}::uuid AND j.id = u.id)
  AND NOT EXISTS (SELECT 1 FROM (${LEGACY_ACTIONS(graph)}) l
    WHERE ${TRANSFERABLE_ACTION} AND ${ACTION_SLOT_FREE(graph)} AND lower(l.a ->> 'id') = u.id::text)
  AND (EXISTS (SELECT 1 FROM action_journal j
                WHERE j.graph_id = ${graph}::uuid AND j.type <> 'undo' AND j.id::text = lower(u.undoes))
       OR EXISTS (SELECT 1 FROM (${LEGACY_ACTIONS(graph)}) l
                   WHERE ${TRANSFERABLE_ACTION} AND ${ACTION_SLOT_FREE(graph)}
                     AND lower(l.a ->> 'id') = lower(u.undoes)))
  AND NOT EXISTS (SELECT 1 FROM (${LEGACY_UNDOS(graph)}) p
                   WHERE lower(p.undoes) = lower(u.undoes) AND (p.created_at, p.id) < (u.created_at, u.id))
  AND NOT EXISTS (SELECT 1 FROM action_journal j
                   WHERE j.graph_id = ${graph}::uuid AND j.type = 'undo' AND j.undoes::text = lower(u.undoes)), false)`;

/**
 * Отчёт о прежнем журнале графа (только чтение): прежних записей действий и отмен и сколько из них перенос ОСТАВИТ —
 * нет в таблице и не перенесутся (обязательное поле отсутствует или не той формы, не-uuid id, отмена неперенесённого
 * действия, повторная отмена). Для задачи 21: `missingRequired` отчёта `--report` — это `untransferable` (ненулевой —
 * стоп до применения: в задаче 24 окно и подготовка схемы уже начались; автоматического отката DDL нет). Коллизия
 * занятого id по типу или цели отмены тоже непредставима. Общие проверки наличия и переносимости дают до переноса
 * прогноз, после — факт (`skipped`).
 */
export function legacyJournalReportQuery(graph: GraphId): SQL {
  return sql`SELECT
      (SELECT count(*) FROM (${LEGACY_ACTIONS(graph)}) l) AS legacy_actions,
      (SELECT count(*) FROM (${LEGACY_UNDOS(graph)}) u) AS legacy_undo,
      (SELECT count(*) FROM (${LEGACY_ACTIONS(graph)}) l
        WHERE NOT ${ACTION_PRESENT(graph)} AND NOT (${TRANSFERABLE_ACTION} AND ${ACTION_SLOT_FREE(graph)}))
      + (SELECT count(*) FROM (${LEGACY_UNDOS(graph)}) u
          WHERE NOT ${UNDO_PRESENT(graph, sql`u.id`, sql`u.undoes`)}
            AND NOT ${UNDO_TRANSFERABLE(graph)}) AS untransferable`;
}

export interface LegacyJournalReport {
  /** Прежних записей действий (элементов `metadata.actions` audit-сообщений). */
  legacyActions: number;
  /** Прежних сообщений отмены. */
  legacyUndo: number;
  /** Прежних записей, которых нет в таблице и которые перенос не перенесёт. */
  untransferable: number;
}

export async function legacyJournalReport(tx: Tx, graph: GraphId): Promise<LegacyJournalReport> {
  const rows = (await tx.execute(legacyJournalReportQuery(graph))) as unknown as Array<
    Record<'legacy_actions' | 'legacy_undo' | 'untransferable', number | string>
  >;
  const row = rows[0];
  return {
    legacyActions: Number(row?.legacy_actions ?? 0),
    legacyUndo: Number(row?.legacy_undo ?? 0),
    untransferable: Number(row?.untransferable ?? 0),
  };
}

/**
 * Прежние сообщения журнала графа, которые можно сносить (второй проход задачи 21, РП-2 «снос только перенесённого»):
 * audit-сообщение — если КАЖДОЕ его действие есть в таблице этого графа с типом, отличным от `undo`; сообщение
 * отмены — если в этом графе есть строка с его id, типом `undo` и совпадающим валидным `undoes`. id действий
 * сравниваются ТЕКСТОМ; цель отмены и массив проверяются под `CASE`: сломанная прежняя запись (не-uuid id, `actions` не массив)
 * остаётся в сообщениях и не роняет проход 22P02 — её уже назвал отчёт (`legacyJournalReport`).
 */
export function transferredLegacyMessagesQuery(graph: GraphId): SQL {
  return sql`SELECT m.id::text AS id FROM chat_messages m
      JOIN chat_threads t ON t.id = m.thread_id
     WHERE t.graph_id = ${graph}::uuid AND m.role = 'system'
       AND CASE
             WHEN m.metadata @> '{"type": "undo"}'::jsonb THEN
               ${UNDO_PRESENT(graph, sql`m.id`, sql`m.metadata ->> 'undoes'`)}
             WHEN jsonb_typeof(m.metadata -> 'actions') = 'array'
                  AND jsonb_array_length(m.metadata -> 'actions') > 0 THEN
               NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(m.metadata -> 'actions') = 'array' THEN m.metadata -> 'actions'
                        ELSE '[]'::jsonb END) AS a(value)
                  WHERE NOT EXISTS (SELECT 1 FROM action_journal j
                                     WHERE j.graph_id = ${graph}::uuid AND j.type <> 'undo'
                                       AND j.id::text = lower(a.value ->> 'id')))
             ELSE false
           END
     ORDER BY m.created_at, m.id`;
}

export async function transferredLegacyMessageIds(tx: Tx, graph: GraphId): Promise<string[]> {
  const rows = (await tx.execute(transferredLegacyMessagesQuery(graph))) as unknown as Array<{
    id: string;
  }>;
  return rows.map((r) => r.id);
}

/**
 * Прогноз журнала после переноса — только SELECT для засева в отчёте задачи 21. Переносимость ровно та же,
 * что у transferJournal; при конфликте таблица сильнее старого сообщения, а среди прежних дублей выигрывает
 * первая строка в порядке INSERT. Отмены идут после действий, поэтому их PK не вытесняет действие.
 */
export function prospectiveJournalQuery(graph: GraphId): SQL {
  return sql`WITH legacy AS MATERIALIZED (
      SELECT DISTINCT ON (lower(l.a ->> 'id'))
             (l.a ->> 'id')::uuid AS id, l.created_at, l.a ->> 'type' AS type,
             l.a -> 'operations' AS operations, NULL::uuid AS undoes
        FROM (${LEGACY_ACTIONS(graph)}) l
       WHERE ${TRANSFERABLE_ACTION} AND ${ACTION_SLOT_FREE(graph)}
       ORDER BY lower(l.a ->> 'id'), l.created_at, l.message_id, l.ord
    ), actions AS (
      SELECT j.id, j.created_at, j.type, j.operations, j.undoes
        FROM action_journal j WHERE j.graph_id = ${graph}::uuid
      UNION ALL SELECT * FROM legacy
    )
    SELECT * FROM actions
    UNION ALL
    SELECT u.id, u.created_at, 'undo'::text, '[]'::jsonb, CASE WHEN u.undoes ~* ${UUID} THEN u.undoes::uuid END
      FROM (${LEGACY_UNDOS(graph)}) u
     WHERE ${UNDO_TRANSFERABLE(graph)}
       AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.id = u.id)`;
}
