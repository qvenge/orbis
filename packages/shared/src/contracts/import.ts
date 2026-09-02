// packages/shared/src/contracts/import.ts
// Wire-контракты CSV-импорта (Task C2, 03-budget §3.4/§3.4.1) — общий словарь трёх
// процедур tRPC-роутера import (analyze/review/confirm) и web-клиента (Task C4).
// Суммы — только decimal-строки (01-arch §3.3); файл целиком на сервер НЕ уходит:
// клиент парсит его локально, присылает канонические строки и sha256 содержимого.
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { toParts } from '../date';
import type { CanonicalRow } from '../import/normalize';

/**
 * Потолок строк одного импорта — общий для review и confirm. Ограничение НЕ в лимите
 * параметров PostgreSQL (батч-селектор конвертов C2a упёрся бы в него лишь тысячами
 * строк), а в числе ПОСЛЕДОВАТЕЛЬНЫХ round-trip'ов внутри ОДНОЙ транзакции: confirm —
 * 2N операций исполнителя, и до N привязок дописывает бюджет-хук A4, итого до 3N.
 *
 * ЗАМЕР (фикс-раунд ревью фазы C, локальная БД, худший случай «у категории есть
 * конверт» — 3N операций; линейно по N):
 *   N=100 → 1.35 c (300 оп.) · N=300 → 3.5 c (900 оп.) · N=500 → 5.8 c (1500 оп.)
 *   N=1000 → 12.0 c (3000 оп., тело запроса 344 КБ, metadata журнала 428 КБ)
 * Без конверта вдвое дешевле (N=1000 → 4.2 c), но «конверт есть» — обычный случай.
 * Прод дороже локали: БД за сетью (Render frankfurt → Supabase pooler), инстанс free,
 * пул max=3 — 12-секундная транзакция держала бы треть пула и вышла бы за терпение
 * пользователя и таймауты прокси.
 *
 * ПОЭТОМУ 300, а не 1000: те же ~3.5 c локально дают четырёхкратный запас по времени
 * и по объёму журнала, покрывая при этом реальную месячную выписку (10 операций в
 * день). Выписка крупнее делится на части — отказ явный, с числом строк (VALIDATION
 * с details.limit), а не молчаливое подвисание.
 */
export const MAX_IMPORT_ROWS = 300;

/** Образцов строк на распознавание структуры (§3.4 шаг 1: в LLM уходит только выборка). */
export const MAX_ANALYZE_SAMPLE_ROWS = 10;

/** Потолок длины одного образца — защита промпта; лишнее сервер обрезает. */
export const MAX_ANALYZE_ROW_CHARS = 1000;

