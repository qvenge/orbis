// apps/server/src/agent-loop/queries.ts
// Запросы круга исполнителя (§4.14, С7): читающие проверки и выборки, которыми
// пользуются гейты и глаголы. Все — под уже открытым `withIdentity`-tx вызывающего
// (RLS владельца), собственных мутаций здесь нет.
import type { AgentRunAspect, RoutineAspect, RunSummary } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

/**
 * Инвариант 2 спеки: «скоуп worker не может тронуть чужое». Периметр записи фонового
 * исполнителя — треды НАЗНАЧЕННЫХ ему тикетов и их ПРЯМЫХ РОДИТЕЛЕЙ по связи parent:
 * тикет он ведёт, а в родителя (обычно проект) пишет сводку «готово, проверь» (С8/С9).
 * Аспект родителя проба не спрашивает намеренно — периметр задаёт связь, а не аспект.
 * Всё остальное в графе владельца ему закрыто.
 *
 * Один SQL вместо двух чтений: сущность годится, если она сама — тикет с назначением на
 * ЭТОТ грант, либо она родитель такого тикета (`relations.relation_type='parent'`,
 * направление как в грамматике §6: родитель — `source_id`, ребёнок — `target_id`).
 * Проверка назначения — containment по колонке `aspects_legacy` (индекс
 * `entities_aspects_legacy_gin`),
 * а не разбор json-полей: так условие остаётся индексируемым.
 *
 * `executor: 'agent'` в пробе не декоративен: при `executor='human'` grant_id запрещён
 * инвариантом (assertAssignment), но проба обязана быть точной сама по себе — назначение
 * человеку не даёт прав никакому гранту.
 *
 * Архивные не годятся ни целью, ни тикетом-основанием: архив — «убрано с глаз», и писать
 * туда исполнителю нечего. Цель присоединяется JOIN'ом, поэтому несуществующий id даёт
 * пустую выборку — то есть FORBIDDEN_LEVEL, а не NOT_FOUND (исполнителю не с чего узнавать,
 * что за пределами его назначений вообще что-то есть).
 */
