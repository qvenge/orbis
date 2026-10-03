import { parseBody } from '@orbis/shared/doc';
import type { BodyKind } from '@orbis/shared/doc/placement';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthProvider';
import { useSession } from '../../auth/supabase';
import { BodyKindProvider } from '../../lib/query-blocks/body-kind';
import {
  blocksReply,
  installCrashTrap,
  renderWithProviders,
  trpcError,
  wireEntity,
} from '../../test/harness';
import { registryReply } from '../../test/registry';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';
import { BodyEditor } from './BodyEditor';

vi.mock('../../auth/supabase', () => ({ auth: { signOut: vi.fn() }, useSession: vi.fn() }));
let gateClient: QueryClient;
function CaptureGateClient() {
  gateClient = useQueryClient();
  return null;
}
type Suggestion = { id: string; title: string; emoji: string | null; status: string | null };
const suggestion = (id: string, title: string): Suggestion => ({
  id,
  title,
  emoji: null,
  status: null,
});

const NEW_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * СТРОГИЙ мок: `entity.suggest` отвечает ТОЛЬКО про тот `term`, о котором спросили, и только
 * если спросили именно полем `term`. Щедрый мок (отдающий список на что угодно) сделал бы
 * неотличимыми правильный вызов и вызов с полем `prefix`/`query` — контракт переименовали
 * коммитом 6df313f, и тест обязан ловить возврат старого имени.
 *
 * Пачка `entity.blocks` тоже отвечает каждому блоку по ЕГО тексту (`blocksReply`): виджет со
 * СТАРЫМ атрибутом иначе был бы неотличим от виджета с новым (тот же приём, что в
 * query-widget.test.tsx). Блок просит данные текстом атрибута (спека страниц 1а §6.3), дерево на
 * сервер не уходит — приводить его к ключу печатью больше не нужно.
 */

const api =
  (opts: {
    byTerm?: Record<string, Suggestion[]>;
    byQuery?: Record<string, { id: string; title: string }[]>;
    created?: { id: string; title: string };
    createFails?: boolean;
  }) =>
  (path: string, input: unknown): unknown => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    if (path === 'entity.blocks') {
      const rows = Object.fromEntries(
        Object.entries(opts.byQuery ?? {}).map(([q, list]) => [q, list.map((e) => wireEntity(e))]),
      );
      return blocksReply(rows)(path, input);
    }
    if (path === 'entity.suggest') {
      const term = (input as { term?: unknown }).term;
      if (typeof term !== 'string') throw trpcError('BAD_REQUEST', 'ожидалось поле term');
      return opts.byTerm?.[term] ?? [];
    }
    if (path === 'entity.resolveRefs') {
      const ids = new Set((input as { ids: string[] }).ids);
      const rows = [
        ...Object.values(opts.byTerm ?? {}).flat(),
        ...(opts.created ? [suggestion(opts.created.id, opts.created.title)] : []),
      ];
      return rows.filter((r) => ids.has(r.id)).map((r) => ({ ...r, archived: false }));
    }
    if (path === 'entity.create') {
      if (opts.createFails) throw trpcError('BAD_REQUEST', 'создание не удалось');
      const title = (input as { input: { title: string } }).input.title;
      return { id: opts.created?.id ?? NEW_ID, title };
    }
    return {};
  };

type Held = { editor: Editor | null };

/**
 * Редактор с телом `md`, каретка в КОНЦЕ текста.
 *
 * Набирают тесты через `userEvent.keyboard`, а не через `userEvent.type(area, …)`: `type()`
 * перед вводом КЛИКАЕТ, а клик по contenteditable jsdom разрешает по геометрии, которой нет
 * (все прямоугольники нулевые, elementFromPoint отдаёт null — tests/prosemirror-polyfill.ts),
 * и каретка каждый раз укладывается в НАЧАЛО абзаца. Замерено: `type(area, ' /заг')` по телу
 * «привет» даёт текст « /загпривет». Тесту про вставку «в позицию каретки» такая адресация
 * не годится вовсе — она проверяла бы вставку в начало. `keyboard()` печатает в то, что
 * сфокусировано, и оставляет позицию за `commands.focus`.
 */
async function mountEditor(
  md: string,
  handler: (p: string, i: unknown) => unknown,
  // Род тела (§5.5) — как его ставит экран записи (EntityBody); по умолчанию — заметка.
  kind: BodyKind = 'note',
) {
  const onChange = vi.fn();
  const h: Held = { editor: null };
  // AuthProvider должен сам перечитать useSession при неизменном editor child.
  function SessionHost() {
    const [, refresh] = useState(0);
    return (
      <>
        <button type="button" onClick={() => refresh((n) => n + 1)}>
          ownerchange
        </button>
        <AuthProvider>
          <CaptureGateClient />
          <BodyKindProvider kind={kind}>
            <BodyEditor
              doc={parseBody(md)}
              onChange={onChange}
              onReady={(e) => {
                h.editor = e;
              }}
            />
            <Toaster />
          </BodyKindProvider>
        </AuthProvider>
      </>
    );
  }
  const r = renderWithProviders(<SessionHost />, handler);
  await waitFor(() => expect(h.editor).not.toBeNull());
  const area = (await screen.findByTestId('body-editor')).querySelector(
    '[contenteditable]',
  ) as HTMLElement;
  // Клик — ОДИН раз и здесь, и он нужен ради ФОКУСА, а не сам по себе: `userEvent.keyboard`
  // печатает в `document.activeElement`, и без фокуса набор не доезжает никуда. Прежняя
  // запись этого замера («без клика user-event не вставляет в contenteditable вовсе») мерила
  // не то: после НАСТОЯЩЕГО фокуса — `commands.focus()` плюс кадр, который тот ждёт через
  // requestAnimationFrame, — набор доезжает и без единого клика (перемерено ре-ревью пакета B;
  // на этом стоят тесты фокуса в editor.test.tsx). Клик оставлен потому, что он короче
  // ожидания кадра. Он же укладывает каретку в начало, поэтому позицию задаём СЛЕДОМ,
  // командой редактора.
  await userEvent.click(area);
  h.editor?.commands.focus('end');
  return { r, h, onChange, area };
}

