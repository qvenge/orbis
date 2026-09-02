// apps/server/src/agent-loop/queries.ts
// Запросы круга исполнителя (§4.14, С7): читающие проверки и выборки, которыми
// пользуются гейты и глаголы. Все — под уже открытым `withIdentity`-tx вызывающего
// (RLS владельца), собственных мутаций здесь нет.
import type {
  AgentRunStep,
  RoutineMode,
  RoutineStage,
  RunCheckpoint,
  RunOutcome,
  RunProposal,
  RunReply,
  RunSummary,
  RunUsage,
  Weekday,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import { ROUTINE_STAGE_PROPERTY } from '../policy/confirmation';
import { hierarchicalRolesSql } from '../registry/roles';

/**
 * Значения ПРОГОНА по id свойств (§А1-1/§А8) — то, чем после реформы говорит вся зона
 * исполнителя.
 *
 * Формы значений берутся из КОНТРАКТА круга исполнителя (`contracts/agent-loop.ts`) — там
 * же, где их видит агент по MCP. Прежде они выводились из zod-схемы аспекта
 * (`AgentRunAspect['<поле>']`), но аспект-объекта больше нет: реформа оставила словарь
 * свойств и контракт, а второй набор типов рядом с ними разъехался бы на первой же правке.
 *
 * `project_id` не переехал: §А8 его удаляет (замена — вычисляемые `orbis/parent_project`
 * и `orbis/root_project`).
 */
export interface RunProps {
  'orbis/grant'?: string;
  'orbis/run_routine'?: string;
  'orbis/run_bucket'?: string;
  'orbis/run_attempt'?: number;
  'orbis/fail_note'?: string;
  'orbis/run_proposal'?: RunProposal;
  'orbis/undecided'?: boolean;
  'orbis/run_outcome': RunOutcome;
  'orbis/run_started_at': string;
  'orbis/run_finished_at'?: string;
  'orbis/last_step_at': string;
  'orbis/step_count': number;
  'orbis/run_steps': AgentRunStep[];
  'orbis/session_url'?: string;
  'orbis/run_report'?: string;
  'orbis/run_checkpoint'?: RunCheckpoint;
  'orbis/run_reply'?: RunReply;
  'orbis/run_usage'?: RunUsage;
  'orbis/abandon_note'?: string;
}

/** Значения РУТИНЫ по id свойств (§А8) — та же подмена адреса, что у прогона. */
export interface RoutineProps {
  'orbis/routine_stage': RoutineStage;
  'orbis/routine_at': string;
  'orbis/routine_days'?: readonly Weekday[];
  'orbis/routine_mode': RoutineMode;
  'orbis/allowed_tools'?: string[];
}

/** Значения ТИКЕТА, которые читает круг исполнителя: задача плюс назначение (§А8). */
export interface TicketProps {
  'orbis/task_status'?: string;
  'orbis/priority'?: string;
  'orbis/due_date'?: string;
  'orbis/executor'?: string;
  'orbis/grant'?: string;
  'orbis/assignee'?: string;
  'orbis/may_close'?: boolean;
}

/**
 * Проба назначения гранту в форме containment по `props` (§А1-1).
 *
 * `executor: 'agent'` в пробе не декоративен: при `executor='human'` grant_id запрещён
 * инвариантом (assertAssignment), но проба обязана быть точной сама по себе — назначение
 * человеку не даёт прав никакому гранту.
 */
function assignedToGrant(grantId: string): string {
  return JSON.stringify({ 'orbis/executor': 'agent', 'orbis/grant': grantId });
}

/**
 * Инвариант 2 спеки: «скоуп worker не может тронуть чужое». Периметр записи фонового
 * исполнителя — треды НАЗНАЧЕННЫХ ему тикетов и их ПРЯМЫХ РОДИТЕЛЕЙ по иерархии:
 * тикет он ведёт, а в родителя (обычно проект) пишет сводку «готово, проверь» (С8/С9).
 * Аспект родителя проба не спрашивает намеренно — периметр задаёт связь, а не аспект.
 * Всё остальное в графе владельца ему закрыто.
 *
 * Один SQL вместо двух чтений: сущность годится, если она сама — тикет с назначением на
 * ЭТОТ грант, либо она родитель такого тикета по ИЕРАРХИЧЕСКОЙ роли (§А4-3; направление
 * как в грамматике §6: родитель — `source_id`, ребёнок — `target_id`). Список ролей —
 * подзапрос по реестру, а не литерал: роль с признаком `hierarchical` заводится операциями
 * реестра, и написанная в коде четвёрка её не увидела бы.
 * Проверка назначения — containment по колонке `props` (индекс `entities_props_gin`), а не
 * разбор `->>`-полей: так условие остаётся индексируемым. Рядом с ним обязателен признак
 * носителя `'orbis/assignment' = ANY(t.aspects)` (Р9): снятие аспекта назначения НЕ уносит
 * из `props` ни `orbis/executor`, ни `orbis/grant`, тогда как из старой карты они уходили
 * вместе с аспектом, — без признака грант писал бы в тред тикета, у которого назначение
 * уже снято.
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
  const rows = await tx.execute(
    sql`SELECT 1 AS ok
        FROM entities t
        JOIN entities target ON target.id = ${entityId}::uuid AND NOT target.archived
        WHERE t.owner_id = ${ownerId}::uuid
          AND NOT t.archived
          AND 'orbis/assignment' = ANY(t.aspects)
          AND t.props @> ${assignedToGrant(grantId)}::jsonb
          AND (
            t.id = target.id
            OR EXISTS (
              SELECT 1 FROM relations r
              WHERE r.source_id = target.id
                AND r.target_id = t.id
                AND r.role IN (${hierarchicalRolesSql()})
            )
          )
        LIMIT 1`,
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Выборки глаголов (§9.3): очередь, проект тикета, прогоны, брошенные прогоны.
// Все — сырой SQL под tx вызывающего: тащить их через компилятор запросов нельзя, он
// служебный аспект orbis/agent-run из выдачи вырезает, пока запрос сам его не назвал
// (`query/compile-ast.ts`, `namesServiceAspect`).
// ---------------------------------------------------------------------------

/** Строка тикета в объёме очереди и подметания (тело сюда не тянем — оно не нужно). */
export interface TicketRow {
  id: string;
  title: string;
  /** Значения строки по id свойств (§А1-1) — читаются под признаком носителя. */
  props: TicketProps;
  /** Список интерпретаций: он и есть признак носителя. */
  aspects: string[];
  updatedAt: Date;
}

/** Тикет в объёме задания исполнителю: с телом — это и есть текст работы. */
export interface TicketDetail {
  id: string;
  title: string;
  body: string;
  /** Значения строки по id свойств (§А1-1). */
  props: TicketProps;
  aspects: string[];
}

/** Строка прогона: его свойства + идентичность сущности (заголовок для карточек). */
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
  /**
   * Свойства прогона. Признака носителя рядом нет НАМЕРЕННО: каждая выборка строк прогона
   * в этом файле уже требует `'orbis/agent-run' = ANY(aspects)` в WHERE, и вторая проверка
   * на стороне JS была бы тавтологией.
   */
  props: RunProps;
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
  /** Свойства рутины; признак носителя, как и у прогона, стоит в WHERE каждой выборки. */
  props: RoutineProps;
}

