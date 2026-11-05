import { appendFileSync } from 'node:fs';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  mockEntityUpdateResult,
  queryReply,
  renderWithProviders,
  wireEntity,
} from '../../test/harness';
import { navAt } from '../../test/nav';
import { registryReply } from '../../test/registry';
import { Toaster } from '../../ui/Toast';
import { DetailScreen } from './DetailScreen';

function trace(event: string, details: object = {}) {
  appendFileSync(process.env.B13_REFERENCE_TRACE!, JSON.stringify({
    event, at: performance.now(), ...details,
  }) + '\n');
}
let aspectImport: Promise<unknown> | undefined;
vi.mock('./AspectSectionView', async (importOriginal) => {
  trace('aspect-view:import-start');
  const loaded = importOriginal<typeof import('./AspectSectionView')>();
  aspectImport = loaded;
  try {
    const actual = await loaded;
    trace('aspect-view:import-resolved');
    return actual;
  } catch (error) {
    trace('aspect-view:import-rejected', { error: String(error) });
    throw error;
  }
});
afterEach(async () => {
  if (aspectImport) await Promise.allSettled([aspectImport]);
});

const id = '019a0000-0000-7000-8000-000000000060',
  old = '019a0000-0000-7000-8000-000000000061',
  next = '019a0000-0000-7000-8000-000000000062';
test('actual reference picker caption uses prior and next cached labels without extra title requests', async () => {
  trace('fixture:begin');
  if (process.env.B13_REFERENCE_WARM === '1') await import('./AspectSectionView');
  navAt(id);
  trace('fixture:render-ready');
  const entity = wireEntity({
    id,
    title: 'Coffee',
    aspects: ['orbis/financial'],
    props: { 'orbis/finance_category': old },
  });
  const { calls } = renderWithProviders(
    <>
      <DetailScreen entityId={id} />
      <Toaster />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        trace('entity.get:reply', { id: (input as { id: string }).id });
        return { entity, relations: [], thread: null };
      }
      if (path === 'registry.effective') trace('registry.effective:reply');
      if (path === 'entity.query') trace('entity.query:reply', { input });
      if (path === 'entity.query')
        return queryReply([
          wireEntity({ id: old, title: 'Old label', aspects: ['orbis/category'] }),
          wireEntity({ id: next, title: 'Next label', aspects: ['orbis/category'] }),
        ]);
      if (path === 'entity.update')
        return {
          ...mockEntityUpdateResult(entity),
          actionId: '019a0000-0000-7000-8000-000000000063',
          consequences: false,
        };
      return registryReply(path) ?? {};
    },
  );
  trace('category:wait');
  const picker = await screen.findByLabelText('Категория').then(
    (field) => {
      trace('category:visible');
      return field;
    },
    (error) => {
      trace('category:timeout', { recordVisible: screen.queryByText(entity.title) !== null });
      throw error;
    },
  );
  await screen.findByRole('option', { name: 'Next label' });
  fireEvent.change(picker, { target: { value: next } });
  expect(await screen.findByText('Категория: Old label → Next label')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeInTheDocument();
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(1));
  expect(
    calls
      .filter((c) => c.path === 'entity.get')
      .every((c) => (c.input as { id: string }).id === id),
  ).toBe(true);
});
