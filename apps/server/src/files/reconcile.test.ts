import { expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import type { RegistrySnapshot } from '../registry/load';
import { canonicalBodyFiles, canonicalOperationFiles } from './reconcile';

const registry = { properties: new Map() } as RegistrySnapshot;
const file = newId();
const text = `[PDF](orbis-file:${file})`;

test('canonical history keeps the explicit file grammar and protects legacy Markdown', () => {
  expect(canonicalBodyFiles({ body: text, bodyFormat: 4 })).toEqual([file]);
  expect(canonicalBodyFiles({ body: text, bodyFormat: null })).toEqual([]);
  expect(
    canonicalOperationFiles(registry, [{ op: 'entity_update', payload: { body: text } }], null),
  ).toEqual([]);
  expect(
    canonicalOperationFiles(
      registry,
      [{ op: 'entity_update', payload: { body: text, bodyFormatVersion: 4 } }],
      null,
    ),
  ).toEqual([file]);
});

test('a future or damaged source blocks collection in its graph', () => {
  expect(() => canonicalBodyFiles({ bodyDoc: { ...parseBody(text, 4), v: 5 } })).toThrow();
  expect(() =>
    canonicalBodyFiles({
      bodyDoc: {
        v: 4,
        doc: { type: 'doc', content: [{ type: 'fileRef', attrs: { fileId: 'broken' } }] },
      },
    }),
  ).toThrow();
  expect(() =>
    canonicalOperationFiles(registry, [{ op: 'future_operation', payload: {} }], 4),
  ).toThrow();
  expect(() =>
    canonicalOperationFiles(
      registry,
      [{ op: 'file_field_edit', payload: { edit: { kind: 'future' } } }],
      4,
    ),
  ).toThrow();
});
