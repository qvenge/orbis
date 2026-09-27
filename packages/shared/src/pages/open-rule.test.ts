import { describe, expect, test } from 'bun:test';
import { PAGE_ASPECT } from '../constants';
import type { AppRef } from '../nav/address';
import type { TemplateCandidate, TemplateChoice } from './choose-template';
import {
  type AppInfo,
  chooseOpening,
  type OpenDecision,
  type OpenInput,
  placeContendersOf,
  recordPlaceChoice,
} from './open-rule';

// Таблица случаев С1б-1: правило открытия записи с приложением в адресе (спека 1б §5.1–§5.3, §4.3,
// §7.4, §9.2; Фокус ревью п. 3). У каждого случая — вход и полный ожидаемый ответ: рамка, вид,
// плашки, `redirect`, `openApp`.

const T = 'orbis/task';
const N = 'orbis/note';

const SHELL = 'id-host-shell';
const HOME = 'id-my-home'; // «Мой дом»
const PROJ = 'id-projects'; // «Проекты»
const THIRD = 'id-third';
const OFF = 'id-off'; // выключенное
const ARCH = 'id-arch'; // в архиве

const app = (id: string, over: Partial<AppInfo> = {}): AppInfo => ({
  id,
  supplyKey: null,
  title: id,
  disabled: false,
  archived: false,
  opensOver: [],
  createdAt: '2026-09-01T00:00:00Z',
  ...over,
});
const tpl = (
  id: string,
  forAspects: readonly string[],
  home: string | null,
  createdAt = '2026-09-01T00:00:00Z',
): TemplateCandidate => ({ id, forAspects, winsOver: [], createdAt, home });

const HOST: AppRef = { kind: 'host' };
const at = (ref: string): AppRef => ({ kind: 'app', ref });

const TASK = { id: 'r-task', aspects: [T], home: null };
const page = (home: string | null) => ({ id: 'r-page', aspects: [PAGE_ASPECT, T], home });

const ok = () => null;
const brokenIds =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id) ? 'сломан' : null;

const APPS = [app(HOME), app(PROJ), app(OFF, { disabled: true }), app(ARCH, { archived: true })];

function input(over: Partial<OpenInput>): OpenInput {
  return {
    app: HOST,
    record: TASK,
    apps: APPS,
    hostShellId: SHELL,
    templates: [],
    isBroken: ok,
    ...over,
  };
}

const HOST_VIEW: TemplateChoice = { kind: 'host', broken: [] };
const OWN: TemplateChoice = { kind: 'own-body' };
const view = (id: string): TemplateChoice => ({ kind: 'template', id, dispute: null, broken: [] });
const inHost = (
  v: TemplateChoice,
  plaques: OpenDecision['plaques'] = [],
  redirect = false,
): OpenDecision => ({
  frame: { kind: 'host' },
  view: v,
  plaques,
  redirect,
});
const inApp = (
  id: string,
  v: TemplateChoice,
  plaques: OpenDecision['plaques'] = [],
  redirect = false,
): OpenDecision => ({ frame: { kind: 'app', id }, view: v, plaques, redirect });

describe('Р-20: запись-приложение открывает своё приложение (§7.4)', () => {
  test('включённое неархивное приложение по ссылке откуда угодно → его домашняя', () => {
    const want: OpenDecision = {
      frame: { kind: 'app', id: HOME },
      view: HOST_VIEW,
      plaques: [],
      redirect: false,
      openApp: { kind: 'home', app: { kind: 'app', ref: HOME } },
    };
    const record = { id: HOME, aspects: ['orbis/app'], home: null };
    expect(chooseOpening(input({ record }))).toEqual(want);
    expect(chooseOpening(input({ record, app: at(PROJ) }))).toEqual(want);
    // Раньше шага 0: выключенное приложение в адресе ссылку на включённое не портит.
    expect(chooseOpening(input({ record, app: at(OFF) }))).toEqual(want);
  });

  test('запись-оболочка хоста → домашняя хоста', () => {
    const record = { id: SHELL, aspects: ['orbis/app'], home: null };
    const want: OpenDecision = {
      frame: { kind: 'host' },
      view: HOST_VIEW,
      plaques: [],
      redirect: false,
      openApp: { kind: 'home', app: { kind: 'host' } },
    };
    expect(chooseOpening(input({ record }))).toEqual(want);
    expect(chooseOpening(input({ record, app: at(HOME) }))).toEqual(want);
  });

  test('выключенное или архивное приложение → запись в хосте + app-off (владелец видит и правит её)', () => {
    const off = { id: OFF, aspects: ['orbis/app'], home: null };
    expect(chooseOpening(input({ record: off }))).toEqual(
      inHost(HOST_VIEW, [{ kind: 'app-off', appId: OFF, archived: false }]),
    );
    const arch = { id: ARCH, aspects: ['orbis/app'], home: null };
    // Из другого приложения — место уточнено: адрес заменяется адресом хоста.
    expect(chooseOpening(input({ record: arch, app: at(HOME) }))).toEqual(
      inHost(HOST_VIEW, [{ kind: 'app-off', appId: ARCH, archived: true }], true),
    );
    // Шаблон владельца для приложений в хосте работает как для любой записи.
    const templates = [tpl('t-app', ['orbis/app'], null)];
    expect(chooseOpening(input({ record: off, templates })).view).toEqual(view('t-app'));
  });
});

