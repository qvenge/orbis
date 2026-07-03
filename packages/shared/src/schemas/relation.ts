import { z } from 'zod';
import { RELATION_TYPES } from '../constants';

export const relationSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  relationType: z.enum(RELATION_TYPES),
  meta: z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Relation = z.infer<typeof relationSchema>;
