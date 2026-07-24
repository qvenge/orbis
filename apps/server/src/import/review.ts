// apps/server/src/import/review.ts
// Домен CSV-импорта (Task C2, 03-budget §3.4, §3.4.1): распознавание структуры файла
// одним LLM-вызовом, статусы строк ревью и подтверждение импорта одним batch_execute.
// Роутер (routers/import.ts) — только трансляция: формулы, SQL и обращения к
// исполнителю живут здесь (правило 8 impl-00).
//
// Три инварианта задачи:
//   1. Provenance строки — НЕ поле сущности, а строка entity_origins (01-arch §4.8)
//      с уникальностью (owner_id, namespace, external_id); external_id считает общий
//      с клиентом код C1 (externalRowId) — второй реализации хэша нет.
//   2. Импорт — ОДИН batch_execute с клиентским batch_id: идемпотентен по нему,
//      падение любой строки не оставляет частичного импорта, Undo откатывает группу
//      целиком (созданные сущности архивируются, строки origins удаляются физически).
//   3. Привязку к конвертам импорт не создаёт руками — её выводит бюджет-хук
//      исполнителя (A4) в тот же action.
import {
  type CanonicalRow,
  csvMappingToolJsonSchema,
  externalRowId,
  type FastPathCategory,
  findCategory,
  type ImportAnalyzeResult,
  type ImportConfirmInput,
  type ImportConfirmResult,
  type ImportReviewInput,
  type ImportReviewResult,
  type ImportReviewRow,
  importAnalyzeResultSchema,
  isProbableDuplicate,
  MAX_ANALYZE_ROW_CHARS,
  MAX_IMPORT_ROWS,
  newId,
  normalizeCounterparty,
} from '@orbis/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { recordUsage } from '../ai/metering';
import type { AiDeps } from '../ai/send-message';
import type { Db } from '../db/client';
import { entityOrigins } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { IMPORT_CSV_KEY, resolveEntitlement } from '../entitlements';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import type { LLMRequest, LLMResponse } from '../llm/types';
import { addDays } from '../recurring/materialize';

// Синк один на модуль (как rollover/post-due): состояния не хранит, audit-сообщение
// batch пишется тем же tx, что и операции исполнителя (§7.8).
const sink = makeChatJournalSink();

/**
 * Гейт §8 для всех трёх процедур импорта (образец — gateAiEntitlements): на плане
 * 'dev' разрешено, отказ резолвера → LIMIT (429 маппингом errors.ts).
 */
export function gateImportCsv(ownerId: string): void {
  const decision = resolveEntitlement(ownerId, IMPORT_CSV_KEY);
  if (!decision.allowed) {
    throw new ExecError('LIMIT', `лимит «${IMPORT_CSV_KEY}» исчерпан`, {
      key: IMPORT_CSV_KEY,
      limit: decision.limit,
    });
  }
}

/** Потолок размера импорта — общий для review и confirm (см. MAX_IMPORT_ROWS). */
function assertRowLimit(count: number): void {
  if (count > MAX_IMPORT_ROWS) {
    throw new ExecError(
      'VALIDATION',
      `за один импорт принимается не более ${MAX_IMPORT_ROWS} строк — разбейте выписку на части`,
      { limit: MAX_IMPORT_ROWS, rows: count },
    );
  }
}

// ---------------------------------------------------------------------------
// analyze (§3.4 шаг 2): единственный LLM-вызов флоу
// ---------------------------------------------------------------------------

const MAPPING_TOOL = 'csv_mapping';
const ANALYZE_MAX_TOKENS = 1024;

const ANALYZE_SYSTEM = [
  'Ты разбираешь структуру банковской выписки в CSV.',
  'На вход даны первые строки файла как есть (возможно, с заголовком).',
  'Определи индексы колонок (нумерация с нуля), формат даты и способ кодирования знака:',
  '«sign» — одна колонка суммы со знаком, «separate_columns» — раздельные дебет и кредит.',
  `Ответь ТОЛЬКО вызовом инструмента ${MAPPING_TOOL}; confidence — твоя уверенность 0..1.`,
  'Если структура непонятна, всё равно верни лучшую гипотезу с низким confidence.',
].join(' ');

