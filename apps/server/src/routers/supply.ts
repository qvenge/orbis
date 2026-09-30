// apps/server/src/routers/supply.ts
// Ручки механизма поставки (срез 1б §9.1, С1б-6): «Обновления» и действия владельца над записями
// поставки. Только владельцу (ownerOnly): каждое действие — его решение, агент записи поставки правит
// обычной правкой записи по просьбе владельца, а их эталон не трогает вовсе (флаг `writer`).
import { SUPPLY_KEY_VALUES, SUPPLY_KEYS } from '@orbis/shared/supply';
import { z } from 'zod';
import { ExecError, execErrorToTRPC } from '../errors';
import {
  acceptAll,
  acceptUpdate,
  addSupplyRecord,
  declineUpdate,
  listUpdates,
  revertToEtalon,
} from '../supply/mechanism';
import { ownerOnlyProcedure, router } from '../trpc';

/** «Принять», «Оставить своё», «Добавить» — только ключи эталонов кода: снятому ключу нечего предлагать. */
const keyInput = z.object({ key: z.enum(SUPPLY_KEYS) }).strict();

/**
 * «Вернуть как было» — с версией записи, которую видел клиент (финал 1б, B1 m-3): возврат не снимет
 * то, чего диалог не показал. Необязательна: без неё — версия, прочитанная сервером.
 *
 * Поле остаётся штампом записи, а не ревизией тела (спека скорости §8.2): это замок записи ЦЕЛИКОМ — диалог
 * оболочки называет исчезающие разделы по свойствам места, а ревизию тела правка свойства не двигает.
 * Замок текста страницы механизм ставит сам по ревизии, прочитанной вместе со строкой (`revertToEtalon`).
 *
 * Ключ — любой допустимый, и снятый с поставки тоже (срез 1в §6.3, РП-10): правленая Upcoming 1б
 * возвращается к печати эталона, которая лежит в ней самой.
 */
const revertInput = z
  .object({ key: z.enum(SUPPLY_KEY_VALUES), expectedUpdatedAt: z.string().min(1).optional() })
  .strict();

/** Отказ механизма — структурной ошибкой tRPC, как у прочих ручек исполнителя. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ExecError) {
      throw execErrorToTRPC({ code: e.code, message: e.message, details: e.details });
    }
    throw e;
  }
}

export const supplyRouter = router({
  /** Что предлагает поставка: обновления записей и новые записи. Ничего не пишет. */
  updates: ownerOnlyProcedure.query(({ ctx }) => listUpdates(ctx)),
  /** «Принять — прежняя версия сохранится». */
  accept: ownerOnlyProcedure
    .input(keyInput)
    .mutation(({ ctx, input }) => guarded(() => acceptUpdate(ctx, input.key))),
  /** «Принять все» — только неправленые, одним действием. */
  acceptAll: ownerOnlyProcedure.mutation(({ ctx }) => guarded(() => acceptAll(ctx))),
  /** «Оставить своё» — отказ до следующего эталона. */
  decline: ownerOnlyProcedure
    .input(keyInput)
    .mutation(({ ctx, input }) => guarded(() => declineUpdate(ctx, input.key))),
  /** «Вернуть как было». */
  revert: ownerOnlyProcedure
    .input(revertInput)
    .mutation(({ ctx, input }) =>
      guarded(() => revertToEtalon(ctx, input.key, input.expectedUpdatedAt)),
    ),
  /** «Добавить» новую запись поставки. */
  add: ownerOnlyProcedure
    .input(keyInput)
    .mutation(({ ctx, input }) => guarded(() => addSupplyRecord(ctx, input.key))),
});
