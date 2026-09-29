import { describe, expect, test } from 'bun:test';
import { BUILTIN_ACTION_DEFS } from './builtin-actions';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import {
  EXTENSION_IDS,
  EXTENSION_MANIFESTS,
  extensionName,
  extensionNameGenitive,
  extensionOfTool,
  extensionPromptFragments,
  HOST_OWN_CARDS,
  isExtensionEnabled,
  ownCardOrder,
  SURFACE_ENGINE,
  SURFACE_RE,
  SURFACES,
  SWITCHABLE_EXTENSION_IDS,
  setExtensionEnabledInput,
  surfaceExtensionOf,
} from './extensions';

describe('словарь расширений и поверхностей (спека 1б §3.1–§3.3, РП-1, РП-2)', () => {
  test('четыре расширения: planner и memory — ядро, ade разделён на «Проекты» и «Разработку»', () => {
    expect([...EXTENSION_IDS]).toEqual(['finance', 'goals', 'projects', 'dev']);
  });
  test('поверхности — только те, у которых есть движок подписки (Р-К-10); Повестки среди них нет (1в §6.5)', () => {
    // Повестка с 1в — запись поставки из блоков: движка подписки у неё нет, и имя без исполнителя
    // было бы обещанием, которое некому сдержать. `SURFACE_RE` голову `core` по-прежнему принимает
    // (форма имени законна), запись подписки стережёт этот словарь.
    expect([...SURFACES]).toEqual(['finance/budget-overview']);
    expect(SURFACE_ENGINE).toEqual({ 'finance/budget-overview': 'budget' });
  });
  test('каждое имя проходит форму «расширение/поверхность»; головы прежнего словаря — нет', () => {
    for (const s of SURFACES) expect(SURFACE_RE.test(s)).toBe(true);
    expect([
      SURFACE_RE.test('agenda'),
      SURFACE_RE.test('unknown/agenda'),
      SURFACE_RE.test('planner/agenda'),
      SURFACE_RE.test('ade/x'),
      SURFACE_RE.test('projects/board'),
    ]).toEqual([false, false, false, false, true]);
  });
  test('расширение читается ИЗ ИМЕНИ; core — ядро, расширения нет', () => {
    expect([
      surfaceExtensionOf('finance/budget-overview'),
      surfaceExtensionOf('core/agenda'),
      surfaceExtensionOf('core/row'),
      surfaceExtensionOf('planner/agenda'),
    ]).toEqual(['finance', null, null, null]);
  });
});

