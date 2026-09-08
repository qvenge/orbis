// Состав встроенных подписок (§Б5-4) — то, что уедет system-строками в реестр.
//
// Проверяется не «схема принимает», а ССЫЛКИ декларации: подписка обязана говорить именами
// контрактов, наборов и параметров. Сырая ссылка на свойство в системном сиде — дефект
// реформы, а не мелочь стиля: ради него вся часть Б и затевалась.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_SUBSCRIPTION_DEFS } from './builtin-subscriptions';
import { AGENDA_DEF } from './subscription-fixtures';
import { subscriptionDefinitionSchema } from './subscription-type';

describe('встроенные подписки §Б5-4', () => {
  test('одна подписка среза: orbis/agenda на planner/agenda, декларация проходит строгую схему', () => {
    expect(BUILTIN_SUBSCRIPTION_DEFS.map((s) => s.id)).toEqual(['orbis/agenda']);
    expect(BUILTIN_SUBSCRIPTION_DEFS[0]?.surface).toBe('planner/agenda');
    expect(BUILTIN_SUBSCRIPTION_DEFS[0]?.module).toBe('planner');
    for (const s of BUILTIN_SUBSCRIPTION_DEFS) {
      expect(() => subscriptionDefinitionSchema.parse(s.definition)).not.toThrow();
    }
  });
  test('ссылки — на контракты и наборы, не на свойства; окно — параметрами (§Б5-2, Р-К-4)', () => {
    const def = subscriptionDefinitionSchema.parse(BUILTIN_SUBSCRIPTION_DEFS[0]?.definition);
    if (def.engine !== 'agenda') throw new Error('движок не agenda');
    expect(def.show.contract).toBe('orbis/when');
    expect(def.show.slot).toBe('moment');
    expect(def.overdue.slots).toEqual(['deadline', 'moment']);
    expect(def.hide).toEqual({ contract: 'orbis/recurrence', set: 'templates' });
    // Сырых ссылок на свойства в СИСТЕМНОМ сиде нет вовсе; prefer пуст (рамка §4-3)
    expect(JSON.stringify(def)).not.toContain('"prop"');
    expect([def.show.prefer, def.overdue.prefer]).toEqual([[], []]);
    expect(def.params).toEqual(['window_from', 'window_to']);
    expect(def.show.window).toEqual({ from: { ctx: '$today' }, to: { param: 'window_to' } });
  });
  test('каноническая Agenda ОДНА: сид — тот же литерал, что норматив (Ф-Б1-27)', () => {
    // Не «глубоко равен», а ТОТ ЖЕ объект: копия разошлась бы с нормативом молча, и тест на
    // равенство пришлось бы поддерживать вручную при каждом новом поле декларации.
    expect(BUILTIN_SUBSCRIPTION_DEFS[0]?.definition).toBe(AGENDA_DEF);
    expect(BUILTIN_SUBSCRIPTION_DEFS[0]?.definition).toEqual(AGENDA_DEF);
  });
});
