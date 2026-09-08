import { describe, expect, test } from 'bun:test';
import { MODULE_IDS, SURFACE_RE, SURFACES, surfaceModuleOf } from './modules';

describe('словарь модулей и поверхностей (§Б5-1, §Б8-1)', () => {
  test('пять модулей — ровно те, что стоят в колонке module встроенных реестров', () => {
    expect([...MODULE_IDS]).toEqual(['finance', 'planner', 'goals', 'ade', 'memory']);
  });
  test('поверхности Б-1 — только те, у которых есть движок подписки (Р-К-10)', () => {
    expect([...SURFACES]).toEqual(['planner/agenda', 'finance/budget-overview']);
  });
  test('каждое имя проходит форму «модуль/поверхность»', () => {
    for (const s of SURFACES) expect(SURFACE_RE.test(s)).toBe(true);
    expect([SURFACE_RE.test('agenda'), SURFACE_RE.test('unknown/agenda')]).toEqual([false, false]);
  });
  test('модуль читается ИЗ ИМЕНИ; core — ядро, модуля нет', () => {
    expect([surfaceModuleOf('finance/budget-overview'), surfaceModuleOf('core/row')]).toEqual([
      'finance',
      null,
    ]);
  });
});
