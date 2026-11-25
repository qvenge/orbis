import type { FileFieldEdit } from '@orbis/shared/files';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { FileFieldControl } from './FileFieldControl';

const field = 'orbis/attachments',
  entityId = crypto.randomUUID();
const limits = { maxFileBytes: 50, maxFiles: 50, webChunkBytes: 50, mcpChunkBytes: 24 };
test('частичный успех оставляет повтор B привязанным к соседу C; потерянный ответ повторяет команду', async () => {
  const ids = ['A', 'B', 'C', 'X'].map(() => crypto.randomUUID());
  const files = ids.map((id, i) => ({
    id,
    name: ['A', 'B', 'C', 'X'][i]!,
    mediaType: 'application/pdf',
    byteSize: 0,
    sha256: '0'.repeat(64),
  }));
  const uploads = new Map<string, (typeof files)[number]>();
  const commands = new Map<string, string[]>();
  let saved: string[] = [],
    fail = true,
    unknown = true;
  const { calls } = renderWithProviders(
    <FileFieldControl entityId={entityId} propertyId={field} many value={[]} />,
    (path, raw) => {
      if (path === 'files.limits') return limits;
      if (path === 'files.begin') {
        const i = raw as { uploadId: string; name: string };
        const f = files.find((f) => f.name === i.name)!;
        uploads.set(i.uploadId, f);
        return {
          uploadId: i.uploadId,
          fileId: f.id,
          state: 'open',
          nextOffset: 0,
          chunkBytes: 50,
          expiresAt: new Date().toISOString(),
        };
      }
      if (path === 'files.finish') {
        const f = uploads.get((raw as { uploadId: string }).uploadId)!;
        if (f.name === 'B' && fail) {
          fail = false;
          throw Error('обрыв части');
        }
        return f;
      }
      if (path === 'files.describe')
        return files.filter((f) => (raw as { ids: string[] }).ids.includes(f.id));
      if (path === 'files.editField') {
        const cmd = raw as FileFieldEdit,
          edit = cmd.edit;
        if (!commands.has(cmd.commandId) && edit.kind === 'add') {
          const i = edit.beforeId ? saved.indexOf(edit.beforeId) : saved.length;
          if (i < 0) throw Error('Конфликт');
          saved.splice(i, 0, edit.fileId);
          commands.set(cmd.commandId, [...saved]);
          if (edit.fileId === ids[1] && unknown) {
            unknown = false;
            throw Error('Ответ потерян');
          }
        }
        return {
          entityId,
          propertyId: field,
          value: commands.get(cmd.commandId),
          actionId: null,
          consequences: false,
        };
      }
      return {};
    },
  );
  const picker = screen.getByLabelText('Выбрать файл');
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.change(picker, {
    target: {
      files: ['A', 'B', 'C'].map((name) => new File([], name, { type: 'application/pdf' })),
    },
  });
  await screen.findByRole('button', { name: 'Скачать C' }, { timeout: 5000 });
  saved.push(ids[3]!);
  expect(saved).toEqual([ids[0], ids[2], ids[3]]);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await screen.findByText(/Ответ потерян/);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await screen.findByRole('button', { name: 'Скачать B' }, { timeout: 5000 });
  expect(saved).toEqual([ids[0], ids[1], ids[2], ids[3]]);
  const edits = calls
    .filter((c) => c.path === 'files.editField')
    .map((c) => c.input as FileFieldEdit);
  expect(edits.at(-1)).toEqual(edits.at(-2));
  expect(edits.at(-1)?.edit).toMatchObject({ kind: 'add', beforeId: ids[2] });
});
test.each([
  'refused',
  'unknown',
] as const)('первая привязка %s сохраняет порядок группы при повторе', async (mode) => {
  const metadata = ['A', 'B', 'C'].map((name) => ({
    id: crypto.randomUUID(),
    name,
    mediaType: 'application/pdf',
    byteSize: 0,
    sha256: '0'.repeat(64),
  }));
  const sessions = new Map<string, (typeof metadata)[number]>(),
    saved: string[] = [],
    attempts: FileFieldEdit[] = [];
  const { calls } = renderWithProviders(
    <FileFieldControl entityId={entityId} propertyId={field} many value={[]} />,
    (path, raw) => {
      if (path === 'files.limits') return limits;
      if (path === 'files.describe')
        return metadata.filter((f) => (raw as { ids: string[] }).ids.includes(f.id));
      if (path === 'files.begin') {
        const i = raw as { name: string; uploadId: string };
        const meta = metadata.find((f) => f.name === i.name)!;
        sessions.set(i.uploadId, meta);
        return {
          uploadId: i.uploadId,
          fileId: meta.id,
          state: 'open',
          nextOffset: 0,
          chunkBytes: 50,
          expiresAt: new Date().toISOString(),
        };
      }
      if (path === 'files.finish') return sessions.get((raw as { uploadId: string }).uploadId);
      if (path === 'files.editField') {
        const cmd = raw as FileFieldEdit;
        attempts.push(cmd);
        if (attempts.length === 1)
          throw mode === 'refused'
            ? trpcError('CONFLICT', 'Основание изменилось')
            : Error('Сеть пропала');
        if (cmd.edit.kind === 'add')
          saved.splice(
            cmd.edit.beforeId ? saved.indexOf(cmd.edit.beforeId) : saved.length,
            0,
            cmd.edit.fileId,
          );
        return { entityId, propertyId: field, value: [...saved], actionId: null };
      }
      return {};
    },
  );
  const picker = screen.getByLabelText('Выбрать файл');
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.change(picker, {
    target: { files: metadata.map((m) => new File([], m.name, { type: m.mediaType })) },
  });
  const retry = await screen.findByRole('button', { name: 'Повторить' });
  await waitFor(() => expect(retry).toBeEnabled());
  expect(saved).toEqual(mode === 'refused' ? metadata.slice(1).map((f) => f.id) : []);
  fireEvent.click(retry);
  await waitFor(() => expect(saved).toEqual(metadata.map((f) => f.id)));
  const first = attempts.filter((x) => x.edit.kind === 'add' && x.edit.fileId === metadata[0]!.id);
  if (mode === 'unknown') expect(first[0]).toEqual(first[1]);
  else expect(first[1]?.edit).toMatchObject({ beforeId: metadata[1]!.id });
  expect(calls.filter((c) => c.path === 'files.finish')).toHaveLength(3);
});
test('офлайн не принимает выбор и сохраняет существующий оригинал', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  try {
    const id = crypto.randomUUID();
    const { calls } = renderWithProviders(
      <FileFieldControl entityId={entityId} propertyId="user/cover" many={false} value={id} />,
      (path) =>
        path === 'files.limits'
          ? limits
          : [{ id, name: 'Обложка', mediaType: 'image/png', byteSize: 0, sha256: '0'.repeat(64) }],
    );
    expect(screen.getByLabelText('Выбрать файл')).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Скачать Обложка' })).toBeEnabled();
    expect(calls.some((c) => c.path === 'files.begin')).toBe(false);
  } finally {
    online.mockRestore();
  }
});
