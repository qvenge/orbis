/**
 * Вставленный в тело адрес Orbis — ссылка на запись (срез 1б §7.4, С1б-2): в данных — ссылка по id
 * (`[[entity:<id>]]`), не адрес; адрес вычисляется при нажатии. Только если ВЕСЬ вставленный текст —
 * один адрес записи своего origin; чужой адрес и текст с адресом внутри вставляются как есть.
 */
import { parseBody, serializeBody } from '@orbis/shared/doc';
import { waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, expect, test, vi } from 'vitest';
import { blocksReply, installCrashTrap, renderWithProviders } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { BodyEditor } from './BodyEditor';
import { pastedRecordId } from './paste-address';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const APP = '019d48ea-4188-765d-8e96-93a0ad9c262a';
const ORIGIN = 'https://orbis.example';

installCrashTrap();

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── чистая функция ─────────────────────────────────────────────────────────────────────────────

test.each([
  ['запись в приложении, id в верхнем регистре', `${ORIGIN}/a/${APP}/r/${ID.toUpperCase()}`, ID],
  ['запись в хосте', `${ORIGIN}/r/${ID}`, ID],
  ['старая ссылка /entity/<id>', `${ORIGIN}/entity/${ID}`, ID],
  ['хвостовой перевод строки (копия из адресной строки)', `${ORIGIN}/r/${ID}\n`, ID],
  ['пробелы и перевод строки вокруг', `  \n${ORIGIN}/r/${ID} \r\n`, ID],
  ['домашняя своего приложения — запись-приложение', `${ORIGIN}/a/${APP}`, APP],
])('%s → id', (_what, text, id) => {
  expect(pastedRecordId(text, ORIGIN)).toBe(id);
});

test.each([
  ['чужой origin', `https://example.com/r/${ID}`],
  ['поиск', `${ORIGIN}/search?q=x`],
  ['текст с адресом внутри', `смотри ${ORIGIN}/r/${ID}`],
  ['два адреса', `${ORIGIN}/r/${ID} ${ORIGIN}/r/${ID}`],
  ['ключ поставки вместо записи', `${ORIGIN}/a/records`],
  ['старая ссылка категории Бюджета — остаётся текстом', `${ORIGIN}/budget/category/${ID}`],
  ['старая ссылка треда — не id записи', `${ORIGIN}/thread/${ID}`],
  ['пусто', ''],
])('%s → null', (_what, text) => {
  expect(pastedRecordId(text, ORIGIN)).toBeNull();
});

// ─── в редакторе ────────────────────────────────────────────────────────────────────────────────

const handler = (path: string, input?: unknown) => {
  const reg = registryReply(path);
  if (reg !== undefined) return reg;
  if (path === 'entity.blocks') return blocksReply({})(path, input);
  if (path === 'entity.resolveRefs') return [];
  if (path === 'entity.suggest') return [];
  return {};
};

/**
 * Событие вставки с буфером: в jsdom нет ни `ClipboardEvent`, ни `DataTransfer`. Буфер отдаёт ТОЛЬКО
 * `text/plain` — так кладёт адрес адресная строка и «Скопировать ссылку».
 */
function pasteEvent(text: string): Event {
  const e = new Event('paste') as Event & { clipboardData: unknown };
  e.clipboardData = { getData: (type: string) => (type === 'text/plain' ? text : '') };
  return e;
}

async function mountEditor(body = 'до ') {
  vi.stubGlobal('ClipboardEvent', class extends Event {});
  const held: { editor: Editor | null } = { editor: null };
  const onChange = vi.fn();
  renderWithProviders(
    <BodyEditor doc={parseBody(body)} onChange={onChange} onReady={(e) => (held.editor = e)} />,
    handler,
  );
  await waitFor(() => expect(held.editor).not.toBeNull());
  const editor = held.editor as Editor;
  editor.commands.focus('end');
  return { editor, onChange };
}

const refsOf = (editor: Editor): unknown[] => {
  const out: unknown[] = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === 'entityRef') out.push(n.attrs.entityId);
  });
  return out;
};

test('вставка адреса записи своего origin — узел entityRef с id, текста адреса нет; печать — [[entity:<id>]]', async () => {
  const { editor, onChange } = await mountEditor();
  const url = `${window.location.origin}/a/${APP}/r/${ID}\n`;
  editor.view.pasteText(url, pasteEvent(url) as ClipboardEvent);

  expect(refsOf(editor)).toEqual([ID]);
  expect(editor.getText()).not.toContain('/r/');
  const printed = serializeBody(onChange.mock.calls.at(-1)?.[0]);
  expect(printed).toContain(`[[entity:${ID}]]`);
  expect(printed).not.toContain(window.location.origin);
});

test('вставка чужого адреса — обычный текст, узла ссылки нет', async () => {
  const { editor } = await mountEditor();
  const url = `https://example.com/r/${ID}`;
  editor.view.pasteText(url, pasteEvent(url) as ClipboardEvent);

  expect(refsOf(editor)).toEqual([]);
  expect(editor.getText()).toContain(url);
});

test('текст с адресом внутри — как есть', async () => {
  const { editor } = await mountEditor();
  const text = `смотри ${window.location.origin}/r/${ID}`;
  editor.view.pasteText(text, pasteEvent(text) as ClipboardEvent);

  expect(refsOf(editor)).toEqual([]);
  expect(editor.getText()).toContain(text);
});

test('адрес, вставленный в блок кода, — просто текст; блок не разрезан (гейт 24, M-4)', async () => {
  const { editor } = await mountEditor('```\nкод\n```');
  expect(editor.state.doc.lastChild?.type.name).toBe('codeBlock');
  const url = `${window.location.origin}/r/${ID}`;
  editor.view.pasteText(url, pasteEvent(url) as ClipboardEvent);

  expect(refsOf(editor)).toEqual([]);
  const blocks: string[] = [];
  editor.state.doc.forEach((n) => {
    blocks.push(n.type.name);
  });
  expect(blocks).toEqual(['codeBlock']);
  expect(editor.state.doc.lastChild?.textContent).toContain(url);
});
