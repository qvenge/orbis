import {
  fileDescribeInput,
  fileFieldEditInput,
  fileReadInput,
  uploadBeginInput,
  uploadIdInput,
  uploadPartInput,
} from '@orbis/shared/files';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ExecError } from '../errors';
import { withFileAccess } from '../files/access';
import { fileLimits } from '../files/file-limits';
import { describeFiles, readRange } from '../files/read';
import { beginUpload, finishUpload, uploadStatus, writePart } from '../files/uploads';
import { parseEnvelope, type ToolCallCtx } from './dispatch-common';
import type { OrbisToolDef } from './registry';

const empty = z.object({}).strict();
function fileTool(
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  kind: OrbisToolDef['kind'],
): OrbisToolDef {
  return {
    name,
    description,
    kind,
    agentOnly: true,
    fullScopeOnly: true,
    inputJsonSchema: zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' }),
  };
}
export const fileFieldTool = fileTool(
  'file_field_edit',
  'Прикрепить, открепить или переставить файл в свойстве записи. Сохраняйте commandId для повтора.',
  fileFieldEditInput,
  'mutate',
);

// Transfer tools belong only to the external transport: they cannot enter a batch,
// confirmation card, assistant conversation, durable trace, or graph journal.
export const transferTools = [
  fileTool(
    'file_limits',
    'Получить пределы размера файла, числа вложений и размера порции.',
    empty,
    'read',
  ),
  fileTool(
    'file_describe',
    'Получить метаданные доступных файлов по ID.',
    fileDescribeInput,
    'read',
  ),
  fileTool(
    'file_read_chunk',
    'Получить порцию оригинала в base64. Продолжайте с nextOffset до eof.',
    fileReadInput,
    'read',
  ),
  fileTool(
    'file_upload_begin',
    'Начать загрузку оригинала с постоянным uploadId и согласовать размер порции.',
    uploadBeginInput,
    'mutate',
  ),
  fileTool(
    'file_upload_part',
    'Передать очередную порцию в base64 по смещению.',
    uploadPartInput,
    'mutate',
  ),
  fileTool(
    'file_upload_status',
    'Узнать подтверждённое смещение и состояние загрузки.',
    uploadIdInput,
    'read',
  ),
  fileTool(
    'file_upload_finish',
    'Проверить части и завершить загрузку оригинала. Для привязки вызовите file_field_edit.',
    uploadIdInput,
    'mutate',
  ),
];
export const isTransferTool = (name: string) => transferTools.some((d) => d.name === name);

export async function transfer(ctx: ToolCallCtx, name: string, input: unknown) {
  if (ctx.source !== 'mcp' || ctx.actorKind !== 'agent' || ctx.grant?.scope !== 'full')
    throw new ExecError('FORBIDDEN_LEVEL', 'Доступ к файловой операции запрещён.');
  switch (name) {
    case 'file_limits':
      parseEnvelope(empty, input, name);
      return withFileAccess(ctx, 'read', async () => fileLimits());
    case 'file_describe':
      return describeFiles(ctx, parseEnvelope(fileDescribeInput, input, name).ids);
    case 'file_read_chunk': {
      const { fileId, offset, length } = parseEnvelope(fileReadInput, input, name);
      const read = await readRange(ctx, fileId, offset, length);
      const bytes = Buffer.from(await new Response(read.stream).arrayBuffer());
      if (bytes.length !== read.length) throw new Error('Хранилище вернуло неполную порцию.');
      return {
        fileId,
        offset,
        length: bytes.length,
        data: bytes.toString('base64'),
        nextOffset: offset + bytes.length,
        eof: offset + bytes.length === read.info.byteSize,
      };
    }
    case 'file_upload_begin':
      return beginUpload(ctx, parseEnvelope(uploadBeginInput, input, name), 'mcp');
    case 'file_upload_status':
      return uploadStatus(ctx, parseEnvelope(uploadIdInput, input, name).uploadId);
    case 'file_upload_part': {
      const { uploadId, offset, data } = parseEnvelope(uploadPartInput, input, name);
      return writePart(ctx, uploadId, offset, Buffer.from(data, 'base64'));
    }
    case 'file_upload_finish':
      return finishUpload(ctx, parseEnvelope(uploadIdInput, input, name).uploadId);
    default:
      throw new ExecError('VALIDATION', 'Неизвестная файловая операция.');
  }
}