describe('манифест расширения (§4.1): состав вне реестров объявлен данными', () => {
  test('манифест у каждого расширения: имя, иконка, описание; поверхность принадлежит ему же', () => {
    expect(Object.keys(EXTENSION_MANIFESTS).sort()).toEqual([...EXTENSION_IDS].sort());
    for (const id of EXTENSION_IDS) {
      const m = EXTENSION_MANIFESTS[id];
      expect(m.id).toBe(id);
      // Экран «Приложения и расширения» (задача 22) рисует карточку из этих трёх полей —
      // пустое поле дало бы безымянную плитку.
      expect((m.name.ru ?? '').trim().length).toBeGreaterThan(0);
      expect(m.icon.trim().length).toBeGreaterThan(0);
      expect((m.description.ru ?? '').trim().length).toBeGreaterThan(0);
      // Иначе выключение чужого расширения унесло бы чужую поверхность (§С1-3 п.9)
      for (const s of m.surfaces) expect(surfaceExtensionOf(s)).toBe(id);
      for (const r of m.codeRemainder) expect(r.why.trim().length).toBeGreaterThan(0);
    }
    // Родительный падеж — голова отказа правила выключенного расширения (спека 1б §8.3, R-9).
    expect(EXTENSION_IDS.map((id) => extensionNameGenitive(id))).toEqual([
      'Финансов',
      'Целей',
      'Проектов',
      'Разработки',
    ]);
    expect(extensionNameGenitive('planner')).toBe('planner'); // вне словаря — как есть
    expect(EXTENSION_IDS.map((id) => EXTENSION_MANIFESTS[id].name.ru)).toEqual([
      'Финансы',
      'Цели',
      'Проекты',
      'Разработка',
    ]);
  });

  test('Финансы: три тула, одна поверхность, три промпт-фрагмента, читает два контракта', () => {
    const fin = EXTENSION_MANIFESTS.finance;
    // `budget_rollover` — инструмент РАСШИРЕНИЯ (задача 10 Б-2, §Б6-5 ревизии 4): выключены
    // Финансы — нет и переноса остатков. `subscription_set` — с 1в (§6.5, R-22): единственная
    // поверхность подписки — Бюджета, и без Финансов тул отвечает `MODULE_DISABLED`, а не «неизвестным».
    // `import_csv_start` снят до среза Бюджета (1в §7.4): интерфейса импорта нет — и в описании
    // расширения импорта выписок тоже нет.
    expect([...fin.tools].sort()).toEqual(['budget_rollover', 'budget_status', 'subscription_set']);
    expect(fin.description).toEqual({
      ru: 'Расходы и доходы, категории и конверты бюджета',
      en: 'Expenses and income, categories and budget envelopes',
    });
    expect(fin.surfaces).toEqual(['finance/budget-overview']);
    expect(fin.promptFragments.map((f) => f.id)).toEqual([
      'finance/amounts',
      'finance/one-intent',
      'finance/budget',
    ]);
    expect(fin.promptFragments[0]?.text.startsWith('Деньги (расширение «Финансы»)')).toBe(true);
    expect(fin.reads).toEqual(['orbis/money-movement', 'orbis/envelope']);
    expect(fin.cards).toEqual([{ aspect: 'orbis/financial', rank: 50 }]);
  });

  test('Цели, Проекты, Разработка: тулов нет; фрагмент — только у Целей (строки о целях v8)', () => {
    for (const id of ['projects', 'dev'] as const) {
      expect([EXTENSION_MANIFESTS[id].tools, EXTENSION_MANIFESTS[id].promptFragments]).toEqual([
        [],
        [],
      ]);
    }
    const goals = EXTENSION_MANIFESTS.goals;
    expect(goals.tools).toEqual([]);
    expect(goals.promptFragments.map((f) => f.id)).toEqual(['goals/goals']);
    expect(goals.promptFragments[0]?.text.startsWith('Цели (расширение «Цели»):')).toBe(true);
    expect(goals.cards).toEqual([{ aspect: 'orbis/goal', rank: 10 }]);
  });

  test('ownCardOrder: карточки ядра и расширений по рангу — порядок снимка 1а (РП-23)', () => {
    expect(HOST_OWN_CARDS.map((c) => c.aspect)).toEqual([
      'orbis/assignment',
      'orbis/routine',
      'orbis/agent-run',
    ]);
    expect(ownCardOrder().map((c) => c.aspect)).toEqual([
      'orbis/goal',
      'orbis/assignment',
      'orbis/routine',
      'orbis/agent-run',
      'orbis/financial',
    ]);
    // Каждая своя карточка — существующий аспект: иначе {{cards: own}} ссылался бы в пустоту.
    const aspects = new Set(BUILTIN_ASPECT_DEFS.map((a) => a.id));
    for (const c of ownCardOrder()) expect(aspects.has(c.aspect)).toBe(true);
  });

  test('extensionName: подпись из манифеста; id вне словаря — как есть', () => {
    expect([
      extensionName('finance'),
      extensionName('dev', 'en'),
      extensionName('planner'),
    ]).toEqual(['Финансы', 'Development', 'planner']);
  });

  test('isExtensionEnabled: ядро (module null) не выключается никогда (§8.2)', () => {
    expect([
      isExtensionEnabled(null, ['finance']),
      isExtensionEnabled(undefined, ['finance']),
      isExtensionEnabled('finance', ['finance']),
      isExtensionEnabled('goals', ['finance']),
    ]).toEqual([true, true, false, true]);
  });

  test('extensionOfTool: attach_* — по module аспекта, core-тул — по манифесту', () => {
    const reg = { aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])) };
    expect(extensionOfTool('attach_orbis_financial', reg)).toBe('finance');
    expect(extensionOfTool('attach_orbis_project', reg)).toBe('projects');
    expect(extensionOfTool('attach_orbis_repo', reg)).toBe('dev');
    // Планировщик и Память — ядро с 1б (спека §8.1): их аспекты не выключаются.
    expect(extensionOfTool('attach_orbis_schedule', reg)).toBe(null);
    expect(extensionOfTool('attach_orbis_memory', reg)).toBe(null);
    expect(extensionOfTool('attach_orbis_note', reg)).toBe(null);
    expect(extensionOfTool('budget_status', reg)).toBe('finance');
    expect(extensionOfTool('entity_create', reg)).toBe(null);
  });

  test('extensionOfTool: action_* — по module действия, вперёд от ключей (§Б6-6, Р-20)', () => {
    const reg = {
      aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
      actions: new Map(BUILTIN_ACTION_DEFS.map((a) => [a.id, a])),
    };
    // Действие ядра (РП-2): `core/postpone_overdue`, module null.
    expect(extensionOfTool('action_core_postpone_overdue', reg)).toBe(null);
    expect(extensionOfTool('action_finance_plan_to_fact', reg)).toBe('finance');
    // Имени нет среди действий снимка — ядро/неизвестное, а не чужое расширение по префиксу имени.
    expect(extensionOfTool('action_finance_выдумка', reg)).toBe(null);
    // Снимок без словаря действий — тот же `null`.
    expect(extensionOfTool('action_finance_plan_to_fact', { aspects: reg.aspects })).toBe(null);
    // Реестровый `action_set` (задача 10 Б-2) — не тул действия: ядро (М-4).
    expect(extensionOfTool('action_set', reg)).toBe(null);
  });

  test('extensionPromptFragments и setExtensionEnabledInput', () => {
    expect(extensionPromptFragments([])).toContain('budget_status');
    expect(extensionPromptFragments([])).toContain('orbis/target_value');
    // Маска гасит ровно своё расширение: без Финансов остаются Цели, без Целей — Финансы
    expect(extensionPromptFragments(['finance'])).not.toContain('budget_status');
    expect(extensionPromptFragments(['finance'])).toContain('orbis/target_value');
    expect(extensionPromptFragments(['goals'])).not.toContain('orbis/target_value');
    // Непустые фрагменты — только у Финансов и Целей: без обоих секции нет вовсе
    expect(extensionPromptFragments(['finance', 'goals'])).toBe(null);
    // П0 (спека 1б §8.6): с задачи 7 переключаются ВСЕ четыре расширения — условия Ф-Б1-57б
    // выполнены (проза — во фрагментах, задача 6; поля — только чтение, задача 7). Бывшие модули
    // ядра и `ade` — не расширения вовсе.
    expect([...SWITCHABLE_EXTENSION_IDS]).toEqual([...EXTENSION_IDS]);
    for (const m of EXTENSION_IDS) {
      expect(setExtensionEnabledInput.safeParse({ module: m, enabled: false }).success).toBe(true);
    }
    for (const m of ['planner', 'ade', 'nope', 'memory']) {
      expect(setExtensionEnabledInput.safeParse({ module: m, enabled: false }).success).toBe(false);
    }
    expect(
      setExtensionEnabledInput.safeParse({ module: 'finance', enabled: false, x: 1 }).success,
    ).toBe(false);
  });
});
