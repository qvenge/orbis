// packages/shared/src/nav/history-model.test.ts
// ЗАЧЕМ ЭТОТ ТЕСТ: история навигации (спека 1б §7.3, С1б-3) — одна модель «приложение → разделы →
// стопки» и два поведения по способу запуска. Поведение — чистая функция, поэтому обе стороны
// (как приложение / как сайт) проверяются здесь, а в экранах нет «если PWA». Где поведение общее —
// `describe.each` по режимам; где разное — отдельные таблицы. Сохранение `orbis:nav:v2` держит
// «переживает перезапуск: раздел и последнее место, глубина — нет» и отказ от старого `orbis:nav:v1`
// (Фокус ревью п. 1). Последний блок — тотальность: любое действие над любой моделью даёт модель.
import { describe, expect, test } from 'bun:test';
import { type Address, type AppRef, buildAddress } from './address';
import {
  type AppNav,
  canGoBack,
  currentEntry,
  HOME_SECTION,
  HOST_APP,
  initialModel,
  type LaunchMode,
  launchModeOf,
  NAV_STORAGE_KEY,
  type NavAction,
  type NavEffect,
  type NavModel,
  navReduce,
  persistOf,
  restoreFrom,
  type StackEntry,
} from './history-model';

const HOST: AppRef = { kind: 'host' };
const X = '0198f0a1-0000-7000-8000-00000000000a';
const Y = '0198f0a1-0000-7000-8000-00000000000b';
const XR: AppRef = { kind: 'app', ref: X };
const YR: AppRef = { kind: 'app', ref: Y };
const id = (n: number) => `0198f0a1-1111-7000-8000-${String(n).padStart(12, '0')}`;
const rec = (n: number, app: AppRef = HOST): Address => ({ kind: 'record', app, id: id(n) });
const HOST_HOME: Address = { kind: 'home', app: HOST };
const X_HOME: Address = { kind: 'home', app: XR };
const Y_HOME: Address = { kind: 'home', app: YR };
const CHAT: Address = { kind: 'host-screen', screen: 'chat' };
const SEARCH: Address = { kind: 'host-screen', screen: 'search', q: 'еда' };
// Разделы хоста — id записей-разделов; «Записи» и «Сегодня» — корни своих стопок.
const RECORDS = id(900);
const TODAY = id(901);
const RECORDS_ROOT = rec(900);
const TODAY_ROOT = rec(901);

const MODES: LaunchMode[] = ['app', 'site'];

/** Прогон действий подряд; эффекты — по порядку. */
function run(model: NavModel, actions: NavAction[], mode: LaunchMode) {
  const effects: NavEffect[] = [];
  let m = model;
  for (const a of actions) {
    const r = navReduce(m, a, mode);
    m = r.model;
    effects.push(r.effect);
  }
  return { model: m, effects, last: effects[effects.length - 1] };
}

/** Адреса стопки раздела (по умолчанию — активного раздела активного приложения). */
function stackOf(m: NavModel, app = m.activeApp, section?: string): Address[] | undefined {
  const nav = m.apps[app];
  const s = nav?.stacks[section ?? nav.activeSection];
  return s?.map((e) => e.address);
}

const open = (
  address: Address,
  app = HOST_APP,
  from: 'content' | 'host-screen' = 'content',
): NavAction => ({
  type: 'open',
  address,
  app,
  from,
});
const BACK: NavAction = { type: 'back' };

/** Хост с разделом «Записи» (активен) и «Сегодня». */
function hostWithSections(): NavModel {
  return run(
    initialModel(HOST_HOME),
    [
      { type: 'section', app: HOST_APP, section: TODAY, root: TODAY_ROOT },
      { type: 'section', app: HOST_APP, section: RECORDS, root: RECORDS_ROOT },
    ],
    'app',
  ).model;
}

describe('initialModel, currentEntry, canGoBack', () => {
  test('начальная модель — хост, раздел HOME_SECTION, [home]', () => {
    const m = initialModel(HOST_HOME);
    expect(m).toEqual({
      activeApp: HOST_APP,
      apps: {
        [HOST_APP]: {
          activeSection: HOME_SECTION,
          stacks: { [HOME_SECTION]: [{ address: HOST_HOME }] },
        },
      },
    });
    expect(HOST_APP).toBe('host');
    expect(HOME_SECTION).toBe('home');
    expect(currentEntry(m)).toEqual({ address: HOST_HOME });
  });

  test('(12) canGoBack: корень хоста — false; после перехода — true; корень раздела хоста — false', () => {
    expect(canGoBack(initialModel(HOST_HOME))).toBe(false);
    expect(canGoBack(run(initialModel(HOST_HOME), [open(rec(1))], 'app').model)).toBe(true);
    expect(canGoBack(hostWithSections())).toBe(false);
  });

  test('canGoBack: дно стопки не-хоста — true (назад ведёт в хост)', () => {
    const m = run(
      initialModel(HOST_HOME),
      [{ type: 'switch-app', app: X, home: X_HOME }],
      'app',
    ).model;
    expect(canGoBack(m)).toBe(true);
  });

  test('currentEntry на модели без активной стопки не бросает — домашняя хоста', () => {
    const broken: NavModel = { activeApp: 'нет', apps: {} };
    expect(currentEntry(broken)).toEqual({ address: HOST_HOME });
  });
});

