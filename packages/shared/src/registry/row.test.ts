// Правило строки M14 (§Б5-6 :560) — ДАННЫЕ, а не россыпь `if` по аспектам: один источник для
// EntityRow, NativeRow, toSuggestion и снимка core/row. Реестр НАСТОЯЩИЙ: правило обязано
// совпадать с боевым, иначе зелёный тест не значит ничего.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import { BUILTIN_CONTRACT_DEFS } from './builtin-contracts';
import type { AspectDefinition } from './property-type';
import {
  declaredSlot,
  M14_ROW_ELEMENTS,
  type RowElementRule,
  rowAllDayOf,
  rowCategoryRefOf,
  rowMoneyCurrencyOf,
  rowProjectionOf,
  rowStatusPropertyOf,
} from './row';

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
  test('closed = {done, cancelled} из одного источника; бейдж — у cancelled', () => {
    const done = rowProjectionOf(task({ 'orbis/task_status': 'done' }), REG);
    expect(done.checkbox).toEqual({ closed: true, cls: 'done' });
    expect(done.badges).toEqual([]); // чекбокс уже назвал первый класс набора
    const cancelled = rowProjectionOf(task({ 'orbis/task_status': 'cancelled' }), REG);
    expect(cancelled.checkbox).toEqual({ closed: true, cls: 'cancelled' });
    expect(cancelled.badges).toEqual([
      { kind: 'class', contract: 'orbis/completable', cls: 'cancelled' },
    ]);
  });
  test('снятый аспект гасит элемент, хотя значение осталось в props (Р9)', () => {
    const p = rowProjectionOf(
      { aspects: [], props: { 'orbis/task_status': 'done', 'orbis/priority': 'high' } },
      REG,
    );
    expect(p.checkbox).toBeNull();
    expect(p.badges).toEqual([]);
  });
  test('операция: сумма, направление классом, валюта; расход — дефолт промаха', () => {
    const fin = (props: Record<string, unknown>) =>
      rowProjectionOf({ aspects: ['orbis/financial'], props }, REG);
    expect(
      fin({ 'orbis/amount': '340.00', 'orbis/direction': 'income', 'orbis/currency': 'USD' })
        .amount,
    ).toEqual({ amount: '340.00', direction: 'inflow', currency: 'USD' });
    expect(fin({ 'orbis/amount': '340.00' }).amount).toEqual({
      amount: '340.00',
      direction: 'outflow',
      currency: null,
    });
    // ИЗМЕНЕНИЕ ВИДИМОГО ПОВЕДЕНИЯ: у операции без суммы элемент ПУСТ. Разметка печатала
    // `String(props['orbis/amount'] ?? '0')`, то есть «−0.00» там, где суммы нет вовсе.
    expect(fin({ 'orbis/direction': 'expense' }).amount).toBeNull();
    expect(fin({}).amount).toBeNull();
  });
  test('дата: deadline сильнее moment; у события остаётся moment', () => {
    const both = rowProjectionOf(
      {
        aspects: ['orbis/task', 'orbis/schedule'],
        props: {
          'orbis/task_status': 'planned',
          'orbis/due_date': '2026-09-11',
          'orbis/start_at': '2026-09-10T09:00:00+03:00',
        },
      },
      REG,
    );
    expect(both.date).toEqual({ value: '2026-09-11', slot: 'deadline' });
    const event = rowProjectionOf(
      { aspects: ['orbis/schedule'], props: { 'orbis/start_at': '2026-09-10T09:00:00+03:00' } },
      REG,
    );
    expect(event.date).toEqual({ value: '2026-09-10T09:00:00+03:00', slot: 'moment' });
  });
  test('важность — raw_value: только у незакрытой и только при носителе', () => {
    expect(
      rowProjectionOf(task({ 'orbis/task_status': 'inbox', 'orbis/priority': 'high' }), REG).badges,
    ).toEqual([{ kind: 'priority' }]);
    expect(
      rowProjectionOf(task({ 'orbis/task_status': 'done', 'orbis/priority': 'high' }), REG).badges,
    ).toEqual([]);
    // ИЗМЕНЕНИЕ ВИДИМОГО ПОВЕДЕНИЯ: у ОТМЕНЁННОЙ важность гаснет тоже. Разметка гасила точку при
    // `done` (`!done`), то есть у отменённой с `priority=high` рисовала её; условие теперь —
    // членство в наборе `closed`, и бейдж у такой записи остаётся ровно один: класс.
    expect(
      rowProjectionOf(task({ 'orbis/task_status': 'cancelled', 'orbis/priority': 'high' }), REG)
        .badges,
    ).toEqual([{ kind: 'class', contract: 'orbis/completable', cls: 'cancelled' }]);
  });
  test('свойство статуса — из ПОБЕДИВШЕЙ привязки; без контракта его нет', () => {
    // Читатель один — гард переключения чекбокса: писатель шапки знает ровно `orbis/task_status`,
    // и у чужой привязки клик записал бы не то свойство.
    expect(rowStatusPropertyOf(task({ 'orbis/task_status': 'inbox' }), REG)).toBe(
      'orbis/task_status',
    );
    expect(rowStatusPropertyOf({ aspects: ['orbis/note'], props: {} }, REG)).toBeUndefined();
    // Значение осталось, аспект снят — привязки нет, и переключать нечего (Р9).
    expect(
      rowStatusPropertyOf({ aspects: [], props: { 'orbis/task_status': 'done' } }, REG),
    ).toBeUndefined();
  });
  test('две привязки одного контракта: слот выбирается правилом, привязка — по rank аспекта', () => {
    // task и schedule оба реализуют `when`: deadline пуст → берётся moment у schedule.
    const p = rowProjectionOf(
      {
        aspects: ['orbis/schedule', 'orbis/task'],
        props: {
          'orbis/task_status': 'inbox',
          'orbis/start_at': '2026-09-10T09:00:00+03:00',
        },
      },
      REG,
    );
    expect(p.date).toEqual({ value: '2026-09-10T09:00:00+03:00', slot: 'moment' });
  });
});