/**
 * Дата строки выписки: формат И календарная существуемость. Одного регекспа мало —
 * `2026-02-31` его проходит, а `toParts` (C1, календарная арифметика дедупа) на нём
 * бросает RangeError, и он прилетел бы посреди import.review сырым 500 (Minor №3
 * ревью C1). Проверка здесь делает такой вход невозможным по построению.
 */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date YYYY-MM-DD')
  .refine(
    (value) => {
      try {
        toParts(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'несуществующая календарная дата' },
  );
/**
 * Строго положительная decimal-строка: > 0, без экспоненты и минуса.
 *
 * ЕДИНСТВЕННЫЙ негативный lookahead, доезжающий до JSON Schema тула, и на нём держится
 * довод `strict: false` транспорта OpenAI (D29, `llm/openai.ts`): строгий режим Responses
 * API lookaround не принимает. У свойств РЕЕСТРА его больше нет — там «> 0» выражено
 * границей типа (`exclusiveMin` → `exclusiveMinimum`).
 */
const positiveDecimal = z
  .string()
  .regex(/^(?!0+(\.0+)?$)\d+(\.\d+)?$/, 'строго положительная decimal-строка');

/**
 * Каноническая строка выписки — граница доверия сервера. Схема ОБЯЗАНА соответствовать
 * типу `CanonicalRow` (Task C1, import/normalize.ts), а не заводить второй тип:
 * соответствие обеспечено `satisfies` ниже и тем, что сервер передаёт разобранные
 * строки прямо в `isProbableDuplicate`/`externalRowId`.
 *
 * Валидация здесь закрывает Minor №3 ревью C1: `toParts` бросает RangeError на
 * не-`YYYY-MM-DD`, и без этой границы `isProbableDuplicate` мог бы упасть посреди
 * review на timestamp-образной дате от клиента.
 */
export const canonicalRowSchema = z
  .object({
    occurredOn: dateString,
    amount: positiveDecimal, // знак операции несёт direction (§3.3), не сумма
    direction: z.enum(['income', 'expense']),
    counterparty: z.string(), // может быть пустой — банк не всегда даёт описание
    // .max(128) — та же граница, что у аспекта orbis/financial.bank_txn_id: без неё
    // длинный ID проходил бы review и падал бы на confirm неспецифичной ошибкой схемы
    // аспекта, без указания строки (Minor B2 финального ревью)
    bankTxnId: z.string().max(128).optional(),
    raw: z.string(), // исходная строка файла — показывается в ревью
    rowIndex: z.number().int().nonnegative(), // zero-based, входит в external_id
  })
  .strict() satisfies z.ZodType<CanonicalRow>;

/** sha256 содержимого файла в нижнем hex — считает клиент (C1: вход externalRowId). */
export const fileHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256-хэш файла (hex)');

/**
 * `namespace = "csv:<источник>"` (§3.4.1): нормализованное имя источника задаёт клиент.
 * Требования — префикс `csv:`, непустой хвост без управляющих символов и пробельных
 * краёв, суммарная длина ≤ 80 (namespace входит в уникальный индекс entity_origins).
 */
export const importNamespaceSchema = z
  .string()
  .regex(/^csv:[^\p{C}\s](?:[^\p{C}]{0,74}[^\p{C}\s])?$/u, 'namespace вида «csv:<источник>»');

// --- analyze (§3.4 шаг 2): распознавание структуры одним LLM-вызовом --------

const columnIndex = z.number().int().nonnegative();

/**
 * Форма маппинга колонок. `direction` описывает, КАК в файле закодирован знак:
 * `sign` — одна колонка суммы со знаком, `separate_columns` — раздельные дебет/кредит.
 * Согласованность проверяет схема, а не доверие к модели.
 *
 * `encoding` эскиза брифа намеренно отсутствует: клиент обязан декодировать байты в
 * текст ДО того, как сможет прислать образцы строк, — мнение сервера о кодировке
 * приходило бы заведомо поздно.
 */
const csvMappingObject = z
  .object({
    date: columnIndex,
    counterparty: columnIndex,
    direction: z.enum(['sign', 'separate_columns']),
    amount: columnIndex.optional(), // при direction='sign'
    debit: columnIndex.optional(), // при direction='separate_columns'
    credit: columnIndex.optional(),
    // Только форматы, которые умеет разбирать клиент (C4): незнакомая строка была бы
    // для него бесполезна, а честный отказ уводит пользователя на ручной маппинг
    dateFormat: z.enum(['DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY']),
    bankTxnId: columnIndex.optional(),
  })
  .strict();

/** Согласованность маппинга — общая проверка строгого (wire) и мягкого (LLM) вариантов. */
function checkMappingConsistency(
  mapping: z.infer<typeof csvMappingObject>,
  ctx: z.RefinementCtx,
): void {
  if (mapping.direction === 'sign' && mapping.amount === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amount'],
      message: 'direction=sign требует колонку amount',
    });
  }
  if (
    mapping.direction === 'separate_columns' &&
    (mapping.debit === undefined || mapping.credit === undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['debit'],
      message: 'direction=separate_columns требует колонки debit и credit',
    });
  }
}

export const csvMappingSchema = csvMappingObject.superRefine(checkMappingConsistency);

