import { parseBody } from '@orbis/shared/doc';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { type ReactNode, useState } from 'react';
import { expect, test, vi } from 'vitest';
import {
  installCrashTrap,
  mockEntityUpdateResult,
  renderWithProviders,
  trpcError,
  wireEntity,
} from '../../test/harness';
import { navAt } from '../../test/nav';
import { registryReply } from '../../test/registry';
import { trpc } from '../../trpc';
import { DetailScreen } from '../entity-detail/DetailScreen';
import { NativeRow } from '../entity-detail/NativeRow';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { canRedoStep, canUndoStep, clearAllSteps, undoStep } from './arrows-stack';
import { BodyEditor } from './BodyEditor';
import { EditorShell } from './EditorShell';
import { hasLiveEditor } from './editor-cache';

const doc = parseBody('тело');
const handler = (path: string) =>
  registryReply(path) ?? (path === 'entity.resolveRefs' || path === 'entity.suggest' ? [] : {});
installCrashTrap();
const entity = { ...wireEntity({ id: 'e1', title: 'План' }), bodyDoc: doc };
function mount(ui: ReactNode) {
  let update: (v: ReactNode) => void = () => {};
  function Host() {
    const [view, set] = useState(ui);
    update = set;
    return view;
  }
  const r = renderWithProviders(<Host />, handler);
  return { ...r, rerender: (view: ReactNode) => act(() => update(view)) };
}
const pm = (): Editor =>
  (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
const key = (el: HTMLElement, shiftKey = false) =>
  fireEvent.keyDown(el, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey });
