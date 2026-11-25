import { describe, expect, test } from 'bun:test';
import type { ParseRegistry } from '../query';
import * as convert from './convert';
import {
  bodyDocError,
  bodyPairFromDoc,
  bodyRefsFromDoc,
  parseBody,
  readBodyDoc,
  serializeBody,
} from './convert';
import { DOC_SCHEMA_VERSION } from './types';

const id = '018f932a-e591-7011-99d1-0ea197510b3f';
const link = `[Смета](orbis-file:${id})`;
const image = `![План](orbis-file:${id})`;
const reg = {
  properties: new Map(),
  aspects: new Map(),
  roles: new Map(),
  contracts: new Map(),
  locale: 'ru',
} satisfies ParseRegistry;

describe('файловый документ v4', () => {
  test('абзац, список и таблица сохраняют форму и все вхождения одного ID', () => {
    const body = `${link} ${image}\n\n- ${link}\n\n| A |\n| --- |\n| ${image} |`;
    const doc = parseBody(body);
    expect(doc.v).toBe(4);
    expect(doc.doc.content?.map((n) => n.type)).toEqual(['paragraph', 'bulletList', 'table']);
    expect(doc.doc.content?.[0]?.content?.[0]).toEqual({
      type: 'fileRef',
      attrs: { fileId: id, display: 'link', label: 'Смета' },
    });
    expect(convert.collectFileIds(doc)).toEqual([id]);
    expect(bodyRefsFromDoc(doc)).toEqual([]);
    expect(parseBody(serializeBody(doc))).toEqual(doc);
    expect(bodyPairFromDoc(doc).doc).toEqual(doc);
  });

  test('вставка после сырого блока со сноской остаётся канонической ссылкой', () => {
    const raw = 'См. [источник][сайт].\n\n[сайт]: https://example.org';
    const doc = parseBody(raw);
    expect(doc.doc.content?.[0]?.type).toBe('rawBlock');
    doc.doc.content?.push(...(parseBody(link).doc.content ?? []));
    const saved = bodyPairFromDoc(doc);
    expect(convert.collectFileIds(saved.doc)).toEqual([id]);
    expect(convert.collectFileIds(parseBody(saved.body))).toEqual([id]);
    expect(saved.body).toContain(raw);
    expect(convert.collectFileIds(parseBody(raw + '\n\n`' + link + '`'))).toEqual([]);
    expect(convert.collectFileIds(parseBody(raw + '\n\n' + link, null))).toEqual([]);
  });

  test('экранированный маркер, код, raw и внешняя ссылка не становятся файлами', () => {
    for (const body of [
      `\\${link}`,
      `\\${image}`,
      `\`${link}\``,
      `\`\`\`\n${image}\n\`\`\``,
      `<html>${image}</html>`,
      '[Открыть](https://example.org/)',
    ]) {
      const doc = parseBody(body);
      expect(convert.collectFileIds(doc)).toEqual([]);
      expect(convert.collectFileIds(parseBody(serializeBody(doc)))).toEqual([]);
    }
  });

  test('исторический Markdown-only и старый raw сохраняют точный литерал через редактор', () => {
    for (const marker of [link, image]) {
      for (const stored of [
        null,
        {
          v: 3,
          doc: {
            type: 'doc',
            content: [{ type: 'rawBlock', attrs: { id: 'block-1', markdown: marker } }],
          },
        },
      ]) {
        const doc = readBodyDoc(stored, marker, reg, null);
        if (stored) expect(doc.doc.content?.[0]?.attrs?.id).toBe('block-1');
        const next = parseBody(serializeBody(doc));
        expect(convert.collectFileIds(next)).toEqual([]);
        expect(JSON.stringify(next.doc)).toContain(marker);
      }
      expect(convert.collectFileIds(readBodyDoc(null, marker, reg, 4))).toEqual([id]);
    }
  });

  test('подпись со скобками и обратной косой чертой обратима', () => {
    const node = {
      type: 'fileRef',
      attrs: { fileId: id, display: 'link', label: 'План [A] \\ B' },
    };
    const doc = {
      v: DOC_SCHEMA_VERSION,
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [node] }] },
    };
    expect(parseBody(serializeBody(doc))).toEqual(doc);
    expect(bodyDocError(doc)).toBeUndefined();
    for (const attrs of [
      { ...node.attrs, fileId: 'oops' },
      { ...node.attrs, display: 'video' },
      { ...node.attrs, label: 123 },
    ]) {
      expect(
        bodyDocError({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'fileRef', attrs }] }],
        }),
      ).toBeDefined();
    }
  });
});