const rows = () => screen.getAllByRole('option').map((o) => o.textContent ?? '');
installCrashTrap();
test('gate18 actual ownerchange old mention rejection must not resurrect toast after session reset', async () => {
  vi.mocked(useSession).mockReturnValue({ token: 'jwt1', userId: 'u1', status: 'authed' } as never);
  let reject!: (e: unknown) => void;
  const held = new Promise((_, rej) => {
    reject = rej;
  });
  const rest = api({});
  const { r } = await mountEditor('см', (p, i) => (p === 'entity.create' ? held : rest(p, i)));
  await userEvent.keyboard(' @Стирка');
  await waitFor(() => expect(rows()).toEqual(['Создать «Стирка»']));
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(r.calls.some((c) => c.path === 'entity.create')).toBe(true));
  vi.mocked(useSession).mockReturnValue({ token: 'jwt2', userId: 'u2', status: 'authed' } as never);
  r.rerender(
    <AuthProvider>
      <div data-testid="new-owner">u2</div>
    </AuthProvider>,
  );
  expect(screen.getByTestId('new-owner')).toHaveTextContent('u2');
  expect(useToastStore.getState().toasts).toEqual([]);
  await act(async () => {
    reject(trpcError('BAD_REQUEST', 'old failure'));
  });
  await waitFor(() =>
    expect(
      gateClient
        .getMutationCache()
        .getAll()
        .some((m) => m.state.status === 'error'),
    ).toBe(true),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(useToastStore.getState().toasts).toEqual([]);
});

test('gate18 current owner mention rejection retains ordinary error', async () => {
  vi.mocked(useSession).mockReturnValue({ token: 'jwt1', userId: 'u1', status: 'authed' } as never);
  await mountEditor('см', api({ createFails: true }));
  await userEvent.keyboard(' @Стирка');
  await waitFor(() => expect(rows()).toEqual(['Создать «Стирка»']));
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByText('Не удалось создать запись')).toBeInTheDocument();
});

test('current owner mention success inserts the created reference', async () => {
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt',
    userId: 'current-success',
    status: 'authed',
  } as never);
  const { h } = await mountEditor('см', api({ created: { id: NEW_ID, title: 'Стирка' } }));
  await userEvent.keyboard(' @Стирка');
  await waitFor(() => expect(rows()).toEqual(['Создать «Стирка»']));
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(JSON.stringify(h.editor?.getJSON())).toContain('entityRef'));
  expect(JSON.stringify(h.editor?.getJSON())).toContain(NEW_ID);
});

test('old owner mention success leaves the still mounted editor untouched', async () => {
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt1',
    userId: 'mention-old',
    status: 'authed',
  } as never);
  let resolve!: (value: unknown) => void;
  const held = new Promise((resolveHeld) => {
    resolve = resolveHeld;
  });
  const rest = api({});
  const { r, h } = await mountEditor('см', (p, i) => (p === 'entity.create' ? held : rest(p, i)));
  await userEvent.keyboard(' @Стирка');
  await waitFor(() => expect(rows()).toEqual(['Создать «Стирка»']));
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(r.calls.some((c) => c.path === 'entity.create')).toBe(true));
  const snapshot = h.editor?.getJSON();
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt2',
    userId: 'mention-new',
    status: 'authed',
  } as never);
  // Тот же экземпляр редактора: положительный контроль не зависит от его уничтожения.
  fireEvent.click(screen.getByText('ownerchange'));
  await act(async () => {
    resolve({ id: NEW_ID, title: 'Стирка' });
  });
  await waitFor(() =>
    expect(
      gateClient
        .getMutationCache()
        .getAll()
        .some((m) => m.state.status === 'success'),
    ).toBe(true),
  );
  expect(h.editor?.getJSON()).toEqual(snapshot);
  expect(useToastStore.getState().toasts).toEqual([]);
});

test('private sameEditor после ownerchange принимает новый ввод и новое mention меню', async () => {
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt1',
    userId: 'live-private1',
    status: 'authed',
  } as never);
  const { r, h, onChange } = await mountEditor('см', api({}));
  const initial = h.editor;
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt2',
    userId: 'live-private2',
    status: 'authed',
  } as never);
  fireEvent.click(screen.getByText('ownerchange'));
  expect(h.editor).toBe(initial);
  onChange.mockClear();
  h.editor?.commands.focus('end');
  await userEvent.keyboard(' @Новое');
  expect(onChange).toHaveBeenCalled();
  await waitFor(() => expect(rows()).toEqual(['Создать «Новое»']));
  expect(
    r.calls.some(
      (c) => c.path === 'entity.suggest' && (c.input as { term?: string }).term === 'Новое',
    ),
  ).toBe(true);
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(JSON.stringify(h.editor?.getJSON())).toContain(NEW_ID));
  expect(r.calls.filter((c) => c.path === 'entity.create')).toHaveLength(1);
  h.editor?.commands.focus('end');
  await userEvent.keyboard(' /заг');
  await screen.findByTestId('slash-menu');
  expect(h.editor).toBe(initial);
});
