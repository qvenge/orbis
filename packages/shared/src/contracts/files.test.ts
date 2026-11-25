import { describe, expect, test } from 'bun:test';
import {
  fileFieldEditInput,
  fileInfoSchema,
  fileLimitsSchema,
  uploadBeginInput,
  uploadPartInput,
} from './files';

const id = '00000000-0000-4000-8000-000000000001';
const info = {
  id,
  name: 'Смета.pdf',
  mediaType: 'application/pdf',
  byteSize: 0,
  sha256: 'a'.repeat(64),
};

describe('file wire contracts', () => {
  test('metadata has no provider address and describes empty originals', () => {
    expect(fileInfoSchema.parse(info)).toEqual(info);
    expect(fileInfoSchema.safeParse({ ...info, objectKey: 'private' }).success).toBe(false);
    expect(fileInfoSchema.safeParse({ ...info, byteSize: -1 }).success).toBe(false);
  });
  test('transfer inputs bound incoming allocation and negotiate MCP chunks', () => {
    const begin = {
      uploadId: id,
      name: info.name,
      byteSize: 42,
      mediaType: info.mediaType,
      chunkBytes: 6144 as const,
    };
    expect(uploadBeginInput.parse(begin)).toEqual(begin);
    expect(uploadBeginInput.safeParse({ ...begin, chunkBytes: 5000 }).success).toBe(false);
    expect(
      uploadPartInput.safeParse({ uploadId: id, offset: 0, data: 'A'.repeat(32769) }).success,
    ).toBe(false);
    expect(
      fileLimitsSchema.safeParse({
        maxFileBytes: -1,
        maxFiles: 50,
        webChunkBytes: 524288,
        mcpChunkBytes: 24576,
      }).success,
    ).toBe(false);
  });
  test('changes retain an explicit expected basis for one and reorder', () => {
    const base = { entityId: id, propertyId: id, commandId: id };
    expect(
      fileFieldEditInput.safeParse({ ...base, edit: { kind: 'set', fileId: id } }).success,
    ).toBe(false);
    expect(
      fileFieldEditInput.safeParse({ ...base, edit: { kind: 'set', fileId: id, expected: null } })
        .success,
    ).toBe(true);
    expect(
      fileFieldEditInput.safeParse({
        ...base,
        edit: { kind: 'reorder', expected: [id], value: [id, id] },
      }).success,
    ).toBe(false);
  });
});
