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
  addDays,
  applyMemoryRules,
  batchAuditMessageId,
  type CanonicalRow,
  csvMappingToolJsonSchema,
  type FastPathCategory,
  type FastPathRule,
  findCategory,
  type ImportAnalyzeResult,
  type ImportConfirmInput,
  type ImportConfirmResult,
  type ImportReviewInput,
  type ImportReviewResult,
  type ImportReviewRow,
  importSummaryMessageId,
  isProbableDuplicate,
  llmMappingResponseSchema,
  MAX_ANALYZE_ROW_CHARS,
  MAX_IMPORT_ROWS,
  newId,
  normalizeCounterparty,
  resolveCategoryInOrder,
  ROLE_ENVELOPE_BINDING,
  ROLE_REF,
  externalRowId,
} from '@orbis/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { recordUsage } from '../ai/metering';
import { type AiDeps, gateAiEntitlements } from '../ai/send-message';
import { appendMessageIdempotent } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import type { Db } from '../db/client';
import { entityOrigins } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { type EntitlementResolver, IMPORT_CSV_KEY, resolveEntitlement } from '../entitlements';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import type { LLMRequest, LLMResponse } from '../llm/types';
import { CONTRACT_MONEY_MOVEMENT, RULE_PATTERN, RULE_TARGET } from '../memory/rules';
import { memoryRulesWhere } from '../memory/select';
import type { Card } from '../tools/registry';

// Синк один на модуль (как rollover/post-due): состояния не хранит, audit-сообщение
// batch пишется тем же tx, что и операции исполнителя (§7.8).
const sink = makeChatJournalSink();

/**
 * Свойство категории (§А8/В1) — оно же подпись зеркала-ребра в `meta.property`. Литералом
 * его тут писать нельзя дважды: один и тот же id называет и ЗНАЧЕНИЕ на сущности, и
 * ПОДПИСЬ на ребре, и разъехавшись, они дали бы «без конверта» пустым при целых данных.
 */
const PROP_FINANCE_CATEGORY = 'orbis/finance_category';

/**
 * Зависимости review/confirm (у analyze резолвер входит в AiDeps): резолвер §8 —
 * инжектируемый шов тестов по образцу McpDeps.entitlements (mcp/server.ts).
 */
export interface ImportDeps {
  /** Резолвер §8; по умолчанию — боевой resolveEntitlement (план dev безлимитен). */
  entitlements?: EntitlementResolver;
}

/**
 * Гейт §8 для всех трёх процедур импорта (образец — gateAiEntitlements): на плане
 * 'dev' разрешено, отказ резолвера → LIMIT (429 маппингом errors.ts). Резолвер —
 * параметром (шов mcp/server.ts): вызывающий подставляет deps.entitlements ?? боевой.
 */
export function gateImportCsv(ownerId: string, resolve: EntitlementResolver): void {
  const decision = resolve(ownerId, IMPORT_CSV_KEY);
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
 * Обрезание образца по КОДОВЫМ ТОЧКАМ, не по UTF-16-юнитам: `slice(0, max)` мог
 * разрезать суррогатную пару (эмодзи или редкий CJK в назначении платежа) ровно на
 * границе и оставить в LLM-промпте одинокий суррогат. Обход — O(max), не O(строки):
 * итератор строки идёт по кодовым точкам и останавливается на лимите.
 */
function truncateRowCodePoints(row: string, maxCodePoints: number): string {
  if (row.length <= maxCodePoints) return row; // юнитов ≤ лимита ⇒ и кодовых точек ≤
  let end = 0;
  let count = 0;
  for (const ch of row) {
    if (count === maxCodePoints) break;
    end += ch.length;
    count += 1;
  }
  return row.slice(0, end);
}

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
  const resolve = deps.entitlements ?? resolveEntitlement;
  gateImportCsv(args.ownerId, resolve);
  // Гейт AI-бюджета §8 — ТОТ ЖЕ, что у ai.sendMessage: analyze зовёт провайдера и
  // списывает в общий дневной счётчик ai_usage (recordUsage ниже), поэтому ключи
  // ai.requests_per_day / ai.tokens_per_day обязаны его ограничивать. Оба гейта —
  // ДО обращения к провайдеру; резолвер — из того же инъецируемого шва.
  await gateAiEntitlements(db, args.ownerId, resolve, deps.clock ?? (() => new Date()));

  const samples = args.sampleRows.map((row) => truncateRowCodePoints(row, MAX_ANALYZE_ROW_CHARS));
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
  // Разбор ответа МОДЕЛИ — мягким вариантом схемы (B1): лишний ключ модели отбрасывается,
  // а не роняет импорт в 503; смысловые требования те же. Wire-контракт процедуры
  // (importAnalyzeResultSchema) остаётся строгим — валидируется на границе tRPC.
  const parsed = llmMappingResponseSchema.safeParse(call.input);
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
  bankTxnId?: string;
}

