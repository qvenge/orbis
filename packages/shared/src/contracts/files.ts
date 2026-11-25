import { z } from 'zod';

export const FILE_MAX_BYTES = 32 * 1024 * 1024;
export const FILE_LIST_LIMIT = 50;
export const WEB_FILE_CHUNK_BYTES = 512 * 1024;
export const MCP_FILE_CHUNK_BYTES = 24 * 1024;
export const MCP_FILE_CHUNK_SIZES = [6144, 12288, 24576] as const;

export const fileIdSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
const byteCount = z.number().int().nonnegative().safe();
const fileName = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => s.trim().length > 0 && !/\p{Cc}/u.test(s));
const mediaType = z.string().min(1).max(255);
export const fileInfoSchema = z
  .object({
    id: fileIdSchema,
    name: fileName,
    mediaType,
    byteSize: byteCount,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const fileLimitsSchema = z
  .object({
    maxFileBytes: byteCount,
    maxFiles: z.number().int().min(1).max(FILE_LIST_LIMIT),
    webChunkBytes: z.number().int().min(1).max(WEB_FILE_CHUNK_BYTES),
    mcpChunkBytes: z.number().int().min(1).max(MCP_FILE_CHUNK_BYTES),
  })
  .strict();

export const uploadIdInput = z.object({ uploadId: fileIdSchema }).strict();
export const uploadBeginInput = uploadIdInput.extend({
  name: fileName,
  byteSize: byteCount,
  mediaType: mediaType.optional(),
  chunkBytes: z.union([z.literal(6144), z.literal(12288), z.literal(24576)]).optional(),
});
export const uploadPartInput = uploadIdInput.extend({
  offset: byteCount,
  data: z
    .string()
    .min(4)
    .max(32768)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export const uploadStatusSchema = z
  .object({
    uploadId: fileIdSchema,
    fileId: fileIdSchema,
    nextOffset: byteCount,
    chunkBytes: z.number().int().positive().max(WEB_FILE_CHUNK_BYTES),
    state: z.enum(['open', 'finishing', 'ready', 'expired', 'failed']),
    expiresAt: z.string().datetime(),
  })
  .strict();

const idList = z
  .array(fileIdSchema)
  .max(FILE_LIST_LIMIT)
  .refine((items) => new Set(items).size === items.length, 'Повторяющийся ID файла');
export const fileDescribeInput = z.object({ ids: idList }).strict();
export const fileReadInput = z
  .object({
    fileId: fileIdSchema,
    offset: byteCount,
    length: z.number().int().min(1).max(MCP_FILE_CHUNK_BYTES),
  })
  .strict();
export const fileFieldEditSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('add'), fileId: fileIdSchema, beforeId: fileIdSchema.optional() })
    .strict(),
  z.object({ kind: z.literal('remove'), fileId: fileIdSchema }).strict(),
  z.object({ kind: z.literal('reorder'), expected: idList, value: idList }).strict(),
  z
    .object({ kind: z.literal('set'), expected: fileIdSchema.nullable(), fileId: fileIdSchema })
    .strict(),
  z.object({ kind: z.literal('clear'), expected: fileIdSchema.nullable() }).strict(),
]);
export const fileFieldEditInput = z
  .object({
    entityId: fileIdSchema,
    propertyId: z.string().min(1).max(255),
    edit: fileFieldEditSchema,
    commandId: fileIdSchema,
  })
  .strict();

export type FileId = z.infer<typeof fileIdSchema>;
export type FileInfo = z.infer<typeof fileInfoSchema>;
export type FileLimits = z.infer<typeof fileLimitsSchema>;
export type UploadStatus = z.infer<typeof uploadStatusSchema>;
export type UploadBeginInput = z.infer<typeof uploadBeginInput>;
export type FileFieldEdit = z.infer<typeof fileFieldEditInput>;