describe('Р-20 и шаг 0 вместе', () => {
  test('R — выключенное приложение, A — другое выключенное: две app-off, сначала A, потом R', () => {
    const record = { id: ARCH, aspects: ['orbis/app'], home: null };
    expect(chooseOpening(input({ record, app: at(OFF) }))).toEqual(
      inHost(HOST_VIEW, [
        { kind: 'app-off', appId: OFF, archived: false },
        { kind: 'app-off', appId: ARCH, archived: true },
      ]),
    );
  });
});

describe('Приложение в адресе: оболочка хоста, резерв, неизвестное (Фокус ревью п. 3)', () => {
  test('/a/<hostShellId> и /a/host-shell → хост без плашки, адрес нормализуется', () => {
    for (const ref of [SHELL, 'host-shell']) {
      expect(chooseOpening(input({ app: at(ref) }))).toEqual(inHost(HOST_VIEW, [], true));
    }
    // Нормализация не мешает шагу 4: одно приложение с шаблоном — сразу туда.
    const templates = [tpl('t-home', [T], HOME)];
    expect(chooseOpening(input({ app: at('host-shell'), templates }))).toEqual(
      inApp(HOME, view('t-home'), [], true),
    );
  });

  test('/a/budget → хост + reserved (без «включить»), адрес не заменяется', () => {
    expect(chooseOpening(input({ app: at('budget') }))).toEqual(
      inHost(HOST_VIEW, [{ kind: 'reserved', key: 'budget' }]),
    );
  });

  test('id записи, не являющейся приложением, неизвестный id и неизвестный ключ → хост + app-unknown', () => {
    for (const ref of ['r-some-note', '00000000-0000-4000-8000-000000000000', 'nope']) {
      expect(chooseOpening(input({ app: at(ref) }))).toEqual(
        inHost(HOST_VIEW, [{ kind: 'app-unknown', ref }]),
      );
    }
    // Дальше — как хост: шаблон владельца работает.
    const templates = [tpl('t-own', [T], null)];
    expect(chooseOpening(input({ app: at('nope'), templates }))).toEqual(
      inHost(view('t-own'), [{ kind: 'app-unknown', ref: 'nope' }]),
    );
  });

  test('приложение находится и по ключу поставки, и по id', () => {
    const apps = [app(HOME, { supplyKey: 'my-home' }), app(PROJ)];
    const templates = [tpl('t-home', [T], HOME)];
    expect(chooseOpening(input({ app: at('my-home'), apps, templates }))).toEqual(
      inApp(HOME, view('t-home')),
    );
    expect(chooseOpening(input({ app: at(HOME), apps, templates }))).toEqual(
      inApp(HOME, view('t-home')),
    );
  });

  test('среди записей с одним ключом поставки берётся живая, а не первая по списку', () => {
    const apps = [
      app('id-old', { supplyKey: 'my-home', archived: true }),
      app(HOME, { supplyKey: 'my-home' }),
    ];
    const templates = [tpl('t-home', [T], HOME)];
    expect(chooseOpening(input({ app: at('my-home'), apps, templates }))).toEqual(
      inApp(HOME, view('t-home')),
    );
  });

  test('alias оболочки + страница с домом → рамка дома, адрес заменён', () => {
    expect(chooseOpening(input({ app: at(SHELL), record: page(HOME) }))).toEqual(
      inApp(HOME, OWN, [], true),
    );
  });

  test('пустой вход тотален: ни приложений, ни шаблонов, ни оболочки — хост', () => {
    expect(
      chooseOpening({
        app: at('x'),
        record: { id: 'r', aspects: [], home: null },
        apps: [],
        hostShellId: null,
        templates: [],
        isBroken: ok,
      }),
    ).toEqual(inHost(HOST_VIEW, [{ kind: 'app-unknown', ref: 'x' }]));
  });
});

