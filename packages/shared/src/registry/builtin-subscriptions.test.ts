// Состав встроенных подписок (§Б5-4) — то, что уедет system-строками в реестр.
//
// Проверяется не «схема принимает», а ССЫЛКИ декларации: подписка обязана говорить именами
// контрактов, наборов и параметров. Сырая ссылка на свойство в системном сиде — дефект
// реформы, а не мелочь стиля: ради него вся часть Б и затевалась.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_CONTRACT_DEFS } from './builtin-contracts';
import { BUILTIN_SUBSCRIPTION_DEFS } from './builtin-subscriptions';
import { AGENDA_DEF, BUDGET_DEF } from './subscription-fixtures';
import { type BudgetSubscription, subscriptionDefinitionSchema } from './subscription-type';

describe('встроенные подписки §Б5-4', () => {
  test('две подписки среза: agenda и budget-overview, обе проходят строгую схему', () => {
    expect(BUILTIN_SUBSCRIPTION_DEFS.map((s) => s.id)).toEqual([
      'orbis/agenda',
      'orbis/budget-overview',
    ]);
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

describe('подписка Budget §Б5-4: форма декларации', () => {
  const row = BUILTIN_SUBSCRIPTION_DEFS.find((d) => d.id === 'orbis/budget-overview');
  const def = row?.definition as BudgetSubscription | undefined;

  test('вторая встроенная подписка: поверхность finance/budget-overview, модуль finance', () => {
    expect(row?.surface).toBe('finance/budget-overview');
    expect(row?.module).toBe('finance');
    expect(BUILTIN_SUBSCRIPTION_DEFS).toHaveLength(2); // agenda (задача 6) + budget
  });

  test('декларация проходит строгую схему подписки', () => {
    expect(() => subscriptionDefinitionSchema.parse(row?.definition)).not.toThrow();
  });

  test('каноническая Budget ОДНА: сид — тот же литерал, что норматив (Ф-Б1-27)', () => {
    expect(row?.definition).toBe(BUDGET_DEF);
    expect(row?.definition).toEqual(BUDGET_DEF);
  });

  test('§Б3-5: денежный литерал — строка, не JSON-число', () => {
    expect(def?.alerts.warn_at).toBe('0.85');
  });

  test('§Б5-2: ни одного id аспекта и ни одного id свойства — только контракты, слоты, наборы', () => {
    const text = JSON.stringify(row?.definition);
    for (const a of ['orbis/financial', 'orbis/budget', 'orbis/schedule'])
      expect(text).not.toContain(a);
    // единственный адрес свойства — core-заголовок внутри deref порядка карточек (§Б3-3)
    expect(text.match(/"orbis\/(?!money-movement|envelope|recurrence)[a-z_]+"/g)).toEqual([
      '"orbis/title"',
    ]);
  });

  test('декларация Budget не читает ни одного timestamp-слота — таймзона в компиляции не участвует', () => {
    // Обоснование движка: `DEFAULT_TIMEZONE` в его `CompileCtx` законна ровно потому, что
    // читать по зоне нечего. Появится в декларации слот `moment` — тест покраснеет, и зона
    // приедет из `user_settings`, а не тихо разъедется с «сегодня» владельца.
    if (def === undefined) throw new Error('декларации Budget нет в сиде');
    const contracts = new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c]));
    const used = new Set<string>();
    for (const m of JSON.stringify(def).matchAll(/"slot":"([a-z][a-z0-9_]*)"/g))
      used.add(m[1] as string);
    expect(used.size).toBeGreaterThan(0); // сторож: регулярка что-то нашла
    for (const name of used) {
      for (const contract of [def.sources.movement.contract, def.sources.envelope.contract]) {
        const c = contracts.get(contract);
        const slot = c?.kind === 'slots' ? c.slots.find((s) => s.name === name) : undefined;
        // Тип слота сравнивается целиком (в нём бывает `any_of`), поэтому проверка — по тексту.
        expect([name, JSON.stringify(slot?.type ?? null).includes('timestamp')]).toEqual([
          name,
          false,
        ]);
      }
    }
  });

  test('подписка ссылается только на существующие наборы контракта денег', () => {
    if (def === undefined) throw new Error('декларации Budget нет в сиде');
    const mm = BUILTIN_CONTRACT_DEFS.find((c) => c.id === 'orbis/money-movement');
    const names = new Set(Object.keys(mm?.sets ?? {}));
    expect(names.has(def.sources.movement.counted_set)).toBe(true);
    for (const l of Object.values(def.lists)) expect(names.has(l.counted_set)).toBe(true);
  });
});