describe.each(MODES)('общее для обоих режимов: %s', (mode) => {
  const push = mode === 'app' ? 'replace' : 'push';

  test('(1) open, open — в стопку активного раздела', () => {
    const r = run(hostWithSections(), [open(rec(1)), open(rec(2))], mode);
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, rec(1), rec(2)]);
    expect(r.effects).toEqual([{ history: push }, { history: push }]);
    expect(stackOf(r.model, HOST_APP, TODAY)).toEqual([TODAY_ROOT]);
  });

  test('(2) ссылка на запись «чужого» раздела кладётся в текущую стопку', () => {
    const r = run(hostWithSections(), [open(TODAY_ROOT)], mode);
    expect(r.model.apps[HOST_APP]?.activeSection).toBe(RECORDS);
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, TODAY_ROOT]);
    expect(stackOf(r.model, HOST_APP, TODAY)).toEqual([TODAY_ROOT]);
  });

  test('переход на то же место, что наверху, стопку не растит', () => {
    const r = run(hostWithSections(), [open(rec(1)), open(rec(1))], mode);
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, rec(1)]);
    expect(r.last).toEqual({ history: 'replace' });
  });

  test('(3) повторное нажатие на активный раздел → корень раздела', () => {
    const r = run(
      hostWithSections(),
      [
        open(rec(1)),
        open(rec(2)),
        { type: 'section', app: HOST_APP, section: RECORDS, root: RECORDS_ROOT },
      ],
      mode,
    );
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT]);
    expect(r.last).toEqual({ history: push });
    // Уже на корне — место не меняется: в режиме сайта это замена, не новая запись истории.
    const again = navReduce(
      r.model,
      { type: 'section', app: HOST_APP, section: RECORDS, root: RECORDS_ROOT },
      mode,
    );
    expect(again.model).toEqual(r.model);
    expect(again.effect).toEqual({ history: 'replace' });
  });

  test('(4) switch-app на текущем → домашняя приложения (HOME_SECTION, [home])', () => {
    const r = run(
      initialModel(HOST_HOME),
      [
        { type: 'switch-app', app: X, home: X_HOME },
        { type: 'section', app: X, section: 's', root: rec(10, XR) },
        open(rec(11, XR), X),
        { type: 'switch-app', app: X, home: X_HOME },
      ],
      mode,
    );
    expect(r.model.activeApp).toBe(X);
    expect(r.model.apps[X]?.activeSection).toBe(HOME_SECTION);
    expect(stackOf(r.model)).toEqual([X_HOME]);
    // Стопка раздела не сбрасывается — к нему вернёт нажатие на раздел.
    expect(stackOf(r.model, X, 's')).toEqual([rec(10, XR), rec(11, XR)]);
  });

  test('(5) форма «домашняя как центр» — одна стопка HOME_SECTION', () => {
    const r = run(
      initialModel(HOST_HOME),
      [{ type: 'switch-app', app: X, home: X_HOME }, open(rec(1, XR), X), open(rec(2, XR), X)],
      mode,
    );
    expect(Object.keys(r.model.apps[X]?.stacks ?? {})).toEqual([HOME_SECTION]);
    expect(stackOf(r.model)).toEqual([X_HOME, rec(1, XR), rec(2, XR)]);
    const home = navReduce(r.model, { type: 'switch-app', app: X, home: X_HOME }, mode).model;
    expect(stackOf(home)).toEqual([X_HOME]);
  });

  test('(6) переход в другое приложение: запись с источником в стопке его активного раздела', () => {
    const r = run(hostWithSections(), [open(rec(1)), open(rec(5, XR), X)], mode);
    expect(r.model.activeApp).toBe(X);
    expect(r.model.apps[X]?.stacks[HOME_SECTION]).toEqual([
      { address: rec(5, XR), source: { app: HOST_APP, section: RECORDS } },
    ]);
    expect(stackOf(r.model, HOST_APP, RECORDS)).toEqual([RECORDS_ROOT, rec(1)]);
    expect(r.last).toEqual({ history: push });
  });

  test('(7) экран хоста — поверх текущего раздела, в его стопку', () => {
    const r = run(hostWithSections(), [open(rec(1)), { type: 'host-screen', address: CHAT }], mode);
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, rec(1), CHAT]);
    expect(r.last).toEqual({ history: push });
  });

  test('(7) экран хоста поверх экрана хоста заменяет его: «‹» всегда ведёт в раздел', () => {
    const r = run(
      hostWithSections(),
      [
        { type: 'host-screen', address: CHAT },
        { type: 'host-screen', address: SEARCH },
      ],
      mode,
    );
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, SEARCH]);
  });

  test('(7) open из экрана хоста в том же приложении — экран снят', () => {
    const r = run(
      hostWithSections(),
      [{ type: 'host-screen', address: CHAT }, open(rec(1), HOST_APP, 'host-screen')],
      mode,
    );
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, rec(1)]);
  });

  test('(7) open из экрана хоста в другое приложение — источник = раздел под экраном, экран снят', () => {
    const r = run(
      hostWithSections(),
      [{ type: 'host-screen', address: CHAT }, open(rec(5, XR), X, 'host-screen')],
      mode,
    );
    expect(stackOf(r.model, HOST_APP, RECORDS)).toEqual([RECORDS_ROOT]);
    expect(r.model.apps[X]?.stacks[HOME_SECTION]).toEqual([
      { address: rec(5, XR), source: { app: HOST_APP, section: RECORDS } },
    ]);
  });

  test('open из содержимого (боковой чат, ⌘K) экран хоста наверху не снимает', () => {
    // Боковой чат и ⌘K не элементы истории: их ссылка — обычный переход из текущего места.
    const r = run(hostWithSections(), [{ type: 'host-screen', address: CHAT }, open(rec(1))], mode);
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, CHAT, rec(1)]);
  });

  test('(8) replace в том же приложении меняет верх стопки; source и view на месте; эффект replace', () => {
    const refined = rec(6, XR);
    for (const app of [undefined, X]) {
      const r = run(
        hostWithSections(),
        [
          open(rec(5, XR), X),
          { type: 'view', patch: { tab: 'Связи' } },
          app === undefined
            ? { type: 'replace', address: refined }
            : { type: 'replace', address: refined, app },
        ],
        mode,
      );
      expect(r.model.activeApp).toBe(X);
      expect(r.model.apps[X]?.stacks[HOME_SECTION]).toEqual([
        { address: refined, source: { app: HOST_APP, section: RECORDS }, view: { tab: 'Связи' } },
      ]);
      expect(r.last).toEqual({ history: 'replace' });
    }
  });

  describe('(8) replace в другое приложение (R-22): рамка = активное приложение', () => {
    // У X уже есть стопка раздела `s`; в хосте открыта запись, правило открытия уточнило её в X.
    function redirected() {
      return run(
        hostWithSections(),
        [
          { type: 'switch-app', app: X, home: X_HOME },
          { type: 'section', app: X, section: 's', root: rec(10, XR) },
          open(rec(11, XR), X),
          { type: 'switch-app', app: HOST_APP, home: HOST_HOME },
          open(rec(1)),
          { type: 'view', patch: { tab: 'Связи' } },
          { type: 'replace', address: rec(1, XR), app: X },
        ],
        mode,
      );
    }

    test('запись переехала в стопку активного раздела X с источником; эффект replace', () => {
      const r = redirected();
      expect(r.last).toEqual({ history: 'replace' });
      expect(r.model.activeApp).toBe(X);
      expect(r.model.apps[X]?.activeSection).toBe('s');
      expect(r.model.apps[X]?.stacks.s).toEqual([
        { address: rec(10, XR) },
        { address: rec(11, XR) },
        {
          address: rec(1, XR),
          source: { app: HOST_APP, section: RECORDS },
          view: { tab: 'Связи' },
        },
      ]);
      expect(stackOf(r.model, HOST_APP, RECORDS)).toEqual([RECORDS_ROOT]);
    });

    test('«‹» ведёт туда, откуда пришли (РП-21): app — в «Записи» хоста, site — назад браузера', () => {
      const m = redirected().model;
      const r = navReduce(m, BACK, mode);
      if (mode === 'app') {
        expect(r.effect).toEqual({ history: 'none' });
        expect(r.model.activeApp).toBe(HOST_APP);
        expect(r.model.apps[HOST_APP]?.activeSection).toBe(RECORDS);
        expect(currentEntry(r.model).address).toEqual(RECORDS_ROOT);
        expect(stackOf(r.model, X, 's')).toEqual([rec(10, XR), rec(11, XR)]);
      } else {
        expect(r).toEqual({ model: m, effect: { history: 'back' } });
      }
    });

    test('иконка X теперь — иконка текущего приложения: домашняя X', () => {
      const r = navReduce(redirected().model, { type: 'switch-app', app: X, home: X_HOME }, mode);
      expect(r.model.activeApp).toBe(X);
      expect(r.model.apps[X]?.activeSection).toBe(HOME_SECTION);
      expect(stackOf(r.model)).toEqual([X_HOME]);
    });

    test('persistOf пишет адрес X в раздел X, не в раздел хоста', () => {
      const p = persistOf(redirected().model);
      expect(p.activeApp).toBe(X);
      expect(p.apps[X]?.last.s).toEqual(rec(1, XR));
      expect(p.apps[HOST_APP]?.last[RECORDS]).toEqual(RECORDS_ROOT);
    });

    test('запись, уже пришедшая из третьего приложения, сохраняет свой источник', () => {
      const r = run(
        hostWithSections(),
        [open(rec(5, YR), Y), { type: 'replace', address: rec(5, XR), app: X }],
        mode,
      );
      expect(r.model.activeApp).toBe(X);
      expect(r.model.apps[X]?.stacks[HOME_SECTION]).toEqual([
        { address: rec(5, XR), source: { app: HOST_APP, section: RECORDS } },
      ]);
      expect(r.model.apps[Y]?.stacks[HOME_SECTION]).toBeUndefined();
    });

    test('единственная запись хоста (вход по ссылке) — хосту места не остаётся; «назад» с дна X — домашняя хоста', () => {
      const r = navReduce(
        initialModel(rec(1)),
        { type: 'replace', address: rec(1, XR), app: X },
        mode,
      );
      expect(r.model.activeApp).toBe(X);
      expect(r.model.apps[X]?.stacks[HOME_SECTION]).toEqual([{ address: rec(1, XR) }]);
      expect(r.model.apps[HOST_APP]?.stacks[HOME_SECTION]).toBeUndefined();
      // Orbis закрывается только на дне корневого приложения (§7.3): дно X ведёт в хост.
      expect(canGoBack(r.model)).toBe(true);
      const opened = navReduce(r.model, open(rec(2, XR), X), mode).model;
      const b1 = navReduce(opened, BACK, 'app');
      expect(currentEntry(b1.model).address).toEqual(rec(1, XR));
      const b2 = navReduce(b1.model, BACK, 'app');
      expect(b2.effect).toEqual({ history: 'none' });
      expect(b2.model.activeApp).toBe(HOST_APP);
      expect(b2.model.apps[HOST_APP]?.activeSection).toBe(HOME_SECTION);
      expect(currentEntry(b2.model)).toEqual({ address: HOST_HOME });
      expect(navReduce(b2.model, BACK, 'app').effect).toEqual({ history: 'exit' });
    });

    test('раздел хоста, чья запись переехала в X, пуст — «назад» с дна X ведёт в другую стопку хоста', () => {
      const r = run(hostWithSections(), [{ type: 'replace', address: rec(900, XR), app: X }], mode);
      expect(r.model.apps[HOST_APP]?.stacks[RECORDS]).toBeUndefined();
      expect(canGoBack(r.model)).toBe(true);
      const b = navReduce(r.model, BACK, 'app');
      expect(b.effect).toEqual({ history: 'none' });
      expect(b.model.activeApp).toBe(HOST_APP);
      // Стопки хоста: домашняя и «Сегодня» — предпочтение домашней.
      expect(b.model.apps[HOST_APP]?.activeSection).toBe(HOME_SECTION);
      expect(currentEntry(b.model)).toEqual({ address: HOST_HOME });
      // Домашней нет — первая имеющаяся стопка хоста.
      const noHome: NavModel = {
        ...r.model,
        apps: {
          ...r.model.apps,
          [HOST_APP]: { activeSection: RECORDS, stacks: { [TODAY]: [{ address: TODAY_ROOT }] } },
        },
      };
      const b3 = navReduce(noHome, BACK, 'app').model;
      expect(b3.activeApp).toBe(HOST_APP);
      expect(b3.apps[HOST_APP]?.activeSection).toBe(TODAY);
      expect(canGoBack(b.model)).toBe(false);
    });
  });

  test('switch-app с toHome (R-23) — домашняя приложения, а не его последнее место', () => {
    const r = run(
      hostWithSections(),
      [open(rec(1)), { type: 'switch-app', app: X, home: X_HOME }, open(rec(2, XR), X)],
      mode,
    );
    const home = navReduce(
      r.model,
      { type: 'switch-app', app: HOST_APP, home: HOST_HOME, toHome: true },
      mode,
    );
    expect(home.model.activeApp).toBe(HOST_APP);
    expect(home.model.apps[HOST_APP]?.activeSection).toBe(HOME_SECTION);
    expect(stackOf(home.model)).toEqual([HOST_HOME]);
    expect(home.effect).toEqual({ history: push });
    // Разделы хоста не тронуты: «Записи» вернутся нажатием на раздел.
    expect(stackOf(home.model, HOST_APP, RECORDS)).toEqual([RECORDS_ROOT, rec(1)]);
    // Без toHome — последнее место хоста.
    const last = navReduce(r.model, { type: 'switch-app', app: HOST_APP, home: HOST_HOME }, mode);
    expect(currentEntry(last.model).address).toEqual(rec(1));
  });

  test('(8а) view пишет состояние в верх стопки, null снимает ключ; эффект replace', () => {
    const r1 = run(
      hostWithSections(),
      [open(rec(1)), { type: 'view', patch: { tab: 'Связи', via: 't1' } }],
      mode,
    );
    expect(currentEntry(r1.model)).toEqual({ address: rec(1), view: { tab: 'Связи', via: 't1' } });
    expect(r1.last).toEqual({ history: 'replace' });
    const r2 = navReduce(r1.model, { type: 'view', patch: { via: null } }, mode);
    expect(currentEntry(r2.model)).toEqual({ address: rec(1), view: { tab: 'Связи' } });
    expect(r2.effect).toEqual({ history: 'replace' });
    const r3 = navReduce(r2.model, { type: 'view', patch: { tab: null } }, mode);
    expect(currentEntry(r3.model)).toEqual({ address: rec(1) });
  });

  test('(8а) состояние экрана не попадает ни в адрес («поделиться» — без состояния), ни в сохранение', () => {
    const r = run(
      hostWithSections(),
      [open(rec(1)), { type: 'view', patch: { tab: 'Связи' } }],
      mode,
    );
    expect(buildAddress(currentEntry(r.model).address)).toBe(`/r/${id(1)}`);
    expect(JSON.stringify(persistOf(r.model))).not.toContain('Связи');
  });

  test('разделы с одинаковым верхом — разные места: переход между ними — честный переход', () => {
    // «Записи» → ссылка на корень «Сегодня» (в стопку «Записей»), затем раздел «Сегодня» с тем же верхом.
    const r = run(
      hostWithSections(),
      [open(TODAY_ROOT), { type: 'section', app: HOST_APP, section: TODAY, root: TODAY_ROOT }],
      mode,
    );
    expect(currentEntry(r.model).address).toEqual(TODAY_ROOT);
    expect(r.model.apps[HOST_APP]?.activeSection).toBe(TODAY);
    expect(r.last).toEqual({ history: push });
  });

  test('(9) переключение раздела показывает его последнее место', () => {
    const r = run(
      hostWithSections(),
      [
        open(rec(1)),
        open(rec(2)),
        { type: 'section', app: HOST_APP, section: TODAY, root: TODAY_ROOT },
        { type: 'section', app: HOST_APP, section: RECORDS, root: RECORDS_ROOT },
      ],
      mode,
    );
    expect(currentEntry(r.model).address).toEqual(rec(2));
    expect(r.effects.slice(2)).toEqual([{ history: push }, { history: push }]);
  });

  test('switch-app на другое приложение показывает его последнее место', () => {
    const r = run(
      hostWithSections(),
      [
        { type: 'switch-app', app: X, home: X_HOME },
        open(rec(1, XR), X),
        { type: 'switch-app', app: HOST_APP, home: HOST_HOME },
        { type: 'switch-app', app: X, home: X_HOME },
      ],
      mode,
    );
    expect(r.model.activeApp).toBe(X);
    expect(currentEntry(r.model).address).toEqual(rec(1, XR));
    expect(r.last).toEqual({ history: push });
  });

  test('раздел другого приложения: приложение становится активным, стопка заводится от root', () => {
    const r = navReduce(
      hostWithSections(),
      { type: 'section', app: Y, section: 's', root: rec(20, YR) },
      mode,
    );
    expect(r.model.activeApp).toBe(Y);
    expect(r.model.apps[Y]).toEqual({
      activeSection: 's',
      stacks: { s: [{ address: rec(20, YR) }] },
    });
  });
});