describe('Шаг 0: A выключено или в архиве — хост + плашка, дальше как хост', () => {
  test('выключено → app-off «включить»; в архиве → app-off «восстановить»; адрес остаётся', () => {
    expect(chooseOpening(input({ app: at(OFF) }))).toEqual(
      inHost(HOST_VIEW, [{ kind: 'app-off', appId: OFF, archived: false }]),
    );
    expect(chooseOpening(input({ app: at(ARCH) }))).toEqual(
      inHost(HOST_VIEW, [{ kind: 'app-off', appId: ARCH, archived: true }]),
    );
    // И выключено, и в архиве — сперва восстановить: включение архивного ничего бы не открыло.
    const both = [app(OFF, { disabled: true, archived: true })];
    expect(chooseOpening(input({ app: at(OFF), apps: both })).plaques).toEqual([
      { kind: 'app-off', appId: OFF, archived: true },
    ]);
  });

  test('шаблоны выключенного A не показываются; работает шаблон владельца', () => {
    const templates = [tpl('t-off', [T], OFF), tpl('t-own', [T], null)];
    expect(chooseOpening(input({ app: at(OFF), templates }))).toEqual(
      inHost(view('t-own'), [{ kind: 'app-off', appId: OFF, archived: false }]),
    );
  });

  // Пинит РЕШЕНИЕ, а не экран (R-25): плашка A есть в решении, вызвавшем замену адреса; после замены
  // пересчёт для `/a/HOME/…` её уже не даёт — показать её до следующего перехода обязан web (задача 20).
  test('дальше как хост: одно приложение с шаблоном — туда (redirect), плашка A — в этом решении', () => {
    const templates = [tpl('t-home', [T], HOME)];
    expect(chooseOpening(input({ app: at(OFF), templates }))).toEqual(
      inApp(HOME, view('t-home'), [{ kind: 'app-off', appId: OFF, archived: false }], true),
    );
  });
});

describe('Шаг 1: страница — своим телом в рамке своего дома', () => {
  test('из хоста в дом → рамка дома, адрес заменён', () => {
    expect(chooseOpening(input({ record: page(HOME) }))).toEqual(inApp(HOME, OWN, [], true));
  });

  test('из другого приложения → рамка дома, адрес заменён; из самого дома — без замены', () => {
    expect(chooseOpening(input({ record: page(HOME), app: at(PROJ) }))).toEqual(
      inApp(HOME, OWN, [], true),
    );
    expect(chooseOpening(input({ record: page(HOME), app: at(HOME) }))).toEqual(inApp(HOME, OWN));
  });

  test('шаблоны на страницу не смотрятся', () => {
    const templates = [tpl('t-home', [T], HOME), tpl('t-own', [T, PAGE_ASPECT], null)];
    expect(chooseOpening(input({ record: page(null), templates }))).toEqual(inHost(OWN));
  });

  test('дом пуст → хост; из приложения — адрес заменяется адресом хоста', () => {
    expect(chooseOpening(input({ record: page(null) }))).toEqual(inHost(OWN));
    expect(chooseOpening(input({ record: page(null), app: at(PROJ) }))).toEqual(
      inHost(OWN, [], true),
    );
  });

  test('дом выключен или в архиве → хост + app-off дома', () => {
    expect(chooseOpening(input({ record: page(OFF) }))).toEqual(
      inHost(OWN, [{ kind: 'app-off', appId: OFF, archived: false }]),
    );
    expect(chooseOpening(input({ record: page(ARCH), app: at(HOME) }))).toEqual(
      inHost(OWN, [{ kind: 'app-off', appId: ARCH, archived: true }], true),
    );
  });

  test('дом указывает не на приложение → хост + app-unknown; на оболочку хоста → хост', () => {
    expect(chooseOpening(input({ record: page('r-not-an-app') }))).toEqual(
      inHost(OWN, [{ kind: 'app-unknown', ref: 'r-not-an-app' }]),
    );
    expect(chooseOpening(input({ record: page(SHELL) }))).toEqual(inHost(OWN));
  });

  test('неизвестный id и в адресе, и в «Доме» страницы — одна плашка app-unknown', () => {
    expect(chooseOpening(input({ app: at('id-ghost'), record: page('id-ghost') }))).toEqual(
      inHost(OWN, [{ kind: 'app-unknown', ref: 'id-ghost' }]),
    );
  });

  test('страница при выключенном A: плашка A есть (шаг 0 раньше шага 1)', () => {
    expect(chooseOpening(input({ record: page(null), app: at(OFF) }))).toEqual(
      inHost(OWN, [{ kind: 'app-off', appId: OFF, archived: false }]),
    );
    expect(chooseOpening(input({ record: page(HOME), app: at(OFF) }))).toEqual(
      inApp(HOME, OWN, [{ kind: 'app-off', appId: OFF, archived: false }], true),
    );
    // A и дом — одно выключенное приложение: плашка одна.
    expect(chooseOpening(input({ record: page(OFF), app: at(OFF) }))).toEqual(
      inHost(OWN, [{ kind: 'app-off', appId: OFF, archived: false }]),
    );
  });
});