function Fields({
  id = 'e1',
  onChange = () => {},
  onSave = () => {},
}: {
  id?: string;
  onChange?: () => void;
  onSave?: (v: string, expected: string) => unknown;
}) {
  return (
    <>
      <NativeRow entity={{ ...entity, id }} onToggleTask={() => {}} onSaveTitle={onSave} />
      <BodyEditor entityId={id} doc={doc} onChange={onChange} />
    </>
  );
}
test('общий стек реального редактора: текст, заголовок, повтор заголовка родной клавишей', async () => {
  const save = vi.fn();
  renderWithProviders(<Fields onSave={save} />, handler);
  const title = await screen.findByTestId('title-edit');
  fireEvent.change(title, { target: { value: 'План Б' } });
  const ed = pm();
  act(() => {
    ed.commands.insertContentAt(ed.state.doc.content.size, '<p>абзац</p>');
  });
  key(ed.view.dom);
  expect(ed.getText()).not.toContain('абзац');
  expect(title).toHaveValue('План Б');
  key(ed.view.dom);
  expect(title).toHaveValue('План');
  expect(save).toHaveBeenLastCalledWith('План', 'План');
  key(title, true);
  expect(title).toHaveValue('План Б');
  expect(canRedoStep('e1')).toBe(true);
  key(ed.view.dom, true);
  expect(ed.getText()).toContain('абзац');
  expect(canRedoStep('e1')).toBe(false);
});
test('после ухода тот же экземпляр, актуальный onChange и история', async () => {
  const old = vi.fn(),
    current = vi.fn();
  const r = mount(<BodyEditor entityId="e1" doc={doc} onChange={old} />);
  const ed = pm();
  act(() => {
    ed.commands.insertContentAt(1, 'Х');
  });
  const live = { v: doc.v, doc: ed.getJSON() };
  r.rerender(<div />);
  r.rerender(<BodyEditor entityId="e1" doc={live} onChange={current} />);
  expect(pm()).toBe(ed);
  expect(ed.isDestroyed).toBe(false);
  act(() => {
    ed.commands.insertContentAt(1, 'Я');
  });
  expect(current).toHaveBeenCalledOnce();
  expect(old).toHaveBeenCalledTimes(1);
  act(() => {
    undoStep('e1');
  });
  expect(current).toHaveBeenCalledTimes(2);
});
test('внешнее тело сбрасывает native историю и общий стек; пустой стек не обращается к native undo', () => {
  const r = mount(<BodyEditor entityId="e1" doc={doc} onChange={() => {}} />);
  const ed = pm();
  act(() => {
    ed.commands.insertContentAt(1, 'Х');
  });
  r.rerender(<BodyEditor entityId="e1" doc={parseBody('чужое')} onChange={() => {}} />);
  expect(ed.getText()).toBe('чужое');
  expect(canUndoStep('e1')).toBe(false);
  key(ed.view.dom);
  expect(ed.getText()).toBe('чужое');
  expect(ed.commands.undo()).toBe(false);
});
test('пять отпущенных записей: шестая уничтожает первый реальный редактор', () => {
  const r = mount(<BodyEditor entityId="e1" doc={doc} onChange={() => {}} />);
  const ed = pm();
  for (let i = 2; i <= 6; i++) {
    r.rerender(<div />);
    r.rerender(<BodyEditor entityId={`e${i}`} doc={doc} onChange={() => {}} />);
  }
  expect(ed.isDestroyed).toBe(true);
  expect(hasLiveEditor('e1')).toBe(false);
});
test('EditorShell сразу поднимает сохранённый экземпляр без нового жеста', async () => {
  const r = mount(<EditorShell entityId="e1" doc={doc} markdown="тело" onChange={() => {}} />);
  fireEvent.click(screen.getByTestId('editor-preview'));
  await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
  const ed = pm();
  r.rerender(<div />);
  r.rerender(<EditorShell entityId="e1" doc={doc} markdown="тело" onChange={() => {}} />);
  expect(screen.queryByTestId('editor-preview')).toBeNull();
  await waitFor(() => expect(pm()).toBe(ed));
});
test('без entityId редактор предложения сохраняет родную историю и клавиши', () => {
  renderWithProviders(<BodyEditor doc={doc} onChange={() => {}} />, handler);
  const ed = pm();
  act(() => {
    ed.commands.insertContentAt(1, 'Х');
  });
  key(ed.view.dom);
  expect(ed.getText()).toBe('тело');
  key(ed.view.dom, true);
  expect(ed.getText()).toContain('Х');
});
test('clear отвязывает старые callbacks: прежний редактор не восстанавливает шаги', () => {
  mount(<BodyEditor entityId="e1" doc={doc} onChange={() => {}} />);
  const ed = pm();
  act(() => clearAllSteps());
  act(() => {
    ed.commands.insertContentAt(1, 'Х');
  });
  expect(canUndoStep('e1')).toBe(false);
});
test('тело → заголовок → тело в одной паузе сохраняют именно этот порядок', async () => {
  renderWithProviders(<Fields />, handler);
  const ed = pm();
  const title = await screen.findByTestId('title-edit');
  act(() => ed.commands.insertContentAt(1, 'А'));
  fireEvent.change(title, { target: { value: 'План Б' } });
  act(() => ed.commands.insertContentAt(2, 'Б'));
  key(ed.view.dom);
  expect(ed.getText()).toBe('Атело');
  expect(title).toHaveValue('План Б');
  key(ed.view.dom);
  expect(title).toHaveValue('План');
  key(ed.view.dom);
  expect(ed.getText()).toBe('тело');
});
test('cached readonly и обновлённые suggestions работают на текущем remount', () => {
  const r = mount(<BodyEditor entityId="e1" doc={doc} onChange={() => {}} />);
  const ed = pm();
  r.rerender(<div />);
  r.rerender(<BodyEditor entityId="e1" doc={doc} onChange={() => {}} readOnly />);
  expect(pm()).toBe(ed);
  expect(ed.isEditable).toBe(false);
  r.rerender(<BodyEditor entityId="e1" doc={doc} onChange={() => {}} />);
  expect(ed.isEditable).toBe(true);
  act(() => ed.commands.insertContentAt(1, '/'));
  expect(screen.getByTestId('slash-menu')).toBeInTheDocument();
});

