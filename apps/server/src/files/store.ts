/// <reference types="bun-types/s3" />
import { S3Client } from 'bun';

export type FileStoreEntry =
  | { key: string; modifiedAt: Date }
  | { key: string; unexpectedDirectory: true };

export interface FileStore {
  listGraph?(graph: string): Promise<FileStoreEntry[]>;
  put(key: string, body: Blob | Uint8Array): Promise<void>;
  read(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<ReadableStream<Uint8Array>>;
  remove(key: string): Promise<void>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Не задан ${name} для приватного Storage.`);
  return value;
}

function retryableAuth(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['AccessDenied', 'ExpiredToken', 'InvalidToken', 'InvalidJwt', '401', '403'].includes(
      String(error.code),
    )
  );
}

// The first read starts the provider request. An authentication failure can then be
// retried before any bytes have been delivered; later failures propagate to the consumer.
async function openStream(file: Blob): Promise<ReadableStream<Uint8Array>> {
  const reader = file.stream().getReader();
  const first = await reader.read();
  return new ReadableStream({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function privateBucket(): FileStore {
  const url = required('SUPABASE_URL').replace(/\/+$/, '');
  const anon = required('SUPABASE_ANON_KEY');
  const email = required('ORBIS_FILE_STORAGE_EMAIL');
  const password = required('ORBIS_FILE_STORAGE_PASSWORD');
  const bucket = process.env.ORBIS_FILE_STORAGE_BUCKET ?? 'record-attachments';
  const endpoint = process.env.ORBIS_FILE_S3_ENDPOINT ?? `${url}/storage/v1/s3`;
  const region = required('ORBIS_FILE_S3_REGION');
  const accessKeyId = required('ORBIS_FILE_S3_ACCESS_KEY_ID');
  type Session = { client: S3Client; token: string; renewAt: number };
  let current: Session | undefined;
  let pending: Promise<Session> | undefined;
  async function signIn(): Promise<Session> {
    const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Ошибка авторизации Storage (HTTP ${response.status}).`);
    const token = (await response.json()) as { access_token?: string; expires_in?: number };
    if (
      !token.access_token ||
      !Number.isFinite(token.expires_in) ||
      !(Number(token.expires_in) > 0)
    )
      throw new Error('Некорректная сессия Storage.');
    const ttl = Number(token.expires_in) * 1000;
    return {
      token: token.access_token,
      client: new S3Client({
        bucket,
        endpoint,
        region,
        accessKeyId,
        secretAccessKey: anon,
        sessionToken: token.access_token,
        virtualHostedStyle: false,
      }),
      renewAt: Date.now() + ttl - Math.min(60000, ttl / 5),
    };
  }
  async function session(): Promise<Session> {
    if (current && Date.now() < current.renewAt) return current;
    pending ??= signIn()
      .then((value) => (current = value))
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  async function run<T>(operation: (s3: S3Client, auth: Session) => Promise<T>): Promise<T> {
    const active = await session();
    try {
      return await operation(active.client, active);
    } catch (error) {
      if (!retryableAuth(error)) throw error;
      if (active === current) current = undefined;
      const renewed = await session();
      return operation(renewed.client, renewed);
    }
  }
  return {
    async listGraph(graph) {
      const result: FileStoreEntry[] = [];
      // Supabase Storage lists a single directory at a time. The service owns
      // exactly two namespaces and parts have exactly one upload subdirectory.
      const folders = [`originals/${graph}`, `parts/${graph}`];
      for (const prefix of folders) {
        for (let offset = 0; ; offset += 250) {
          const page = await run(async (_client, auth) => {
            const response = await fetch(
              `${url}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
              {
                method: 'POST',
                headers: {
                  apikey: anon,
                  Authorization: `Bearer ${auth.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  prefix,
                  limit: 250,
                  offset,
                  sortBy: { column: 'name', order: 'asc' },
                }),
                signal: AbortSignal.timeout(15000),
                redirect: 'error',
              },
            );
            if (!response.ok)
              throw Object.assign(new Error('Не удалось перечислить объекты Storage.'), {
                code: String(response.status),
              });
            return (await response.json()) as Array<{
              id: string | null;
              name: string;
              updated_at?: string;
              created_at?: string;
            }>;
          });
          for (const row of page) {
            if (!row.name || row.name.includes('/') || row.name === '.' || row.name === '..')
              throw Error('Повреждённый ключ Storage.');
            const key = `${prefix}/${row.name}`;
            if (row.id === null) {
              if (prefix === `parts/${graph}`) folders.push(key);
              // Neither an original nor a part can have descendants. This
              // virtual directory has no timestamp, but its presence alone
              // proves the namespace contains unrecognised data.
              else result.push({ key, unexpectedDirectory: true });
              continue;
            }
            const modifiedAt = new Date(row.updated_at ?? row.created_at ?? '');
            if (!Number.isFinite(modifiedAt.getTime()))
              throw Error('Неизвестное время записи Storage.');
            result.push({ key, modifiedAt });
          }
          if (page.length < 250) break;
        }
      }
      return result;
    },
    async put(key, body) {
      await run((s3) => s3.write(key, body));
    },
    read(key, range) {
      return run(async (s3) => {
        const file = s3.file(key);
        if (!range) return openStream(file);
        // Bun 1.2.7 streams the entire S3 object for slice(0, end). Send an
        // explicit Range to the same private S3 endpoint for every partial read.
        const end = range.offset + range.length - 1;
        const response = await fetch(file.presign({ expiresIn: 30 }), {
          headers: { Range: `bytes=${range.offset}-${end}` },
          redirect: 'error',
        });
        const bounds = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get('content-range') ?? '',
        );
        if (
          response.status !== 206 ||
          !response.body ||
          !bounds ||
          Number(bounds[1]) !== range.offset ||
          Number(bounds[2]) !== end ||
          Number(bounds[3]) <= end
        ) {
          await response.body?.cancel();
          throw Object.assign(new Error('Хранилище не подтвердило диапазон файла.'), {
            code: String(response.status),
          });
        }
        return response.body;
      });
    },
    async remove(key) {
      try {
        await run((s3) => s3.unlink(key));
      } catch (error) {
        if (
          !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'NoSuchKey'
          )
        )
          throw error;
      }
    },
  };
}

let store: FileStore | undefined;
export function getFileStore(): FileStore {
  store ??= privateBucket();
  return store;
}