describe('Шаг 2: шаблоны A по правилу 1а', () => {
  const TN = { id: 'r-tn', aspects: [T, N], home: null };

  test('подходящий шаблон A', () => {
    const templates = [tpl('t-home', [T], HOME)];
    expect(chooseOpening(input({ app: at(HOME), templates }))).toEqual(inApp(HOME, view('t-home')));
  });

  test('больший набор побеждает', () => {
    const templates = [tpl('t-1', [T], HOME), tpl('t-2', [T, N], HOME)];
    expect(chooseOpening(input({ app: at(HOME), record: TN, templates }))).toEqual(
      inApp(HOME, view('t-2')),
    );
  });

  test('спор шаблонов внутри A: раньше созданный + dispute (правило 1а)', () => {
    const templates = [
      tpl('t-b', [N], HOME, '2026-09-02T00:00:00Z'),
      tpl('t-a', [T], HOME, '2026-09-01T00:00:00Z'),
    ];
    expect(chooseOpening(input({ app: at(HOME), record: TN, templates }))).toEqual(
      inApp(HOME, { kind: 'template', id: 't-a', dispute: ['t-a', 't-b'], broken: [] }),
    );
  });

  test('сломанный → следующий, сломанный перечислен', () => {
    const templates = [tpl('t-1', [T], HOME), tpl('t-2', [T, N], HOME)];
    expect(
      chooseOpening(input({ app: at(HOME), record: TN, templates, isBroken: brokenIds('t-2') })),
    ).toEqual(
      inApp(HOME, {
        kind: 'template',
        id: 't-1',
        dispute: null,
        broken: [{ id: 't-2', reason: 'сломан' }],
      }),
    );
  });

  test('шаблоны другого приложения и владельца в A не участвуют', () => {
    const templates = [
      tpl('t-home', [T], HOME),
      tpl('t-proj', [T, N], PROJ),
      tpl('t-own', [T, N], null),
    ];
    expect(chooseOpening(input({ app: at(HOME), record: TN, templates }))).toEqual(
      inApp(HOME, view('t-home')),
    );
  });
});

