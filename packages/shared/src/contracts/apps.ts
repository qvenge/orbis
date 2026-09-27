// packages/shared/src/contracts/apps.ts
// Wire-контракт действий владельца над записью-приложением (срез 1б §8.6, РП-12) и перевода
// старой ссылки на тред (§7.1, РП-17).
//  - `app.setDisabled` — «Выключить/Включить приложение»: свойство «Выключено» и `module_set`
//    отмеченных расширений ОДНОЙ пачкой, один Undo;
//  - `app.archive` — «Удалить приложение»: архив записи и выключение осиротевших расширений той же
//    пачкой;
//  - `chat.threadEntity` — запись, которой принадлежит тред (`/thread/<id>` → адрес записи).
import { z } from 'zod';
import { SWITCHABLE_EXTENSION_IDS } from '../registry/extensions';

/**
 * Список расширений пачки: только переключаемые и каждое — один раз. Повтор — отказ схемы, а не
 * «схлопнуть молча»: два `module_set` одного расширения в пачке — ошибка клиента, и в журнале она
 * легла бы двумя строками об одном переключении.
 */
const extensionList = z
  .array(z.enum(SWITCHABLE_EXTENSION_IDS))
  .max(SWITCHABLE_EXTENSION_IDS.length)
  .refine((list) => new Set(list).size === list.length, {
    message: 'расширение в списке повторяется: каждое переключается один раз',
  });

/**
 * «Выключить приложение» (`disabled: true`) / «Включить приложение» (`false`). `extensions` —
 * расширения, отмеченные в диалоге (по умолчанию — те из «Состава», которых нет в «Составе» других
 * включённых приложений, Р-9); выбор делает клиент, сервер переключает ровно их в ту же сторону.
 */
export const appSetDisabledInput = z
  .object({
    appId: z.string().uuid(),
    disabled: z.boolean(),
    extensions: extensionList,
  })
  .strict();
export type AppSetDisabledInput = z.infer<typeof appSetDisabledInput>;

/** «Удалить приложение»: архив записи; `disableExtensions` — осиротевшие расширения, которые владелец выключает. */
export const appArchiveInput = z
  .object({
    appId: z.string().uuid(),
    disableExtensions: extensionList,
  })
  .strict();
export type AppArchiveInput = z.infer<typeof appArchiveInput>;

/** Старая ссылка `/thread/<id>`: чья это запись. */
export const chatThreadEntityInput = z.object({ threadId: z.string().uuid() }).strict();
export type ChatThreadEntityInput = z.infer<typeof chatThreadEntityInput>;
