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
import { entityUpdateUiInput } from './tools';

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

/** Потолок пачки правок: выбор шаблона и смена вида пишут единицы операций, не десятки. */
export const UPDATE_BATCH_CAP = 20;

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
 */
export const entityBlocksInput = z
  .object({
    blocks: z
      .array(
        z
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
          })
          .strict(),
      )
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

/** Отказ блока: код причины, человеческий текст, позиция в тексте запроса (если есть). */
export interface BlockError {
  code: string;
  message: string;
  position?: number;
}

/**
 * Ответ по одному блоку. Вид — по проекции запроса: `display=tile` → агрегат плитки
 * (`count` | `sum` | `latest`), иначе строки.
 *
 * Строки — wire-форма сущности (`Entity`, схема `schemas/entity`): её же отдаёт `entity.query`.
 * `more` — сколько строк выборки не поместилось в `limit` (0 — всё показано).
 *
 * `sum` — текстом (`numeric` без потери точности decimal-строк); `currencies` — различные
 * непустые значения `orbis/currency` у суммированных записей: плитка суммы по записям в
 * разных валютах не имеет смысла, и клиент обязан это увидеть, а не сложить рубли с долларами.
 */
export type BlockResult =
  | { ok: true; kind: 'rows'; rows: Entity[]; more: number }
  | { ok: true; kind: 'count'; count: number }
  | { ok: true; kind: 'sum'; sum: string; count: number; currencies: string[] }
  | { ok: true; kind: 'latest'; value: string | null }
  | { ok: false; error: BlockError };
export type EntityBlocksResult = { results: Record<string, BlockResult> };

/**
 * Вход `entity.updateBatch`: белый список из двух операций исполнителя.
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
