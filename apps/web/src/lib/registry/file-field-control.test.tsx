import { BUILTIN_PROPERTY_META } from '@orbis/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { PropertyControl } from './PropertyControl';

const id = '018f932a-e591-7011-99d1-0ea197510b3f';
const fileId = '018f932a-e591-7011-99d1-0ea197510b30';
const info = {
  id: fileId,
  name: 'Смета.pdf',
  byteSize: 0,
  mediaType: 'application/pdf',
  sha256: '1'.repeat(64),
};
test('файл из именованного поля сохраняется в своём поле отдельной командой', async () => {
  const base = BUILTIN_PROPERTY_META.find((def) => def.id === 'orbis/title')!;
  const def = {
    ...base,
    id: 'user/estimate',
    type: { kind: 'file' as const, cardinality: 'one' as const },
  };
  const { calls } = renderWithProviders(
    <PropertyControl
      selfId={id}
      def={def}
      value={null}
      onChange={() => {
        throw Error('ожидался files.editField');
      }}
    />,
    (path, input) => {
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
      if (path === 'files.finish') return info;
      if (path === 'files.editField')
        return {
          entityId: id,
          propertyId: def.id,
          value: fileId,
          actionId: null,
          consequences: false,
        };
      if (path === 'files.describe') return [info];
      return {};
    },
  );
  const picker = await screen.findByLabelText('Выбрать файл');
  await waitFor(() => expect(picker).not.toBeDisabled());
  fireEvent.change(picker, {
    target: { files: [new File([], info.name, { type: info.mediaType })] },
  });
  await waitFor(() =>
    expect(calls.find((call) => call.path === 'files.editField')?.input).toMatchObject({
      entityId: id,
      propertyId: def.id,
      edit: { kind: 'set', expected: null, fileId },
    }),
  );
  expect(await screen.findByRole('button', { name: 'Скачать Смета.pdf' })).toBeEnabled();
});