describe('§С8-18: пользовательский аспект попадает в строку без строки кода', () => {
  // Аспект заведён ЗДЕСЬ, декларацией: ни одного `if` под его id в row.ts нет и быть не может —
  // строка читает привязки, а не список аспектов. Имя — `probe`, не `gate`: токены гейта
  // (`GATE_GREP_TOKENS` 0d) разрешены только фикстуре 0d и golden (Р-К-27), и греп-доказательство
  // задачи 10 считает любую другую строку с ними кодом под аспект гейта.
  // Основа — любой встроенный аспект: пробе нужны только `implements` и `properties`, всё
  // остальное (подписи, модуль, viewConfig) в правило строки не входит вовсе.
  const BASE = BUILTIN_ASPECT_DEFS[1];
  if (BASE === undefined) throw new Error('встроенных аспектов нет — пробу не из чего собрать');
  const PROBE: AspectDefinition = {
    ...BASE,
    id: 'user/probe-plain',
    key: 'user/probe-plain',
    rank: 99,
    properties: [{ propertyId: 'orbis/task_status', required: true, rank: 1 }],
    implements: [
      {
        contract: 'orbis/completable',
        bind: { status: 'orbis/task_status' },
        fixed: {},
        value_map: [
          { slot: 'status', variant: 'inbox', class: 'active' },
          { slot: 'status', variant: 'done', class: 'done' },
          { slot: 'status', variant: 'cancelled', class: 'cancelled' },
        ],
      },
      { contract: 'orbis/when', bind: { moment: 'orbis/start_at' }, fixed: {}, value_map: [] },
    ],
  };
  const REG_PROBE = {
    aspects: new Map([...REG.aspects, ['user/probe-plain', PROBE]]),
    contracts: REG.contracts,
  };

  test('чекбокс, дата и бейдж появляются у аспекта, которого код не знает', () => {
    const p = rowProjectionOf(
      {
        aspects: ['user/probe-plain'],
        props: {
          'orbis/task_status': 'cancelled',
          'orbis/start_at': '2026-09-10T09:00:00+03:00',
        },
      },
      REG_PROBE,
    );
    expect(p.checkbox).toEqual({ closed: true, cls: 'cancelled' });
    expect(p.date).toEqual({ value: '2026-09-10T09:00:00+03:00', slot: 'moment' });
    expect(p.badges).toEqual([{ kind: 'class', contract: 'orbis/completable', cls: 'cancelled' }]);
  });
});

describe('rowMoneyCurrencyOf: деньги колонки — по валюте привязки суммы (спека страниц 1а §7.2)', () => {
  const money = (props: Record<string, unknown>) => ({ aspects: ['orbis/financial'], props });
  test('слот amount привязки на записи — валюта её слота currency', () => {
    expect(
      rowMoneyCurrencyOf(
        money({ 'orbis/amount': '10', 'orbis/currency': 'USD' }),
        REG,
        'orbis/amount',
      ),
    ).toBe('USD');
    expect(rowMoneyCurrencyOf(money({ 'orbis/amount': '10' }), REG, 'orbis/amount')).toBeNull();
  });
  test('не слот amount или аспект снят — свойство не денежное', () => {
    expect(
      rowMoneyCurrencyOf(money({ 'orbis/currency': 'USD' }), REG, 'orbis/due_date'),
    ).toBeUndefined();
    expect(
      rowMoneyCurrencyOf({ aspects: [], props: { 'orbis/amount': '10' } }, REG, 'orbis/amount'),
    ).toBeUndefined();
  });
});