async function openDetailEditor() {
  fireEvent.click(await screen.findByTestId('editor-preview'));
  await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
  return pm();
}
test('реальный экран: сохранённый title undo использует текущее видимое основание CAS', async () => {
  navAt('e1');
  let title = 'План',
    gets = 0;
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get') {
      gets++;
      return {
        entity: {
          ...entity,
          title,
          body: 'тело',
          bodyRevision: 1,
          bodyChangedAt: entity.updatedAt,
          bodyAction: null,
        },
        relations: [],
        thread: { threadId: 'th1', messages: [] },
      };
    }
    if (path === 'entity.update') {
      title = (input as { title: string }).title;
      return mockEntityUpdateResult({ ...entity, title });
    }
    return handler(path);
  });
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(gets).toBeGreaterThan(1));
  key(field);
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.update').at(-1)?.input).toMatchObject({
      title: 'План',
      expectedTitle: 'План Б',
    }),
  );
});
test('реальный экран: отказ CAS стирает общий стек и оставляет баннер R28', async () => {
  navAt('e1');
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return {
        entity: {
          ...entity,
          body: 'тело',
          bodyRevision: 1,
          bodyChangedAt: entity.updatedAt,
          bodyAction: null,
        },
        relations: [],
        thread: { threadId: 'th1', messages: [] },
      };
    if (path === 'entity.update')
      throw trpcError('CONFLICT', 'Чужое имя', {
        code: 'CONFLICT',
        details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
      });
    return handler(path);
  });
  const field = await screen.findByTestId('title-edit');
  const ed = await openDetailEditor();
  act(() => ed.commands.insertContentAt(1, 'Х'));
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await screen.findByText(/Заголовок изменён в другом месте/);
  expect(canUndoStep('e1')).toBe(false);
  expect(calls.some((c) => c.path === 'entity.update')).toBe(true);
  expect(field).toHaveValue('План Б');
});

test('частный редактор StrictMode не оставляет живых отвергнутых экземпляров после unmount', async () => {
  const created: Editor[] = [];
  const original = Editor.prototype.mount;
  const spy = vi.spyOn(Editor.prototype, 'mount').mockImplementation(function (this: Editor, el) {
    created.push(this);
    return original.call(this, el);
  });
  try {
    const r = renderWithProviders(<BodyEditor doc={doc} onChange={() => {}} />, handler, {
      strict: true,
    });
    expect(pm().getText()).toBe('тело');
    r.unmount();
    await waitFor(() => expect(created.every((e) => e.isDestroyed)).toBe(true));
  } finally {
    spy.mockRestore();
    for (const e of created) if (!e.isDestroyed) e.destroy();
  }
});

test('чужой заголовок, совпавший с прежней собственной отправкой, очищает историю', async () => {
  const save = vi.fn();
  const view = (title: string) => (
    <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
  );
  const r = mount(view('План'));
  const title = await screen.findByTestId('title-edit');
  fireEvent.change(title, { target: { value: 'План Б' } });
  fireEvent.blur(title);
  await waitFor(() => expect(save).toHaveBeenCalled());
  r.rerender(view('План Б'));
  fireEvent.change(title, { target: { value: 'План В' } });
  fireEvent.blur(title);
  r.rerender(view('План В'));
  expect(canUndoStep('e1')).toBe(true);
  r.rerender(view('План Б'));
  expect(canUndoStep('e1')).toBe(false);
});

