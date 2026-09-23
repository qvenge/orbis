import { describe, expect, test } from 'bun:test';
import { actionDefinitionSchema, BATCH_CAP_DEFAULT } from './action-type';
import { BUILTIN_ACTION_DEFS } from './builtin-actions';

describe('встроенные действия §Б6-5', () => {
  test('ровно два: finance/plan-to-fact и planner/postpone_overdue; rank — позиция', () => {
    expect(BUILTIN_ACTION_DEFS.map((a) => a.key)).toEqual([
      'finance/plan-to-fact',
      'planner/postpone_overdue',
    ]);
    expect(BUILTIN_ACTION_DEFS.map((a) => a.rank)).toEqual([0, 1]);
    expect(BUILTIN_ACTION_DEFS.map((a) => a.id)).toEqual(BUILTIN_ACTION_DEFS.map((a) => a.key));
    for (const a of BUILTIN_ACTION_DEFS) {
      expect(a.graphId).toBeNull();
      expect(() => actionDefinitionSchema.parse(a)).not.toThrow();
    }
  });
  test('plan-to-fact — одиночное, деньги; postpone_overdue — пакетное с капом и тулом LLM (Р-30)', () => {
    const [p2f, postpone] = BUILTIN_ACTION_DEFS;
    expect([p2f?.over, p2f?.batch_cap]).toEqual([null, null]);
    expect(p2f?.sensitivity).toEqual(['touches_money']);
    expect(p2f?.offered_by).toEqual([]); // карточка Detail — срез 2 страниц
    expect(postpone?.batch_cap).toBe(BATCH_CAP_DEFAULT);
    expect(postpone?.offered_by).toEqual([{ llm: true }]); // §Б6-6 → тул action_* (задача 7)
    expect(postpone?.sensitivity).toEqual([]);
    // Q пакетного — просроченные открытые задачи: относительное время здесь ЗАКОННО
    // (это не `scope`/`ref.target`, см. ОВ-6-1 черновика).
    expect(postpone?.over?.filter).toEqual({
      and: [
        { aspect: 'orbis/task' },
        { class: { contract: 'orbis/completable', set: 'open' } },
        { prop: 'orbis/due_date', op: 'lt', value: { token: 'today' } },
      ],
    });
  });
});