describe('rowAllDayOf: «весь день» — слот all_day контракта «когда» (1в §4.3, Б-2 №100)', () => {
  // Аспект владельца со СВОИМ свойством «весь день»: код его не знает, строка обязана прочесть
  // признак через привязку, а не по id встроенного `orbis/all_day`.
  const BASE = BUILTIN_ASPECT_DEFS[1];
  if (BASE === undefined) throw new Error('встроенных аспектов нет — пробу не из чего собрать');
  const TRIP: AspectDefinition = {
    ...BASE,
    id: 'user/trip',
    key: 'user/trip',
    rank: 99,
    properties: [],
    implements: [
      {
        contract: 'orbis/when',
        bind: { moment: 'user/trip_day', all_day: 'user/allday' },
        fixed: {},
        value_map: [],
      },
    ],
  };
  const REG_TRIP = {
    aspects: new Map([...REG.aspects, ['user/trip', TRIP]]),
    contracts: REG.contracts,
  };
  test('аспект владельца, реализующий «когда» своим свойством, — истина', () => {
    const e = {
      aspects: ['user/trip'],
      props: { 'user/trip_day': '2026-10-01', 'user/allday': true },
    };
    expect(rowAllDayOf(e, REG_TRIP)).toBe(true);
    expect(rowAllDayOf({ ...e, props: { 'user/allday': false } }, REG_TRIP)).toBe(false);
  });
  test('встроенное расписание — через свою привязку', () => {
    expect(
      rowAllDayOf({ aspects: ['orbis/schedule'], props: { 'orbis/all_day': true } }, REG),
    ).toBe(true);
  });
  test('orbis/all_day пережило снятие аспекта расписания (Р9) — ложь', () => {
    expect(rowAllDayOf({ aspects: [], props: { 'orbis/all_day': true } }, REG)).toBe(false);
    // У задачи «когда» есть, но слот all_day она не привязывает: сырое значение не читается.
    expect(rowAllDayOf(task({ 'orbis/all_day': true }), REG)).toBe(false);
  });
});

describe('имена слотов строки — из поля slots правила элемента (Б-2 №78 п. 43)', () => {
  const amountRule = M14_ROW_ELEMENTS.find((r) => r.element === 'amount');
  if (amountRule === undefined) throw new Error('правила элемента суммы нет');
  test('правило суммы объявляет все слоты, которые читает строка', () => {
    expect(amountRule.slots).toEqual(['amount', 'direction', 'currency', 'category']);
  });
  test('declaredSlot: слот вне правила — отказ, а не тихое чтение', () => {
    expect(declaredSlot(amountRule, 'currency')).toBe('currency');
    expect(() => declaredSlot({ element: 'amount', slots: ['amount'] }, 'currency')).toThrow(
      'слот не объявлен правилом',
    );
  });
  /**
   * Подменённый реестр правил: правило суммы без `currency`. Каждый читатель валюты обязан упасть —
   * значит, имя слота он берёт из правила, а не литералом мимо него. Правило — модульная константа,
   * поэтому подмена на время теста и возврат в `finally`.
   */
  test('правило без currency — чтение валюты бросает у всех читателей', () => {
    const rule = amountRule as { slots?: RowElementRule['slots'] };
    const saved = rule.slots;
    rule.slots = ['amount', 'direction', 'category'];
    try {
      const money = {
        aspects: ['orbis/financial'],
        props: { 'orbis/amount': '10', 'orbis/currency': 'USD' },
      };
      expect(() => rowMoneyCurrencyOf(money, REG, 'orbis/amount')).toThrow(
        'слот не объявлен правилом',
      );
      expect(() => rowProjectionOf(money, REG)).toThrow('слот не объявлен правилом');
    } finally {
      rule.slots = saved;
    }
  });
  test('правило без category — чтение категории бросает', () => {
    const rule = amountRule as { slots?: RowElementRule['slots'] };
    const saved = rule.slots;
    rule.slots = ['amount', 'direction', 'currency'];
    try {
      expect(() => rowCategoryRefOf({ aspects: ['orbis/financial'], props: {} }, REG)).toThrow(
        'слот не объявлен правилом',
      );
    } finally {
      rule.slots = saved;
    }
  });
});