/** Ключ бакета кандидатов: направление + дата (сверка идёт по дню ±1, §3.4.1 п.2). */
function bucketKey(direction: string, occurredOn: string): string {
  return `${direction}\u0000${occurredOn}`;
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
    SELECT id, title, props
    FROM entities
    WHERE owner_id = ${ownerId} AND NOT archived
      AND 'orbis/financial' = ANY(aspects)
      AND NOT ('orbis/schedule' = ANY(aspects) AND props->'orbis/recurrence' IS NOT NULL)
      AND props->>'orbis/occurred_on' >= ${from}
      AND props->>'orbis/occurred_on' <= ${to}
    ORDER BY props->>'orbis/occurred_on', id
  `)) as unknown as Array<{ id: string; title: string; props: Record<string, unknown> }>;

  const buckets = new Map<string, Candidate[]>();
  for (const row of rows) {
    // Признак носителя не нужен: `'orbis/financial' = ANY(aspects)` в WHERE уже отобрал
    // строки, где аспект приложен, — второй проверкой была бы тавтология.
    const {
      'orbis/amount': amount,
      'orbis/direction': direction,
      'orbis/occurred_on': occurredOn,
      'orbis/counterparty': counterparty,
      'orbis/bank_txn_id': bankTxnId,
    } = row.props;
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
      // orbis/bank_txn_id → bankTxnId кандидата: даёт данные ветке «совпавший
      // bank txn id» isProbableDuplicate (§3.4.1 п.3 — независимо от текста)
      ...(typeof bankTxnId === 'string' && { bankTxnId }),
    };
    const key = bucketKey(direction, occurredOn);
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [candidate]);
    else list.push(candidate);
  }
  return buckets;
}

/**
 * Категории владельца для резолва по алиасам — тот же словарь, что у fast-path (§7.5).
 * title выбирается ради memory-правил: правило называет категорию НАЗВАНИЕМ (D3a).
 */
async function categoryDictionary(tx: Tx, ownerId: string): Promise<FastPathCategory[]> {
  const rows = (await tx.execute(sql`
    SELECT id, title, props->'orbis/aliases' AS aliases
    FROM entities
    WHERE owner_id = ${ownerId} AND NOT archived AND 'orbis/category' = ANY(aspects)
    ORDER BY id
  `)) as unknown as Array<{ id: string; title: string; aliases: unknown }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    aliases: Array.isArray(r.aliases)
      ? r.aliases.filter((a): a is string => typeof a === 'string')
      : [],
  }));
}

/**
 * Активные correction-правила владельца — ЧЕРЕЗ ЕДИНЫЙ СЕЛЕКТОР (`memory/select.ts`).
 * Своей копии предиката здесь больше нет: копий было четыре, и одна из них (слой памяти
 * промпта) читала другую колонку.
 *
 * Машиночитаемая часть правила приезжает СВОЙСТВАМИ (В7): образец и id категории, а не
 * заголовок с разделителем. Заголовок здесь не читается вовсе — он стал генерируемой
 * подписью.
 *
 * Порядок стабилен (`ORDER BY id`), но на результат не влияет: приоритет правил задаёт
 * applyMemoryRules — в том числе по updated_at, поэтому время правки едет вместе с
 * правилом (иначе конфликт двух правил на один образец импорт разрешал бы иначе, чем
 * быстрый ввод). Строки без образца или без цели отбрасываются здесь, а не в shared:
 * записать такое правило больше нельзя (`memory/rules.ts` — fail-closed), но данные,
 * записанные прямым SQL, до резолва доходить не должны.
 */
async function memoryRules(tx: Tx, ownerId: string): Promise<FastPathRule[]> {
  const rows = (await tx.execute(sql`
    SELECT props ->> ${RULE_PATTERN} AS pattern,
           props ->> ${RULE_TARGET}  AS target_id,
           updated_at
    FROM entities
    WHERE owner_id = ${ownerId} AND ${memoryRulesWhere(CONTRACT_MONEY_MOVEMENT)}
    ORDER BY id
  `)) as unknown as Array<{ pattern: unknown; target_id: unknown; updated_at: unknown }>;
  const rules: FastPathRule[] = [];
  for (const r of rows) {
    if (typeof r.pattern !== 'string' || typeof r.target_id !== 'string') continue;
    rules.push({ pattern: r.pattern, targetId: r.target_id, updatedAt: toIsoTime(r.updated_at) });
  }
  return rules;
}

/**
 * timestamptz сырой выдачи → ISO (как toWireEntity: наружу время всегда ISO). Драйвер на
 * raw-SQL отдаёт строку PG, поэтому приводим тем же способом, что wire.ts. Нераспознанное
 * время — пустая строка: правило от этого становится «самым старым», но не роняет импорт.
 */
function toIsoTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * Категоризация строки — детерминированно, без LLM (плановое ограничение: бесплатно и
 * предсказуемо): сначала correction-правила памяти, затем алиасы категорий. Обе ступени —
 * общий с fast-path код shared (applyMemoryRules/findCategory, K12): counterparty
 * нормализуется байт-точно по §3.4.1 (регистр, ё, пунктуация, служебные префиксы).
 * Неуверенно — предложения нет, клиент покажет [❓ выбрать].
 *
 * Правила ПЕРЕД алиасами — обязательство фазы C (Task C2 отложил его до появления
 * формата правила в D3a): на реальной выписке алиасы не покрывают имён мерчантов
 * («ПЯТЁРОЧКА», «OZON»), и полезной категоризацию импорта делают именно правила.
 * Сам ПОРЯДОК ступеней — общая константа `RESOLVE_ORDER` (shared), а не порядок строк
 * здесь: вторым его вызывающим стоит быстрый ввод, и разъехаться им нельзя.
 */
function suggestCategoryRef(
  counterparty: string,
  categories: FastPathCategory[],
  rules: FastPathRule[],
): string | undefined {
  const normalized = normalizeCounterparty(counterparty);
  return (
    resolveCategoryInOrder({
      rules: () => applyMemoryRules(counterparty, rules, categories),
      aliases: () => (normalized === '' ? null : findCategory(normalized.split(' '), categories)),
    })?.id ?? undefined
  );
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
  deps: ImportDeps = {},
): Promise<ImportReviewResult> {
  gateImportCsv(ownerId, deps.entitlements ?? resolveEntitlement);
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
    const rules = await memoryRules(tx, ownerId);

    const rows: ImportReviewRow[] = input.rows.map((row, i) => {
      const externalId = externalIds[i] as string;
      if (known.has(externalId)) {
        return { ...row, externalId, status: 'already_imported' };
      }
      const duplicate = findDuplicate(row, buckets);
      const suggested = suggestCategoryRef(row.counterparty, categories, rules);
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
 *
 * «Конверт-родитель» — то же, что у хука и агрегатов: роль `envelope-binding` с
 * источником-конвертом. Карточка импорта обязана считать «без конверта» так же, как считает
 * его экран бюджета, иначе владелец увидит в итоге импорта одно число, а во вкладке Budget —
 * другое; до 0017 общим у пятерых читателей было расширенное множество ролей
 * (`legacyParentRolesSql`), с 0017 — одна роль.
 *
 * Признак `'orbis/financial' = ANY(e.aspects)` на ЦЕЛИ — не перестраховка: `orbis/budget`
 * делит с `orbis/financial` свойство `orbis/finance_category` (В1 §А8), и без него в
 * «без конверта» попал бы сам конверт, случайно оказавшийся в списке созданных импортом.
 * Старая карта различала это адресом аспекта, `props` — нет. С зеркалом-ребром (§А6-2)
 * признак нужен ровно так же: ребро роли `ref` есть и у конверта.
 *
 * «Кто ссылается на категорию» считается ПО ГРАФУ — ребром роли `ref` с `meta.property`
 * (§А6-2), а не разбором `props->>` (§А8 «backlinks видят правила», находка 9 ревью плана).
 * Разница не косметическая: `->>`-фильтр по jsonb индексом не покрывается, а индекс
 * `(target_id, role)` — тот же, которым идут обратный обход детали и секция «Связанное»,
 * то есть «кто в этой категории» у импорта, у экрана и у обхода теперь ОДИН механизм.
 * Зеркало ставит исполнитель в той же транзакции, что и значение, поэтому строки, созданные
 * этим же `confirm`, к моменту запроса уже с рёбрами.
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
      SELECT ref.target_id AS category_ref,
             count(*)::int AS count
      FROM entities e
      JOIN relations ref ON ref.source_id = e.id AND ref.role = ${ROLE_REF}
                        AND ref.meta->>'property' = ${PROP_FINANCE_CATEGORY}
      WHERE e.id IN (${ids})
        AND 'orbis/financial' = ANY(e.aspects)
        AND NOT EXISTS (
          SELECT 1 FROM relations r
          JOIN entities p ON p.id = r.source_id
          WHERE r.target_id = e.id AND r.role = ${ROLE_ENVELOPE_BINDING}
            AND 'orbis/budget' = ANY(p.aspects) AND NOT p.archived
        )
      GROUP BY 1
      ORDER BY 1
    `)) as unknown as Array<{ category_ref: string; count: number }>;
  });
  return rows.map((r) => ({ categoryRef: r.category_ref, count: r.count }));
}

