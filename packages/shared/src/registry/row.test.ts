// Правило строки M14 (§Б5-6 :560) — ДАННЫЕ, а не россыпь `if` по аспектам: один источник для
// EntityRow, NativeRow, toSuggestion и снимка core/row. Реестр НАСТОЯЩИЙ: правило обязано
// совпадать с боевым, иначе зелёный тест не значит ничего.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import { BUILTIN_CONTRACT_DEFS } from './builtin-contracts';
import type { AspectDefinition } from './property-type';
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
