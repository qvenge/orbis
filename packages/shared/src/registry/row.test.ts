// Правило строки M14 (§Б5-6 :560) — ДАННЫЕ, а не россыпь `if` по аспектам: один источник для
// EntityRow, NativeRow, toSuggestion и снимка core/row. Реестр НАСТОЯЩИЙ: правило обязано
// совпадать с боевым, иначе зелёный тест не значит ничего.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import { BUILTIN_CONTRACT_DEFS } from './builtin-contracts';
import { M14_ROW_ELEMENTS, rowProjectionOf } from './row';

const REG = {
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
  contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
};
const task = (props: Record<string, unknown>) => ({ aspects: ['orbis/task'], props });

describe('rowProjectionOf: контракт → элемент', () => {
  test('задача: чекбокс из completable, дата из when.deadline', () => {
    const p = rowProjectionOf(
      task({ 'orbis/task_status': 'inbox', 'orbis/due_date': '2026-09-10' }),
      REG,
    );
    expect(p.checkbox).toEqual({ closed: false, cls: 'active' });
    expect(p.date).toEqual({ value: '2026-09-10', slot: 'deadline' });
    expect(p.amount).toBeNull();
    expect(p.progress).toBeNull();
    expect(p.badges).toEqual([]);
  });
  test('порядок элементов — единый для обеих строк (§Б5-6)', () => {
    expect(M14_ROW_ELEMENTS.map((r) => r.element)).toEqual([
      'checkbox',
      'title',
      'date',
      'amount',
      'progress',
      'badges',
    ]);
  });
});
