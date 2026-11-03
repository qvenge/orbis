import type { QueryClient } from '@tanstack/react-query';
import { isUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import type { ChatMessage } from './useChatThread';

type SendToken = { thread: string; user: ChatMessage };
type LocalNote = ChatMessage & { replacesFastPathEntity?: string };
const EMPTY: readonly LocalNote[] = [];

export function createLocalMessages() {
  type Send = { token: SendToken; error?: ChatMessage; answer?: ChatMessage };
  const threads = new Map<
    string,
    {
      sends: Map<string, Send>;
      notes: Map<string, LocalNote>;
      snapshot: readonly LocalNote[];
    }
  >();
  const listeners = new Set<() => void>();

  function get(thread: string) {
    let state = threads.get(thread);
    if (!state) {
      state = { sends: new Map(), notes: new Map(), snapshot: EMPTY };
      threads.set(thread, state);
    }
    return state;
  }

  function publish(thread: string) {
    const state = get(thread);
    state.snapshot = [
      ...state.notes.values(),
      ...[...state.sends.values()].flatMap(({ token, error, answer }) =>
        [answer ?? error, token.user].filter((msg): msg is ChatMessage => msg !== undefined),
      ),
    ];
    for (const listener of listeners) listener();
  }

  return {
    snapshot: (thread: string) => threads.get(thread)?.snapshot ?? EMPTY,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(thread: string, user: ChatMessage): SendToken {
      const token = { thread, user };
      get(thread).sends.set(user.id, { token });
      publish(thread);
      return token;
    },
    fail(token: SendToken, error: ChatMessage) {
      const entry = get(token.thread).sends.get(token.user.id);
      if (entry?.token !== token) return;
      entry.error = error;
      publish(token.thread);
    },
    confirm(token: SendToken, answer: ChatMessage) {
      const entry = get(token.thread).sends.get(token.user.id);
      if (entry?.token !== token) return;
      entry.error = undefined;
      entry.answer = answer;
      publish(token.thread);
    },
    observeServer(thread: string, messages: readonly ChatMessage[]) {
      const state = threads.get(thread);
      if (!state) return;
      const ids = new Set(messages.map(({ id }) => id));
      let changed = false;
      for (const [id, { answer }] of state.sends) {
        if (answer && ids.has(id) && ids.has(answer.id)) {
          state.sends.delete(id);
          changed = true;
        }
      }
      if (changed) publish(thread);
    },
    note(thread: string, message: ChatMessage, replacesFastPathEntity?: string) {
      get(thread).notes.set(message.id, { ...message, replacesFastPathEntity });
      publish(thread);
    },
    clear() {
      threads.clear();
      for (const listener of listeners) listener();
    },
  };
}

export function projectLocalMessages(
  server: ChatMessage[],
  local: readonly LocalNote[],
): ChatMessage[] {
  if (!local.length) return server;
  const ids = new Set(server.map(({ id }) => id));
  const fastPath = new Map(
    local.flatMap((message) =>
      message.replacesFastPathEntity ? [[message.replacesFastPathEntity, message] as const] : [],
    ),
  );
  const replaced = new Set<string>();
  const projected = server.map((message) => {
    const journal = message.metadata.journal as
      | { source?: string; entityId?: string; undone?: boolean }
      | undefined;
    const note =
      journal?.source === 'fast_path' && journal.entityId && fastPath.get(journal.entityId);
    if (!note) return message;
    replaced.add(note.id);
    const meta = note.metadata.fastPath as { text: string } | undefined;
    return meta && !journal.undone
      ? {
          ...message,
          metadata: {
            ...message.metadata,
            fastPath: { ...meta, entityId: journal.entityId, status: 'confirmed' },
          },
        }
      : message;
  });
  const pending = local.filter(({ id }) => !replaced.has(id) && !ids.has(id) && ids.add(id));
  return pending.length
    ? [...pending, ...projected].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : projected;
}

const clients = new WeakMap<
  QueryClient,
  { epoch: number; store: ReturnType<typeof createLocalMessages> }
>();
export function localMessagesOf(client: QueryClient) {
  let entry = clients.get(client);
  if (!entry || !isUndoEpoch(entry.epoch)) {
    entry = { epoch: undoEpoch(), store: createLocalMessages() };
    clients.set(client, entry);
  }
  return entry.store;
}

export function clearLocalMessages(client: QueryClient): void {
  const entry = clients.get(client);
  clients.delete(client);
  entry?.store.clear();
}
