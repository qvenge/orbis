import type { BodyActionInfo, UndoResult } from '@orbis/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthProvider';
import { useSession } from '../../auth/supabase';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { resetNavForTests } from '../../state/navigation';
import {
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  trpcError,
} from '../../test/harness';
import { navAt } from '../../test/nav';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';
import { type FlushResult, registerBodyFlush } from '../entity-editor/body-flush';
import { resetUndoSession } from '../undo/undo-epoch';
import { peekUndoable } from '../undo/undo-stack';
import { CONTINUE_UNDO } from '../undo/undo-toast';
import { resetDetailMenuModuleForTests } from './DetailMenuSlot';
import { DetailScreen } from './DetailScreen';
import { revertTextLabel, useRevertTextItem } from './RevertTextItem';
import { STRUCTURE_FIXTURES, structureHandler } from './structure-fixtures';

vi.mock('../../auth/supabase', () => ({ auth: { signOut: vi.fn() }, useSession: vi.fn() }));
installCrashTrap();
const at = (hhmm: string, day = '30') =>
  `2026-09-${day}T${String(Number(hhmm.slice(0, 2)) - 3).padStart(2, '0')}:${hhmm.slice(3)}:00.000Z`;
const NOW = new Date(at('15:00'));
const session = (p: Partial<BodyActionInfo> = {}): BodyActionInfo => ({
  actionId: 's1',
  textSession: true,
  mine: true,
  actorKind: 'owner',
  startedAt: at('14:02'),
  endedAt: at('14:18'),
  ...p,
});
const LABEL = 'Вернуть текст как на 14:02 · правка текста 14:02–14:18';
const RESULT: UndoResult = {
  actionId: 'u1',
  undone: { id: 's1', title: 'правка текста 14:02–14:18' },
  pinnedVersions: [{ entityId: 'e1', versionId: 'v1', label: 'перед возвратом к 14:02' }],
  bodyRevisions: [{ entityId: 'e1', bodyRevision: 2 }],
};
const cleanupFlush: (() => void)[] = [];
beforeEach(() => {
  // Только Date: асинхронные события и реальный досыл сохраняют живые таймеры.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetDetailMenuModuleForTests();
  resetUndoSession();
  vi.stubGlobal('requestIdleCallback', () => 1);
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt1',
    userId: 'revert-owner',
    status: 'authed',
  } as never);
});
afterEach(() => {
  for (const cleanup of cleanupFlush.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetNavForTests();
});
function Probe({ a = session() }: { a?: BodyActionInfo | null }) {
  const item = useRevertTextItem('e1', a);
  return (
    <>
      {item && (
        <button type="button" onClick={item.onSelect}>
          {item.label}
        </button>
      )}
      <Toaster />
    </>
  );
}
const settings = { timezone: 'Europe/Moscow' };
const probeApi: MockHandler = (path) => (path === 'user.getSettings' ? settings : {});
function OwnerHost({ children }: { children: ReactNode }) {
  const [, refresh] = useState(0);
  return (
    <>
      <button type="button" onClick={() => refresh((n) => n + 1)}>
        ownerchange
      </button>
      <AuthProvider>{children}</AuthProvider>
    </>
  );
}
function probe(handler: MockHandler = probeApi) {
  return renderWithProviders(
    <OwnerHost>
      <Probe />
    </OwnerHost>,
    handler,
  );
}
const undoCalls = (r: ReturnType<typeof renderWithProviders>) =>
  r.calls.filter((c) => c.path === 'ai.undo');
const click = async () => fireEvent.click(await screen.findByRole('button', { name: LABEL }));
async function drain() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const conflict = () =>
  trpcError('CONFLICT', 'сменился текст', {
    code: 'UNDO_TEXT_CHANGED',
    details: {
      action: { id: 's1', title: RESULT.undone.title },
      entries: [
        { entityId: 'e1', title: 'Запись', actorKind: 'ai', actorLabel: null, at: at('14:30') },
      ],
      continuation: { kind: 'here' },
    },
  });

test('подпись называет отрезок, неизвестный конец и другой день в поясе владельца', () => {
  expect(revertTextLabel(session(), 'Europe/Moscow', NOW)).toBe(LABEL);
  expect(revertTextLabel(session({ endedAt: null }), 'Europe/Moscow', NOW)).toBe(
    'Вернуть текст как на 14:02 · правка текста 14:02',
  );
  expect(
    revertTextLabel(session({ startedAt: at('14:02', '29'), endedAt: null }), 'Europe/Moscow', NOW),
  ).toBe('Вернуть текст как на 29 сент., 14:02 · правка текста 29 сент., 14:02');
  expect(revertTextLabel(session(), 'Asia/Novosibirsk', NOW)).toBe(
    'Вернуть текст как на 18:02 · правка текста 18:02–18:18',
  );
});
const f = (() => {
  const note = STRUCTURE_FIXTURES.find((f) => f.name === 'note');
  if (note === undefined) throw new Error('нет фикстуры заметки');
  return note;
})();
function openScreen(a: BodyActionInfo | null, next?: BodyActionInfo) {
  let current = a;
  const base = structureHandler(f);
  navAt(f.entity.id);
  return renderWithProviders(
    <>
      <DetailScreen entityId={f.entity.id} />
      <Toaster />
    </>,
    (path, input) => {
      if (path === 'user.getSettings')
        return { ...(base(path, input) as object), timezone: 'Europe/Moscow' };
      if (path === 'entity.get' && (input as { id: string }).id === f.entity.id)
        return { ...(base(path, input) as object), bodyAction: current };
      if (path === 'ai.undo') {
        current = next ?? null;
        return { ...RESULT, bodyRevisions: [{ entityId: f.entity.id, bodyRevision: 2 }] };
      }
      return base(path, input);
    },
  );
}
async function openMenu() {
  fireEvent.keyDown(await screen.findByTestId('screen-menu'), { key: 'Enter' });
  await screen.findByRole('menu');
}
const menuLabels = () =>
  within(screen.getByRole('group', { name: 'Этот экран' }))
    .getAllByRole('menuitem')
    .map((n) => n.textContent ?? '');
test('свежий экран показывает серверный сеанс сразу после закрепления версии', async () => {
  openScreen(session());
  await openMenu();
  await screen.findByRole('menuitem', { name: LABEL });
  const labels = menuLabels();
  expect(labels[labels.indexOf('Закрепить версию') + 1]).toBe(LABEL);
});
test.each([
  session({ mine: false }),
  session({ textSession: false }),
  null,
])('свежий экран скрывает не свой или не текстовый действующий сеанс: %j', async (a) => {
  openScreen(a);
  await openMenu();
  await screen.findByRole('menuitem', { name: 'Закрепить версию' });
  expect(menuLabels().filter((label) => label.startsWith('Вернуть текст как на'))).toEqual([]);
});
test('успешный возврат перечитывает экран и предлагает следующий сеанс', async () => {
  const r = openScreen(
    session(),
    session({ actionId: 's0', startedAt: at('13:10'), endedAt: at('13:40') }),
  );
  await openMenu();
  fireEvent.click(await screen.findByRole('menuitem', { name: LABEL }));
  await screen.findByText(`Отменено: ${RESULT.undone.title}`);
  await waitFor(() =>
    expect(
      r.calls.filter(
        (c) => c.path === 'entity.get' && (c.input as { id: string }).id === f.entity.id,
      ).length,
    ).toBeGreaterThan(1),
  );
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  await openMenu();
  await screen.findByRole('menuitem', {
    name: 'Вернуть текст как на 13:10 · правка текста 13:10–13:40',
  });
  expect(undoCalls(r).map((c) => c.input)).toEqual([{ actionId: 's1' }]);
  expect(peekUndoable()).toBeUndefined();
});
test('возврат ждёт досыл своего тела, называет серверную страховочную версию и не пишет вторую', async () => {
  const order: string[] = [];
  const held = deferred<FlushResult>();
  cleanupFlush.push(
    registerBodyFlush('e1', () => {
      order.push('flush:e1');
      return held.promise;
    }),
  );
  // Чужая смонтированная запись не должна досылаться вместо явно указанной.
  cleanupFlush.push(
    registerBodyFlush('other', async () => {
      order.push('flush:other');
      return 'blocked';
    }),
  );
  const r = probe((path) => {
    if (path === 'ai.undo') {
      order.push(path);
      return RESULT;
    }
    return probeApi(path, undefined);
  });
  await click();
  expect(order).toEqual(['flush:e1']);
  expect(undoCalls(r)).toEqual([]);
  await act(async () => held.resolve('saved'));
  await screen.findByText(`Отменено: ${RESULT.undone.title}`);
  expect(order).toEqual(['flush:e1', 'ai.undo']);
  expect(undoCalls(r).map((c) => c.input)).toEqual([{ actionId: 's1' }]);
  expect(
    await screen.findByText('ваш текст — в версии «перед возвратом к 14:02» (Детали → Версии)'),
  ).toBeInTheDocument();
  expect(r.calls.filter((c) => c.path.startsWith('version.'))).toEqual([]);
});
test.each([
  'blocked',
  'offline',
] as const)('отказ досыла %s не отправляет отмену', async (state) => {
  cleanupFlush.push(registerBodyFlush('e1', async () => state));
  const r = probe((path) => (path === 'ai.undo' ? RESULT : probeApi(path, undefined)));
  await click();
  await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
  expect(undoCalls(r)).toEqual([]);
  expect(screen.queryByText(`Отменено: ${RESULT.undone.title}`)).not.toBeInTheDocument();
});
test('гонка отказывает с here, продолжение досылает снова и отправляет force с серверной версией', async () => {
  let count = 0;
  const order: string[] = [];
  cleanupFlush.push(
    registerBodyFlush('e1', async () => {
      order.push('flush');
      return 'nothing';
    }),
  );
  const r = probe((path) => {
    if (path === 'ai.undo') {
      order.push('undo');
      if (++count === 1) throw conflict();
      return RESULT;
    }
    return probeApi(path, undefined);
  });
  await click();
  fireEvent.click(await screen.findByRole('button', { name: CONTINUE_UNDO }));
  await screen.findByText(`Отменено: ${RESULT.undone.title}`);
  expect(undoCalls(r).map((c) => c.input)).toEqual([
    { actionId: 's1' },
    { actionId: 's1', force: true },
  ]);
  expect(order).toEqual(['flush', 'undo', 'flush', 'undo']);
  expect(
    await screen.findByText('ваш текст — в версии «перед возвратом к 14:02» (Детали → Версии)'),
  ).toBeInTheDocument();
});
test('already не выдаётся за новый undone', async () => {
  const r = probe((path) => {
    if (path === 'ai.undo')
      throw trpcError('BAD_REQUEST', 'already', {
        code: 'VALIDATION',
        details: { reason: 'already_undone' },
      });
    return probeApi(path, undefined);
  });
  await click();
  await screen.findByText('Уже отменено');
  expect(undoCalls(r)).toHaveLength(1);
  expect(screen.queryByText(`Отменено: ${RESULT.undone.title}`)).not.toBeInTheDocument();
});
test.each([
  false,
  true,
])('actual AuthProvider смена владельца гасит поздний исход обычного/force %s', async (force) => {
  const held = deferred<UndoResult>();
  let count = 0;
  const r = probe((path) => {
    if (path === 'ai.undo') {
      if (force && ++count === 1) throw conflict();
      return held.promise;
    }
    return probeApi(path, undefined);
  });
  await click();
  if (force) fireEvent.click(await screen.findByRole('button', { name: CONTINUE_UNDO }));
  await waitFor(() => expect(undoCalls(r)).toHaveLength(force ? 2 : 1));
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt2',
    userId: 'revert-new-owner',
    status: 'authed',
  } as never);
  fireEvent.click(screen.getByRole('button', { name: 'ownerchange' }));
  expect(useToastStore.getState().toasts).toEqual([]);
  await act(async () => held.resolve(RESULT));
  await drain();
  expect(useToastStore.getState().toasts).toEqual([]);
});
test('старый пункт и старое force продолжение не начинают отмену в новом AuthProvider', async () => {
  let retainedSelect!: () => void;
  function Retain() {
    const item = useRevertTextItem('e1', session());
    if (retainedSelect === undefined && item) retainedSelect = item.onSelect;
    return <Probe />;
  }
  const r = renderWithProviders(
    <OwnerHost>
      <Retain />
    </OwnerHost>,
    (path) => {
      if (path === 'ai.undo') throw conflict();
      return probeApi(path, undefined);
    },
  );
  await click();
  await screen.findByRole('button', { name: CONTINUE_UNDO });
  const retry = useToastStore.getState().toasts[0]?.action?.onSelect;
  expect(retry).toBeTypeOf('function');
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt2',
    userId: 'revert-new-owner',
    status: 'authed',
  } as never);
  fireEvent.click(screen.getByRole('button', { name: 'ownerchange' }));
  await act(async () => {
    retainedSelect();
    retry?.();
  });
  await drain();
  expect(undoCalls(r)).toHaveLength(1);
  expect(useToastStore.getState().toasts).toEqual([]);
});