/** Сырые строки sql-шаблона drizzle — приводим к своим формам одной точкой. */
type RawRow = Record<string, unknown>;

function toTicketRow(row: RawRow): TicketRow {
  return {
    id: row.id as string,
    title: row.title as string,
    props: row.props as TicketProps,
    aspects: row.aspects as string[],
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Свойства прогона валидированы ajv на записи (стадия 2 executor'а по реестру), поэтому
 * приведение честно: другой формы в колонке быть не может. Прецедент — `actorKind as
 * ActorKind` в executor'е при чтении собственной же записи.
 */
function toRunRow(row: RawRow): RunRow {
  return {
    id: row.id as string,
    title: row.title as string,
    createdAt: row.created_at as Date,
    archived: row.archived === true,
    props: row.props as RunProps,
  };
}

/** Та же честность приведения, что у прогона: свойства рутины валидированы ajv на записи. */
function toRoutineRow(row: RawRow): RoutineRow {
  return {
    id: row.id as string,
    title: row.title as string,
    body: row.body as string,
    props: row.props as RoutineProps,
  };
}

/**
 * Тикеты, назначенные гранту (очередь исполнителя). Отбор — containment по КОЛОНКЕ `props`
 * (`@>`), а не разбор `->>`-полей: форма запроса одна на все чтения свойств.
 *
 * ПРО ИНДЕКС — ЧЕСТНО (замер 2026-08-27, `perf/explain.test.ts`). GIN `entities_props_gin`
 * это условие ПОД РОЛЬЮ ПРИЛОЖЕНИЯ НЕ БЕРЁТ: политика RLS `owner_owns_row` — security qual,
 * а `jsonb_contains` не leakproof, поэтому планировщик обязан применить политику раньше и
 * уходит в Bitmap Heap Scan по `entities_owner_updated` с фильтром по куче. Под админским
 * подключением (сиды, скрипты, `ops.ts`) тот же запрос индекс берёт. Прежняя формулировка
 * «покрыт GIN-индексом» была неправдой ровно на боевом пути (долг 5 ветки).
 *
 * `executor: 'agent'` в пробе обязателен: назначение человеку не даёт прав никакому гранту
 * (та же логика, что в isWorkerThreadTarget).
 *
 * Признаков носителя ДВА, и оба переводят по одному предикату старой формы: containment по
 * старой карте требовал КЛЮЧА `orbis/assignment`, а `aspects_legacy ? 'orbis/task'` —
 * ключа задачи. В `props` значения переживают снятие аспекта (Р9), поэтому без обоих
 * признаков в очередь попадали бы записи, назначением или задачей быть переставшие.
 *
 * Архивные исключены: архив — это «убрано с глаз», а не «сделай». Статус тикета в отбор
 * НЕ входит намеренно — очередь показывает и `waiting`/`done` с пометкой claimable=false:
 * агенту важно видеть, что тикет у него есть и почему его нельзя взять.
 */
export async function assignedTickets(tx: Tx, grantId: string): Promise<TicketRow[]> {
  const rows = await tx.execute(
    sql`SELECT id, title, props, aspects, updated_at
        FROM entities
        WHERE NOT archived
          AND 'orbis/assignment' = ANY(aspects)
          AND 'orbis/task' = ANY(aspects)
          AND props @> ${assignedToGrant(grantId)}::jsonb
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
    sql`SELECT id, title, body, props, aspects FROM entities
        WHERE id = ${ticketId}::uuid AND NOT archived AND 'orbis/task' = ANY(aspects)`,
  );
  const row = (rows as unknown as RawRow[])[0];
  if (row === undefined) return null;
  return {
    id: row.id as string,
    title: row.title as string,
    body: row.body as string,
    props: row.props as TicketProps,
    aspects: row.aspects as string[],
  };
}

/**
 * Проект тикета — ВЫЧИСЛЕННЫЙ предок `orbis/parent_project` (§А8, правило
 * `nearest_ancestor`), а не JOIN по одному ребру.
 *
 * До реформы здесь стоял одноуровневый `parents_of`, и он отвечал «проекта нет» на любом
 * тикете, лежащем под задачей проекта, — а такие тикеты владелец заводит постоянно. Теперь
 * ответ считает движок предков (`executor/ancestors.ts`) тем же tx, что и правку рёбер, и
 * очередь исполнителя читает ровно то значение, которое лежит в графе.
 *
 * Тикет без проекта над собой — законный случай (личная задача владельца), поэтому null,
 * а не ошибка. Чужой проект под RLS невидим: JOIN не соединится, и ответ тот же null.
 */
export async function parentProject(tx: Tx, ticketId: string): Promise<ProjectRow | null> {
  const rows = await tx.execute(
    sql`SELECT p.id, p.title, p.body
        FROM entities t
        JOIN entities p ON p.id = (t.props->>'orbis/parent_project')::uuid
        WHERE t.id = ${ticketId}::uuid`,
  );
  const row = (rows as unknown as RawRow[])[0];
  if (row === undefined) return null;
  return { id: row.id as string, title: row.title as string, body: row.body as string };
}

/**
 * Прогоны РОДИТЕЛЯ (`children_of`), в порядке появления: история читается сверху вниз.
 *
 * Родитель — тикет у внешнего исполнителя и рутина у внутреннего (V1.4): запрос никогда
 * не спрашивал аспект родителя, он идёт по иерархической связи, — и обобщение свелось
 * к имени. Прогон вешается ролью `run`, но отбор идёт по всему семейству иерархии: сузив
 * его до одной роли, запрос потерял бы прогон, привязанный владельцем вручную (`subitem`),
 * — а история прогонов обязана показывать то же, что показывала до реформы.
 */
export async function runsOfParent(tx: Tx, parentId: string): Promise<RunRow[]> {
  const rows = await tx.execute(
    sql`SELECT e.id, e.title, e.created_at, e.archived, e.props
        FROM entities e
        JOIN relations r ON r.target_id = e.id
        WHERE r.source_id = ${parentId}::uuid
          AND r.role IN (${hierarchicalRolesSql()})
          AND 'orbis/agent-run' = ANY(e.aspects)
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
 * Containment по колонке `props` (индекс `entities_props_gin`), а не разбор `->>`-полей;
 * признак носителя `'orbis/agent-run' = ANY(aspects)` переводит требование КЛЮЧА аспекта,
 * которое containment по старой карте нёс в себе (Р9).
 * Архивные НЕ исключаются намеренно: убранный с глаз прогон всё равно занимает свой слот,
 * иначе архивация прогона молча разрешала бы прогнать бакет заново.
 */
export async function runsForBucket(tx: Tx, routineId: string, bucket: string): Promise<RunRow[]> {
  const ofBucket = JSON.stringify({ 'orbis/run_routine': routineId, 'orbis/run_bucket': bucket });
  const rows = await tx.execute(
    sql`SELECT id, title, created_at, archived, props
        FROM entities
        WHERE 'orbis/agent-run' = ANY(aspects)
          AND props @> ${ofBucket}::jsonb
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
  const active = JSON.stringify({ [ROUTINE_STAGE_PROPERTY]: 'active' });
  const rows = await tx.execute(
    sql`SELECT id, title, body, props
        FROM entities
        WHERE NOT archived
          AND 'orbis/routine' = ANY(aspects)
          AND props @> ${active}::jsonb
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
    sql`SELECT id, title, body, props
        FROM entities
        WHERE id = ${id}::uuid AND NOT archived AND 'orbis/routine' = ANY(aspects)`,
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
  const running = JSON.stringify({ 'orbis/run_outcome': 'running' });
  const rows = await tx.execute(
    sql`SELECT id, title, created_at, archived, props
        FROM entities
        WHERE 'orbis/agent-run' = ANY(aspects)
          AND props @> ${running}::jsonb
          AND (props ->> 'orbis/last_step_at')::timestamptz < ${before.toISOString()}::timestamptz
        ORDER BY created_at ASC`,
  );
  return (rows as unknown as RawRow[]).map(toRunRow);
}

/**
 * Прогон по id (глаголы шага, чекпойнта и итога). Чужой и несуществующий неразличимы —
 * оба null, как у тикета: по той же причине, что и там (не быть оракулом чужого графа).
 * Условие `'orbis/agent-run' = ANY(aspects)` не декоративно: без него id любой сущности
 * владельца проходил бы за прогон, и глагол падал бы на разборе пустых свойств.
 *
 * Архивный прогон — структурно «прогона нет»: шаги и итог дописывать некуда, раз владелец
 * убрал запись (в том числе откатив собственный захват). Подметание при этом его ВИДИТ
 * (staleRuns) — инвариант 6 держится и на архивных.
 */
export async function runById(tx: Tx, runId: string): Promise<RunRow | null> {
  const rows = await tx.execute(
    sql`SELECT id, title, created_at, archived, props
        FROM entities
        WHERE id = ${runId}::uuid AND NOT archived AND 'orbis/agent-run' = ANY(aspects)`,
  );
  const row = (rows as unknown as RawRow[])[0];
  return row === undefined ? null : toRunRow(row);
}

/** Тикет прогона — его родитель по иерархической связи. Прогон-сирота даёт null. */
export async function ticketOfRun(tx: Tx, runId: string): Promise<TicketRow | null> {
  const rows = await tx.execute(
    sql`SELECT e.id, e.title, e.props, e.aspects, e.updated_at
        FROM entities e
        JOIN relations r ON r.source_id = e.id
        WHERE r.target_id = ${runId}::uuid
          AND r.role IN (${hierarchicalRolesSql()})
          AND 'orbis/task' = ANY(e.aspects)
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
  const p = row.props;
  const finishedAt = p['orbis/run_finished_at'];
  const report = p['orbis/run_report'];
  const checkpoint = p['orbis/run_checkpoint'];
  const reply = p['orbis/run_reply'];
  const abandonNote = p['orbis/abandon_note'];
  const sessionUrl = p['orbis/session_url'];
  const routineId = p['orbis/run_routine'];
  const bucket = p['orbis/run_bucket'];
  const attempt = p['orbis/run_attempt'];
  const failNote = p['orbis/fail_note'];
  const proposal = p['orbis/run_proposal'];
  return {
    id: row.id,
    outcome: p['orbis/run_outcome'],
    started_at: p['orbis/run_started_at'],
    step_count: p['orbis/step_count'],
    last_steps: p['orbis/run_steps'].slice(-SUMMARY_STEPS),
    ...(finishedAt !== undefined && { finished_at: finishedAt }),
    ...(report !== undefined && { report }),
    ...(checkpoint !== undefined && { checkpoint }),
    ...(reply !== undefined && { reply }),
    ...(abandonNote !== undefined && { abandon_note: abandonNote }),
    ...(sessionUrl !== undefined && { session_url: sessionUrl }),
    // V1: рутинная половина сводки. Субъект и слот отвечают на «что было вчера в 07:00»,
    // fail_note и статус предложения — на «почему в графе ничего не изменилось».
    ...(routineId !== undefined && { routine_id: routineId }),
    ...(bucket !== undefined && { bucket }),
    ...(attempt !== undefined && { attempt }),
    ...(failNote !== undefined && { fail_note: failNote }),
    // Пачка осталась неразобранной (D42 ОЧ.6). Снятый флажок лежит в свойстве значением
    // `false`, но в сводку не едет: для читателя истории «разобрано» и «пачки не было» —
    // одно и то же, а `undecided: false` заставляло бы его различать несуществующее.
    ...(p['orbis/undecided'] === true && { undecided: true as const }),
    // Расхождения предусловия (proposal.mismatches) в сводку НЕ едут: это материал экрана
    // предложения, а в хвосте истории они раздували бы каждый ответ раннера чужим разбором.
    ...(proposal !== undefined && {
      proposal: {
        pending_id: proposal.pending_id,
        status: proposal.status,
        ...(proposal.decided_at !== undefined && { decided_at: proposal.decided_at }),
        // След правки владельца (Ш1.8) — часть судьбы предложения, а не разбор
        // расхождений: история рутины обязана отличать «принял» от «принял, переписав»
        ...(proposal.edited_from !== undefined && { edited_from: proposal.edited_from }),
      },
    }),
  };
}
