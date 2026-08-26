import { z } from 'zod';

export const relationSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  /** Правда ребра (§А4-3): id роли из реестра `relation_role_definitions`. */
  role: z.string().min(1),
  /**
   * ПЕРЕХОДНОЕ поле: производная от роли проекция в старую колонку `relation_type`. Живёт
   * до contract-миграции 0017, поэтому `optional()` — новый клиент её уже не шлёт и не ждёт.
   */
  relationType: z.string().optional(),
  meta: z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Relation = z.infer<typeof relationSchema>;
