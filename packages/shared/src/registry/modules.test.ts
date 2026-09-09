import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import {
  isModuleEnabled,
  MODULE_IDS,
  MODULE_MANIFESTS,
  moduleOfTool,
  modulePromptFragments,
  SURFACE_RE,
  SURFACES,
  SWITCHABLE_MODULE_IDS,
  setModuleEnabledInput,
  surfaceModuleOf,
} from './modules';

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

describe('манифест модуля (§Б8-1): состав вне реестров объявлен данными', () => {
  test('манифест у каждого модуля; поверхность модуля принадлежит ему же', () => {
    expect(Object.keys(MODULE_MANIFESTS).sort()).toEqual([...MODULE_IDS].sort());
    for (const id of MODULE_IDS) {
      expect(MODULE_MANIFESTS[id].id).toBe(id);
      // Иначе выключение чужого модуля унесло бы чужую поверхность (§С1-3 п.9)
      for (const s of MODULE_MANIFESTS[id].surfaces) expect(surfaceModuleOf(s)).toBe(id);
      for (const r of MODULE_MANIFESTS[id].codeRemainder)
        expect(r.why.trim().length).toBeGreaterThan(0);
    }
  });

  test('Финансы: два тула, одна поверхность, три промпт-фрагмента', () => {
    const fin = MODULE_MANIFESTS.finance;
    expect([...fin.tools].sort()).toEqual(['budget_status', 'import_csv_start']);
    expect(fin.surfaces).toEqual(['finance/budget-overview']);
    expect(fin.promptFragments.map((f) => f.id)).toEqual([
      'finance/amounts',
      'finance/one-intent',
      'finance/budget',
    ]);
  });

  test('isModuleEnabled: ядро (module null) не выключается никогда (§Б8-2)', () => {
    expect([
      isModuleEnabled(null, ['finance']),
      isModuleEnabled(undefined, ['finance']),
      isModuleEnabled('finance', ['finance']),
      isModuleEnabled('planner', ['finance']),
    ]).toEqual([true, true, false, true]);
  });

  test('moduleOfTool: attach_* — по module аспекта, core-тул — по манифесту', () => {
    const reg = { aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])) };
    expect(moduleOfTool('attach_orbis_financial', reg)).toBe('finance');
    expect(moduleOfTool('attach_orbis_note', reg)).toBe(null); // ядро, builtin-aspects.ts:139
    expect(moduleOfTool('budget_status', reg)).toBe('finance');
    expect(moduleOfTool('entity_create', reg)).toBe(null);
  });

  test('modulePromptFragments и setModuleEnabledInput', () => {
    expect(modulePromptFragments([])).toContain('budget_status');
    expect(modulePromptFragments(['finance'])).toBe(null); // непустые фрагменты в Б-1 — только у Финансов
    expect(setModuleEnabledInput.safeParse({ module: 'finance', enabled: false }).success).toBe(
      true,
    );
    expect(setModuleEnabledInput.safeParse({ module: 'nope', enabled: false }).success).toBe(false);
    // Ф-Б1-57б: переключается ТОЛЬКО `finance` — у остальных четырёх серверной половины
    // §Б8-1 в Б-1 нет, и выключение дало бы владельцу ПОЛОВИНУ выключения (реестр снялся бы,
    // проза промпта осталась).
    expect([...SWITCHABLE_MODULE_IDS]).toEqual(['finance']);
    for (const m of MODULE_IDS.filter((id) => id !== 'finance')) {
      expect(setModuleEnabledInput.safeParse({ module: m, enabled: false }).success).toBe(false);
    }
    expect(
      setModuleEnabledInput.safeParse({ module: 'finance', enabled: false, x: 1 }).success,
    ).toBe(false);
  });
});