describe('Шаг 3: в A нет вида — шаблон хоста в рамке A + no-view', () => {
  test('альтернативы — P без A: включённые неархивные приложения с подходящим шаблоном', () => {
    const apps = [...APPS, app(THIRD)];
    const templates = [
      tpl('t-proj', [T], PROJ),
      tpl('t-third', [T], THIRD),
      tpl('t-off', [T], OFF),
      tpl('t-arch', [T], ARCH),
      tpl('t-home-note', [N], HOME),
      tpl('t-own', [T], null),
    ];
    expect(chooseOpening(input({ app: at(HOME), apps, templates }))).toEqual(
      inApp(HOME, HOST_VIEW, [{ kind: 'no-view', appId: HOME, alternatives: [PROJ, THIRD] }]),
    );
  });

  test('альтернатив нет — плашка с пустым списком', () => {
    expect(chooseOpening(input({ app: at(HOME) }))).toEqual(
      inApp(HOME, HOST_VIEW, [{ kind: 'no-view', appId: HOME, alternatives: [] }]),
    );
  });

  test('единственный подходящий шаблон A сломан: шаблон хоста в рамке A, сломанный перечислен, no-view нет', () => {
    // Подходящий в A есть (набор ⊆ аспекты) — это шаг 2 с правилом 1а «сломанный — следующий + плашка»,
    // а не шаг 3 «в A подходящего нет» (R-26): плашку даёт `view.broken`.
    const templates = [tpl('t-home', [T], HOME), tpl('t-proj', [T], PROJ)];
    expect(
      chooseOpening(input({ app: at(HOME), templates, isBroken: brokenIds('t-home') })),
    ).toEqual(inApp(HOME, { kind: 'host', broken: [{ id: 't-home', reason: 'сломан' }] }));
  });

  test('альтернативы шага 3 включают приложение со сломанными подходящими шаблонами (R-26)', () => {
    const templates = [tpl('t-home-note', [N], HOME), tpl('t-proj', [T], PROJ)];
    expect(
      chooseOpening(input({ app: at(HOME), templates, isBroken: brokenIds('t-proj') })),
    ).toEqual(inApp(HOME, HOST_VIEW, [{ kind: 'no-view', appId: HOME, alternatives: [PROJ] }]));
  });
});

