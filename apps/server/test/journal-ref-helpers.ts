import { expect } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { journalOf } from './journal-helpers';

/** Ответ адресует настоящее действие; проверка не зависит от формы старой полезной нагрузки. */
export async function expectJournalRef(graph: GraphId, result: unknown, consequences?: boolean) {
  expect(typeof (result as { actionId?: unknown }).actionId).toBe('string');
  const actual = (result as { consequences?: unknown }).consequences;
  expect(typeof actual).toBe('boolean');
  if (consequences !== undefined) expect(actual).toBe(consequences);
  const actionId = (result as { actionId: string }).actionId;
  const action = await journalOf(graph, actionId);
  expect(action?.id).toBe(actionId);
  expect(action?.source).not.toBe('system');
  return action;
}
