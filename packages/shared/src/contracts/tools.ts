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

// Форму документа контракт не разбирает: её знает схема нод (@orbis/shared/doc), а дублирующая
// zod-модель дерева ProseMirror разъехалась бы с ней при первой же новой ноде. Импортировать
// сюда сам `@orbis/shared/doc` тоже нельзя: этот модуль лежит в эагерном барреле, а тот тянет
// всю схему Tiptap (~156 kB gzip) — она уехала бы в первый кадр web.
//
// Но «не моделировать ноды» — не то же самое, что «не проверять ничего»: структура верхнего
// уровня стоит одну строку и ловит формы, которые serializeBody МОЛЧА превращает в пустую
// строку (`{}`, `content` не массивом), стирая тело вместе с body_refs. `.passthrough()`
// обязателен: без него zod срезал бы всё, чего нет в форме, и правда о теле приехала бы в БД
// урезанной. Версию сверяет executor — здесь про DOC_SCHEMA_VERSION знать нечем.
const bodyDocSchema = z.object({
  v: z.number().int().positive(),
  doc: z.object({ type: z.literal('doc'), content: z.array(z.record(z.unknown())) }).passthrough(),
});

/**
 * Вход tRPC-роутера entity.update: то же, что у тула, плюс структурная форма тела.
 *
 * Почему отдельной схемой, а не расширением `entityUpdateInput`: та — контракт ТУЛА, её парность
 * с рукописной JSON Schema реестра (tools/registry.ts) проверяет тест, и рост схемы показал бы
 * `bodyDoc` модели — а дизайн держит тул-контракт строковым. Один путь записи (executor), два
 * входа с разными полномочиями.
 */
export const entityUpdateUiInput = entityUpdateInput
  .extend({ bodyDoc: bodyDocSchema.optional() })
  .refine((v) => !(v.body !== undefined && v.bodyDoc !== undefined), {
    message: 'body и bodyDoc одновременно недопустимы',
    path: ['bodyDoc'],
  });
export type EntityUpdateUiInput = z.infer<typeof entityUpdateUiInput>;

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

/**
 * Симметрично для чтения: UI просит документ, тул-контракт не растёт. Объявлена ПОСЛЕ
 * `entityGetInput` намеренно — `const` в TDZ до своей инициализации, и ссылка выше по файлу
 * упала бы ReferenceError при загрузке модуля (проверено пробой).
 */
export const entityGetUiInput = entityGetInput.extend({
  include: z.array(z.enum(['body', 'bodyDoc', 'relations', 'backlinks', 'thread'])).optional(),
});
export type EntityGetUiInput = z.infer<typeof entityGetUiInput>;

export type EntityCreateInput = z.infer<typeof entityCreateInput>;
export type EntityUpdateInput = z.infer<typeof entityUpdateInput>;
export type AttachAspectInput = z.infer<typeof attachAspectInput>;
export type RelationCreateInput = z.infer<typeof relationCreateInput>;
export type RelationDeleteInput = z.infer<typeof relationDeleteInput>;
export type BatchExecuteInput = z.infer<typeof batchExecuteInput>;
export type EntityQueryInput = z.infer<typeof entityQueryInput>;
export type EntityGetInput = z.infer<typeof entityGetInput>;
