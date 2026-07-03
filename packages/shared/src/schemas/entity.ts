import { z } from 'zod';

export const entitySchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  title: z.string().min(1),
  emoji: z.string().nullable().default(null),
  body: z.string().default(''),
  bodyRefs: z.array(z.string().uuid()).default([]),
  tags: z.array(z.string()).default([]),
  meta: z.record(z.any()).default({}),
  aspects: z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.boolean().default(false),
});
export type Entity = z.infer<typeof entitySchema>;
