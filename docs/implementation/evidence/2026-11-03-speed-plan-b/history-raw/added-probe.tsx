import { getQueryKey } from '@trpc/react-query';
import { freshnessRuntimeOf } from '../../lib/freshness/provenance';

function detailSnapshot(qc: QueryClient | null, id: string) {
  const query = qc?.getQueryCache().find({
    queryKey: getQueryKey(trpc.entity.get, detailGetInput(id), 'query'),
    exact: true,
  });
  const runtime = qc ? freshnessRuntimeOf(qc) : undefined;
  const read = query && runtime?.publicationOf(query.queryHash);
  const title = (value: unknown) =>
    (value as { entity?: { title?: string } } | undefined)?.entity?.title;
  return {
    raw: title(read?.raw),
    visible: title(query?.state.data),
    rawAccepted: read ? runtime?.isAcceptedRead(read) : false,
    commonUndo: canUndoStep(id),
  };
}

function titleConflict() {
  return trpcError('CONFLICT', 'Чужое имя', {
    code: 'CONFLICT',
    details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
  });
}

function logProbe(name: string, data: unknown) {
  console.log(JSON.stringify({ name, data }));
}

for (const outcome of ['foreign', 'pending', 'accepted'] as const)
  for (const order of ['body'] as const)
    if (outcome !== 'foreign' || order === 'body')
      test(`B13 independent raw title and actual body Undo outcome=${outcome} order=${order}`, async () => {
        navAt('e1');
        const observed = vi.spyOn(titleHistory, 'observeTitleValue');
        observed.mockClear();
        const acknowledged = vi.spyOn(titleHistory, 'acceptTitleSend');
        acknowledged.mockClear();
        let qc: QueryClient | null = null;
        let change: (id: string) => void = () => {};
        let refetch: () => Promise<unknown> = async () => {};
        let template = '{{title}}\n\n{{body}}',
          serverTitle = 'План';
        let titleWrites = 0,
          bodyWrites = 0,
          reads = 0,
          supplyReads = 0,
          ownCWrite = 0;
        const titleInputs: { id?: string; title?: string; expectedTitle?: string }[] = [];
        let rejectC: (error: unknown) => void = () => {};
        const bodyInputs: unknown[] = [];
        const heldC = new Promise((_done, fail) => {
          rejectC = fail;
        });
        const settledC = vi.fn();
        void heldC.then(settledC, settledC);
        let rejected: (error: unknown) => void = () => {};
        const held = new Promise((_resolve, reject) => {
          rejected = reject;
        });
        function Host() {
          const [id, set] = useState('e1');
          change = set;
          qc = useQueryClient();
          const utils = trpc.useUtils();
          refetch = () =>
            utils.entity.query.invalidate({ query: SUPPLY_RECORDS_QUERY, fields: 'full' });
          const warm = trpc.entity.get.useQuery(detailGetInput('e2'));
          return (
            <>
              <span data-testid="warm">{warm.data?.entity.title}</span>
              <DetailScreen entityId={id} />
            </>
          );
        }
        const e1Queries = () =>
          qc
            ?.getQueryCache()
            .getAll()
            .filter((q) => JSON.stringify(q.queryKey).includes('"e1"')) ?? [];
        const cachedTitle = () =>
          (
            qc
              ?.getQueryCache()
              .getAll()
              .find(
                (q) =>
                  (q.state.data as { entity?: { id: string } } | undefined)?.entity?.id === 'e1',
              )?.state.data as { entity: { title: string } } | undefined
          )?.entity.title;
        renderWithProviders(
          <Host />,
          (path, input) => {
            const vars = input as {
              query?: string;
              id?: string;
              title?: string;
              expectedTitle?: string;
              bodyDoc?: typeof doc;
            };
            if (path === 'entity.query' && vars.query === SUPPLY_RECORDS_QUERY) {
              supplyReads++;
              return queryReply([hostTemplateRecord(template)]);
            }
            if (path === 'entity.get') {
              if (vars.id === 'e1') reads++;
              return {
                entity: {
                  ...entity,
                  id: vars.id ?? 'e1',
                  title: vars.id === 'e2' ? 'Сосед' : serverTitle,
                },
                relations: [],
                thread: null,
              };
            }
            if (path === 'entity.update') {
              if (vars.bodyDoc !== undefined) {
                bodyWrites++;
                bodyInputs.push(vars);
                return mockEntityUpdateResult({ ...entity, title: serverTitle, bodyDoc: vars.bodyDoc });
              }
              if (vars.title !== undefined) {
                titleWrites++;
                titleInputs.push(vars);
                if (titleWrites === 1) return held;
                if (outcome !== 'foreign' && vars.expectedTitle === serverTitle) {
                  serverTitle = vars.title;
                  ownCWrite++;
                  return outcome === 'accepted'
                    ? mockEntityUpdateResult({ ...entity, title: serverTitle })
                    : heldC;
                }
                return heldC;
              }
            }
            return fallback(path);
          },
          { queries: { gcTime: 0 } },
        );
        const field = await screen.findByTestId('title-edit');
        await waitFor(() => expect(screen.getByTestId('warm')).toHaveTextContent('Сосед'));
        fireEvent.change(field, { target: { value: 'План Б' } });
        fireEvent.blur(field);
        await waitFor(() => expect(titleWrites).toBe(1));
        await waitFor(() => expect(cachedTitle()).toBe('План Б'));
        await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План Б'));
        await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
        const editor = (
          screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
            editor: Editor;
          }
        ).editor;
        const unchanged = editor.getJSON();
        fireEvent.change(field, { target: { value: 'План В' } });
        act(() => editor.commands.insertContentAt(1, 'own'));
        act(() => {
          editor.view.dispatch(closeHistory(editor.state.tr));
          editor.commands.deleteRange({ from: 1, to: 4 });
        });
        expect(undoDepth(editor.state)).toBe(2);
        expect(editor.getJSON()).toEqual(unchanged);
        act(() => {
          fireEvent.blur(field);
          change('e2');
        });
        await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
        await waitFor(() => expect(titleWrites).toBe(2));
        expect(titleInputs).toMatchObject([
          { id: 'e1', title: 'План Б', expectedTitle: 'План' },
          { id: 'e1', title: 'План В', expectedTitle: 'План' },
        ]);
        expect(ownCWrite).toBe(outcome === 'foreign' ? 0 : 1);
        if (outcome === 'accepted')
          await waitFor(() =>
            expect(acknowledged).toHaveBeenCalledWith(
              'e1',
              expect.objectContaining({ value: 'План В', state: 'accepted' }),
            ),
          );
        else expect(acknowledged).not.toHaveBeenCalled();
        expect(field).not.toBeInTheDocument();
        expect(
          observed.mock.calls.filter(([id, value]) => id === 'e1' && value === 'План В'),
        ).toHaveLength(0);
        await act(async () => {
          rejected(
            trpcError(
              'INTERNAL_SERVER_ERROR',
              'Observed B did not write; newer C is still pending',
            ),
          );
          await held.catch(() => {});
        });
        await waitFor(() => expect(e1Queries()).toHaveLength(0));
        expect(undoDepth(editor.state)).toBe(2);
        expect(canUndoStep('e1')).toBe(true);
        const beforeSupply = supplyReads;
        template =
          order === 'body'
            ? '{{body}}'
            : order === 'title-body'
              ? '{{title}}\n\n{{body}}'
              : '{{body}}\n\n{{title}}';
        await act(async () => {
          await refetch();
        });
        await waitFor(() => expect(supplyReads).toBeGreaterThan(beforeSupply));
        await waitFor(() =>
          expect(screen.queryByTestId('title-edit') === null).toBe(order === 'body'),
        );
        if (outcome === 'foreign') serverTitle = 'Чужое имя Д'; // Distinct from original, own B, and still-pending C.
        const beforeReads = reads;
        act(() => change('e1'));
        await waitFor(() => expect(reads).toBeGreaterThan(beforeReads));
        if (outcome === 'foreign') {
          await waitFor(() => expect(detailSnapshot(qc, 'e1')).toMatchObject({
            raw: 'Чужое имя Д', visible: 'План В', rawAccepted: true,
          }));
          await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
          expect(settledC).not.toHaveBeenCalled();
          expect(editor.getJSON()).toEqual(unchanged);
          const arrow = screen.getByRole('button', { name: 'Шаг назад' });
          const before = { ...detailSnapshot(qc, 'e1'), nativeUndo: undoDepth(editor.state), disabled: (arrow as HTMLButtonElement).disabled };
          fireEvent.click(arrow);
          const afterClick = { text: editor.getText(), nativeUndo: undoDepth(editor.state), nativeRedo: redoDepth(editor.state) };
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
          logProbe('foreign-D-while-C-pending-real-body-undo', {
            before, afterClick, titleWrites, bodyWrites, bodyInputs,
            settledC: settledC.mock.calls.length,
          });
          expect.soft(before).toMatchObject({ commonUndo: false, nativeUndo: 0, disabled: true });
          expect.soft(editor.getJSON()).toEqual(unchanged);
          expect.soft(bodyWrites).toBe(0);
          expect(settledC).not.toHaveBeenCalled();
          await act(async () => {
            rejectC(titleConflict());
            await heldC.catch(() => {});
          });
        }
        const returned = outcome === 'foreign' ? 'Чужое имя Д' : 'План В';
        await waitFor(() => expect(cachedTitle()).toBe(returned));
        expect(await screen.findByRole('heading', { name: returned })).toBeInTheDocument();
        await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
        expect(
          (
            screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
              editor: Editor;
            }
          ).editor,
        ).toBe(editor);
        expect(screen.queryByTestId('title-edit') === null).toBe(order === 'body');
        if (order !== 'body') {
          expect(screen.getByTestId('title-edit')).toHaveValue(returned);
          const copies = observed.mock.calls.flatMap(([id, value], index) =>
            id === 'e1' && value === returned ? [observed.mock.results[index]?.value] : [],
          );
          expect(copies.length).toBeGreaterThanOrEqual(2);
          expect(copies.every((foreign) => foreign === false)).toBe(true);
        }
        expect(screen.getAllByRole('button', { name: 'Шаг назад' })).toHaveLength(1);
        if (outcome === 'foreign') {
          expect(canUndoStep('e1')).toBe(false);
          expect(undoDepth(editor.state)).toBe(0);
          expect(redoDepth(editor.state)).toBe(0);
        } else {
          const before = detailSnapshot(qc, 'e1');
          expect(before).toMatchObject({ raw: 'План В', visible: 'План В', rawAccepted: true, commonUndo: true });
          expect(canUndoStep('e1')).toBe(true);
          expect(undoDepth(editor.state)).toBe(2);
          fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
          expect(editor.getText()).toBe('ownтело');
          expect(undoDepth(editor.state)).toBe(1);
          expect(redoDepth(editor.state)).toBe(1);
          logProbe('own-' + outcome + '-real-body-undo', {before, text: editor.getText(), nativeUndo: undoDepth(editor.state), nativeRedo: redoDepth(editor.state), bodyWrites});
        }
        expect(titleWrites).toBe(2);
        if (outcome === 'foreign') {
          expect(settledC).toHaveBeenCalledTimes(1);
          logProbe('cold-body-settled-C', {
            ...detailSnapshot(qc, 'e1'),
            nativeUndo: undoDepth(editor.state),
            nativeRedo: redoDepth(editor.state),
            titleWrites,
            bodyWrites,
          });
        } else {
          expect(settledC).not.toHaveBeenCalled();
        }
        if (outcome !== 'foreign') expect(bodyWrites).toBe(0);
      }, 12000);

