import { describe, expect, it } from 'vitest';
import {
  isRestorableResponse,
  makeResponseBuster,
  projectServerResponse,
  RESPONSE_TTL_MS,
} from './response-cache';

const newest = [['chat', 'listMessages'], { input: { threadId: 't', limit: 50 }, type: 'query' }];
const chat = ['chatThread', 't'];
const detail = [['entity', 'get'], { input: { id: 'e' }, type: 'query' }];
const messages = Array.from({ length: 55 }, (_, id) => ({
  id,
  content: 'kept',
  metadata: {
    journal: { actionId: 'action', inverse: ['private'] },
    pending: { id: 'pending', input: 'private' },
    cards: [{ kind: 'entity_card', results: ['private'] }],
  },
}));
const message = {
  id: 0,
  content: 'kept',
  metadata: {
    journal: { actionId: 'action' },
    pending: { id: 'pending' },
    cards: [{ kind: 'entity_card' }],
  },
};

describe('response persistence policy', () => {
  it('persists only the canonical newest page and safe card projections', () => {
    const outer = projectServerResponse(chat, {
      pages: [messages, [{ id: 'old' }]],
      pageParams: [undefined, 'cursor'],
    });
    const tail = [message, ...messages.slice(1, 50).map(({ id }) => ({ ...message, id }))];
    expect(outer).toEqual({ pages: [tail], pageParams: [undefined] });
    expect(projectServerResponse(newest, messages)).toEqual(tail);
    expect(
      projectServerResponse(chat, { pages: [[], messages], pageParams: [undefined, 'old'] }),
    ).toEqual({ pages: [[]], pageParams: [undefined] });
    expect(projectServerResponse(chat, { pages: [messages], pageParams: ['old'] })).toBeUndefined();
    expect(
      projectServerResponse(detail, { entity: { id: 'e' }, thread: { id: 't', messages } }),
    ).toMatchObject({
      thread: {
        id: 't',
        messages: [message, ...messages.slice(1, 50).map(({ id }) => ({ ...message, id }))],
      },
    });
  });

  it('denies history, transient data and unknown families', () => {
    expect(
      projectServerResponse([newest[0], { input: { threadId: 't', before: 'cursor' } }], messages),
    ).toBeUndefined();
    for (const path of [
      'oauth.listGrants',
      'version.list',
      'entity.suggest',
      'routine.proposal',
      'changes.reconcile',
      'unknown.get',
    ]) {
      expect(projectServerResponse([path.split('.')], { input: 'secret' })).toBeUndefined();
    }
    expect(projectServerResponse([['entity', 'count']], 0)).toBe(0);
  });

  it('expires from the oldest fragment and separates build and document schema', () => {
    const buster = makeResponseBuster('build-1', 3);
    expect(buster).not.toBe(makeResponseBuster('build-2', 3));
    expect(buster).not.toBe(makeResponseBuster('build-1', 4));
    const meta = { receivedAt: 10, fragmentTimes: { body: 1000 } };
    expect(isRestorableResponse(meta, RESPONSE_TTL_MS + 9)).toBe(true);
    expect(isRestorableResponse(meta, RESPONSE_TTL_MS + 10)).toBe(false);
    expect(isRestorableResponse({ receivedAt: 10, fragmentTimes: { refs: Number.NaN } }, 20)).toBe(
      false,
    );
  });
});
