import { describe, expect, test } from 'bun:test';
import { BUDGET_DEF } from './subscription-fixtures';
import { budgetSubscriptionSchema, subscriptionDefinitionSchema } from './subscription-type';

/**
 * Прежняя декларация Повестки (1б) литералом: норматив ушёл из кода вместе с движком (спека 1в §6.5),
 * а схема обязана отказывать ей — иначе строка, пережившая миграцию 0023, разобралась бы и ушла к
 * движку, которого нет.
 */
const AGENDA_DEF_1B = {
  engine: 'agenda',
  params: ['window_from', 'window_to'],
  show: {
    contract: 'orbis/when',
    slot: 'moment',
    window: { from: { ctx: '$today' }, to: { param: 'window_to' } },
    prefer: [],
    sortBy: 'asc',
    limit: 200,
  },
  overdue: {
    contract: 'orbis/when',
    slots: ['deadline', 'moment'],
    before: { ctx: '$today' },
    where: { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }] },
    prefer: [],
    limit: 200,
  },
  hide: { contract: 'orbis/recurrence', set: 'templates' },
};

describe('форма подписки: budget строгая; строка в E-позиции — SECOND_LANGUAGE', () => {
  test('лишнее поле отвергается .strict() — молча отброшенное уехало бы в jsonb', () => {
    expect(budgetSubscriptionSchema.safeParse({ ...BUDGET_DEF, секции: 3 }).success).toBe(false);
  });
  test('строка в E-позиции формой не разбирается (код SECOND_LANGUAGE даёт валидатор сервера)', () => {
    expect(
      budgetSubscriptionSchema.safeParse({
        ...BUDGET_DEF,
        phases: { ...BUDGET_DEF.phases, closed: 'сегодня > конец периода' },
      }).success,
    ).toBe(false);
  });
  test('союз по engine выбирает ветку; чужой engine — отказ', () => {
    expect(subscriptionDefinitionSchema.safeParse(BUDGET_DEF).success).toBe(true);
    expect(subscriptionDefinitionSchema.safeParse({ ...BUDGET_DEF, engine: 'row' }).success).toBe(
      false,
    );
  });
  test("engine: 'agenda' — отказ схемы: движок Повестки снят (спека 1в §6.5)", () => {
    expect(subscriptionDefinitionSchema.safeParse(AGENDA_DEF_1B).success).toBe(false);
  });
  test('budget: prefer у movement и envelope — массивы; без них подставляется [] (§С8-21)', () => {
    const d = budgetSubscriptionSchema.parse(BUDGET_DEF);
    expect([d.sources.movement.prefer, d.sources.envelope.prefer]).toEqual([[], []]);
    // Вход без поля получает умолчание, а эталон пишет его явно.
    const { prefer: _mp, ...movement } = BUDGET_DEF.sources.movement;
    const { prefer: _ep, ...envelope } = BUDGET_DEF.sources.envelope;
    const bare = budgetSubscriptionSchema.parse({ ...BUDGET_DEF, sources: { movement, envelope } });
    expect([bare.sources.movement.prefer, bare.sources.envelope.prefer]).toEqual([[], []]);
    expect(
      budgetSubscriptionSchema.safeParse({
        ...BUDGET_DEF,
        sources: { ...BUDGET_DEF.sources, movement: { ...movement, prefer: 'orbis/financial' } },
      }).success,
    ).toBe(false);
  });
  test('порог тревоги — СТРОКА (§Б3-5): число отвергается', () => {
    expect(
      budgetSubscriptionSchema.safeParse({
        ...BUDGET_DEF,
        alerts: { ...BUDGET_DEF.alerts, warn_at: 0.85 },
      }).success,
    ).toBe(false);
  });
});