describe('поведение «как приложение» (app): назад по стопке', () => {
  test('(1) open, open, back → первая запись; эффект none', () => {
    const r = run(hostWithSections(), [open(rec(1)), open(rec(2)), BACK], 'app');
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, rec(1)]);
    expect(r.last).toEqual({ history: 'none' });
  });

  test('(6) из хоста («Записи») в приложение X → back возвращает в «Записи» хоста', () => {
    const r = run(hostWithSections(), [open(rec(1)), open(rec(5, XR), X), BACK], 'app');
    expect(r.model.activeApp).toBe(HOST_APP);
    expect(r.model.apps[HOST_APP]?.activeSection).toBe(RECORDS);
    expect(currentEntry(r.model).address).toEqual(rec(1));
    expect(r.last).toEqual({ history: 'none' });
    // Запись снята; стопка, в которой она была одна, не остаётся пустой.
    expect(r.model.apps[X]?.stacks[HOME_SECTION]).toBeUndefined();
  });

  test('(6) журнал: X → Y → back → X → back → хост; у X своя домашняя остаётся', () => {
    const r = run(
      hostWithSections(),
      [
        { type: 'switch-app', app: X, home: X_HOME },
        { type: 'switch-app', app: HOST_APP, home: HOST_HOME },
        open(rec(5, XR), X),
        open(rec(6, YR), Y),
      ],
      'app',
    );
    expect(r.model.activeApp).toBe(Y);
    const b1 = navReduce(r.model, BACK, 'app').model;
    expect(b1.activeApp).toBe(X);
    expect(stackOf(b1)).toEqual([X_HOME, rec(5, XR)]);
    const b2 = navReduce(b1, BACK, 'app').model;
    expect(b2.activeApp).toBe(HOST_APP);
    expect(stackOf(b2)).toEqual([RECORDS_ROOT]);
    expect(stackOf(b2, X)).toEqual([X_HOME]);
  });

  test('(7) экран хоста → back возвращает в раздел', () => {
    const r = run(
      hostWithSections(),
      [open(rec(1)), { type: 'host-screen', address: CHAT }, BACK],
      'app',
    );
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, rec(1)]);
  });

  test('(7) open из чата в том же приложении → back ведёт в раздел, не в чат', () => {
    const r = run(
      hostWithSections(),
      [{ type: 'host-screen', address: CHAT }, open(rec(1), HOST_APP, 'host-screen'), BACK],
      'app',
    );
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT]);
  });

  test('(8а) back на запись возвращает её view (вкладку)', () => {
    const r = run(
      hostWithSections(),
      [open(rec(1)), { type: 'view', patch: { tab: 'Связи' } }, open(rec(2)), BACK],
      'app',
    );
    expect(currentEntry(r.model)).toEqual({ address: rec(1), view: { tab: 'Связи' } });
  });

  test('(9) переключение раздела восстанавливает стопку целиком', () => {
    const r = run(
      hostWithSections(),
      [
        open(rec(1)),
        open(rec(2)),
        { type: 'section', app: HOST_APP, section: TODAY, root: TODAY_ROOT },
        { type: 'section', app: HOST_APP, section: RECORDS, root: RECORDS_ROOT },
      ],
      'app',
    );
    expect(stackOf(r.model)).toEqual([RECORDS_ROOT, rec(1), rec(2)]);
    expect(r.effects.slice(2)).toEqual([{ history: 'replace' }, { history: 'replace' }]);
    const back = navReduce(r.model, BACK, 'app').model;
    expect(currentEntry(back).address).toEqual(rec(1));
  });

  test('(10) дно стопки хоста → exit, модель не меняется', () => {
    const m = hostWithSections();
    expect(navReduce(m, BACK, 'app')).toEqual({ model: m, effect: { history: 'exit' } });
    const i = initialModel(HOST_HOME);
    expect(navReduce(i, BACK, 'app')).toEqual({ model: i, effect: { history: 'exit' } });
  });

  test('дно стопки не-хоста без источника → в хост (журнал исчерпан)', () => {
    const m = run(hostWithSections(), [{ type: 'switch-app', app: X, home: X_HOME }], 'app').model;
    const r = navReduce(m, BACK, 'app');
    expect(r.model.activeApp).toBe(HOST_APP);
    expect(currentEntry(r.model).address).toEqual(RECORDS_ROOT);
    expect(r.effect).toEqual({ history: 'none' });
    // Стопка X не тронута — переключение на X её восстановит.
    expect(stackOf(r.model, X)).toEqual([X_HOME]);
  });
});

