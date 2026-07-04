// packages/shared/src/contracts/tools.ts
// Envelope-схемы тулов — wire-контракт §9.2 (нотация `*`/`?`), общий для tRPC/AI/MCP.
// expectedUpdatedAt в entity_update — решение 4 плана 1a: §9.2 поле не показывает,
// но §5.2 требует optimistic-check по updated_at при правке body; поле опционально
// в envelope, обязательность при body enforce'ит executor.
import { z } from 'zod';
import { RELATION_TYPES } from '../constants';

export const entityCreateInput = z
  .object({
    id: z.string().uuid().optional(),
    title: z.string().min(1),
    emoji: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()), // обязателен по §9.2 (может быть пустым)
    meta: z.record(z.unknown()).optional(),
    aspects: z.record(z.record(z.unknown())).optional(),
  })
  .strict();

export const entityUpdateInput = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime().optional(), // §5.2; обязателен при body — executor
    title: z.string().min(1).optional(),
    emoji: z.string().nullable().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    meta: z.record(z.unknown()).optional(),
    aspects: z.record(z.union([z.record(z.unknown()), z.null()])).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const attachAspectInput = z
  .object({
    entity_id: z.string().uuid(),
    data: z.record(z.unknown()),
  })
  .strict();

export const relationCreateInput = z
  .object({
    source_id: z.string().uuid(),
    target_id: z.string().uuid(),
    relation_type: z.enum(RELATION_TYPES),
  })
  .strict();
export const relationDeleteInput = relationCreateInput;

export const batchExecuteInput = z
  .object({
    batch_id: z.string().uuid(),
    // Элемент тоже strict — парность с рукописной JSON Schema реестра тулов
    // (additionalProperties: false вложенного конверта, §9.2)
    operations: z
      .array(z.object({ tool: z.string(), input: z.record(z.unknown()) }).strict())
      .min(1),
  })
  .strict();

export const entityQueryInput = z.object({ query: z.string().min(1) }).strict();
export const entityGetInput = z
  .object({
    id: z.string().uuid(),
    include: z.array(z.enum(['body', 'relations', 'backlinks', 'thread'])).optional(),
  })
  .strict();

export type EntityCreateInput = z.infer<typeof entityCreateInput>;
export type EntityUpdateInput = z.infer<typeof entityUpdateInput>;
export type AttachAspectInput = z.infer<typeof attachAspectInput>;
export type RelationCreateInput = z.infer<typeof relationCreateInput>;
export type RelationDeleteInput = z.infer<typeof relationDeleteInput>;
export type BatchExecuteInput = z.infer<typeof batchExecuteInput>;
export type EntityQueryInput = z.infer<typeof entityQueryInput>;
export type EntityGetInput = z.infer<typeof entityGetInput>;