describe('Шаг 4: из хоста — спор мест между приложениями P', () => {
  test('P пусто → шаблон владельца с пустым домом, иначе шаблон хоста', () => {
    expect(chooseOpening(input({ templates: [tpl('t-own', [T], null)] }))).toEqual(
      inHost(view('t-own')),
    );
    expect(chooseOpening(input({}))).toEqual(inHost(HOST_VIEW));
  });

  test('P = одно → сразу туда, адрес заменён', () => {
    const templates = [tpl('t-home', [T], HOME)];
    expect(chooseOpening(input({ templates }))).toEqual(inApp(HOME, view('t-home'), [], true));
  });

  test('хост в спор не входит: шаблон владельца при одном приложении P — всё равно туда (Р-28 п. 1)', () => {
    const templates = [tpl('t-own', [T], null), tpl('t-home', [T], HOME)];
    expect(chooseOpening(input({ templates }))).toEqual(inApp(HOME, view('t-home'), [], true));
  });

  test('выключенные и архивные приложения — вне P', () => {
    const templates = [tpl('t-off', [T], OFF), tpl('t-arch', [T], ARCH), tpl('t-home', [T], HOME)];
    expect(chooseOpening(input({ templates }))).toEqual(inApp(HOME, view('t-home'), [], true));
    // Только выключенные и архивные — P пусто.
    expect(chooseOpening(input({ templates: templates.slice(0, 2) }))).toEqual(inHost(HOST_VIEW));
  });

  test('приложение, чьи подходящие шаблоны все сломаны, — в P (R-26): спор мест не молчит о поломке', () => {
    const templates = [tpl('t-home', [T], HOME), tpl('t-proj', [T], PROJ)];
    expect(chooseOpening(input({ templates, isBroken: brokenIds('t-proj') }))).toEqual(
      inHost(HOST_VIEW, [{ kind: 'place-dispute', contenders: [PROJ, HOME].sort() }]),
    );
    // Единственное приложение, и его шаблон сломан: туда — шаблон хоста в его рамке + плашка поломки.
    expect(
      chooseOpening(
        input({ templates: [templates[0] as TemplateCandidate], isBroken: brokenIds('t-home') }),
      ),
    ).toEqual(
      inApp(HOME, { kind: 'host', broken: [{ id: 't-home', reason: 'сломан' }] }, [], true),
    );
  });

  test('запомнено «HOME вместо PROJ», шаблон HOME сломан → HOME с плашкой поломки, не молча в PROJ (R-26)', () => {
    const apps = [app(HOME, { opensOver: [PROJ] }), app(PROJ)];
    const templates = [tpl('t-home', [T], HOME), tpl('t-proj', [T], PROJ)];
    expect(chooseOpening(input({ apps, templates, isBroken: brokenIds('t-home') }))).toEqual(
      inApp(HOME, { kind: 'host', broken: [{ id: 't-home', reason: 'сломан' }] }, [], true),
    );
  });

  test('оболочка хоста, попавшая в apps вопреки контракту, в P не входит (Р-28 п. 1)', () => {
    const apps = [...APPS, app(SHELL, { supplyKey: 'host-shell' })];
    const templates = [tpl('t-shell', [T], SHELL), tpl('t-home', [T], HOME)];
    // Шаблон с «Дом» = оболочка — шаблон хоста; единственное место — HOME.
    expect(chooseOpening(input({ apps, templates }))).toEqual(
      inApp(HOME, view('t-home'), [], true),
    );
    expect(
      placeContendersOf({ record: TASK, apps, hostShellId: SHELL, templates, isBroken: ok }),
    ).toBeNull();
  });

  const TWO = [tpl('t-home', [T], HOME), tpl('t-proj', [T], PROJ)];

  test('P ≥ 2 без выбора → хост + place-dispute (РП-20); показ — шаблон владельца или хоста', () => {
    expect(chooseOpening(input({ templates: TWO }))).toEqual(
      inHost(HOST_VIEW, [{ kind: 'place-dispute', contenders: [PROJ, HOME].sort() }]),
    );
    expect(chooseOpening(input({ templates: [...TWO, tpl('t-own', [T], null)] }))).toEqual(
      inHost(view('t-own'), [{ kind: 'place-dispute', contenders: [PROJ, HOME].sort() }]),
    );
  });

  test('P ≥ 2 с запомненным выбором («Открывать вместо» победителя покрывает остальных) → туда', () => {
    const apps = [app(HOME, { opensOver: [PROJ] }), app(PROJ)];
    expect(chooseOpening(input({ apps, templates: TWO }))).toEqual(
      inApp(HOME, view('t-home'), [], true),
    );
  });

  test('противоречие: A вместо B и B вместо A → place-dispute', () => {
    const apps = [app(HOME, { opensOver: [PROJ] }), app(PROJ, { opensOver: [HOME] })];
    expect(chooseOpening(input({ apps, templates: TWO }))).toEqual(
      inHost(HOST_VIEW, [{ kind: 'place-dispute', contenders: [PROJ, HOME].sort() }]),
    );
  });

  test('новый участник C при выборе «A вместо B» → place-dispute', () => {
    const apps = [app(HOME, { opensOver: [PROJ] }), app(PROJ), app(THIRD)];
    const templates = [...TWO, tpl('t-third', [T], THIRD)];
    expect(chooseOpening(input({ apps, templates }))).toEqual(
      inHost(HOST_VIEW, [{ kind: 'place-dispute', contenders: [HOME, PROJ, THIRD].sort() }]),
    );
  });

  test('победитель с «Открывать вместо» на выключенное: выключенное вне P, выбор держится', () => {
    const apps = [app(HOME, { opensOver: [PROJ] }), app(PROJ), app(OFF, { disabled: true })];
    const templates = [...TWO, tpl('t-off', [T], OFF)];
    expect(chooseOpening(input({ apps, templates }))).toEqual(
      inApp(HOME, view('t-home'), [], true),
    );
  });
});

describe('placeContendersOf — P для «Сменить, где открывать такие записи»', () => {
  const base = { record: TASK, apps: APPS, hostShellId: SHELL, isBroken: ok };
  const T_HOME = tpl('t-home', [T], HOME);
  const TWO = [T_HOME, tpl('t-proj', [T], PROJ)];

  test('P ≥ 2 — отсортированные id, и при запомненном выборе тоже', () => {
    expect(placeContendersOf({ ...base, templates: TWO })).toEqual([PROJ, HOME].sort());
    const apps = [app(HOME, { opensOver: [PROJ] }), app(PROJ)];
    expect(placeContendersOf({ ...base, apps, templates: TWO })).toEqual([PROJ, HOME].sort());
  });

  test('одно или ни одного — null; выключенные не в счёт', () => {
    expect(placeContendersOf({ ...base, templates: [T_HOME] })).toBeNull();
    expect(placeContendersOf({ ...base, templates: [] })).toBeNull();
    expect(placeContendersOf({ ...base, templates: [T_HOME, tpl('t-off', [T], OFF)] })).toBeNull();
  });

  test('сломанные шаблоны спорящих не выводят приложение из P (R-26)', () => {
    const asked: string[] = [];
    const isBroken = (id: string) => {
      asked.push(id);
      return 'сломан';
    };
    expect(placeContendersOf({ ...base, templates: TWO, isBroken })).toEqual([PROJ, HOME].sort());
    // Для P разбор тел не нужен: подходящий — набор ⊆ аспекты.
    expect(asked).toEqual([]);
  });

  test('страница и запись-приложение спора мест не имеют', () => {
    expect(placeContendersOf({ ...base, record: page(null), templates: TWO })).toBeNull();
    const record = { id: HOME, aspects: [T], home: null };
    expect(placeContendersOf({ ...base, record, templates: TWO })).toBeNull();
  });
});

