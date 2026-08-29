import { z } from 'zod';

export const entitySchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  title: z.string().min(1),
  emoji: z.string().nullable().default(null),
  body: z.string().default(''),
  // Документ едет ТОЛЬКО по явному include (Р6): wire-форма несёт body всегда, и второй
  // экземпляр тела в каждом ответе удвоил бы вес любого списка сущностей. Поэтому optional
  // (ключа может не быть вовсе) И nullable (запросили, но строка ещё не сконвертирована).
  bodyDoc: z
    .object({ v: z.number(), doc: z.record(z.unknown()) })
    .nullable()
    .optional(),
  bodyRefs: z.array(z.string().uuid()).default([]),
  tags: z.array(z.string()).default([]),
  // НОВАЯ и единственная правда значений (§А1-1): `props` по id свойства, `aspects`
  // списком навешенного, `queryRefs` — индекс ссылок тела. Мешок `meta` (§А1-3) и старая
  // карта `aspectsMap` из wire-формы СНЯТЫ (Задача 13c): читателей у них не осталось ни
  // одного, а `z.object` без `.passthrough()` срезает всё лишнее — то есть схема и есть
  // гарантия, что вторая форма не поедет наружу молча.
  props: z.record(z.unknown()).default({}),
  aspects: z.array(z.string()).default([]),
  queryRefs: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.boolean().default(false),
});
export type Entity = z.infer<typeof entitySchema>;
