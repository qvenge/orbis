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
  aspects: z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.boolean().default(false),
});
export type Entity = z.infer<typeof entitySchema>;
