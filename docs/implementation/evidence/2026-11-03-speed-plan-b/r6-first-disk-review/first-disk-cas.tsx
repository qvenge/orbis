import { bindQueryResponses, responseQueryOptions } from '../../lib/local-data/query-responses';

vi.mock('../../lib/local-data/response-cache', () => ({
  responseBuster: 'review-test',
  openResponseCache: (scope: unknown) => ({
    scope,
    capture: () => 'ticket',
    isCurrent: () => true,
    read: ({ key }: { key: unknown }) =>
      JSON.stringify(key) === JSON.stringify(getQueryKey(trpc.entity.get, detailGetInput('e1'), 'query'))
        ? { data: { entity, relations: [], thread: null }, receivedAt: Date.now() - 60_000 }
        : undefined,
    writeServerResponse: async () => true,
    close() {},
  }),
}));

for (const serverTitle of ['План', 'Чужое имя Д']) {
  test(`B13 independent first disk editable before first accepted network title=${serverTitle}`, async () => {
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      queueMicrotask(callback);
      return 1;
    });
    vi.stubGlobal('cancelIdleCallback', () => {});
    navAt('e1');
    const key = getQueryKey(trpc.entity.get, detailGetInput('e1'), 'query');
    let show: () => void = () => {};
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reply = { entity: { ...entity, title: serverTitle }, relations: [], thread: null };
    let reads = 0;
    let storedTitle = serverTitle;
    const writes = vi.fn();
    function Host() {
      const [opened, setOpened] = useState(false);
      show = () => setOpened(true);
      return opened ? <DetailScreen entityId="e1" /> : null;
    }
    const { queryClient } = renderWithProviders(<Host />, (path, input) => {
      if (path === 'entity.get' && (input as { id?: string }).id === 'e1') {
        reads++;
        return held.then(() => reply);
      }
      if (path === 'entity.update') {
        const patch = input as { title: string; expectedTitle: string };
        writes(patch);
        if (patch.expectedTitle !== storedTitle) return trpcError('CONFLICT', 'title CAS');
        storedTitle = patch.title;
        return mockEntityUpdateResult({ ...reply.entity, title: storedTitle });
      }
      return fallback(path);
    }, { queries: responseQueryOptions });
    const runtime = freshnessRuntimeOf(queryClient);
    if (!runtime) throw new Error('missing runtime');
    const responses = bindQueryResponses(queryClient, runtime, { enabled: true });
    try {
      await responses.ready;
      act(show);
      const field = await screen.findByTestId('title-edit');
      const arrow = await screen.findByRole('button', { name: 'Шаг назад' });
      const disk = runtime.publicationOf(hashKey(key));
      expect(disk?.source).toBe('disk');
      expect(disk && runtime.isAcceptedRead(disk)).toBe(false);
      expect(field).toHaveValue('План');
      expect(field).not.toHaveAttribute('readonly');
      expect(writes).not.toHaveBeenCalled();
      fireEvent.change(field, { target: { value: 'Набранный заголовок' } });
      expect(canUndoStep('e1')).toBe(true);
      expect(arrow).toBeEnabled();
      let network: Promise<unknown> | undefined;
      act(() => { network = queryClient.refetchQueries({ queryKey: key, exact: true }); });
      await waitFor(() => expect(reads).toBeGreaterThan(0));
      expect(acceptedDetailTitle(queryClient, 'e1')).toBeUndefined();
      await act(async () => { release(); await network; });
      await waitFor(() => expect(acceptedDetailTitle(queryClient, 'e1')).toBe(serverTitle));
      expect(screen.getByTestId('title-edit')).toBe(field);
      expect(field).toHaveValue('Набранный заголовок');
      const before = { disk: disk?.source, raw: acceptedDetailTitle(queryClient, 'e1'), undo: canUndoStep('e1'), disabled: (arrow as HTMLButtonElement).disabled };
      fireEvent.click(arrow);
      if (!before.disabled)
        await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
      const after = { title: (field as HTMLInputElement).value, writes: writes.mock.calls, storedTitle };
      process.stdout.write(JSON.stringify({ before, after }) + '\n');
      if (serverTitle === 'План') {
        expect(before).toMatchObject({ undo: true, disabled: false });
        expect(after.title).toBe('План');
      } else {
        expect.soft(before).toMatchObject({ undo: false, disabled: true });
        expect.soft(after.title).toBe('Набранный заголовок');
      }
    } finally {
      responses.close();
    }
  });
}
