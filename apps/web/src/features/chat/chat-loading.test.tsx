import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useContext } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../../pwa/fresh-reload', () => ({ reloadWithFreshWorker: vi.fn(async () => {}) }));
afterEach(() => {
  vi.doUnmock('./ChatPanel');
  vi.restoreAllMocks();
});

for (const side of [false, true]) {
  for (const rejected of [false, true]) {
    test(`chat module side=${side} rejected=${rejected} preserves its frame`, async () => {
      vi.resetModules();
      vi.clearAllMocks();
      let release!: (v: unknown) => void;
      let reject!: (e: Error) => void;
      let loads = 0;
      const gate = new Promise((r, j) => {
        release = r;
        reject = j;
      });
      vi.doMock('./ChatPanel', () => {
        loads++;
        return gate;
      });
      const { renderWithProviders } = await import('../../test/harness');
      const { frameHandler, frameWorld, resetFrame } = await import(
        '../../app/frame/frame-fixtures'
      );
      const { FrameAppContext } = await import('../../app/frame/FrameApp');
      const { useSideChat } = await import('../../app/frame/side-chat-store');
      const { ChunkErrorBoundary } = await import('../../app/ChunkErrorBoundary');
      const { reloadWithFreshWorker } = await import('../../pwa/fresh-reload');
      resetFrame('/');
      let Parent: (() => React.JSX.Element) | undefined;
      let importError: unknown;
      const importing = (side ? import('../../app/frame/SideChat') : import('./ChatScreen'))
        .then((m) => {
          Parent = 'SideChat' in m ? m.SideChat : m.ChatScreen;
        })
        .catch((e) => {
          importError = e;
        });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // The parent must finish loading while its real module import remains held.
        await waitFor(() => expect(Parent).toBeDefined());
        if (!Parent) throw new Error('missing parent module');
        const ReadyParent = Parent;
        act(() => useSideChat.setState({ open: true }));
        function Host() {
          const open = useSideChat((s) => s.open);
          return side ? (
            open ? (
              <ReadyParent />
            ) : (
              <button type="button" onClick={() => useSideChat.setState({ open: true })}>
                Reopen
              </button>
            )
          ) : (
            <ChunkErrorBoundary resetKey="chat">
              <ReadyParent />
            </ChunkErrorBoundary>
          );
        }
        renderWithProviders(<Host />, frameHandler(frameWorld()));
        expect(screen.getByRole('heading', { name: 'Чат' })).toBeInTheDocument();
        expect(screen.getAllByRole('status', { name: 'Загрузка' }).length).toBeGreaterThan(0);
        expect(screen.queryByTestId('loaded-chat')).toBeNull();
        await waitFor(() => expect(loads).toBe(1));
        if (side) {
          fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
          expect(screen.queryByRole('complementary', { name: 'Чат' })).toBeNull();
          fireEvent.click(screen.getByText('Reopen'));
          expect(screen.getByRole('button', { name: 'Закрыть' })).toBeInTheDocument();
        }
        if (rejected) {
          await act(async () => reject(new Error('Failed to fetch dynamically imported module')));
          await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
          expect(screen.getByTestId('chunk-reload')).toBeInTheDocument();
          if (side) {
            expect(screen.getByRole('heading', { name: 'Чат' })).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
            fireEvent.click(screen.getByText('Reopen'));
            await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
            expect(loads).toBe(1); // React.lazy's rejection remains cached.
          }
          fireEvent.click(screen.getByTestId('chunk-reload'));
          expect(reloadWithFreshWorker).toHaveBeenCalledTimes(1);
        } else {
          function Loaded() {
            const frame = useContext(FrameAppContext);
            return <div data-testid="loaded-chat">{frame?.via ?? 'mobile'}</div>;
          }
          await act(async () => release({ ChatPanel: Loaded }));
          await waitFor(() => expect(screen.getByTestId('loaded-chat')).toBeInTheDocument());
          if (side) expect(screen.getByTestId('loaded-chat')).toHaveTextContent('content');
        }
        expect(importError).toBeUndefined();
      } finally {
        release({ ChatPanel: () => null });
        await importing;
        errorLog.mockRestore();
      }
    });
  }
}