test('pending rename → undo использует видимую основу; старый отказ после нового acceptance не гасит redo', async () => {
  navAt('e1');
  let title = 'План';
  let rejectFirst: (error: unknown) => void = () => {};
  const pending = new Promise((_resolve, reject) => {
    rejectFirst = reject;
  });
  let writes = 0,
    reads = 0;
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get') {
      reads++;
      return { entity: { ...entity, title }, relations: [], thread: null };
    }
    if (path === 'entity.update') {
      const vars = input as { title: string; expectedTitle: string };
      if (++writes === 1) {
        // В текущем серверном снимке Б уже установил конкурентный писатель;
        // удержанный запрос ещё не получил решения и позднее получит отказ CAS.
        title = 'План Б';
        return pending;
      }
      expect(vars.expectedTitle).toBe(title);
      title = vars.title;
      return mockEntityUpdateResult({ ...entity, title });
    }
    return handler(path);
  });
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(writes).toBe(1));
  key(field);
  await waitFor(() => expect(writes).toBe(2));
  expect(calls.filter((c) => c.path === 'entity.update').at(-1)?.input).toMatchObject({
    title: 'План',
    expectedTitle: 'План Б',
  });
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  expect(field).toHaveValue('План');
  expect(canRedoStep('e1')).toBe(true);
  await act(async () => {
    rejectFirst(
      trpcError('CONFLICT', 'Поздний отказ', {
        code: 'CONFLICT',
        details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
      }),
    );
    await pending.catch(() => {});
  });
  await waitFor(() => expect(reads).toBeGreaterThan(2));
  expect(canRedoStep('e1')).toBe(true);
  expect(screen.queryByText(/Заголовок изменён в другом месте/)).toBeNull();
  expect(field).toHaveValue('План');
});

test('CAS отказ отмены несохранённого title очищает redo даже без смены visible value', async () => {
  navAt('e1');
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  renderWithProviders(<DetailScreen entityId="e1" />, async (path) => {
    if (path === 'entity.get') return { entity, relations: [], thread: null };
    if (path === 'entity.update') {
      writes++;
      await barrier;
      throw trpcError('CONFLICT', 'Чужое имя', {
        code: 'CONFLICT',
        details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
      });
    }
    return handler(path);
  });
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  key(field);
  await waitFor(() => expect(writes).toBe(1));
  expect(field).toHaveValue('План');
  expect(canRedoStep('e1')).toBe(true);
  await act(async () => {
    release();
    await barrier;
  });
  await screen.findByText(/Заголовок изменён в другом месте/);
  expect(canUndoStep('e1')).toBe(false);
  expect(canRedoStep('e1')).toBe(false);
  expect(field).toHaveValue('План');
});

test('title SUCCESS после checkbox SUCCESS всё ещё принимает title перед старым title отказом', async () => {
  navAt('e1');
  const task = { ...entity, aspects: ['orbis/task'], props: { 'orbis/task_status': 'inbox' } };
  let title = 'План',
    writes = 0,
    reads = 0;
  let rejectOld: (e: unknown) => void = () => {};
  let acceptNew: (v: unknown) => void = () => {};
  const old = new Promise((_resolve, reject) => {
    rejectOld = reject;
  });
  const next = new Promise((resolve) => {
    acceptNew = resolve;
  });
  renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get') {
      reads++;
      return { entity: { ...task, title }, relations: [], thread: null };
    }
    if (path === 'entity.update') {
      writes++;
      const vars = input as { title?: string };
      if (writes === 1) {
        title = 'План Б';
        return old;
      }
      if (vars.title !== undefined) {
        title = vars.title;
        return next;
      }
      return mockEntityUpdateResult({ ...task, title });
    }
    return handler(path);
  });
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(writes).toBe(1));
  key(field);
  await waitFor(() => expect(writes).toBe(2));
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(writes).toBe(3));
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  await act(async () => {
    acceptNew(mockEntityUpdateResult({ ...task, title: 'План' }));
    await next;
  });
  await waitFor(() => expect(reads).toBeGreaterThan(2));
  expect(canRedoStep('e1')).toBe(true);
  await act(async () => {
    rejectOld(
      trpcError('CONFLICT', 'Старый отказ', {
        code: 'CONFLICT',
        details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
      }),
    );
    await old.catch(() => {});
  });
  await waitFor(() => expect(reads).toBeGreaterThan(3));
  expect(canRedoStep('e1')).toBe(true);
  expect(screen.queryByText(/Заголовок изменён в другом месте/)).toBeNull();
});