/**
 * Распознавание маппинга колонок (§7.7): структурированный ответ берётся из TOOL-CALL,
 * а не парсингом прозы. Любой сбой этого пути — структурная ошибка LLM_UNAVAILABLE
 * (503 §7.9): клиент показывает «повторить» и даёт смапить колонки руками. Маппинг
 * НЕ выдумывается сервером ни при каких условиях.
 *
 * Приватность (§3.4 шаг 1): в промпт уходят только образцы строк — не более
 * MAX_ANALYZE_SAMPLE_ROWS (схема входа) и не длиннее MAX_ANALYZE_ROW_CHARS каждая
 * (обрезаются здесь: длинная строка не должна ронять распознавание целиком).
 */
export async function analyzeCsv(
  db: Db,
  deps: AiDeps,
  args: { ownerId: string; sampleRows: string[] },
): Promise<ImportAnalyzeResult> {
  gateImportCsv(args.ownerId);

  const samples = args.sampleRows.map((row) => row.slice(0, MAX_ANALYZE_ROW_CHARS));
  const request: LLMRequest = {
    system: ANALYZE_SYSTEM,
    messages: [{ role: 'user', content: samples.join('\n') }],
    tools: [
      {
        name: MAPPING_TOOL,
        description: 'Маппинг колонок выписки: индексы колонок, формат даты, знак суммы.',
        inputSchema: csvMappingToolJsonSchema(),
      },
    ],
    maxTokens: ANALYZE_MAX_TOKENS,
  };

  let response: LLMResponse;
  try {
    response = await deps.provider.chat(request);
  } catch (e) {
    console.error('[import.analyze] сбой LLM-провайдера:', e);
    throw new ExecError(
      'LLM_UNAVAILABLE',
      'AI-провайдер недоступен — повторите или укажите колонки вручную',
      { reason: e instanceof Error ? e.message : String(e) },
    );
  }

  // Метеринг §4.7 — потреблённые токены честны независимо от того, распознан ли
  // маппинг; сбой метрики логируется, но не ломает ответ (решение 8 плана 1b)
  try {
    await recordUsage(db, {
      ownerId: args.ownerId,
      model: deps.model,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        requestCount: 1,
      },
      ...(deps.clock !== undefined && { clock: deps.clock }),
    });
  } catch (e) {
    console.error('[import.analyze] метеринг ai_usage не записан:', e);
  }

  const call = response.toolCalls[0];
  if (call === undefined) {
    throw new ExecError(
      'LLM_UNAVAILABLE',
      'AI не вернул структуру файла — укажите колонки вручную или повторите',
      { reason: 'no_tool_call', stopReason: response.stopReason },
    );
  }
  const parsed = importAnalyzeResultSchema.safeParse(call.input);
  if (!parsed.success) {
    throw new ExecError(
      'LLM_UNAVAILABLE',
      'AI вернул несогласованный маппинг колонок — укажите колонки вручную или повторите',
      { reason: 'invalid_mapping', issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// review (§3.4 шаг 3, §3.4.1): статусы строк
// ---------------------------------------------------------------------------

/** Кандидат дедупа — существующая финансовая сущность окна дат. */
interface Candidate {
  id: string;
  amount: string;
  direction: string;
  occurredOn: string;
  title: string;
  counterparty?: string;
}

/** Ключ бакета кандидатов: направление + дата (сверка идёт по дню ±1, §3.4.1 п.2). */
function bucketKey(direction: string, occurredOn: string): string {
  return `${direction} ${occurredOn}`;
}

/** external_id этого namespace, уже зарегистрированные в entity_origins (§4.8). */
async function knownExternalIds(
  tx: Tx,
  namespace: string,
  externalIds: string[],
): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await tx
    .select({ externalId: entityOrigins.externalId })
    .from(entityOrigins)
    .where(
      and(
        eq(entityOrigins.namespace, namespace),
        inArray(entityOrigins.externalId, [...new Set(externalIds)]),
      ),
    );
  return new Set(rows.map((r) => r.externalId));
}

/**
 * Окно кандидатов ОДНИМ запросом (не N): неархивные сущности с orbis/financial, чей
 * occurred_on попадает в [min(дат строк) − 1; max(дат строк) + 1]. Шаблоны recurring
 * исключены (§2.8: у них нет операции, они скрыты из агрегатов — тот же фильтр, что в
 * rebindForEnvelope). planned-инстансы НЕ исключаются: §3.4.1 сверяет строку «среди
 * всех финансовых сущностей подходящего окна».
 */
async function candidateWindow(
  tx: Tx,
  ownerId: string,
  from: string,
  to: string,
): Promise<Map<string, Candidate[]>> {
  const rows = (await tx.execute(sql`
    SELECT id, title, aspects->'orbis/financial' AS fin
    FROM entities
    WHERE owner_id = ${ownerId} AND NOT archived
      AND aspects ? 'orbis/financial'
      AND aspects->'orbis/schedule'->'recurrence' IS NULL
      AND aspects->'orbis/financial'->>'occurred_on' >= ${from}
      AND aspects->'orbis/financial'->>'occurred_on' <= ${to}
    ORDER BY aspects->'orbis/financial'->>'occurred_on', id
  `)) as unknown as Array<{ id: string; title: string; fin: Record<string, unknown> }>;

  const buckets = new Map<string, Candidate[]>();
  for (const row of rows) {
    const { amount, direction, occurred_on: occurredOn, counterparty } = row.fin;
    if (
      typeof amount !== 'string' ||
      typeof direction !== 'string' ||
      typeof occurredOn !== 'string'
    ) {
      continue; // структурно неполная строка в критерий §3.4.1 не входит
    }
    const candidate: Candidate = {
      id: row.id,
      amount,
      direction,
      occurredOn,
      title: row.title,
      ...(typeof counterparty === 'string' && { counterparty }),
    };
    const key = bucketKey(direction, occurredOn);
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [candidate]);
    else list.push(candidate);
  }
  return buckets;
}

/** Категории владельца для резолва по алиасам — тот же словарь, что у fast-path (§7.5). */
async function categoryDictionary(tx: Tx, ownerId: string): Promise<FastPathCategory[]> {
  const rows = (await tx.execute(sql`
    SELECT id, aspects->'orbis/category'->'aliases' AS aliases
    FROM entities
    WHERE owner_id = ${ownerId} AND NOT archived AND aspects ? 'orbis/category'
    ORDER BY id
  `)) as unknown as Array<{ id: string; aliases: unknown }>;
  return rows.map((r) => ({
    id: r.id,
    aliases: Array.isArray(r.aliases)
      ? r.aliases.filter((a): a is string => typeof a === 'string')
      : [],
  }));
}

/**
 * Категоризация строки — ТОЛЬКО детерминированный резолв по алиасам категорий (тем же
 * findCategory, что fast-path): counterparty нормализуется байт-точно по §3.4.1
 * (регистр, ё, пунктуация, служебные префиксы) и его токены ищутся среди алиасов.
 * Неуверенно — предложения нет, клиент покажет [❓ выбрать]. LLM для категоризации не
 * зовём (плановое ограничение: детерминированно и бесплатно).
 *
 * Memory-правила `scope=orbis/financial` из эскиза брифа ОТЛОЖЕНЫ в фазу D (Task D4):
 * сегодня у memory-правила нет машиночитаемой части — единственный потребитель
 * (llm/context.ts loadMemory) рендерит title/body текстом в промпт. Формат правила
 * определяет D4; изобретать здесь конкурирующий — гарантированный разъезд.
 */
function suggestCategoryRef(
  counterparty: string,
  categories: FastPathCategory[],
): string | undefined {
  const normalized = normalizeCounterparty(counterparty);
  if (normalized === '') return undefined;
  return findCategory(normalized.split(' '), categories)?.id;
}

/**
 * Статусы строк файла (§3.4.1), порядок проверки: (1) external_id уже в entity_origins
 * этого namespace → already_imported; (2) содержательный критерий против окна дат →
 * probable_duplicate + duplicateOf; (3) иначе new.
 *
 * Внутрифайловые дубли (две похожие строки одной выписки) в MVP не ищутся: у каждой
 * строки свой external_id, а содержательный критерий сверяется только с существующими
 * сущностями.
 */
export async function reviewImport(
  db: Db,
  ownerId: string,
  input: ImportReviewInput,
): Promise<ImportReviewResult> {
  gateImportCsv(ownerId);
  assertRowLimit(input.rows.length);

  const externalIds = await Promise.all(
    input.rows.map((row) => externalRowId(input.fileHash, row)),
  );
  // Строки 'YYYY-MM-DD': лексикографический порядок = хронологический
  const dates = input.rows.map((row) => row.occurredOn).sort();
  const from = addDays(dates[0] as string, -1);
  const to = addDays(dates[dates.length - 1] as string, 1);

  return withIdentity(db, ownerId, async (tx) => {
    const known = await knownExternalIds(tx, input.namespace, externalIds);
    const buckets = await candidateWindow(tx, ownerId, from, to);
    const categories = await categoryDictionary(tx, ownerId);

    const rows: ImportReviewRow[] = input.rows.map((row, i) => {
      const externalId = externalIds[i] as string;
      if (known.has(externalId)) {
        return { ...row, externalId, status: 'already_imported' };
      }
      const duplicate = findDuplicate(row, buckets);
      const suggested = suggestCategoryRef(row.counterparty, categories);
      return {
        ...row,
        externalId,
        status: duplicate === undefined ? 'new' : 'probable_duplicate',
        ...(duplicate !== undefined && { duplicateOf: duplicate }),
        ...(suggested !== undefined && { suggestedCategoryRef: suggested }),
      };
    });
    return { rows };
  });
}

/**
 * Первый кандидат, удовлетворяющий критерию §3.4.1 (сумма+направление точно, дата ±1
 * день, similarity counterparty ≥ порога либо совпавший bank txn id). Сравниваются
 * только три бакета дня (d−1, d, d+1) того же направления — иначе сотни строк на
 * сотни кандидатов давали бы квадрат. Порядок обхода детерминирован: день по
 * возрастанию, внутри дня — порядок SQL (occurred_on, id).
 */
function findDuplicate(row: CanonicalRow, buckets: Map<string, Candidate[]>): string | undefined {
  for (const delta of [-1, 0, 1]) {
    const day = addDays(row.occurredOn, delta);
    for (const candidate of buckets.get(bucketKey(row.direction, day)) ?? []) {
      if (isProbableDuplicate(row, candidate)) return candidate.id;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// confirm (§3.4 шаг 4): один batch_execute
// ---------------------------------------------------------------------------

/** Результаты batch несут и сущности, и строки origins — различаем по форме. */
function isWireEntity(result: unknown): result is WireEntity {
  return (
    typeof result === 'object' && result !== null && 'aspects' in result && 'archived' in result
  );
}

/**
 * Созданные транзакции, оставшиеся без budget-parent, по категориям — итог-карточка
 * §3.4 шаг 5 («Без конверта: 3 — Образование, Прочее»). ОДИН запрос ПОСЛЕ execute и
 * вне его транзакции: привязку дописывает бюджет-хук, и её результат виден только
 * после коммита.
 */
async function unbudgetedOf(
  db: Db,
  ownerId: string,
  entityIds: string[],
): Promise<ImportConfirmResult['unbudgeted']> {
  if (entityIds.length === 0) return [];
  const ids = sql.join(
    entityIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await withIdentity(db, ownerId, async (tx) => {
    return (await tx.execute(sql`
      SELECT e.aspects->'orbis/financial'->>'category_ref' AS category_ref,
             count(*)::int AS count
      FROM entities e
      WHERE e.id IN (${ids})
        AND e.aspects->'orbis/financial'->>'category_ref' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM relations r
          JOIN entities p ON p.id = r.source_id
          WHERE r.target_id = e.id AND r.relation_type = 'parent'
            AND p.aspects ? 'orbis/budget' AND NOT p.archived
        )
      GROUP BY 1
      ORDER BY 1
    `)) as unknown as Array<{ category_ref: string; count: number }>;
  });
  return rows.map((r) => ({ categoryRef: r.category_ref, count: r.count }));
}

/**
 * Подтверждение импорта (§3.4 шаг 4) — ОДИН batch_execute с клиентским batch_id:
 * `create` → entity_create + entity_origin_create, `adopt` → только
 * entity_origin_create на существующую сущность, `skip` → операций нет. Идемпотентно
 * по batch_id (§7.8); ошибка любой строки откатывает всю группу — частичного импорта
 * не бывает. Отдельный replay-пречек не нужен: доменных проверок, которые ломались бы
 * на повторе, здесь нет — идемпотентность целиком держит executor по audit-PK.
 *
 * Валюта созданных транзакций в аспект НЕ кладётся: у CanonicalRow поля currency нет
 * (§3.4.1), а отсутствие currency и селектор конвертов (§2.3), и агрегаты (§2.2)
 * трактуют как дефолтную валюту владельца. Записать defaultCurrency явно значило бы
 * утверждать про валюту выписки то, чего сервер не знает.
 */
export async function confirmImport(
  db: Db,
  ownerId: string,
  input: ImportConfirmInput,
): Promise<ImportConfirmResult> {
  gateImportCsv(ownerId);
  assertRowLimit(input.items.length);

  const operations: ExecuteRequest['operations'] = [];
  let created = 0;
  let adopted = 0;
  let skipped = 0;

  for (const item of input.items) {
    if (item.action === 'skip') {
      skipped += 1;
      continue;
    }
    const externalId = await externalRowId(input.fileHash, item.row);
    const origin = { namespace: input.namespace, external_id: externalId };

    if (item.action === 'adopt') {
      // Сужение типа: обязательность полей уже проверила схема (importConfirmItemSchema)
      if (item.adoptEntityId === undefined) {
        throw new ExecError('VALIDATION', 'усыновление источника требует adoptEntityId', {
          rowIndex: item.row.rowIndex,
        });
      }
      adopted += 1;
      operations.push({
        tool: 'entity_origin_create',
        input: { entity_id: item.adoptEntityId, ...origin },
      });
      continue;
    }

    if (item.categoryRef === undefined) {
      throw new ExecError('VALIDATION', 'создание транзакции требует категорию', {
        rowIndex: item.row.rowIndex,
      });
    }
    created += 1;
    const entityId = newId(); // серверный id: строка origins ссылается на него в том же batch
    const counterparty = item.row.counterparty.trim();
    operations.push(
      {
        tool: 'entity_create',
        input: {
          id: entityId,
          title: counterparty === '' ? `Операция ${item.row.occurredOn}` : counterparty,
          tags: [],
          aspects: {
            'orbis/financial': {
              amount: item.row.amount,
              direction: item.row.direction,
              category_ref: item.categoryRef,
              occurred_on: item.row.occurredOn,
              ...(counterparty !== '' && { counterparty }),
            },
          },
        },
      },
      { tool: 'entity_origin_create', input: { entity_id: entityId, ...origin } },
    );
  }

  if (operations.length === 0) {
    throw new ExecError('VALIDATION', 'нет строк для импорта: все строки помечены «пропустить»', {
      items: input.items.length,
    });
  }

  const request: ExecuteRequest = {
    actorUserId: ownerId,
    actorKind: 'owner', // импорт — путь владельца; LLM/MCP этот флоу не инициируют
    source: 'ui', // подтверждённое действие владельца на экране ревью (§3.4 шаг 4)
    batchId: input.batchId,
    operations,
  };
  const r = await execute(db, request, { sink });
  if (!r.ok) {
    throw new ExecError(r.error.code as ExecErrorCode, r.error.message, r.error.details);
  }

  // Идентификаторы созданных сущностей — из результатов batch (а не из сгенерированных
  // выше id): идемпотентный повтор возвращает СОХРАНЁННЫЕ результаты первого прогона
  const entityIds = r.results.filter(isWireEntity).map((e) => e.id);
  return {
    actionId: r.actionId,
    idempotentReplay: r.idempotentReplay,
    created,
    adopted,
    skipped,
    entityIds,
    unbudgeted: await unbudgetedOf(db, ownerId, entityIds),
  };
}