/**
 * Пречек целей adopt (находка 1 ревью C2): `adoptEntityId` приходит от клиента, а RLS
 * проверяет только владение — без пречека origin можно навесить на заметку, категорию
 * или конверт, и строка выписки навсегда читалась бы `already_imported` против
 * нефинансовой сущности (состояние, которое не чинит ни один путь UI). Требования к
 * цели: видима владельцу, не архивна, несёт orbis/financial.
 *
 * ОДИН запрос на все цели batch (до MAX_IMPORT_ROWS строк), ДО сборки операций —
 * отказ роняет подтверждение целиком, не применив ничего. Коды — по конвенции
 * errors.ts: чужая/несуществующая → NOT_FOUND «сущность не найдена» (неразличимо, как
 * у операций origins в executor), видимая-но-непригодная → VALIDATION (клиентский вход
 * нарушает контракт confirm — как соседние проверки confirmImport).
 *
 * Реплей-детект ДО доменной проверки (образец — confirmPurchase): честный повтор того
 * же batchId (§7.8) обязан вернуться сохранённым replay'ем executor'а, а не упасть на
 * цели, архивированной ПОСЛЕ первого прогона.
 */
async function assertAdoptTargets(
  db: Db,
  ownerId: string,
  input: ImportConfirmInput,
): Promise<void> {
  const targets = new Map<string, number>(); // id цели → rowIndex первого использования
  for (const item of input.items) {
    if (
      item.action === 'adopt' &&
      item.adoptEntityId !== undefined &&
      !targets.has(item.adoptEntityId)
    ) {
      targets.set(item.adoptEntityId, item.row.rowIndex);
    }
  }
  if (targets.size === 0) return;

  await withIdentity(db, ownerId, async (tx) => {
    const replay = await sink.findByAuditId(tx, batchAuditMessageId(ownerId, input.batchId));
    if (replay !== undefined) return; // повтор batchId: executor вернёт результат первого прогона

    const ids = sql.join(
      [...targets.keys()].map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = (await tx.execute(sql`
      SELECT id, archived, ('orbis/financial' = ANY(aspects)) AS financial
      FROM entities
      WHERE owner_id = ${ownerId} AND id IN (${ids})
    `)) as unknown as Array<{ id: string; archived: boolean; financial: boolean }>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const [id, rowIndex] of targets) {
      const row = byId.get(id);
      if (row === undefined) {
        // Чужая и несуществующая намеренно неразличимы — как у origin-операций executor'а
        throw new ExecError('NOT_FOUND', 'сущность не найдена', { adoptEntityId: id, rowIndex });
      }
      if (row.archived || !row.financial) {
        throw new ExecError(
          'VALIDATION',
          'усыновить источник можно только на неархивную финансовую сущность',
          { adoptEntityId: id, rowIndex, reason: row.archived ? 'archived' : 'not_financial' },
        );
      }
    }
  });
}

