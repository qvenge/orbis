import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { resetUndoSession } from '../undo/undo-epoch';
import { createLocalMessages, localMessagesOf, projectLocalMessages } from './local-messages';
import type { ChatMessage } from './useChatThread';

const message = (id: string, role: ChatMessage['role'] = 'user'): ChatMessage =>
  ({
    id,
    threadId: 't',
    role,
    content: id,
    metadata: {},
    createdAt: '2026-11-03T01:00:00Z',
  }) as ChatMessage;

it('preserves retry after a server user row and ignores the older send attempt', () => {
  const store = createLocalMessages();
  const user = message('client');
  const first = store.begin('t', user);
  const error = message('retry', 'assistant');
  store.fail(first, error);
  expect(
    projectLocalMessages([user], store.snapshot('t'))
      .map((m) => m.id)
      .sort(),
  ).toEqual(['client', 'retry']);
  const second = store.begin('t', user);
  store.fail(first, error);
  expect(projectLocalMessages([user], store.snapshot('t')).map((m) => m.id)).toEqual(['client']);
  const answer = message('answer', 'assistant');
  store.confirm(second, answer);
  expect(projectLocalMessages([answer, user], store.snapshot('t'))).toEqual([answer, user]);
});

it('a late retry receipt from the old owner cannot repopulate the new owner layer', () => {
  const client = new QueryClient();
  const previous = localMessagesOf(client);
  const sent = previous.begin('t', message('client'));
  resetUndoSession();
  const current = localMessagesOf(client);
  expect(current.snapshot('t')).toEqual([]);
  previous.fail(sent, message('retry', 'assistant'));
  expect(current.snapshot('t')).toEqual([]);
});