for (const firstSucceeds of [false, true])
  test(`старый title ${firstSucceeds ? 'SUCCESS' : 'FAIL'} не принимает текущий FAILED title`, async () => {
    navAt('e1');
    let writes = 0,
      reads = 0;
    let releaseFirst: () => void = () => {},
      releaseSecond: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const stale = () =>
      trpcError('CONFLICT', 'Чужое имя', {
        code: 'CONFLICT',
        details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
      });
    renderWithProviders(<DetailScreen entityId="e1" />, async (path) => {
      if (path === 'entity.get') {
        reads++;
        return { entity, relations: [], thread: null };
      }
      if (path === 'entity.update') {
        const n = ++writes;
        await (n === 1 ? first : second);
        if (n === 1 && firstSucceeds) return mockEntityUpdateResult({ ...entity, title: 'План Б' });
        throw stale();
      }
      return handler(path);
    });
    const field = await screen.findByTestId('title-edit');
    fireEvent.change(field, { target: { value: 'План Б' } });
    fireEvent.blur(field);
    await waitFor(() => expect(writes).toBe(1));
    fireEvent.change(field, { target: { value: 'План В' } });
    fireEvent.blur(field);
    await waitFor(() => expect(writes).toBe(2));
    await act(async () => {
      releaseFirst();
      await first;
    });
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    fireEvent.change(field, { target: { value: 'План В ещё' } });
    expect(canUndoStep('e1')).toBe(true);
    await act(async () => {
      releaseSecond();
      await second;
    });
    await waitFor(() => expect(reads).toBeGreaterThan(2));
    expect(screen.getByText(/Заголовок изменён в другом месте/)).toBeInTheDocument();
    expect(canUndoStep('e1')).toBe(false);
    expect(field).toHaveValue('План В ещё');
  });

test('e1 → e2 → e1: история title живёт в LRU, cold поле берёт current server basis', async () => {
  navAt('e1');
  let change!: (id: string) => void;
  let firstTitle = 'План',
    reads = 0;
  function Host() {
    const [id, set] = useState('e1');
    change = set;
    return <DetailScreen entityId={id} />;
  }
  const { calls } = renderWithProviders(<Host />, (path, input) => {
    const vars = input as { id?: string; title?: string; expectedTitle?: string };
    if (path === 'entity.get') {
      reads++;
      return {
        entity: { ...entity, id: vars.id ?? 'e1', title: vars.id === 'e2' ? 'Сосед' : firstTitle },
        relations: [],
        thread: null,
      };
    }
    if (path === 'entity.update') {
      expect(vars.id).toBe('e1');
      expect(vars.expectedTitle).toBe(firstTitle);
      firstTitle = vars.title ?? firstTitle;
      return mockEntityUpdateResult({ ...entity, title: firstTitle });
    }
    return handler(path);
  });
  let field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  act(() => change('e2'));
  await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
  act(() => change('e1'));
  await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('План Б'));
  field = screen.getByTestId('title-edit');
  key(field);
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.update').at(-1)?.input).toMatchObject({
      id: 'e1',
      title: 'План',
      expectedTitle: 'План Б',
    }),
  );
  expect(field).toHaveValue('План');
});