export const importAnalyzeInput = z
  .object({
    sampleRows: z.array(z.string()).min(1).max(MAX_ANALYZE_SAMPLE_ROWS),
  })
  .strict();

/** Ответ analyze — wire-контракт процедуры: строгий, лишних ключей на проводе нет. */
export const importAnalyzeResultSchema = z
  .object({ mapping: csvMappingSchema, confidence: z.number().min(0).max(1) })
  .strict();

/**
 * Тот же контракт на границе разбора ОТВЕТА МОДЕЛИ — с отбрасыванием лишних ключей
 * (`.strip()`), а не отказом. Модель не обязана быть побайтно дисциплинированной:
 * один лишний ключ (напр. «reasoning») при строгой схеме превращал бы КАЖДЫЙ импорт в
 * 503 и молча деградировал бы флоу в ручной маппинг. Смысловые требования (индексы,
 * формат даты, согласованность sign/separate_columns) остаются в силе — отбрасывается
 * только неизвестное. Wire-контракт процедуры при этом остаётся строгим.
 */
export const llmMappingResponseSchema = z
  .object({
    mapping: csvMappingObject.strip().superRefine(checkMappingConsistency),
    confidence: z.number().min(0).max(1),
  })
  .strip();

/**
 * JSON Schema того же контракта — определение единственного тула LLM-вызова analyze.
 * Генерируется из zod (единый источник): рукописная копия разъезжалась бы с валидацией
 * ответа модели.
 */
export function csvMappingToolJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(
    z.object({ mapping: csvMappingObject, confidence: z.number().min(0).max(1) }).strict(),
    { $refStrategy: 'none' },
  ) as Record<string, unknown>;
}

// --- review (§3.4 шаг 3): статусы строк -------------------------------------

export const importReviewInput = z
  .object({
    // .max — граница СХЕМЫ: отказ приходит с кодом too_big от самого контракта, а не
    // из домена. Внимание: zod всё равно валидирует каждый элемент (ZodArray помечает
    // too_big и продолжает разбор) — от неограниченной работы защищает не эта строка,
    // а лимит тела запроса на /trpc (apps/server/src/app.ts). Доменная проверка тоже
    // остаётся: её отказ несёт внятный details.limit (§3 брифа).
    rows: z.array(canonicalRowSchema).min(1).max(MAX_IMPORT_ROWS),
    fileHash: fileHashSchema,
    namespace: importNamespaceSchema,
  })
  .strict();

/**
 * Статус строки (§3.4): `already_imported` — её external_id уже в entity_origins этого
 * namespace (⟳, переключение недоступно); `probable_duplicate` — совпадение по критерию
 * §3.4.1 с существующей финансовой сущностью (⊘, по умолчанию не создаётся);
 * `new` — создаётся (✓).
 */
export const importRowStatusSchema = z.enum(['new', 'already_imported', 'probable_duplicate']);

export const importReviewRowSchema = canonicalRowSchema.extend({
  externalId: z.string(), // sha256 hex (C1 externalRowId) — считает сервер, не клиент
  status: importRowStatusSchema,
  duplicateOf: z.string().uuid().optional(), // сущность-кандидат для ⊘ (усыновление §3.4)
  suggestedCategoryRef: z.string().uuid().optional(), // резолв по алиасам; нет — [❓ выбрать]
});

export const importReviewResultSchema = z.object({ rows: z.array(importReviewRowSchema) }).strict();

// --- confirm (§3.4 шаг 4): один batch_execute -------------------------------

/**
 * Решение по строке: `create` — создать транзакцию и записать её источник;
 * `adopt` — только записать источник на существующую сущность (⊘ по умолчанию);
 * `skip` — не импортировать (клиент может такие строки и не присылать).
 */
