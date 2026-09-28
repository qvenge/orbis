// packages/shared/src/contracts/blocks.ts
// Wire-контракт двух пачек страницы (срез 1а, спека §6.3, §4.3, §8.4):
//  - `entity.blocks` — данные блоков страницы ОДНИМ вызовом вместо N `entity.query`: сервер
//    исполняет пачку в одной транзакции под идентичностью владельца и отдаёт по каждому блоку
//    строки, число или ошибку этого блока;
//  - `entity.updateBatch` — пачка правок одним `execute` с `batchId`: один `actionId`, один Undo
//    («одна пачка, один Undo» — §4.3 выбор шаблона, §8.4 смена вида записи).
import { z } from 'zod';
import type { Entity } from '../schemas/entity';
import { BLOCK_ITEM_MESSAGES, BLOCK_TEXT_MAX } from './block-messages';
import { entityCreateUiInput, entityUpdateUiInput } from './tools';

export * from './block-messages';

/** Потолок пачки блоков за вызов (спека §6.3): больше на одной странице не рисуется. */
export const BLOCKS_BATCH_CAP = 30;

/**
 * Потолок строк одного блока — тот же, что `DEFAULT_LIMIT` компилятора запросов
 * (`apps/server/src/query/compile-ast.ts`). Схема канона `limit` сверху не ограничивает, поэтому
 * `limit=1000` в ТЕКСТЕ запроса сервер клампит до этого числа, а `limit` блока выше него
 * отвергает схема входа.
 */
export const BLOCK_ROWS_CAP = 500;

/**
 * Потолок значений параметров у одного блока (спека 1в §5.1): блок ссылается на параметры своей
 * страницы, и их — единицы; потолок только отсекает мусорный вход, на смысл не влияет.
 */
export const BLOCK_PARAMS_CAP = 16;

/** Потолок пачки правок: выбор шаблона и смена вида пишут единицы операций, не десятки. */
export const UPDATE_BATCH_CAP = 20;

/**
 * Блок по ТЕКСТУ запроса — блок страницы, как его пишет тело (срез 1а). Экспортирован: клиент
 * сверяет элемент своей очереди этой схемой до отправки (изоляция блоков, §6.3).
 */
export const entityBlockTextItem = z
  .object({
    key: z.string().min(1).max(200),
    text: z.string().min(1).max(BLOCK_TEXT_MAX, BLOCK_ITEM_MESSAGES.textTooLong),
    thisEntityId: z.string().uuid(BLOCK_ITEM_MESSAGES.thisNotId).optional(),
    limit: z
      .number()
      .int(BLOCK_ITEM_MESSAGES.limitRange)
      .min(1, BLOCK_ITEM_MESSAGES.limitRange)
      .max(BLOCK_ROWS_CAP, BLOCK_ITEM_MESSAGES.limitRange)
      .optional(),
    /**
     * Значения параметров страницы, на которые ссылается блок (`$<имя>`, спека 1в §5.1, РП-6): имя →
     * токен даты. Форма здесь — только «строки, не больше потолка»: ЗНАЧЕНИЕ проверяет сервер ПО
     * БЛОКУ (`substituteParams`) — плохое значение или отсутствующее имя роняют один блок, а не
     * пачку, как любая ошибка блока (изоляция §6.3 1а).
     */
    params: z
      .record(z.string().min(1).max(64), z.string().max(64))
      .refine((p) => Object.keys(p).length <= BLOCK_PARAMS_CAP, BLOCK_ITEM_MESSAGES.paramsTooMany)
      .optional(),
  })
  .strict();

/**
 * Бейдж раздела навигации (срез 1б §9.3, РП-8): число из ПЕРВОГО блока данных страницы `badgeOf`.
 * Текст блока клиент не шлёт: тело страницы читает сервер, и все бейджи навигации уходят той же
 * пачкой, что и блоки, — без `entity.get` на каждый раздел (второй путь данных 1а снимается).
 */
const blockBadgeItem = z
  .object({
    key: z.string().min(1).max(200),
    badgeOf: z.string().uuid(),
  })
  .strict();

/**
 * Вход `entity.blocks`. Блок адресуется ТЕКСТОМ запроса (`{{query:…}}` без обёртки), а не
 * деревом: тело страницы хранит текст, и разбор по реестру владельца — забота сервера.
 *
 * `key` — строка клиента, под ней блок вернётся в `results`. ДУБЛИКАТ КЛЮЧА — ОТКАЗ СХЕМЫ, а не
 * «последний победил»: два блока под одним ключом — ошибка клиента, и молча отдать ответ только
 * одному значило бы нарисовать второму чужие данные.
 *
 * `limit` блока — «ещё N» раскрывается подъёмом `limit`; без него действует `limit` из текста
 * запроса, без того — `BLOCK_ROWS_CAP`.
 *
 * Элемент второго вида — `{key, badgeOf}` (бейдж раздела, см. `blockBadgeItem`); ключи обоих
 * видов делят одно пространство.
 */
