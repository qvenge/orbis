
it.each(['new edit', 'pending debounce'] as const)(
  'B13 probe: %s cannot write from a pre-rollback body before current confirmation',
  async (variant) => {
    const refreshed = deferred();
    let detailReads = 0;
    let editor!: BodySave;
    const initial = detail(3, 'body observed before rollback');
    let serverBody = 'different body with reused revision';
    function Editor({ record }: { record: BodySaveEntity }) {
      editor = useBodySave(id, record);
      return null;
    }
    function Probe() {
      const read = trpc.entity.get.useQuery(detailGetInput(id));
      const record = read.data?.entity;
      return record ? <Editor record={{ ...record, bodyRevision: record.bodyRevision ?? 0 }} /> : null;
    }
    const { queryClient, calls } = renderWithProviders(
      <Probe />,
      (path, input) => {
        if (path === 'entity.get') return detailReads++ === 0 ? initial : refreshed.promise;
        if (path === 'entity.update') {
          const update = input as { expectedBodyRevision: number; bodyDoc: ReturnType<typeof doc> };
          // Match the executor's equality predicate for a reused current bodyRevision.
          expect(update.expectedBodyRevision).toBe(3);
          serverBody = update.bodyDoc.doc.content[0].content[0].text;
          return { ...entity(4, serverBody), txId: '25' };
        }
        throw new Error(path);
      },
      { freshness: true },
    );
    try {
      await waitFor(() => expect(editor).toBeDefined());
      act(() => editor.onShown(3));
      const local = doc('human edit based on the old document');
      if (variant === 'pending debounce') act(() => editor.onDocChange(local));
      act(() => reset(testFreshnessOf(queryClient)));
      await waitFor(() => expect(detailReads).toBe(2));
      await act(async () => {
        if (variant === 'new edit') editor.onDocChange(local);
        editor.flush();
      });
      expect.soft(calls.filter(({ path }) => path === 'entity.update')).toHaveLength(0);
      expect.soft(serverBody).toBe('different body with reused revision');
      expect.soft(readDraft(id)?.doc).toEqual(local);
    } finally {
      await act(async () => refreshed.resolve(detail(3, 'different body with reused revision')));
    }
  },
);