export const importConfirmItemSchema = z
  .object({
    row: canonicalRowSchema,
    action: z.enum(['create', 'adopt', 'skip']),
    categoryRef: z.string().uuid().optional(), // обязателен для create (orbis/financial §3.3)
    adoptEntityId: z.string().uuid().optional(), // обязателен для adopt
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.action === 'create' && item.categoryRef === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['categoryRef'],
        message: 'создание транзакции требует категорию (§3.3 category_ref обязателен)',
      });
    }
    if (item.action === 'adopt' && item.adoptEntityId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adoptEntityId'],
        message: 'усыновление источника требует adoptEntityId',
      });
    }
  });

export const importConfirmInput = z
  .object({
    batchId: z.string().uuid(), // клиентский UUIDv7: идемпотентность и Undo группы (§7.8)
    namespace: importNamespaceSchema,
    fileHash: fileHashSchema,
    // .max — та же граница схемы, что у importReviewInput.rows (см. комментарий там)
    items: z.array(importConfirmItemSchema).min(1).max(MAX_IMPORT_ROWS),
    /**
     * Валюта ВЫПИСКИ (уборочная фаза, решение 6): свойство файла, а не строки — у
     * CanonicalRow поля валюты нет и не заводится. Клиент показывает селектор на шаге
     * маппинга с дефолтом «валюта владельца»; выбранное значение пишется в аспект каждой
     * созданной транзакции ЯВНО. До этого выписка в чужой валюте молча ложилась в валюту
     * по умолчанию: отсутствие ключа и селектор конвертов (§2.3), и агрегаты (§2.2)
     * трактуют именно так, а исправить это можно было только вручную по каждой строке.
     *
     * optional — ради одного релиза: старый бандл у открытых вкладок (Render кэширует
     * прежний index-*.js) не должен получать 400 на confirm. Смешанная выписка вне
     * скоупа — это multi-currency (00-product §10, Future).
     */
    currency: z.string().length(3).optional(),
    /**
     * Сколько строк выписки дошло до ревью (00-product §8, фикс-раунд уборочной фазы).
     *
     * Зачем отдельным полем: в `items` попадают только строки, которые СОЗДАЮТСЯ или
     * привязываются — клиент структурно не присылает ни одной с `action:'skip'` (строки
     * ⟳ «уже импортирована» отсеиваются в ReviewTable). Значит по payload'у число строк
     * выписки не восстановить, и сводка импорта считала «пропущено 0» всегда, а метрика
     * покрытия делила на число ОТПРАВЛЕННЫХ строк. Нет значения (старый бандл) — сводка
     * честно падает обратно на число отправленных строк.
     */
    rowsTotal: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * Итог импорта (§3.4 шаг 5): «Импортировано N, пропущено M… Без конверта: 3 —
 * Образование, Прочее». `unbudgeted` — созданные транзакции, оставшиеся без
 * budget-parent, по категориям (титулы резолвит клиент).
 */
export const importConfirmResultSchema = z
  .object({
    actionId: z.string().uuid(), // = batchId: Undo откатывает весь импорт одной группой
    idempotentReplay: z.boolean(),
    created: z.number().int().nonnegative(),
    adopted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    entityIds: z.array(z.string().uuid()), // созданные сущности (adopt их не порождает)
    unbudgeted: z.array(
      z.object({ categoryRef: z.string().uuid(), count: z.number().int().nonnegative() }),
    ),
  })
  .strict();

export type CsvMapping = z.infer<typeof csvMappingSchema>;
export type ImportAnalyzeInput = z.infer<typeof importAnalyzeInput>;
export type ImportAnalyzeResult = z.infer<typeof importAnalyzeResultSchema>;
export type ImportRowStatus = z.infer<typeof importRowStatusSchema>;
export type ImportReviewInput = z.infer<typeof importReviewInput>;
export type ImportReviewRow = z.infer<typeof importReviewRowSchema>;
export type ImportReviewResult = z.infer<typeof importReviewResultSchema>;
export type ImportConfirmItem = z.infer<typeof importConfirmItemSchema>;
export type ImportConfirmInput = z.infer<typeof importConfirmInput>;
export type ImportConfirmResult = z.infer<typeof importConfirmResultSchema>;
