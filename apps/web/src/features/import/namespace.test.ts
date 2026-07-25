// Task C4b (03-budget §3.4.1): правило нормализации имени источника в namespace
// entity_origins. Значение попадает в уникальный ключ (owner_id, namespace, external_id)
// НАВСЕГДА, поэтому правило покрыто пунктом за пунктом: две выгрузки одного счёта за
// разные месяцы обязаны дать ОДИН namespace, иначе повторная строка получит ✓ вместо ⟳.
import { importNamespaceSchema } from '@orbis/shared';
import { expect, test } from 'vitest';
import { csvNamespace } from './namespace';

test('расширение отбрасывается, регистр опускается, префикс csv:', () => {
  expect(csvNamespace('Statement.CSV')).toBe('csv:statement');
});

test('датоподобные куски вырезаются: DD.MM.YYYY и YYYY-MM-DD дают один namespace', () => {
  expect(csvNamespace('выписка_май_01.05.2026.csv')).toBe('csv:выписка-май');
  expect(csvNamespace('выписка_май_02.06.2026.csv')).toBe('csv:выписка-май');
  expect(csvNamespace('выписка_май_2026-06-02.csv')).toBe('csv:выписка-май');
});

test('отдельно стоящая группа 6–8 цифр — тоже дата (20260501, 010526)', () => {
  expect(csvNamespace('tinkoff_20260501.csv')).toBe('csv:tinkoff');
  expect(csvNamespace('tinkoff_010526.csv')).toBe('csv:tinkoff');
});

test('короткие и длинные группы цифр — часть имени источника, не дата', () => {
  // 4 цифры (номер счёта) и 9 цифр (id) не похожи на дату — остаются
  expect(csvNamespace('счет_4276.csv')).toBe('csv:счет-4276');
  expect(csvNamespace('acc_123456789.csv')).toBe('csv:acc-123456789');
});

test('всё не буква/цифра схлопывается в один дефис, края срезаются', () => {
  expect(csvNamespace('  __Сбер // Счёт**  .csv')).toBe('csv:сбер-счёт');
});

test('длинное имя обрезается до 40 символов хвоста и не оканчивается дефисом', () => {
  const long = `${'а'.repeat(38)}_${'б'.repeat(20)}.csv`;
  const ns = csvNamespace(long);
  expect(ns.slice(4)).toHaveLength(38 + 1 + 1); // 38 «а» + дефис + 1 «б» = 40
  expect(ns.endsWith('-')).toBe(false);
});

test('обрезка на границе дефиса не оставляет висячий дефис', () => {
  // 39 символов имени, 40-й — разделитель: после slice(0,40) хвостовой дефис срезается
  expect(csvNamespace(`${'а'.repeat(39)}_хвост.csv`).slice(4)).toBe('а'.repeat(39));
});

test('имя без букв и цифр (или пустое) → statement', () => {
  expect(csvNamespace('01.05.2026.csv')).toBe('csv:statement');
  expect(csvNamespace('___.csv')).toBe('csv:statement');
  expect(csvNamespace('.csv')).toBe('csv:statement');
  expect(csvNamespace('')).toBe('csv:statement');
});

test('результат всегда проходит importNamespaceSchema сервера', () => {
  const names = [
    'выписка_май_01.05.2026.csv',
    'Statement.CSV',
    '___.csv',
    `${'я'.repeat(90)}.csv`,
    'a b\tc.csv',
    '01.05.2026.csv',
  ];
  for (const name of names) {
    expect(importNamespaceSchema.safeParse(csvNamespace(name)).success).toBe(true);
  }
});
