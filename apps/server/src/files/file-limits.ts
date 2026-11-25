import {
  FILE_LIST_LIMIT,
  FILE_MAX_BYTES,
  type FileLimits,
  MCP_FILE_CHUNK_BYTES,
  WEB_FILE_CHUNK_BYTES,
} from '@orbis/shared/files';
import { ExecError } from '../errors';

export function fileLimits(): FileLimits {
  const configured = Number(process.env.ORBIS_FILE_MAX_BYTES ?? FILE_MAX_BYTES);
  if (!Number.isSafeInteger(configured) || configured < 0)
    throw new Error('Некорректный ORBIS_FILE_MAX_BYTES');
  return {
    maxFileBytes: Math.min(configured, FILE_MAX_BYTES),
    maxFiles: FILE_LIST_LIMIT,
    webChunkBytes: WEB_FILE_CHUNK_BYTES,
    mcpChunkBytes: MCP_FILE_CHUNK_BYTES,
  };
}

export function requireFileWrites(): void {
  if (process.env.ORBIS_FILE_WRITES !== '1')
    throw new ExecError('FORBIDDEN_LEVEL', 'Запись файлов выключена.', {
      reason: 'file_writes_disabled',
    });
}
