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
  meta: z.record(z.any()).default({}),
  // ПЕРЕХОДНАЯ форма (§А1-1): новая правда (`props` по id свойства, `aspects` списком,
  // `queryRefs`) едет рядом со старой картой, переименованной в `aspectsMap`. Пара
  // `aspectsMap`/`meta` уходит из wire-формы вместе со старым носителем — там же, где
  // web перестаёт её читать; до тех пор обе обязаны быть в схеме, иначе `entitySchema.parse`
  // молча срезал бы карту у каждого ответа.
  props: z.record(z.unknown()).default({}),
  aspects: z.array(z.string()).default([]),
  queryRefs: z.array(z.string()).default([]),
  aspectsMap: z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.boolean().default(false),
});
export type Entity = z.infer<typeof entitySchema>;