export const entityBlocksInput = z
  .object({
    blocks: z
      .array(z.union([entityBlockTextItem, blockBadgeItem]))
      .min(1)
      .max(BLOCKS_BATCH_CAP),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.blocks.forEach((b, i) => {
      if (seen.has(b.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', i, 'key'],
          message: `ключ блока '${b.key}' повторяется: у каждого блока пачки свой ключ`,
        });
      }
      seen.add(b.key);
    });
  });
export type EntityBlocksInput = z.infer<typeof entityBlocksInput>;
/** Элемент пачки по тексту запроса. */
export type EntityBlockTextItem = z.infer<typeof entityBlockTextItem>;
/** Элемент пачки «бейдж раздела». */
export type EntityBlockBadgeItem = z.infer<typeof blockBadgeItem>;

/** Отказ блока: код причины, человеческий текст, позиция в тексте запроса (если есть). */
export interface BlockError {
  code: string;
  message: string;
  position?: number;
}

/**
 * Сумма одной валюты плитки (спека 1в §3.6, РП-7). `currency: null` — строки не денежные (свойство не
 * привязано слотом `amount` «движения денег» аспекта на записи: калории, часы): их сумма — число без
 * символа. `sum` — текстом (`numeric` без потери точности decimal-строк), `count` — записей с
 * значением в этой валюте.
 */
export interface BlockSum {
  currency: string | null;
  sum: string;
  count: number;
}

/**
 * Ответ по одному блоку. Вид — по проекции запроса: `display=tile` → агрегат плитки
 * (`count` | `sum` | `latest`), иначе строки.
 *
 * Строки — wire-форма сущности (`Entity`, схема `schemas/entity`): её же отдаёт `entity.query`.
 * `more` — сколько строк выборки не поместилось в `limit` (0 — всё показано). `closedIds` — провод
 * среза 1в (спека §3.5–§3.7, §5.1 «Формат»): поле заведено с подъёмом версии клиента `0.5.0`, чтобы
 * провод менялся ОДИН раз; заполняет его задача 6 (до неё — пустой массив).
 *
 * `sum` — суммы ПО ВАЛЮТАМ раздельно (§3.6): рубли с долларами не складываются. Порядок — валюта
 * владельца, прочие по алфавиту, не денежные (`null`) последними; пустая выборка — `sums: []`.
 * `count` — записей выборки. `latest` — значение первой записи в порядке блока (без `sortBy` —
 * последней правки) и её валюта (`null` — не денежное, §3.7).
 */
export type BlockResult =
  | { ok: true; kind: 'rows'; rows: Entity[]; more: number; closedIds: string[] }
  | { ok: true; kind: 'count'; count: number }
  | { ok: true; kind: 'sum'; count: number; sums: BlockSum[] }
  | { ok: true; kind: 'latest'; value: string | null; currency: string | null }
  // Бейдж страницы без блоков данных: числа нет, и это не отказ — раздел рисуется без бейджа.
  | { ok: true; kind: 'none' }
  | { ok: false; error: BlockError };
export type EntityBlocksResult = { results: Record<string, BlockResult> };

/**
 * Вход `entity.updateBatch`: белый список из трёх операций исполнителя.
 *
 * `entity_create` (срез 1б §9.3, §9.5): «Новое приложение…» и «Добавить в навигацию → Новое
 * приложение…» — создание записи и правка, ссылающаяся на неё, одной пачкой и одним Undo. Клиент
 * задаёт `id` сам, чтобы следующая операция пачки могла на него сослаться; занятый id — отказ
 * `CONFLICT` исполнителя, не повтор.
 *
 * `entity_version_pin` — ФОРМА ТУЛА исполнителя (`entity_id`, а не `entityId` роутера
 * `version`): операции уходят в `execute` без перекладки. Порядок значим — закрепление первым
 * снимает тело ДО замены (§8.4: «Текст до изменения вида»).
 *
 * `label` — подпись жеста интерфейса («Сделать страницей», «Изменить вид только этой записи»):
 * заголовок записи журнала в ленте и то, что назовёт «отмени последнее» (`undo_last`). Без неё
 * пачка из UI звалась бы «batch: операций — N» (финальное ревью, B-M2).
 */
export const entityUpdateBatchInput = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    operations: z
      .array(
        z.discriminatedUnion('tool', [
          z.object({ tool: z.literal('entity_create'), input: entityCreateUiInput }),
          z.object({ tool: z.literal('entity_update'), input: entityUpdateUiInput }),
          z.object({
            tool: z.literal('entity_version_pin'),
            input: z
              .object({
                entity_id: z.string().uuid(),
                label: z.string().trim().min(1).max(200),
              })
              .strict(),
          }),
        ]),
      )
      .min(1)
      .max(UPDATE_BATCH_CAP),
  })
  .strict();
export type EntityUpdateBatchInput = z.infer<typeof entityUpdateBatchInput>;
