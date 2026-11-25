import { openAsBlob } from 'node:fs';
import { openPromise } from 'yauzl';
import { ExecError } from '../errors';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const raster = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const isFilePreviewType = (type: string) => raster.has(type);
const extensions: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  xlsx: XLSX,
};
const known = new Set(Object.values(extensions));
function mismatch(): never {
  throw new ExecError('VALIDATION', 'Содержимое файла не соответствует его формату.');
}

// Inspect only the Office manifest and the central directory. Other members, including
// embedded documents, are never decompressed when deciding how to serve the original.
async function isWorkbook(path: string): Promise<boolean> {
  const zip = await openPromise(path);
  try {
    if (zip.entryCount > 8192) return false;
    let manifest = false;
    let workbook = false;
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName === 'xl/workbook.xml') workbook = entry.uncompressedSize > 0;
      if (entry.fileName !== '[Content_Types].xml') continue;
      if (entry.uncompressedSize > 256 * 1024 || entry.isEncrypted()) return false;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) return false;
        chunks.push(chunk);
      }
      const xml = Buffer.concat(chunks).toString('utf8');
      manifest = [...xml.matchAll(/<Override\b[^>]*>/gu)].some(
        ([element]) =>
          /\bPartName=["']\/xl\/workbook\.xml["']/u.test(element) &&
          /\bContentType=["']application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml["']/u.test(
            element,
          ),
      );
    }
    return workbook && manifest;
  } finally {
    zip.close();
  }
}

export async function verifyMediaType(
  path: string,
  name: string,
  declaredType?: string | null,
): Promise<string> {
  const head = Buffer.from(await (await openAsBlob(path)).slice(0, 32).arrayBuffer());
  const magic = head.toString('hex');
  const ascii = head.toString('latin1');
  const expected = extensions[name.split('.').pop()?.toLowerCase() ?? ''];
  const claimed = declaredType?.split(';')[0]?.trim().toLowerCase();
  let type: string | undefined;
  if (magic.startsWith('89504e470d0a1a0a0000000d49484452')) type = 'image/png';
  else if (magic.startsWith('ffd8ff')) type = 'image/jpeg';
  else if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) type = 'image/gif';
  else if (
    ascii.startsWith('RIFF') &&
    ascii.slice(8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(ascii.slice(12, 16))
  )
    type = 'image/webp';
  else if (ascii.startsWith('%PDF-')) type = 'application/pdf';
  else if (magic.startsWith('504b0304') && (expected === XLSX || claimed === XLSX)) {
    if (await isWorkbook(path).catch(() => false)) type = XLSX;
  }
  if ((expected && expected !== type) || (claimed && known.has(claimed) && claimed !== type))
    mismatch();
  if (type && claimed && claimed !== 'application/octet-stream' && claimed !== type) mismatch();
  return type ?? 'application/octet-stream';
}
