import { parseBody } from '@orbis/shared/doc';
import { act, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { expect, test, vi } from 'vitest';
import { Markdown } from '../../lib/markdown/Markdown';
import VerifiedFileBody from '../../lib/markdown/VerifiedFileBody';
import { renderWithProviders } from '../../test/harness';
import { BodyEditor } from './BodyEditor';

const id = '018f932a-e591-7011-99d1-0ea197510b3f';
const fileId = crypto.randomUUID();
const info = {
  id: fileId,
  name: 'Схема.png',
  byteSize: 0,
  mediaType: 'image/png',
  sha256: 'a'.repeat(64),
};
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function mount() {
  const gate = pending<typeof info>();
  let editor!: Editor;
  const onChange = vi.fn();
  const view = renderWithProviders(
    <BodyEditor
      entityId={id}
      doc={parseBody('начало конец')}
      onChange={onChange}
      onReady={(e) => {
        editor = e;
      }}
    />,
    (path, input) => {
      if (path === 'files.describe') return [info];
      if (path === 'files.limits')
        return { maxFileBytes: 1024, maxFiles: 50, webChunkBytes: 512, mcpChunkBytes: 24 };
      if (path === 'files.begin')
        return {
          uploadId: (input as { uploadId: string }).uploadId,
          fileId,
          nextOffset: 0,
          chunkBytes: 512,
          state: 'open',
          expiresAt: new Date().toISOString(),
        };
      if (path === 'files.finish') return gate.promise;
      return [];
    },
  );
  await waitFor(() => expect(editor).toBeTruthy());
  editor.commands.setTextSelection(8);
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: {
      files: [new File([], info.name, { type: info.mediaType })],
      getData: () => '',
      items: [],
    },
  });
  act(() => {
    editor.view.dom.dispatchEvent(e);
  });
  return { editor, gate, onChange, view };
}
test('файл занимает первоначальное место после параллельного набора и сохраняется только после подтверждения', async () => {
  const { editor, gate, onChange } = await mount();
  expect(await screen.findByRole('button', { name: 'Отменить вставку Схема.png' })).toBeEnabled();
  expect(JSON.stringify(editor.getJSON())).not.toContain('fileRef');
  act(() => {
    editor.commands.insertContentAt(1, 'мой ');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  });
  await act(async () => gate.resolve(info));
  await waitFor(() => expect(JSON.stringify(editor.getJSON())).toContain(fileId));
  const nodes = editor.getJSON().content![0]!.content!;
  expect(nodes.map((n) => ('text' in n ? n.text : n.attrs?.fileId))).toEqual([
    'мой начало ',
    fileId,
    'конец',
  ]);
  expect(onChange).toHaveBeenCalled();
});
test('удалённый маркер и размонтирование исключают позднюю вставку', async () => {
  const { editor, gate, view } = await mount();
  const cancel = await screen.findByRole('button', { name: 'Отменить вставку Схема.png' });
  act(() => cancel.click());
  view.unmount();
  await act(async () => gate.resolve(info));
  expect(JSON.stringify(editor.getJSON())).not.toContain(fileId);
});
test('Markdown v4 показывает обе ссылки на PDF, а старый документ и код не читают файл', async () => {
  const source = `[Смета](orbis-file:${fileId})`;
  const { calls, unmount } = renderWithProviders(<Markdown source={source} />, (path) =>
    path === 'files.describe' ? [{ ...info, name: 'Смета.pdf', mediaType: 'application/pdf' }] : [],
  );
  expect(calls.some((c) => c.path === 'files.describe')).toBe(false);
  unmount();
  const body = {
    v: 4,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'rawBlock',
          attrs: { markdown: '[Смета][адрес]\n\n[адрес]: orbis-file:' + fileId },
        },
        {
          type: 'paragraph',
          content: [1, 2].map(() => ({
            type: 'fileRef',
            attrs: { display: 'link', fileId, label: 'Смета' },
          })),
        },
        { type: 'rawBlock', attrs: { markdown: source } },
      ],
    },
  };
  renderWithProviders(
    <VerifiedFileBody source={source} doc={body}>
      {(text) => <Markdown source={text} />}
    </VerifiedFileBody>,
    () => [info],
  );
  expect(await screen.findAllByRole('button', { name: 'Скачать Смета' })).toHaveLength(2);
});
