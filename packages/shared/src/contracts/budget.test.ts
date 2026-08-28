// Wire-контракты Budget: сужение, которое реформа обязана удержать (Р-10a-1, Z4-117 §С1-4).
import { describe, expect, test } from 'bun:test';
import { BUILTIN_PROPERTY_META } from '../registry/builtin-properties';
import { budgetOverviewSchema } from './budget';

/** Минимальный валидный Overview: всё, кроме `comingUp`, тесту безразлично. */
function overview(comingUp: unknown[]): unknown {
  return {
    period: { start: '2026-07-01', end: '2026-07-31' },
    balance: { income: '0.00', expense: '0.00', balance: '0.00' },
    envelopes: [],
    comingUp,
    planned: [],
    unbudgeted: [],
    alertCount: 0,
  };
}

/** Сущность в минимуме, который требует `entitySchema` (остальное — со значениями по умолчанию). */
const ENTITY = {
  id: '019e4466-1000-7e07-b5d4-64be9721da51',
  ownerId: '019e4466-2000-7e07-b5d4-64be9721da52',
  title: 'Аренда',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};
const ENTRY = { entity: ENTITY, occurredOn: '2026-07-10' };

describe('budgetOverviewSchema.comingUp.direction — варианты ИЗ РЕЕСТРА (Р-10a-1)', () => {
  test('принимает ровно варианты `orbis/direction` и отвергает всё прочее', () => {
    const type = BUILTIN_PROPERTY_META.find((p) => p.id === 'orbis/direction')?.type;
    if (type?.kind !== 'select') throw new Error('orbis/direction перестал быть select');
    const keys = type.options.map((o) => o.key);
    // Не вырожденно: вариантов больше одного, иначе enum ничего не сужал бы.
    expect(keys.length).toBeGreaterThan(1);
    for (const direction of keys) {
      const r = budgetOverviewSchema.safeParse(
        overview([{ ...ENTRY, amount: '10.00', direction }]),
      );
      expect(`${direction}: ${r.success}`).toBe(`${direction}: true`);
    }
    // Прежде здесь стояло `z.string()` — третье, самое слабое зеркало того же
    // перечисления. Оно молчало бы на любом мусоре, в том числе на варианте, который
    // однажды разойдётся с реестром.
    expect(
      budgetOverviewSchema.safeParse(
        overview([{ ...ENTRY, amount: '10.00', direction: 'transfer' }]),
      ).success,
    ).toBe(false);
    expect(
      budgetOverviewSchema.safeParse(overview([{ ...ENTRY, amount: '10.00', direction: '' }]))
        .success,
    ).toBe(false);
  });
});