test('title SUCCESS вне e1 затем e1 remount не возвращает право старому FAIL стереть redo', async () => {
  navAt('e1');
  let change!: (id: string) => void;
  let title = 'План',
    writes = 0,
    firstReads = 0;
  let rejectOld: (e: unknown) => void = () => {},
    acceptNew: (v: unknown) => void = () => {};
  const old = new Promise((_resolve, reject) => {
    rejectOld = reject;
  });
  const next = new Promise((resolve) => {
    acceptNew = resolve;
  });
  function Host() {
    const [id, set] = useState('e1');
    change = set;
    const warm = trpc.entity.get.useQuery(detailGetInput('e2'));
    return (
      <>
        <span data-testid="warm-e2">{warm.data?.entity.title}</span>
        <DetailScreen entityId={id} />
      </>
    );
  }
  renderWithProviders(<Host />, (path, input) => {
    const vars = input as { id?: string; title?: string };
    if (path === 'entity.get') {
      if (vars.id === 'e1') firstReads++;
      return {
        entity: { ...entity, id: vars.id ?? 'e1', title: vars.id === 'e2' ? 'Сосед' : title },
        relations: [],
        thread: null,
      };
    }
    if (path === 'entity.update') {
      if (++writes === 1) {
        // Б — текущий снимок конкурентного писателя, а не запись отказавшего save.
        title = 'План Б';
        return old;
      }
      title = vars.title ?? title;
      return next;
    }
    return handler(path);
  });
  const field = await screen.findByTestId('title-edit');
  await waitFor(() => expect(screen.getByTestId('warm-e2')).toHaveTextContent('Сосед'));
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(writes).toBe(1));
  key(field);
  await waitFor(() => expect(writes).toBe(2));
  act(() => change('e2'));
  await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
  await act(async () => {
    acceptNew(mockEntityUpdateResult({ ...entity, title: 'План' }));
    await next;
  });
  act(() => change('e1'));
  await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('План'));
  await waitFor(() => expect(firstReads).toBeGreaterThan(1));
  expect(canRedoStep('e1')).toBe(true);
  const before = firstReads;
  await act(async () => {
    rejectOld(
      trpcError('CONFLICT', 'Старый отказ', {
        code: 'CONFLICT',
        details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
      }),
    );
    await old.catch(() => {});
  });
  await waitFor(() => expect(firstReads).toBeGreaterThan(before));
  expect(canRedoStep('e1')).toBe(true);
  expect(screen.queryByText(/Заголовок изменён в другом месте/)).toBeNull();
});

test('own undo к уже видимому title не даёт вечное доверие последующему чужому совпадению', async () => {
  navAt('e1');
  const task = { ...entity, aspects: ['orbis/task'], props: { 'orbis/task_status': 'inbox' } };
  let title = 'План',
    reads = 0;
  renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get') {
      reads++;
      return { entity: { ...task, title }, relations: [], thread: null };
    }
    if (path === 'entity.update') {
      const vars = input as { title?: string };
      title = vars.title ?? title;
      return mockEntityUpdateResult({ ...task, title });
    }
    return handler(path);
  });
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  key(field); // Сохраняется прежний показанный План: prop value не меняется.
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  fireEvent.change(field, { target: { value: 'План В' } });
  fireEvent.blur(field);
  await waitFor(() => expect(reads).toBeGreaterThan(2));
  expect(canUndoStep('e1')).toBe(true);
  title = 'План'; // Чужое переименование после подтверждённого План В.
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(reads).toBeGreaterThan(3));
  expect(field).toHaveValue('План');
  expect(canUndoStep('e1')).toBe(false);
});

test('native beforeinput historyUndo/historyRedo идёт по общему title/body порядку', async () => {
  renderWithProviders(<Fields />, handler);
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  const ed = pm();
  act(() => ed.commands.insertContentAt(1, 'Х'));
  const input = (type: string) =>
    act(() => {
      const event = new InputEvent('beforeinput', {
        inputType: type,
        bubbles: true,
        cancelable: true,
      });
      ed.view.dom.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  input('historyUndo');
  expect(ed.getText()).toBe('тело');
  expect(field).toHaveValue('План Б');
  input('historyUndo');
  expect(field).toHaveValue('План');
  input('historyRedo');
  expect(field).toHaveValue('План Б');
  input('historyRedo');
  expect(ed.getText()).toBe('Хтело');
});

test('rapid own optimistic props coalescing не доверяет позднему foreign return к старому v', async () => {
  navAt('e1');
  const task = { ...entity, aspects: ['orbis/task'], props: { 'orbis/task_status': 'inbox' } };
  let title = 'План',
    reads = 0,
    writes = 0;
  let rejectOld!: (e: unknown) => void;
  const old = new Promise((_resolve, reject) => {
    rejectOld = reject;
  });
  renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get') {
      reads++;
      return { entity: { ...task, title }, relations: [], thread: null };
    }
    if (path === 'entity.update') {
      const vars = input as { title?: string };
      if (vars.title !== undefined && ++writes === 1) return old; // Запрос Б не был принят.
      title = vars.title ?? title;
      return mockEntityUpdateResult({ ...task, title });
    }
    return handler(path);
  });
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  fireEvent.change(field, { target: { value: 'План В' } });
  fireEvent.blur(field);
  await waitFor(() => expect(writes).toBe(2));
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  expect(field).toHaveValue('План В');
  await act(async () => {
    rejectOld(
      trpcError('CONFLICT', 'Старый отказ', {
        code: 'CONFLICT',
        details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
      }),
    );
    await old.catch(() => {});
  });
  await waitFor(() => expect(reads).toBeGreaterThan(2));
  expect(canUndoStep('e1')).toBe(true);
  title = 'План Б';
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(reads).toBeGreaterThan(3));
  expect(field).toHaveValue('План Б');
  expect(canUndoStep('e1')).toBe(false);
});