describe('поведение «как сайт» (site): назад — браузер', () => {
  test('(1) back — эффект back, модель не меняется (web восстановит её из history.state)', () => {
    const m = run(hostWithSections(), [open(rec(1)), open(rec(2))], 'site').model;
    expect(navReduce(m, BACK, 'site')).toEqual({ model: m, effect: { history: 'back' } });
  });

  test('(6) после перехода в другое приложение back — эффект back', () => {
    const m = run(hostWithSections(), [open(rec(5, XR), X)], 'site').model;
    expect(navReduce(m, BACK, 'site')).toEqual({ model: m, effect: { history: 'back' } });
  });

  test('(10) на дне стопки хоста — тоже back: браузер сам решает, куда', () => {
    const m = initialModel(HOST_HOME);
    expect(navReduce(m, BACK, 'site')).toEqual({ model: m, effect: { history: 'back' } });
  });
});

describe('(11) сохранение orbis:nav:v2', () => {
  function rich(): NavModel {
    return run(
      hostWithSections(),
      [
        open(rec(1)),
        open(rec(2)),
        { type: 'view', patch: { tab: 'Связи' } },
        { type: 'section', app: HOST_APP, section: TODAY, root: TODAY_ROOT },
        open(rec(3)),
        { type: 'switch-app', app: X, home: X_HOME },
        open(rec(4, XR), X),
        { type: 'switch-app', app: HOST_APP, home: HOST_HOME },
        { type: 'section', app: HOST_APP, section: RECORDS, root: RECORDS_ROOT },
      ],
      'app',
    ).model;
  }

  test('ключ — orbis:nav:v2', () => {
    expect(NAV_STORAGE_KEY).toBe('orbis:nav:v2');
  });

  test('persistOf: активное приложение, активный раздел, последнее место каждого раздела', () => {
    expect(persistOf(rich())).toEqual({
      v: 2,
      activeApp: HOST_APP,
      apps: {
        [HOST_APP]: {
          activeSection: RECORDS,
          last: { [HOME_SECTION]: HOST_HOME, [TODAY]: rec(3), [RECORDS]: rec(2) },
        },
        [X]: { activeSection: HOME_SECTION, last: { [HOME_SECTION]: rec(4, XR) } },
      },
    });
  });

  test('круг через JSON: раздел и последнее место переживают, глубина — нет (стопка [last])', () => {
    const restored = restoreFrom(JSON.parse(JSON.stringify(persistOf(rich()))));
    expect(restored).toEqual({
      activeApp: HOST_APP,
      apps: {
        [HOST_APP]: {
          activeSection: RECORDS,
          stacks: {
            [HOME_SECTION]: [{ address: HOST_HOME }],
            [TODAY]: [{ address: rec(3) }],
            [RECORDS]: [{ address: rec(2) }],
          },
        },
        [X]: { activeSection: HOME_SECTION, stacks: { [HOME_SECTION]: [{ address: rec(4, XR) }] } },
      },
    });
    expect(canGoBack(restored as NavModel)).toBe(false);
  });

  test('экран хоста наверху — не «последнее место» раздела: сохраняется место под ним', () => {
    const m = run(
      hostWithSections(),
      [open(rec(1)), { type: 'host-screen', address: SEARCH }],
      'app',
    ).model;
    expect(persistOf(m).apps[HOST_APP]?.last[RECORDS]).toEqual(rec(1));
  });

  test('источник межприложенческого перехода не сохраняется (глубина журнала — тоже глубина)', () => {
    const m = run(hostWithSections(), [open(rec(5, XR), X)], 'app').model;
    const restored = restoreFrom(persistOf(m)) as NavModel;
    expect(currentEntry(restored)).toEqual({ address: rec(5, XR) });
  });

  test('restoreFrom: v1, null, мусор, чужая форма → null', () => {
    const v1 = {
      state: {
        activeTab: 'browser',
        stacks: { chat: [], browser: [{ kind: 'entity', id: id(1) }] },
      },
      version: 0,
    };
    const good = persistOf(rich());
    const bad: unknown[] = [
      v1,
      null,
      undefined,
      'мусор',
      42,
      [],
      {},
      { ...good, v: 1 },
      { ...good, v: 3 },
      { ...good, activeApp: 7 },
      { ...good, apps: null },
      // Активное приложение не сохранено.
      { ...good, activeApp: Y },
      // Нет последнего места активного раздела.
      {
        ...good,
        apps: {
          ...good.apps,
          [HOST_APP]: { activeSection: 'нет', last: good.apps[HOST_APP]?.last },
        },
      },
      // Битые адреса.
      {
        v: 2,
        activeApp: HOST_APP,
        apps: {
          [HOST_APP]: { activeSection: 'home', last: { home: { kind: 'entity', id: id(1) } } },
        },
      },
      {
        v: 2,
        activeApp: HOST_APP,
        apps: {
          [HOST_APP]: {
            activeSection: 'home',
            last: { home: { kind: 'record', app: HOST, id: 'не-uuid' } },
          },
        },
      },
      {
        v: 2,
        activeApp: HOST_APP,
        apps: {
          [HOST_APP]: {
            activeSection: 'home',
            last: { home: { kind: 'home', app: { kind: 'app', ref: 'budget' } } },
          },
        },
      },
      {
        v: 2,
        activeApp: HOST_APP,
        apps: {
          [HOST_APP]: {
            activeSection: 'home',
            last: { home: { kind: 'home', app: { kind: 'app', ref: `x/r/${id(1)}` } } },
          },
        },
      },
      {
        v: 2,
        activeApp: HOST_APP,
        apps: {
          [HOST_APP]: {
            activeSection: 'home',
            last: { home: { kind: 'home', app: { kind: 'app', ref: X.toUpperCase() } } },
          },
        },
      },
      {
        v: 2,
        activeApp: HOST_APP,
        apps: {
          [HOST_APP]: {
            activeSection: 'home',
            last: { home: { kind: 'host-screen', screen: 'nope' } },
          },
        },
      },
      {
        v: 2,
        activeApp: HOST_APP,
        apps: {
          [HOST_APP]: {
            activeSection: 'home',
            last: { home: { kind: 'host-screen', screen: 'search', q: 5 } },
          },
        },
      },
      { v: 2, activeApp: HOST_APP, apps: { [HOST_APP]: { activeSection: 'home', last: 'x' } } },
      {
        v: 2,
        activeApp: HOST_APP,
        apps: { [HOST_APP]: { activeSection: 5, last: { home: HOST_HOME } } },
      },
    ];
    for (const raw of bad) expect(restoreFrom(raw)).toBeNull();
  });

  test('restoreFrom: без стопки хоста (вход по ссылке сразу в приложение) — модель; назад с дна — домашняя хоста', () => {
    const m = restoreFrom({
      v: 2,
      activeApp: X,
      apps: {
        [X]: { activeSection: HOME_SECTION, last: { [HOME_SECTION]: rec(1, XR) } },
        [HOST_APP]: { activeSection: HOME_SECTION, last: {} },
      },
    }) as NavModel;
    expect(currentEntry(m)).toEqual({ address: rec(1, XR) });
    expect(canGoBack(m)).toBe(true);
    const b = navReduce(m, BACK, 'app');
    expect(b.effect).toEqual({ history: 'none' });
    expect(b.model.activeApp).toBe(HOST_APP);
    expect(currentEntry(b.model)).toEqual({ address: HOST_HOME });
    expect(navReduce(m, BACK, 'site').effect).toEqual({ history: 'back' });
  });

  test('restoreFrom: ключи-имена свойств Object.prototype — обычные ключи, не прототип', () => {
    const raw = JSON.parse(
      `{"v":2,"activeApp":"host","apps":{"host":{"activeSection":"__proto__","last":{"__proto__":${JSON.stringify(HOST_HOME)},"constructor":${JSON.stringify(rec(1))}}}}}`,
    );
    const m = restoreFrom(raw) as NavModel;
    expect(currentEntry(m)).toEqual({ address: HOST_HOME });
    expect(stackOf(m, HOST_APP, 'constructor')).toEqual([rec(1)]);
    // Раздела `hasOwnProperty` нет, хоть у прототипа есть функция с `length` 1 — чтение без проверки
    // своего ключа приняло бы её за непустую стопку. Переход в него заводит стопку от root.
    const r = navReduce(
      m,
      { type: 'section', app: HOST_APP, section: 'hasOwnProperty', root: TODAY_ROOT },
      'app',
    );
    expect(stackOf(r.model)).toEqual([TODAY_ROOT]);
    // То же с приложением: `isPrototypeOf` — новое приложение, а не функция прототипа.
    const s = navReduce(m, { type: 'switch-app', app: 'isPrototypeOf', home: X_HOME }, 'app');
    expect(s.model.activeApp).toBe('isPrototypeOf');
    expect(stackOf(s.model)).toEqual([X_HOME]);
  });
});

