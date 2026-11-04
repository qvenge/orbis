
test.each(['direct gesture', 'already-open dialog'] as const)('B13 old body cannot enter a view rewrite after rewind: %s', async (variant) => {
  const dialogFirst = variant === 'already-open dialog';
  const old = fixture(dialogFirst ? 'project' : 'note-plain');
  const extra = dialogFirst ? [template(TPL_A, 'Шаблон проекта', ['orbis/project'], '{{title}}\n{{cards}}\n')] : [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let restoring = false;
  let refreshed = 0;
  const recordId = old.entity.id;
  const { queryClient, world, batches } = open(old, extra, {
    over: async (path, input) => {
      if (restoring && path === 'entity.get' && (input as { id: string }).id === recordId) {
        refreshed += 1;
        await hold;
      }
    },
  });
  const changedBody = 'new history has different words at the same body revision';
  const chooseView = () => choose('Изменить вид только этой записи');
  try {
    await screen.findByTestId(dialogFirst ? 'page-render' : 'editor-preview');
    if (dialogFirst) {
      await chooseView();
      await screen.findByRole('dialog');
    }
    const row = world.rows.get(recordId);
    if (!row) throw new Error('Expected the target record in the server fixture');
    const previousRevision = revisionOf(row);
    row.body = changedBody;
    row.bodyDoc = parseBody(changedBody);
    restoring = true;
    const { runtime, scope, changes } = testFreshnessOf(queryClient);
    act(() => {
      changes([], 30);
      expect(runtime.acceptChanges(scope, {
        watermark: '20',
        floor: '0',
        reset: { reason: 'future-cursor', phase: 'complete', token: 'future-cursor:31:0:20' },
        transactions: [],
      }, '31')).toBe(true);
    });
    await waitFor(() => expect(refreshed).toBeGreaterThan(0));
    if (dialogFirst) {
      await act(async () => release());
      await waitFor(() => {
        const candidates = queryClient.getQueriesData({ queryKey: [['entity', 'get']] });
        expect(candidates.map(([, data]) => data)).toContainEqual(expect.objectContaining({
          entity: expect.objectContaining({ id: recordId, body: changedBody, bodyRevision: previousRevision }),
        }));
      });
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Показать внизу страницы' }));
    } else {
      await chooseView();
    }
    await act(async () => {});
    expect.soft(batches()).toEqual([]);
    expect.soft(world.rows.get(recordId)?.body).toBe(changedBody);
    expect.soft(world.rows.get(recordId)?.bodyRevision).toBe(previousRevision);
  } finally {
    await act(async () => release());
  }
});
