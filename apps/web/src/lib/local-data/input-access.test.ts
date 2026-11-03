import { parseBody } from '@orbis/shared/doc';
import { afterEach, expect, test } from 'vitest';
import {
  captureDraftWriter,
  countDraftsIn,
  finishDraftSlot,
  readDraft,
  saveDraft,
  setDraftScope,
} from '../../features/entity-editor/draft-storage';
import { captureQueueStorage, setQueueScope } from '../retry-buffer/storage';
import { browserInputStorage, configureInputAccess } from './input-access';

afterEach(() => {
  configureInputAccess(undefined);
  setDraftScope('');
  setQueueScope(null);
  localStorage.clear();
  sessionStorage.clear();
});

test('shared drafts and exact finished tokens stay in the tab storage and stale writers stay fenced', () => {
  let alive = true;
  const normal = browserInputStorage(localStorage);
  const shared = browserInputStorage(sessionStorage);
  configureInputAccess({ storage: shared, prefix: 'tab:', isCurrent: () => alive });
  setDraftScope('account');
  const now = new Date().toISOString();
  const body = parseBody('private draft');
  const token = saveDraft('record', body, 1, now);
  expect(readDraft('record')?.doc).toEqual(body);
  expect(countDraftsIn(shared, 'account', 'tab:')).toBe(1);
  finishDraftSlot('account', 'record', token);
  expect(readDraft('record')).toBeNull();
  expect(countDraftsIn(shared, 'account', 'tab:')).toBe(0);
  expect(countDraftsIn(normal, 'account')).toBe(0);
  const late = captureDraftWriter('late');
  alive = false;
  late(body, 1, now);
  expect(sessionStorage.getItem('tab:orbis:body-draft:account:late')).toBeNull();
  expect(localStorage.length).toBe(0);
});

test('an awaited queue writer retains its original namespace and cannot recreate a cleared queue', () => {
  let alive = true;
  const normal = browserInputStorage(localStorage);
  configureInputAccess({ storage: normal, prefix: '', isCurrent: () => alive });
  setQueueScope('account-a');
  const queue = captureQueueStorage();
  const item = { clientId: 'one', tool: 'entity.create', payload: {}, createdAt: '' };
  queue.save([item]);
  alive = false;
  normal.removeItem('orbis:retry-buffer:v1:account-a');
  configureInputAccess({ storage: normal, prefix: '', isCurrent: () => true });
  setQueueScope('account-b');
  captureQueueStorage().save([{ ...item, clientId: 'two' }]);
  expect(queue.load()).toEqual([]);
  expect(() => queue.save([item])).toThrow();
  expect(normal.getItem('orbis:retry-buffer:v1:account-a')).toBeNull();
  expect(
    captureQueueStorage()
      .load()
      .map((entry) => entry.clientId),
  ).toEqual(['two']);
});