/**
 * Подтверждение импорта (§3.4 шаг 4) — ОДИН batch_execute с клиентским batch_id:
 * `create` → entity_create + entity_origin_create, `adopt` → только
 * entity_origin_create на существующую сущность, `skip` → операций нет. Идемпотентно
 * по batch_id (§7.8); ошибка любой строки откатывает всю группу — частичного импорта
 * не бывает. Единственный доменный пречек — цели adopt (assertAdoptTargets); он идёт
 * после replay-детекта, поэтому повтор batchId остаётся чистым replay'ем executor'а
 * по audit-PK.
 *
 * ГРАНИЦА ДОВЕРИЯ `adopt` (названа явно, требование ревью C5): решение клиента «это та
 * же операция» сервер НЕ перепроверяет по критерию §3.4.1 — он лишь требует, чтобы цель
 * была видимой владельцу неархивной финансовой сущностью (assertAdoptTargets). Это
 * сознательно: §3.4 разрешает пользователю переопределить вердикт дедупа («создать всё
 * равно» и обратное), путь owner-only (ownerOnlyProcedure, LLM/MCP сюда не ходят), а
 * вредные формы (заметка, категория, чужая сущность, архив) пречек блокирует. Худшее,
 * что может сделать владелец, — привязать источник строки к своей же другой операции.
 *
 * ВАЛЮТА (уборочная фаза, решение 6): свойство ВЫПИСКИ, а не строки — у CanonicalRow
 * поля currency нет и не заводится. `input.currency` приходит из селектора «Валюта
 * выписки» на шаге маппинга (дефолт — валюта владельца) и пишется в аспект каждой
 * созданной транзакции явно. Без него ключ не пишется вовсе: отсутствие currency и
 * селектор конвертов (§2.3), и агрегаты (§2.2) трактуют как валюту владельца — это
 * поведение старого клиента, которое остаётся верным для выписки в родной валюте.
 * Смешанная выписка вне скоупа (multi-currency — Future, 00-product §10).
 */
