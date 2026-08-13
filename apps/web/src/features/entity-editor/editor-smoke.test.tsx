// Дымовой тест ОКРУЖЕНИЯ, а не редактора: он проверяет, что ProseMirror вообще живёт в нашем
// jsdom. Без полифилов ассерты проходят, а ПРОГОН падает с кодом 1 — поэтому ценность теста
// раскрывается только вместе с проверкой кода возврата (шаг 3).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { expect, test } from 'vitest';

function Probe({ onReady }: { onReady: (e: unknown) => void }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: '<p></p>',
    onCreate: ({ editor: e }) => onReady(e),
  });
  return <EditorContent editor={editor} data-testid="editor" />;
}

test('редактор принимает набор с клавиатуры в jsdom', async () => {
  // biome-ignore lint/suspicious/noExplicitAny: тип Editor тут не нужен — проба зовёт две команды
  let editor: any = null;
  render(<Probe onReady={(e) => (editor = e)} />);
  await waitFor(() => expect(editor).not.toBeNull());
  const area = screen.getByTestId('editor').querySelector('[contenteditable]');
  editor.commands.focus();
  await userEvent.type(area as HTMLElement, 'привет');
  expect(editor.getText()).toBe('привет');
});
