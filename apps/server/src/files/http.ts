import { createHash } from 'node:crypto';
import { type FileInfo, fileIdSchema, WEB_FILE_CHUNK_BYTES } from '@orbis/shared/files';
import type { Hono } from 'hono';
import { getBunServer } from 'hono/bun';
import { makeCreateContext } from '../context';
import type { Db } from '../db/client';
import { ExecError } from '../errors';
import type { FileContext } from './access';
import { isFilePreviewType } from './media-type';
import { describeFiles, readRange } from './read';
import { openResponseFile, type ResponseFile, sendResponseFile } from './response-file';
import { writePart } from './uploads';

export function downloadDisposition(name: string): string {
  const safe = Buffer.from(name, 'utf8')
    .toString('utf8')
    .replace(/[\\/\p{Cc}]/gu, '_');
  const ascii = safe.replace(/[^a-zA-Z0-9 _.()-]/gu, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/gu,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function parseFileRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || !(match[1] || match[2])) throw new RangeError();
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end)
    throw new RangeError();
  return { offset: start, length: Math.min(end - start + 1, WEB_FILE_CHUNK_BYTES) };
}

async function readPart(req: Request): Promise<Uint8Array> {
  const limit = WEB_FILE_CHUNK_BYTES;
  if (Number(req.headers.get('content-length')) > limit)
    throw new ExecError('LIMIT', 'Порция слишком велика.');
  if (!req.body) throw new ExecError('VALIDATION', 'Пустая порция.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ExecError('LIMIT', 'Порция слишком велика.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export function fileHttpError(error: unknown): Response {
  if (!(error instanceof ExecError))
    return Response.json({ error: 'Ошибка файлового хранилища.' }, { status: 503 });
  const statuses: Record<string, number> = {
    NOT_FOUND: 404,
    FORBIDDEN_LEVEL: 403,
    LIMIT: 413,
    CONFLICT: 409,
    CLIENT_OUTDATED: 412,
  };
  const status = statuses[error.code] ?? 400;
  return Response.json({ code: error.code, error: error.message }, { status });
}

// Four simultaneous full downloads bound temporary disk to four original files. Short ranges
// and small responses are buffered up to the web transfer limit to preserve Content-Length.
const MAX_SPOOLED_DOWNLOADS = 4;
let spooledDownloads = 0;

async function downloadBody(
  caller: FileContext,
  info: FileInfo,
  range: ReturnType<typeof parseFileRange> | undefined,
  signal: AbortSignal,
  sending: (() => boolean) | undefined,
) {
  const read = () => readRange(caller, info.id, range?.offset, range?.length);
  signal.throwIfAborted();
  if (range || info.byteSize <= WEB_FILE_CHUNK_BYTES) {
    const { stream } = await read();
    return new Response(stream.pipeThrough(new TransformStream(), { signal })).arrayBuffer();
  }
  if (spooledDownloads >= MAX_SPOOLED_DOWNLOADS)
    throw new ExecError('CONFLICT', 'Идёт скачивание других файлов. Повторите позже.');
  spooledDownloads++;
  let file: ResponseFile | undefined;
  try {
    file = await openResponseFile();
    const writable = file;
    const hash = createHash('sha256');
    const { stream } = await read();
    await stream.pipeTo(
      new WritableStream({
        async write(bytes) {
          hash.update(bytes);
          await writable.writeFile(bytes);
        },
      }),
      { signal },
    );
    if (hash.digest('hex') !== info.sha256)
      throw new Error('Контрольная сумма оригинала не совпала.');
    return sendResponseFile(file, signal, sending, () => {
      spooledDownloads--;
    });
  } catch (error) {
    try {
      await file?.close();
    } finally {
      spooledDownloads--;
    }
    throw error;
  }
}

export function mountFileHttp(app: Hono, db: Db) {
  const context = makeCreateContext(db);
  for (const path of ['/api/files/*', '/api/file-uploads/*'])
    app.use(path, async (c, next) => {
      await next();
      c.header('Cache-Control', 'private, no-store');
      c.header('X-Content-Type-Options', 'nosniff');
    });
  app.put('/api/file-uploads/:id/parts/:offset', async (c) => {
    try {
      const req = c.req.raw;
      const ctx = await context({ req });
      if (!ctx.identity || ctx.actorKind !== 'owner') return c.body(null, ctx.identity ? 403 : 401);
      const id = fileIdSchema.safeParse(c.req.param('id'));
      const offsetText = c.req.param('offset');
      const offset = Number(offsetText);
      if (!id.success || !/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset))
        return c.body(null, 400);
      return c.json(
        await writePart({ ...ctx, identity: ctx.identity }, id.data, offset, await readPart(req)),
      );
    } catch (error) {
      return fileHttpError(error);
    }
  });
  app.get('/api/files/:id/content', async (c) => {
    try {
      const req = c.req.raw;
      const ctx = await context({ req });
      if (!ctx.identity || ctx.actorKind !== 'owner') return c.body(null, ctx.identity ? 403 : 401);
      const id = fileIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.body(null, 404);
      const caller = { ...ctx, identity: ctx.identity };
      const [info] = await describeFiles(caller, [id.data]);
      if (!info) return c.body(null, 404);
      const preview = c.req.query('mode') === 'preview';
      if (preview && !isFilePreviewType(info.mediaType)) return c.body(null, 415);
      const rangeHeader = req.headers.get('range');
      let range: ReturnType<typeof parseFileRange> | undefined;
      if (rangeHeader !== null) {
        try {
          range = parseFileRange(rangeHeader, info.byteSize);
        } catch {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${info.byteSize}`, 'Content-Length': '0' },
          });
        }
      }
      const server = c.env ? getBunServer<Bun.Server>(c) : undefined;
      // Large files are staged using bounded memory before Bun can announce their length.
      server?.timeout?.(req, 180);
      const signal = AbortSignal.any([req.signal, AbortSignal.timeout(10 * 60_000)]);
      const body = await downloadBody(
        caller,
        info,
        range,
        signal,
        server?.requestIP ? () => server.requestIP(req) !== null : undefined,
      );
      const length = range?.length ?? info.byteSize;
      server?.timeout?.(req, 60);
      return new Response(body, {
        status: range ? 206 : 200,
        headers: {
          'Content-Type': preview ? info.mediaType : 'application/octet-stream',
          'Content-Disposition': preview ? 'inline' : downloadDisposition(info.name),
          'Accept-Ranges': 'bytes',
          'Content-Length': String(length),
          ...(range && {
            'Content-Range': `bytes ${range.offset}-${range.offset + length - 1}/${info.byteSize}`,
          }),
        },
      });
    } catch (error) {
      return fileHttpError(error);
    }
  });
}