export async function isWorkerThreadTarget(
  tx: Tx,
  ownerId: string,
  grantId: string,
  entityId: string,
): Promise<boolean> {
  const assigned = JSON.stringify({
    'orbis/assignment': { executor: 'agent', grant_id: grantId },
  });
  const rows = await tx.execute(
    sql`SELECT 1 AS ok
        FROM entities t
        JOIN entities target ON target.id = ${entityId}::uuid AND NOT target.archived
        WHERE t.owner_id = ${ownerId}::uuid
          AND NOT t.archived
          AND t.aspects_legacy @> ${assigned}::jsonb
          AND (
            t.id = target.id
            OR EXISTS (
              SELECT 1 FROM relations r
              WHERE r.source_id = target.id
                AND r.target_id = t.id
                AND r.relation_type = 'parent'
            )
          )
        LIMIT 1`,
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Выборки глаголов (§9.3): очередь, проект тикета, прогоны, брошенные прогоны.
// Все — сырой SQL под tx вызывающего: тащить их через компилятор грамматики §6
// нельзя, он служебный аспект orbis/agent-run из выдачи вырезает (compile.ts).
// ---------------------------------------------------------------------------

/** Строка тикета в объёме очереди и подметания (тело сюда не тянем — оно не нужно). */
export interface TicketRow {
  id: string;
  title: string;
  /** Старая карта аспектов (§А1-1): носитель до «Пересева мира». */
  aspectsLegacy: Record<string, Record<string, unknown>>;
  updatedAt: Date;
}

/** Тикет в объёме задания исполнителю: с телом — это и есть текст работы. */
export interface TicketDetail {
  id: string;
  title: string;
  body: string;
  /** Старая карта аспектов (§А1-1): носитель до «Пересева мира». */
  aspectsLegacy: Record<string, Record<string, unknown>>;
}

/** Строка прогона: сам аспект + идентичность сущности (заголовок для карточек). */
export interface RunRow {
  id: string;
  title: string;
  createdAt: Date;
  /**
   * Убран ли прогон в архив. У рутинного прогона архив — след ОТКАТА (rollback.ts), и
   * выборки прогонов архивные НЕ исключают (слот остаётся отработанным, история — полной);
   * кому архив важен (обзор рутины: откаченный прогон не «ждёт»), тот смотрит сюда.
   */
  archived: boolean;
  run: AgentRunAspect;
}

/** Проект в объёме ответа на захват: тело несёт раздел «Процесс» (С10). */
export interface ProjectRow {
  id: string;
  title: string;
  body: string;
}

/**
 * Рутина в объёме, нужном раннеру (V1.13): расписание с правами — в аспекте, а «что
 * делать» — в ТЕЛЕ (V1.1), ровно как «Процесс» у проекта. Поэтому тело здесь тянется
 * всегда: без него прогону нечего сказать модели.
 */
export interface RoutineRow {
  id: string;
  title: string;
  body: string;
  routine: RoutineAspect;
}

/** Сырые строки sql-шаблона drizzle — приводим к своим формам одной точкой. */
type RawRow = Record<string, unknown>;

function toTicketRow(row: RawRow): TicketRow {
  return {
    id: row.id as string,
    title: row.title as string,
    aspectsLegacy: row.aspects_legacy as Record<string, Record<string, unknown>>,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Аспект прогона валидирован ajv на записи (стадия 2 executor'а по реестру), поэтому
 * приведение честно: другой формы в колонке быть не может. Прецедент — `actorKind as
 * ActorKind` в executor'е при чтении собственной же записи.
 */
function toRunRow(row: RawRow): RunRow {
  return {
    id: row.id as string,
    title: row.title as string,
    createdAt: row.created_at as Date,
    archived: row.archived === true,
    run: row.run as AgentRunAspect,
  };
}

/** Та же честность приведения, что у прогона: аспект рутины валидирован ajv на записи. */
function toRoutineRow(row: RawRow): RoutineRow {
  return {
    id: row.id as string,
    title: row.title as string,
    body: row.body as string,
    routine: row.routine as RoutineAspect,
  };
}

/**
 * Тикеты, назначенные гранту (очередь исполнителя). Containment по КОЛОНКЕ `aspects_legacy`
 * (`@>`) — покрыт GIN-индексом entities_aspects_legacy_gin; разбор json-полей (`->>`) сделал бы
 * условие неиндексируемым. `executor: 'agent'` в пробе обязателен: назначение человеку
 * не даёт прав никакому гранту (та же логика, что в isWorkerThreadTarget).
 *
 * Архивные исключены: архив — это «убрано с глаз», а не «сделай». Статус тикета в отбор
 * НЕ входит намеренно — очередь показывает и `waiting`/`done` с пометкой claimable=false:
 * агенту важно видеть, что тикет у него есть и почему его нельзя взять.
 */
export async function assignedTickets(tx: Tx, grantId: string): Promise<TicketRow[]> {
  const assigned = JSON.stringify({
    'orbis/assignment': { executor: 'agent', grant_id: grantId },
  });
  const rows = await tx.execute(
    sql`SELECT id, title, aspects_legacy, updated_at
        FROM entities
        WHERE NOT archived
          AND aspects_legacy @> ${assigned}::jsonb
          AND aspects_legacy ? 'orbis/task'
        ORDER BY updated_at DESC`,
  );
  return (rows as unknown as RawRow[]).map(toTicketRow);
}

/**
 * Тикет с телом по id; чужой и несуществующий под RLS неразличимы — оба null.
 *
 * Архивный — тоже null, как и в очереди (assignedTickets): архив значит «убрано», и id из
 * прежней выдачи не должен быть обходным путём взять в работу то, чего на экранах уже нет.
 */
export async function ticketById(tx: Tx, ticketId: string): Promise<TicketDetail | null> {
  const rows = await tx.execute(
    sql`SELECT id, title, body, aspects_legacy FROM entities
        WHERE id = ${ticketId}::uuid AND NOT archived AND aspects_legacy ? 'orbis/task'`,
  );
  const row = (rows as unknown as RawRow[])[0];
  if (row === undefined) return null;
  return {
    id: row.id as string,
    title: row.title as string,
    body: row.body as string,
    aspectsLegacy: row.aspects_legacy as Record<string, Record<string, unknown>>,
  };
}

/**
 * Проект-родитель тикета (`parents_of` грамматики §6: родитель — `source_id`). Тикет без
 * проекта — законный случай (личная задача владельца), поэтому null, а не ошибка.
 */
export async function parentProject(tx: Tx, ticketId: string): Promise<ProjectRow | null> {
  const rows = await tx.execute(
    sql`SELECT e.id, e.title, e.body
        FROM entities e
        JOIN relations r ON r.source_id = e.id
        WHERE r.target_id = ${ticketId}::uuid
          AND r.relation_type = 'parent'
          AND e.aspects_legacy ? 'orbis/project'
        ORDER BY e.created_at ASC
        LIMIT 1`,
  );
  const row = (rows as unknown as RawRow[])[0];
  if (row === undefined) return null;
  return { id: row.id as string, title: row.title as string, body: row.body as string };
}

/**
 * Прогоны РОДИТЕЛЯ (`children_of`), в порядке появления: история читается сверху вниз.
 *
 * Родитель — тикет у внешнего исполнителя и рутина у внутреннего (V1.4): запрос никогда
 * не спрашивал аспект родителя, он идёт по связи `parent`, — и обобщение свелось к имени.
 */
export async function runsOfParent(tx: Tx, parentId: string): Promise<RunRow[]> {
  const rows = await tx.execute(
    sql`SELECT e.id, e.title, e.created_at, e.archived, e.aspects_legacy -> 'orbis/agent-run' AS run
        FROM entities e
        JOIN relations r ON r.target_id = e.id
        WHERE r.source_id = ${parentId}::uuid
          AND r.relation_type = 'parent'
          AND e.aspects_legacy ? 'orbis/agent-run'
        ORDER BY e.created_at ASC`,
  );
  return (rows as unknown as RawRow[]).map(toRunRow);
}

/** Прежнее имя того же запроса — для вызывающих, которым родитель и есть тикет. */
export const runsOfTicket = runsOfParent;

/**
 * Прогоны рутины за конкретный слот расписания (V1.3): все попытки бакета, старшая —
 * первой. Пустая выдача = слот ещё не отработан, `failed` в хвосте = можно ретраить.
 *
 * Тик планировщика (routines/lifecycle.ts startBucketRun) этим запросом НЕ пользуется, а
 * вырезает слот из `runsOfParent` в памяти: ему нужен один снимок «вся рутина + слот» —
 * второй запрос под READ COMMITTED мог бы увидеть прогон, закоммиченный конкурентом
 * между двумя чтениями, и запуск классифицировал бы идущий прогон как отработанный слот.
 * Запрос остаётся для точечного чтения слота (экраны, диагностика).
 *
 * Containment по колонке `aspects_legacy` (индекс `entities_aspects_legacy_gin`), а не
 * разбор json-полей.
 * Архивные НЕ исключаются намеренно: убранный с глаз прогон всё равно занимает свой слот,
 * иначе архивация прогона молча разрешала бы прогнать бакет заново.
 */
export async function runsForBucket(tx: Tx, routineId: string, bucket: string): Promise<RunRow[]> {
  const ofBucket = JSON.stringify({ 'orbis/agent-run': { routine_id: routineId, bucket } });
  const rows = await tx.execute(
    sql`SELECT id, title, created_at, archived, aspects_legacy -> 'orbis/agent-run' AS run
        FROM entities
        WHERE aspects_legacy @> ${ofBucket}::jsonb
        ORDER BY created_at ASC`,
  );
  return (rows as unknown as RawRow[]).map(toRunRow);
}

/**
 * Активные рутины владельца (V1.13) — то, что тик планировщика рассматривает к запуску.
 *
 * `paused` не отбирается: пауза — это «не запускать», и фильтровать её после выборки
 * значило бы держать правило в двух местах. Архивные — тоже нет: архив значит «убрано с
 * глаз», и рутина, которой нет на экранах, не должна ходить в фоне.
 */
export async function activeRoutines(tx: Tx): Promise<RoutineRow[]> {
  const active = JSON.stringify({ 'orbis/routine': { stage: 'active' } });
  const rows = await tx.execute(
    sql`SELECT id, title, body, aspects_legacy -> 'orbis/routine' AS routine
        FROM entities
        WHERE NOT archived AND aspects_legacy @> ${active}::jsonb
        ORDER BY created_at ASC`,
  );
  return (rows as unknown as RawRow[]).map(toRoutineRow);
}

/**
 * Рутина по id — ручной прогон, экран рутины и восстановление контекста прогона.
 *
 * Приостановленная ОТДАЁТСЯ, в отличие от `activeRoutines`: пауза — про запуск по
 * расписанию, а не про видимость, и экран обязан показать то, что владелец сам поставил
 * на паузу. Архивная — null, как и у тикета: id из прежней выдачи не должен быть обходным
 * путём запустить то, чего на экранах уже нет. Чужая и несуществующая под RLS неразличимы.
 */
export async function routineById(tx: Tx, id: string): Promise<RoutineRow | null> {
  const rows = await tx.execute(
    sql`SELECT id, title, body, aspects_legacy -> 'orbis/routine' AS routine
        FROM entities
        WHERE id = ${id}::uuid AND NOT archived AND aspects_legacy ? 'orbis/routine'`,
  );
  const row = (rows as unknown as RawRow[])[0];
  return row === undefined ? null : toRoutineRow(row);
}

/**
 * Прогоны, брошенные к моменту `before` (С6): всё ещё `running`, а последний шаг старше
 * порога.
 *
 * Архивные ОТБИРАЮТСЯ наравне с остальными, в отличие от очереди: инвариант 6 («тикет не
 * висит in_progress навсегда») — про состояние графа, а не про видимость на экране. Путь к
 * архивированному running-прогону — РУКА ВЛАДЕЛЬЦА: «Архивировать» есть в меню ⋮ любой
 * записи, включая прогон, и убранный с глаз прогон остаётся running, а тикет — in_progress;
 * исключи мы архивные, чинить это состояние стало бы нечем. А вот «отмени последнее» после
 * захвата такого состояния НЕ даёт: инверсия идёт всем батчем — статус тикета возвращается,
 * связь тикет→прогон снимается, и архивированный прогон остаётся сиротой без тикета.
 *
 * Сравнение — подпутевое (`->>` с приведением к timestamptz), то есть seq scan:
 * containment по колонке отбирает running-прогоны индексом, а их у владельца единицы —
 * агент работает над одним тикетом за раз. Приведение к timestamptz, а не сравнение
 * строк: формат отметки схема допускает не единственный (смещение вместо `Z`, доли
 * секунды), и лексикографическое сравнение врало бы на первом же таком значении.
 */
export async function staleRuns(tx: Tx, before: Date): Promise<RunRow[]> {
  const running = JSON.stringify({ 'orbis/agent-run': { outcome: 'running' } });
  const rows = await tx.execute(
    sql`SELECT id, title, created_at, archived, aspects_legacy -> 'orbis/agent-run' AS run
        FROM entities
        WHERE aspects_legacy @> ${running}::jsonb
          AND (aspects_legacy -> 'orbis/agent-run' ->> 'last_step_at')::timestamptz < ${before.toISOString()}::timestamptz
        ORDER BY created_at ASC`,
  );
  return (rows as unknown as RawRow[]).map(toRunRow);
}

/**
 * Прогон по id (глаголы шага, чекпойнта и итога). Чужой и несуществующий неразличимы —
 * оба null, как у тикета: по той же причине, что и там (не быть оракулом чужого графа).
 * Условие `aspects_legacy ? 'orbis/agent-run'` не декоративно: без него id любой сущности
 * владельца проходил бы за прогон, и глагол падал бы на разборе пустого аспекта.
 *
 * Архивный прогон — структурно «прогона нет»: шаги и итог дописывать некуда, раз владелец
 * убрал запись (в том числе откатив собственный захват). Подметание при этом его ВИДИТ
 * (staleRuns) — инвариант 6 держится и на архивных.
 */
export async function runById(tx: Tx, runId: string): Promise<RunRow | null> {
  const rows = await tx.execute(
    sql`SELECT id, title, created_at, archived, aspects_legacy -> 'orbis/agent-run' AS run
        FROM entities
        WHERE id = ${runId}::uuid AND NOT archived AND aspects_legacy ? 'orbis/agent-run'`,
  );
  const row = (rows as unknown as RawRow[])[0];
  return row === undefined ? null : toRunRow(row);
}

/** Тикет прогона — его родитель по связи parent. Прогон-сирота даёт null. */
export async function ticketOfRun(tx: Tx, runId: string): Promise<TicketRow | null> {
  const rows = await tx.execute(
    sql`SELECT e.id, e.title, e.aspects_legacy, e.updated_at
        FROM entities e
        JOIN relations r ON r.source_id = e.id
        WHERE r.target_id = ${runId}::uuid
          AND r.relation_type = 'parent'
          AND e.aspects_legacy ? 'orbis/task'
        LIMIT 1`,
  );
  const row = (rows as unknown as RawRow[])[0];
  return row === undefined ? null : toTicketRow(row);
}

/** Сколько последних шагов прогона едет в сводке: полный массив (до 500) раздул бы ответ. */
const SUMMARY_STEPS = 10;

/**
 * Сводка прогона для агента и экранов. Опциональные ключи не заводятся пустыми: `?` в
 * wire-форме значит «этого не было», а не «есть, но undefined».
 */
export function runSummary(row: RunRow): RunSummary {
  const r = row.run;
  return {
    id: row.id,
    outcome: r.outcome,
    started_at: r.started_at,
    step_count: r.step_count,
    last_steps: r.steps.slice(-SUMMARY_STEPS),
    ...(r.finished_at !== undefined && { finished_at: r.finished_at }),
    ...(r.report !== undefined && { report: r.report }),
    ...(r.checkpoint !== undefined && { checkpoint: r.checkpoint }),
    ...(r.reply !== undefined && { reply: r.reply }),
    ...(r.abandon_note !== undefined && { abandon_note: r.abandon_note }),
    ...(r.session_url !== undefined && { session_url: r.session_url }),
    // V1: рутинная половина сводки. Субъект и слот отвечают на «что было вчера в 07:00»,
    // fail_note и статус предложения — на «почему в графе ничего не изменилось».
    ...(r.routine_id !== undefined && { routine_id: r.routine_id }),
    ...(r.bucket !== undefined && { bucket: r.bucket }),
    ...(r.attempt !== undefined && { attempt: r.attempt }),
    ...(r.fail_note !== undefined && { fail_note: r.fail_note }),
    // Пачка осталась неразобранной (D42 ОЧ.6). Снятый флажок лежит в аспекте значением
    // `false`, но в сводку не едет: для читателя истории «разобрано» и «пачки не было» —
    // одно и то же, а `undecided: false` заставляло бы его различать несуществующее.
    ...(r.undecided === true && { undecided: true as const }),
    // Расхождения предусловия (proposal.mismatches) в сводку НЕ едут: это материал экрана
    // предложения, а в хвосте истории они раздували бы каждый ответ раннера чужим разбором.
    ...(r.proposal !== undefined && {
      proposal: {
        pending_id: r.proposal.pending_id,
        status: r.proposal.status,
        ...(r.proposal.decided_at !== undefined && { decided_at: r.proposal.decided_at }),
        // След правки владельца (Ш1.8) — часть судьбы предложения, а не разбор
        // расхождений: история рутины обязана отличать «принял» от «принял, переписав»
        ...(r.proposal.edited_from !== undefined && { edited_from: r.proposal.edited_from }),
      },
    }),
  };
}