describe('recordPlaceChoice — память выбора места (§5.3, зеркало recordDisputeChoice)', () => {
  const apply = (apps: readonly AppInfo[], changes: ReadonlyMap<string, string[]>) =>
    apps.map((a) => (changes.has(a.id) ? { ...a, opensOver: changes.get(a.id) ?? [] } : a));

  test('победитель получает ∪ спорящих без себя, у проигравших победитель вычищен', () => {
    const apps = [
      app(HOME),
      app(PROJ, { opensOver: [HOME] }),
      app(THIRD, { opensOver: [HOME, PROJ] }),
    ];
    const got = recordPlaceChoice(HOME, [HOME, PROJ, THIRD], apps);
    expect(got.get(HOME)).toEqual([PROJ, THIRD]);
    expect(got.get(PROJ)).toEqual([]);
    expect(got.get(THIRD)).toEqual([PROJ]);
    // После записи правило открытия идёт к победителю без вопроса.
    const templates = [
      tpl('t-home', [T], HOME),
      tpl('t-proj', [T], PROJ),
      tpl('t-third', [T], THIRD),
    ];
    expect(chooseOpening(input({ apps: apply(apps, got), templates }))).toEqual(
      inApp(HOME, view('t-home'), [], true),
    );
  });

  test('архивные и выключенные id вычищаются — и у победителя, и у проигравших', () => {
    const apps = [
      app(HOME, { opensOver: [ARCH, OFF] }),
      app(PROJ, { opensOver: [OFF, HOME] }),
      app(OFF, { disabled: true }),
      app(ARCH, { archived: true }),
    ];
    const got = recordPlaceChoice(HOME, [HOME, PROJ, ARCH], apps);
    expect(got.get(HOME)).toEqual([PROJ]);
    expect(got.get(PROJ)).toEqual([]);
    // Архивное приложение среди спорящих никому не пишется и само не правится.
    expect(got.has(ARCH)).toBe(false);
    // Неизвестный id (снят) вычищается так же.
    const ghost = recordPlaceChoice(
      HOME,
      [HOME, PROJ, 'id-gone'],
      [app(HOME, { opensOver: ['id-gone'] }), app(PROJ)],
    );
    expect(ghost.get(HOME)).toEqual([PROJ]);
  });

  test('в карту попадают только изменившиеся; повтор того же выбора — пустая карта', () => {
    const apps = [app(HOME, { opensOver: [PROJ] }), app(PROJ), app(THIRD)];
    const got = recordPlaceChoice(HOME, [HOME, PROJ, THIRD], apps);
    expect([...got.keys()]).toEqual([HOME]);
    expect(recordPlaceChoice(HOME, [HOME, PROJ, THIRD], apply(apps, got)).size).toBe(0);
  });

  test('смена выбора переворачивает прежний', () => {
    const apps = [app(HOME, { opensOver: [PROJ] }), app(PROJ)];
    const got = recordPlaceChoice(PROJ, [HOME, PROJ], apps);
    expect(got.get(PROJ)).toEqual([HOME]);
    expect(got.get(HOME)).toEqual([]);
  });

  test('победитель не среди живых приложений — записывать нечего (пустая карта, не падение)', () => {
    const apps = [app(HOME), app(ARCH, { archived: true }), app(OFF, { disabled: true })];
    expect(recordPlaceChoice('id-gone', [HOME, 'id-gone'], apps).size).toBe(0);
    expect(recordPlaceChoice(ARCH, [HOME, ARCH], apps).size).toBe(0);
    expect(recordPlaceChoice(OFF, [HOME, OFF], apps).size).toBe(0);
  });
});