test('повторный выбор после живого rerender не дублирует pending отмену', async () => {
  const held = deferred<UndoResult>();
  let refresh!: () => void;
  function LiveProbe() {
    const [, update] = useState(0);
    refresh = () => update((n) => n + 1);
    return <Probe />;
  }
  const r = renderWithProviders(
    <OwnerHost>
      <LiveProbe />
    </OwnerHost>,
    (path) => (path === 'ai.undo' ? held.promise : probeApi(path, undefined)),
  );
  await click();
  await waitFor(() => expect(undoCalls(r)).toHaveLength(1));
  act(() => refresh());
  await click();
  await drain();
  expect(undoCalls(r)).toHaveLength(1);
  await act(async () => held.resolve(RESULT));
  await screen.findByText(`Отменено: ${RESULT.undone.title}`);
});

test('old finally не отпирает новую pending попытку, новый владелец может отменять', async () => {
  const old = deferred<UndoResult>();
  const current = deferred<UndoResult>();
  let count = 0;
  const r = probe((path) =>
    path === 'ai.undo'
      ? ++count === 1
        ? old.promise
        : current.promise
      : probeApi(path, undefined),
  );
  await click();
  await waitFor(() => expect(undoCalls(r)).toHaveLength(1));
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt2',
    userId: 'revert-new-owner',
    status: 'authed',
  } as never);
  fireEvent.click(screen.getByRole('button', { name: 'ownerchange' }));
  await click();
  await waitFor(() => expect(undoCalls(r)).toHaveLength(2));
  await act(async () => old.resolve(RESULT));
  await drain();
  expect(useToastStore.getState().toasts).toEqual([]);
  await click();
  await drain();
  expect(undoCalls(r)).toHaveLength(2);
  await act(async () => current.resolve(RESULT));
  await screen.findByText(`Отменено: ${RESULT.undone.title}`);
});
test('actual ownerchange во время досыла не начинает ai.undo и не возвращает плашку', async () => {
  const held = deferred<FlushResult>();
  cleanupFlush.push(registerBodyFlush('e1', () => held.promise));
  const r = probe((path) => (path === 'ai.undo' ? RESULT : probeApi(path, undefined)));
  await click();
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt2',
    userId: 'revert-new-owner',
    status: 'authed',
  } as never);
  fireEvent.click(screen.getByRole('button', { name: 'ownerchange' }));
  await act(async () => held.resolve('saved'));
  await drain();
  expect(undoCalls(r)).toEqual([]);
  expect(useToastStore.getState().toasts).toEqual([]);
});
test('refusal none не обещает продолжение или право чужого сеанса', async () => {
  const r = probe((path) => {
    if (path === 'ai.undo')
      throw trpcError('CONFLICT', 'сменился текст', {
        code: 'UNDO_TEXT_CHANGED',
        details: {
          action: { id: 's1', title: RESULT.undone.title },
          entries: [],
          continuation: { kind: 'none' },
        },
      });
    return probeApi(path, undefined);
  });
  await click();
  await screen.findByText('Текст изменён после этой правки');
  expect(screen.queryByRole('button', { name: CONTINUE_UNDO })).not.toBeInTheDocument();
  expect(undoCalls(r)).toHaveLength(1);
});
