import { ROLE_SUBITEM } from '@orbis/shared';
import { expect, it } from 'vitest';
import { nextNetworkOrder } from '../freshness/provenance';
import { createCreateIntentRegistry } from './create-intents';

const scope = { accountId: 'owner', graphId: 'graph', epoch: 1 };
const origin = 'subtasks:019e4466-1000-7e07-b5d4-64be9721da51';
const parentId = '019e4466-1000-7e07-b5d4-64be9721da51';

function linkedInput() {
  return {
    origin,
    draftIdentity: 'draft:1',
    command: {
      source: 'quick_capture' as const,
      input: {
        title: 'First line',
        body: 'First line\nSecond line',
        tags: ['work'],
        aspects: ['orbis/task'],
        props: { 'orbis/task_status': 'inbox', 'orbis/plan_order': 100 },
      },
      link: { parentId: parentId.toUpperCase(), role: 'subitem' as const },
    },
  };
}

function serverEntity(id: string) {
  return {
    id,
    graphId: scope.graphId,
    title: 'Accepted title',
    body: 'First line\nSecond line',
    bodyRefs: [],
    emoji: null,
    archived: false,
    tags: ['work'],
    aspects: ['orbis/task'],
    props: { 'orbis/task_status': 'inbox', 'orbis/plan_order': 100 },
    queryRefs: [],
    createdAt: '2026-11-03T12:00:00.000Z',
    updatedAt: '2026-11-03T12:00:00.000Z',
    bodyChangedAt: '2026-11-03T12:00:00.000Z',
    bodyRevision: 1,
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a create attempt or result');
  return value;
}

const unknown = { kind: 'unknown', message: 'Не удалось подтвердить сохранение' } as const;

it('publishes once before dispatch and latches duplicate submits in the same origin', () => {
  const registry = createCreateIntentRegistry(scope, () => scope);
  const observed: string[] = [];
  const unsubscribe = registry.subscribe(() => {
    observed.push(...registry.getSnapshot().map((row) => row.status));
  });

  const attempt = required(registry.begin(linkedInput()));
  expect(attempt.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(attempt.command.input.id).toBe(attempt.id);
  expect(registry.lookup(attempt.id.toUpperCase())).toMatchObject({
    id: attempt.id,
    origin,
    draftIdentity: 'draft:1',
    title: 'First line',
    body: 'First line\nSecond line',
    status: 'pending',
  });
  expect(registry.isUnconfirmedCreate(attempt.id)).toBe(true);
  expect(registry.begin(linkedInput())).toBeUndefined();
  expect(registry.retry(attempt.id)).toBeUndefined();
  expect(observed).toEqual(['pending']);
  unsubscribe();

  const other = registry.begin({ ...linkedInput(), origin: 'inbox' });
  expect(other?.id).not.toBe(attempt.id);
  expect(registry.getSnapshot()).toHaveLength(2);
  expect(observed).toEqual(['pending']);
});

it('recovers a committed linked create after remount using exactly the original DTO and UUID', () => {
  const registry = createCreateIntentRegistry(scope, () => scope);
  const input = linkedInput();
  const attempt = required(registry.begin(input));
  const serverRows = new Map<string, ReturnType<typeof serverEntity>>();
  serverRows.set(attempt.id, serverEntity(attempt.id));
  const beforeAck = nextNetworkOrder();

  input.command.link.parentId = '019e4466-1000-7e07-b5d4-64be9721da52';
  input.command.input.tags.push('new draft');
  input.command.input.props['orbis/plan_order'] = 200;
  input.draftIdentity = 'draft:2';
  expect(registry.settle(attempt, unknown)).toMatchObject({
    status: 'unknown',
    message: unknown.message,
  });
  expect(registry.isUnconfirmedCreate(attempt.id)).toBe(true);
  expect(registry.begin(linkedInput())).toBeUndefined();
  const later = required(registry.begin(input));
  expect(later.id).not.toBe(attempt.id);

  // The recovery surface only knows the stable row id after the original form is gone.
  const recoveryId = registry.getSnapshot().find((row) => row.status === 'unknown')?.id ?? '';
  const retry = required(registry.retry(recoveryId));
  expect(retry.command).toEqual({
    input: {
      id: attempt.id,
      title: 'First line',
      body: 'First line\nSecond line',
      tags: ['work'],
      aspects: ['orbis/task'],
      props: { 'orbis/task_status': 'inbox', 'orbis/plan_order': 100 },
    },
    link: { parentId, role: ROLE_SUBITEM },
    source: 'quick_capture',
  });
  expect(() => retry.command.input.tags.push('mutated retry')).toThrow();
  expect(registry.retry(recoveryId)).toBeUndefined();
  expect(registry.settle(attempt, { kind: 'rejected', message: 'Old attempt' })).toBeUndefined();
  const result = {
    ...required(serverRows.get(retry.id)),
    actionId: '019e4466-1000-7e07-b5d4-64be9721da53',
    consequences: true,
  };
  const ack = registry.settle(retry, { kind: 'ack', result });
  expect(ack).toMatchObject({
    status: 'ack',
    draftIdentity: 'draft:1',
    result: {
      id: attempt.id,
      title: 'Accepted title',
      actionId: '019e4466-1000-7e07-b5d4-64be9721da53',
      consequences: true,
    },
  });
  if (ack?.status !== 'ack') throw new Error('Expected create ACK');
  expect(ack.ackSequence).toBeGreaterThan(beforeAck);
  expect(registry.isUnconfirmedCreate(attempt.id)).toBe(false);
  expect(registry.settle(retry, { kind: 'ack', result })).toBeUndefined();
  expect(registry.retry(recoveryId)).toBeUndefined();
  expect(registry.release(recoveryId)).toBe(true);
  expect(registry.lookup(recoveryId)).toBeUndefined();
  expect(registry.lookup(later.id)).toMatchObject({ status: 'pending', draftIdentity: 'draft:2' });
});

it('leaves an unlinked replay without a journal reference', () => {
  const registry = createCreateIntentRegistry(scope, () => scope);
  const attempt = required(
    registry.begin({
      origin: 'records',
      draftIdentity: 'draft:1',
      command: { input: { title: 'First line', tags: [] }, source: 'quick_capture' },
    }),
  );
  registry.settle(attempt, unknown);
  const retry = required(registry.retry(attempt.id));
  const result = serverEntity(retry.id);
  const ack = registry.settle(retry, { kind: 'ack', result });
  result.title = 'Mutated after ACK';
  expect(ack?.status === 'ack' && ack.result.title).toBe('Accepted title');
  expect(ack?.status === 'ack' && Object.hasOwn(ack.result, 'actionId')).toBe(false);
});

it('releases a rejected origin while retaining the reason for the open placeholder', () => {
  const registry = createCreateIntentRegistry(scope, () => scope);
  const attempt = required(registry.begin(linkedInput()));
  expect(registry.release(attempt.id)).toBe(false);
  const refusal = 'Связь образует цикл';
  const rejected = registry.settle(attempt, { kind: 'rejected', message: refusal });
  expect(rejected).toMatchObject({ status: 'rejected', message: refusal, origin });
  expect(registry.lookup(attempt.id)).toBe(rejected);
  expect(registry.retry(attempt.id)).toBeUndefined();
  const edited = required(registry.begin({ ...linkedInput(), draftIdentity: 'draft:2' }));
  expect(edited.id).not.toBe(attempt.id);
  expect(registry.release(attempt.id)).toBe(true);
  expect(registry.lookup(edited.id)?.status).toBe('pending');
});

it('keeps a same-scope attempt recoverable and ignores a mismatched success envelope', () => {
  let current = { ...scope };
  const registry = createCreateIntentRegistry(scope, () => current);
  const attempt = required(registry.begin(linkedInput()));
  const pending = registry.getSnapshot();

  // Refreshing the current scope or reading an early feed event supplies no create ACK.
  current = { ...scope };
  expect(registry.getSnapshot()).toBe(pending);
  expect(
    registry.settle(attempt, {
      kind: 'ack',
      result: { ...serverEntity(attempt.id), graphId: 'foreign graph' },
    }),
  ).toMatchObject({ status: 'unknown' });
  expect(registry.isUnconfirmedCreate(attempt.id)).toBe(true);
  expect(registry.retry(attempt.id)?.id).toBe(attempt.id);
});

it.each([
  { ...scope, accountId: 'other' },
  { ...scope, graphId: 'other' },
  { ...scope, epoch: 2 },
  null,
])('does not expose or settle an old intent after scope changes to %j', (replacement) => {
  let current: typeof scope | null = scope;
  const registry = createCreateIntentRegistry(scope, () => current);
  const attempt = required(registry.begin(linkedInput()));
  current = replacement;
  expect(registry.getSnapshot()).toEqual([]);
  expect(registry.lookup(attempt.id)).toBeUndefined();
  expect(registry.isUnconfirmedCreate(attempt.id)).toBe(false);
  expect(registry.begin(linkedInput())).toBeUndefined();
  expect(
    registry.settle(attempt, { kind: 'ack', result: serverEntity(attempt.id) }),
  ).toBeUndefined();
});

it('drops both pending and unknown attempts on a hard reset and fences late replies', () => {
  const registry = createCreateIntentRegistry(scope, () => scope);
  const one = required(registry.begin(linkedInput()));
  const two = required(registry.begin({ ...linkedInput(), origin: 'inbox' }));
  registry.settle(two, unknown);
  registry.reset();
  expect(registry.getSnapshot()).toEqual([]);
  expect(registry.retry(two.id)).toBeUndefined();
  const next = required(registry.begin(linkedInput()));
  expect(registry.settle(one, { kind: 'ack', result: serverEntity(one.id) })).toBeUndefined();
  expect(registry.lookup(next.id)?.status).toBe('pending');
});
