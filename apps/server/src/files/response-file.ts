import { open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAbortSignal, Readable } from 'node:stream';

export async function openResponseFile() {
  const path = join(tmpdir(), `orbis-response-${crypto.randomUUID()}`);
  const file = await open(path, 'wx+', 0o600);
  // An unlinked POSIX file stays available through its descriptor and is reclaimed on process exit.
  try {
    await unlink(path);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export type ResponseFile = Awaited<ReturnType<typeof openResponseFile>>;

/** Bun 1.2 uses chunked encoding for generic streams, even with an explicit Content-Length.
 * Its native file body uses sendfile and preserves the verified length on the wire.
 * The caller retains ownership on error, otherwise this body closes the descriptor. */
export function sendResponseFile(
  file: ResponseFile,
  signal: AbortSignal,
  sending: (() => boolean) | undefined,
  released: () => void,
): ReadableStream<Uint8Array> {
  signal.throwIfAborted();
  if (sending) {
    const stream = Bun.file(file.fd).stream();
    const cleanup = setInterval(() => {
      if (sending()) return;
      clearInterval(cleanup);
      void file.close().then(released, released);
    }, 250);
    cleanup.unref();
    return stream;
  }
  const stream = addAbortSignal(signal, file.createReadStream({ start: 0 }));
  stream.once('close', released);
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}