for (const duplicate of [false, true]) {
  test(`наблюдение старой собственной отправки сохраняет более новую: duplicate=${duplicate}`, async () => {
    const save = vi.fn(() => new Promise(() => {}));
    const view = (title: string) => (
      <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
    );
    const r = mount(view('План'));
    const field = await screen.findByTestId('title-edit');
    for (const title of duplicate ? ['План Б', 'План В', 'План Б'] : ['План Б', 'План В']) {
      fireEvent.change(field, { target: { value: title } });
      fireEvent.blur(field);
    }
    expect(save).toHaveBeenCalledTimes(duplicate ? 3 : 2);
    r.rerender(view(duplicate ? 'План В' : 'План Б'));
    expect(canUndoStep('e1')).toBe(true);
    r.rerender(view(duplicate ? 'План Б' : 'План В'));
    expect(canUndoStep('e1')).toBe(true);
    r.rerender(view(duplicate ? 'План В' : 'План Б'));
    expect(canUndoStep('e1')).toBe(false);
  });
}

test('повторная отправка значения обновляет его очередь до более позднего intent', async () => {
  const save = vi.fn(() => new Promise(() => {}));
  const view = (title: string) => (
    <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
  );
  const r = mount(view('План'));
  const field = await screen.findByTestId('title-edit');
  for (const title of ['План Б', 'План В', 'План Б']) {
    fireEvent.change(field, { target: { value: title } });
    fireEvent.blur(field);
  }
  expect(save).toHaveBeenCalledTimes(3);
  r.rerender(view('План Б'));
  expect(canUndoStep('e1')).toBe(true);
  r.rerender(view('План В'));
  expect(canUndoStep('e1')).toBe(false);
});

test('own nochange marker не переживает чужой reset и новый несохранённый ввод', async () => {
  const save = vi.fn();
  const view = (title: string) => (
    <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
  );
  const r = mount(view('План'));
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План А' } });
  key(field);
  await waitFor(() => expect(save).toHaveBeenCalledWith('План', 'План'));
  r.rerender(view('План Б'));
  expect(canUndoStep('e1')).toBe(false);
  fireEvent.change(field, { target: { value: 'План В' } });
  expect(canUndoStep('e1')).toBe(true);
  r.rerender(view('План'));
  expect(field).toHaveValue('План В');
  expect(canUndoStep('e1')).toBe(false);
});

test('private native recreation использует новый текущий Editor после уничтожения предыдущего', async () => {
  const held = { editor: null as Editor | null };
  const onChange = vi.fn();
  const ready = (e: Editor) => {
    held.editor = e;
  };
  const view = () => <BodyEditor doc={doc} onChange={onChange} onReady={ready} />;
  const r = mount(view());
  await waitFor(() => expect(held.editor).not.toBeNull());
  const first = held.editor;
  act(() => first?.destroy());
  r.rerender(view());
  await waitFor(() => expect(held.editor).not.toBe(first));
  expect(first?.isDestroyed).toBe(true);
  expect(pm()).toBe(held.editor);
  act(() => pm().commands.insertContentAt(1, 'Н'));
  expect(pm().getText()).toBe('Нтело');
  expect(onChange).toHaveBeenCalled();
});