/**
 * Сводка импорта в журнал (00-product §8, метрика «покрытие транзакций ≥ 95%»).
 *
 * Зачем отдельная запись: единственные числа, по которым покрытие вообще считается, —
 * это ЧИСЛА ВЫПИСКИ, а в графе после импорта остаются только созданные сущности.
 * `skipped` (строка выписки уже была в Orbis) и `adopted` (совпала с ручной записью)
 * не оставляют следа нигде: по таким строкам сущностей не создаётся. До этой правки
 * метрика была объявлена в PRD, но измерить её было физически нечем.
 *
 * Пишется отдельным системным сообщением, а не в audit действия: журнал append-only
 * (§4.6), и метаданные существующего audit-сообщения править нельзя. PK детерминирован
 * по batchId — идемпотентный повтор confirm не удваивает статистику. Своя ошибка
 * логируется и НЕ пробрасывается: импорт уже закоммичен, и провал статистики не имеет
 * права его ронять (тот же контракт, что у эскалации правил, K7).
 */
async function writeImportSummary(
  db: Db,
  ownerId: string,
  input: ImportConfirmInput,
  counts: { created: number; adopted: number },
): Promise<void> {
  // Строк выписки, а не строк payload'а (фикс-раунд): клиент не присылает строки ⟳
  // «уже импортирована» вовсе, поэтому считать total по items значило бы объявлять
  // покрытие по одним только новым строкам. rowsTotal нет (старый бандл) — падаем
  // обратно на число отправленных строк и не врём больше, чем знаем.
  const sent = counts.created + counts.adopted;
  const total = Math.max(input.rowsTotal ?? sent, sent);
  const skipped = total - sent;
  try {
    await withIdentity(db, ownerId, async (tx) => {
      const threadId = await ensureGlobalThread(tx, ownerId);
      await appendMessageIdempotent(tx, {
        id: importSummaryMessageId(ownerId, input.batchId),
        threadId,
        role: 'system',
        content: `Импорт выписки: строк ${total}, создано ${counts.created}, привязано к существующим ${counts.adopted}, уже было ${skipped}`,
        metadata: {
          cards: [
            {
              kind: 'import_summary',
              namespace: input.namespace,
              total,
              created: counts.created,
              adopted: counts.adopted,
              skipped,
            } satisfies Card,
          ],
        },
      });
    });
  } catch (e) {
    console.error('[import] сводка импорта не записана:', e);
  }
}

