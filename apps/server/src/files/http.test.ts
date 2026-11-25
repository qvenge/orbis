import { expect, test } from 'bun:test';
import { downloadDisposition, parseFileRange } from './http';
import { openResponseFile, sendResponseFile } from './response-file';

test('single range respects inclusive bounds and resource size', () => {
  expect(parseFileRange('bytes=3-5', 8)).toEqual({ offset: 3, length: 3 });
  expect(parseFileRange('bytes=5-', 8)).toEqual({ offset: 5, length: 3 });
  expect(parseFileRange('bytes=-3', 8)).toEqual({ offset: 5, length: 3 });
  for (const input of ['bytes=8-', 'bytes=6-5', 'bytes=0-1,3-4', 'bytes=-0', 'bytes=3.1-4'])
    expect(() => parseFileRange(input, 8)).toThrow();
  expect(() => parseFileRange('bytes=0-0', 0)).toThrow();
});
test('download names stay a single header and have UTF-8 encoding', () => {
  const name = downloadDisposition('Смета "вход".pdf');
  expect(name).toContain("filename*=UTF-8''%D0%A1");
  expect(name).toStartWith('attachment;');
  expect(downloadDisposition('a\r\nx.pdf')).not.toMatch(/[\r\n]/);
});

test('a cancelled file response releases its anonymous spool and its transfer slot', async () => {
  const file = await openResponseFile();
  const released = Promise.withResolvers<void>();
  try {
    await file.writeFile(Buffer.alloc(1024 * 1024));
    expect((await file.stat()).nlink).toBe(0);
    const stream = sendResponseFile(
      file,
      new AbortController().signal,
      undefined,
      released.resolve,
    );
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel('download cancelled');
    await released.promise;
    await expect(file.stat()).rejects.toMatchObject({ code: 'EBADF' });
  } finally {
    await file.close();
  }
});
