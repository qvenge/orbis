import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { isFilePreviewType, verifyMediaType } from './media-type';

async function check(data: Uint8Array | string, name: string, type?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'orbis-file-type-'));
  try {
    const path = join(dir, 'original');
    await writeFile(path, data);
    return await verifyMediaType(path, name, type);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('preview requires raster signature and matching declared type', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  expect(await check(png, 'план.png', 'image/png')).toBe('image/png');
  await expect(check('', 'empty.png', 'image/png')).rejects.toThrow();
  await expect(check(png, 'Смета.pdf', 'application/pdf')).rejects.toThrow();
  expect(await check('', 'empty.txt', 'text/plain')).toBe('application/octet-stream');
  expect(isFilePreviewType(await check('<svg/>', 'picture.svg', 'image/svg+xml'))).toBe(false);
});
test('XLSX needs workbook entry and corresponding Office content type', async () => {
  async function workbook(valid: boolean) {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from('<workbook/>'), 'xl/workbook.xml');
    zip.addBuffer(
      Buffer.from(
        valid
          ? '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'
          : '<Types/>',
      ),
      '[Content_Types].xml',
    );
    zip.end();
    const buffers = [];
    for await (const chunk of zip.outputStream) buffers.push(Buffer.from(chunk));
    return Buffer.concat(buffers);
  }
  expect(await check(await workbook(true), 'таблица.xlsx')).toBe(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  await expect(check(await workbook(false), 'таблица.xlsx')).rejects.toThrow();
});