export async function confirmImport(
  db: Db,
  ownerId: string,
  input: ImportConfirmInput,
  deps: ImportDeps = {},
): Promise<ImportConfirmResult> {
  gateImportCsv(ownerId, deps.entitlements ?? resolveEntitlement);
  assertRowLimit(input.items.length);
  await assertAdoptTargets(db, ownerId, input);

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
    // Тримим ЗДЕСЬ, а не полагаемся на клиента: пробельный '   ' прошёл бы и guard
    // записи ниже, и min(1) аспекта, осев в графе мусорным ID (Minor B2 ревью). На
    // external_id это не влияет — он считается по строке, как её прислал клиент.
    const bankTxnId = item.row.bankTxnId?.trim();
    operations.push(
      {
        tool: 'entity_create',
        input: {
          id: entityId,
          title: counterparty === '' ? `Операция ${item.row.occurredOn}` : counterparty,
          tags: [],
          // НОВАЯ форма (§А1-1): значения — плоско в `props` по id свойства, аспект —
          // пометкой в списке. Старую карту исполнитель больше не принимает вовсе
          // (Задача 18): её union снят из exec-надмножеств, и вход этим путём получил бы
          // отказ схемы. Импорт был ОДНИМ ИЗ ДВУХ последних её отправителей на сервере.
          props: {
            'orbis/amount': item.row.amount,
            'orbis/direction': item.row.direction,
            [PROP_FINANCE_CATEGORY]: item.categoryRef,
            'orbis/occurred_on': item.row.occurredOn,
            // Валюта выписки — явно (см. шапку confirmImport); нет значения (старый
            // клиент) — ключа нет вовсе, и всё трактуется как валюта владельца.
            ...(input.currency !== undefined && {
              'orbis/currency': input.currency.toUpperCase(),
            }),
            ...(counterparty !== '' && { 'orbis/counterparty': counterparty }),
            // Пусто/отсутствует — ключа нет вовсе (не писать undefined/пустую строку):
            // тип свойства требует непустую строку, а дедуп пустой ID не сравнивает
            ...(bankTxnId !== undefined && bankTxnId !== '' && { 'orbis/bank_txn_id': bankTxnId }),
          },
          aspects: ['orbis/financial'],
        },
      },
      { tool: 'entity_origin_create', input: { entity_id: entityId, ...origin } },
    );
  }

  if (operations.length === 0) {
    // Выписка, которую Orbis знал ЦЕЛИКОМ, — лучший возможный исход для метрики §8, и
    // потерять его нельзя: сводка пишется ДО отказа (created=0, adopted=0, всё «уже было»).
    // Пользовательское поведение прежнее — импортировать по-прежнему нечего.
    await writeImportSummary(db, ownerId, input, { created: 0, adopted: 0 });
    throw new ExecError('VALIDATION', 'нет строк для импорта: все строки помечены «пропустить»', {
      items: input.items.length,
    });
  }

  const request: ExecuteRequest = {
    actorUserId: ownerId,
    actorKind: 'owner', // импорт — путь владельца; LLM/MCP этот флоу не инициируют
    source: 'ui', // подтверждённое действие владельца на экране ревью (§3.4 шаг 4)
    // Механизм — импорт (§А4-4): только ему разрешено писать `orbis/bank_txn_id` (§А2-5)
    mechanism: 'import',
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
  await writeImportSummary(db, ownerId, input, { created, adopted });
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