describe('(13) launchModeOf (РП-5)', () => {
  test.each([
    [{ standalone: true, userAgent: 'Mozilla/5.0' }, 'app'],
    [{ standalone: false, userAgent: 'Mozilla/5.0 (Linux; Android 14) OrbisApp/1.0' }, 'app'],
    [{ standalone: true, userAgent: 'OrbisApp/2.3' }, 'app'],
    [{ standalone: false, userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15' }, 'site'],
    [{ standalone: false, userAgent: 'OrbisApp' }, 'site'],
    [{ standalone: false, userAgent: '' }, 'site'],
  ] as const)('%j → %s', (env, expected) => {
    expect(launchModeOf(env)).toBe(expected);
  });
});

describe('тотальность: любое действие над любой моделью даёт модель', () => {
  // Детерминированный генератор: воспроизводимо и без зависимостей.
  function lcg(seed: number) {
    let s = seed >>> 0;
    return (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s % n;
    };
  }
  const APPS = [HOST_APP, X, Y];
  const SECTIONS = [HOME_SECTION, RECORDS, TODAY, 's'];
  const ADDRESSES: Address[] = [
    HOST_HOME,
    X_HOME,
    Y_HOME,
    CHAT,
    SEARCH,
    rec(1),
    rec(2),
    rec(3, XR),
    rec(4, YR),
    RECORDS_ROOT,
  ];
  const HOMES: Record<string, Address> = { [HOST_APP]: HOST_HOME, [X]: X_HOME, [Y]: Y_HOME };

  function randomAction(pick: (n: number) => number): NavAction {
    const app = APPS[pick(APPS.length)] as string;
    const address = ADDRESSES[pick(ADDRESSES.length)] as Address;
    switch (pick(7)) {
      case 0:
        return { type: 'open', address, app, from: pick(2) ? 'content' : 'host-screen' };
      case 1:
        return {
          type: 'section',
          app,
          section: SECTIONS[pick(SECTIONS.length)] as string,
          root: address,
        };
      case 2:
        return pick(3)
          ? { type: 'switch-app', app, home: HOMES[app] as Address }
          : { type: 'switch-app', app, home: HOMES[app] as Address, toHome: true };
      case 3:
        return { type: 'host-screen', address: pick(2) ? CHAT : SEARCH };
      case 4:
        return pick(2) ? { type: 'replace', address } : { type: 'replace', address, app };
      case 5:
        return { type: 'view', patch: pick(2) ? { tab: `t${pick(3)}` } : { tab: null } };
      default:
        return BACK;
    }
  }

  function assertValid(m: NavModel) {
    const nav = m.apps[m.activeApp] as AppNav;
    expect(Object.hasOwn(m.apps, m.activeApp)).toBe(true);
    expect(nav.stacks[nav.activeSection]?.length ?? 0).toBeGreaterThan(0);
    for (const a of Object.values(m.apps))
      for (const s of Object.values(a.stacks) as StackEntry[][])
        expect(s.length).toBeGreaterThan(0);
  }

  test.each(
    MODES,
  )('%s: 3000 случайных шагов — модель цела, эффекты своего режима, круг сохранения', (mode) => {
    const pick = lcg(mode === 'app' ? 7 : 11);
    let m = initialModel(HOST_HOME);
    const allowed = mode === 'app' ? ['replace', 'none', 'exit'] : ['push', 'replace', 'back'];
    for (let i = 0; i < 3000; i++) {
      const r = navReduce(m, randomAction(pick), mode);
      expect(allowed).toContain(r.effect.history);
      m = r.model;
      assertValid(m);
      // canGoBack согласован с тем, что сделал бы «назад» приложения.
      expect(canGoBack(m)).toBe(navReduce(m, BACK, 'app').effect.history === 'none');
      const restored = restoreFrom(JSON.parse(JSON.stringify(persistOf(m))));
      expect(restored).not.toBeNull();
      assertValid(restored as NavModel);
    }
  });

  test('модель без активного приложения: действия с адресом её чинят, прочие не бросают', () => {
    const broken: NavModel = { activeApp: X, apps: {} };
    for (const mode of MODES) {
      expect(() => navReduce(broken, BACK, mode)).not.toThrow();
      expect(() => navReduce(broken, { type: 'view', patch: { tab: 'a' } }, mode)).not.toThrow();
      expect(() => navReduce(broken, { type: 'replace', address: rec(1) }, mode)).not.toThrow();
      const opened = navReduce(broken, open(rec(1, XR), X), mode).model;
      expect(currentEntry(opened)).toEqual({ address: rec(1, XR) });
      const hs = navReduce(broken, { type: 'host-screen', address: CHAT }, mode).model;
      expect(currentEntry(hs)).toEqual({ address: CHAT });
    }
  });
});
