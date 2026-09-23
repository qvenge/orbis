import { describe, expect, test } from 'bun:test';
import { AGENDA_DEF, BUDGET_DEF } from './subscription-fixtures';
import {
  agendaSubscriptionSchema,
  budgetSubscriptionSchema,
  subscriptionDefinitionSchema,
} from './subscription-type';

describe('форма подписки: agenda/budget строгая; строка в E-позиции — SECOND_LANGUAGE', () => {
  test('agenda разбирается и подставляет умолчания params/prefer/sortBy/limit', () => {
    // Разбирается КОПИЯ БЕЗ полей с умолчанием: сам эталон типизирован разобранной формой и потому
    // несёт их явно (`subscription-fixtures.ts`), а подстановку наблюдает только вход без них.
    const { params: _params, ...rest } = AGENDA_DEF;
    const { prefer: _sp, sortBy: _ss, limit: _sl, ...show } = AGENDA_DEF.show;
    const { prefer: _op, limit: _ol, ...overdue } = AGENDA_DEF.overdue;
    const d = agendaSubscriptionSchema.parse({ ...rest, show, overdue });
    expect(d.params).toEqual(['window_from', 'window_to']);
    expect([d.show.prefer.length, d.show.sortBy, d.show.limit, d.overdue.limit]).toEqual([
      0,
      'asc',
      200,
      200,
    ]);
  });
  test('лишнее поле отвергается .strict() — молча отброшенное уехало бы в jsonb', () => {
    expect(agendaSubscriptionSchema.safeParse({ ...AGENDA_DEF, секции: 3 }).success).toBe(false);
  });
  test('строка в E-позиции формой не разбирается (код SECOND_LANGUAGE даёт валидатор сервера)', () => {
    expect(
      agendaSubscriptionSchema.safeParse({
        ...AGENDA_DEF,
        overdue: { ...AGENDA_DEF.overdue, where: 'class(completable) in open' },
      }).success,
    ).toBe(false);
  });
  test('союз по engine выбирает ветку; чужой engine — отказ', () => {
    expect(subscriptionDefinitionSchema.safeParse(BUDGET_DEF).success).toBe(true);
    expect(subscriptionDefinitionSchema.safeParse({ ...AGENDA_DEF, engine: 'row' }).success).toBe(
      false,
    );
  });
  test('budget: prefer у movement и envelope — массивы; без них подставляется [] (§С8-21)', () => {
    const d = budgetSubscriptionSchema.parse(BUDGET_DEF);
    expect([d.sources.movement.prefer, d.sources.envelope.prefer]).toEqual([[], []]);
    // Как у Повестки: вход без поля получает умолчание, а эталон пишет его явно.
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
