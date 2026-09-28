/**
 * Мир тестов рамки и навигации (задача 19 среза 1б): записи поставки хоста (оболочка, «Домой»,
 * «Записи», пять списков), пара обычных записей и сеть, которая отвечает за них так, как ответил бы
 * сервер. Один мир на `app/nav.test.tsx` и `app/frame/*.test.tsx` — у рамки один набор данных.
 *
 * Не тест и не продукт: модуль обвязки, его берут только тесты (в сборку он не попадает — у него нет
 * продуктовых импортёров).
 */
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  type BlockResult,
  entityBlocksInput,
  HOME_PROPERTY,
  PAGE_ASPECT,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
} from '@orbis/shared';
import { HOME_SECTION, HOST_APP, initialModel, type NavModel } from '@orbis/shared/nav';
import { etalonOf, type SupplyKey } from '@orbis/shared/supply';
import { act } from '@testing-library/react';
import { APPS_QUERY } from '../../features/apps/useApps';
import { SUPPLY_RECORDS_QUERY } from '../../features/page/useSupplyRecords';
import { resetNavForTests, useNav } from '../../state/navigation';
import {
  type MockHandler,
  trpcError,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY, registryReply } from '../../test/registry';

const id = (n: number) => `00000000-0000-4000-8000-0000000019${String(n).padStart(2, '0')}`;

export const SHELL = id(1);
export const HOME = id(2);
export const RECORDS = id(3);
export const DAILY = id(4);
export const UPCOMING = id(5);
export const ALL_TASKS = id(6);
export const YEAR = id(7);
export const ROUTINES = id(8);
/** Обычные записи графа. */
export const BREAD = id(20);
export const NOTE = id(21);
/** Своё приложение владельца «Мой дом» и его единственный раздел. */
export const MY_APP = id(30);
export const MY_HOME = id(31);
export const MY_SECTION = id(32);
/** Тред записи `NOTE` и глобальный тред. */
export const NOTE_THREAD = id(40);
export const GLOBAL_THREAD = id(41);

const supplyPage = (rid: string, key: string, title: string, emoji: string, body: string) =>
  wireEntity({
    id: rid,
    title,
    emoji,
    body,
    aspects: [PAGE_ASPECT, SUPPLY_ASPECT],
    props: { [SUPPLY_KEY]: key },
  });

export const NAV_IDS = [RECORDS, DAILY, UPCOMING, ALL_TASKS, YEAR, ROUTINES] as const;

export const SHELL_ROW = wireEntity({
  id: SHELL,
  title: 'Orbis',
  emoji: '🪐',
  aspects: [APP_ASPECT, SUPPLY_ASPECT],
  props: {
    [SUPPLY_KEY]: 'host-shell',
    [APP_HOME]: HOME,
    [APP_NAV]: [...NAV_IDS],
    [APP_NAV_FORM]: 'header-list',
  },
});

/** Тело страницы поставки по ключу эталона. */
function bodyOf(key: SupplyKey): string {
  const e = etalonOf(key);
  return e.kind === 'app' ? '' : e.text;
}

/**
 * Записи поставки хоста. Тела списков — простой текст: бейдж раздела мир отдаёт картой `badges`
 * (сервер посчитал бы его по первому блоку данных тела, РП-8).
 */
export const PAGES: readonly WireEntityFixture[] = [
  // Тела «Домой» и «Записи» — эталоны поставки (блоки «Приложения» и «Записи»), а не литералы:
  // маркеры тела пишет одна копия правил (сторож `scripts/grammar-copies.test.ts`).
  supplyPage(HOME, 'home', 'Домой', '🏠', bodyOf('home')),
  supplyPage(RECORDS, 'records', 'Записи', '🗂️', bodyOf('records')),
  supplyPage(DAILY, 'daily-planning', 'Daily Planning', '☀️', 'Утро.'),
  supplyPage(UPCOMING, 'upcoming', 'Upcoming', '📅', 'Неделя.'),
  supplyPage(ALL_TASKS, 'all-tasks', 'All Tasks', '✅', 'Все задачи.'),
  supplyPage(YEAR, 'horizon-year', 'Год', '🗓️', 'Год.'),
  supplyPage(ROUTINES, 'routines', 'Рутины', '🔁', 'Рутины.'),
];

export const RECORDS_WORLD: readonly WireEntityFixture[] = [
  wireEntity({ id: BREAD, title: 'Купить хлеб' }),
  wireEntity({ id: NOTE, title: 'Заметка' }),
  wireEntity({
    id: MY_APP,
    title: 'Мой дом',
    emoji: '🏡',
    aspects: [APP_ASPECT],
    props: { [APP_HOME]: MY_HOME, [APP_NAV]: [MY_SECTION] },
  }),
  // «Дом» = «Мой дом»: первое место задаёт дом (спека 1б §4.3), и правило открытия показывает эти
  // страницы в его рамке (§7.2). Без «Дома» раздел был бы ярлыком хоста, и страница ушла бы в хост.
  wireEntity({
    id: MY_HOME,
    title: 'Дом приложения',
    aspects: [PAGE_ASPECT],
    body: 'Дом.',
    props: { [HOME_PROPERTY]: MY_APP },
  }),
  wireEntity({
    id: MY_SECTION,
    title: 'Ремонт',
    aspects: [PAGE_ASPECT],
    body: 'Ремонт.',
    props: { [HOME_PROPERTY]: MY_APP },
  }),
];

export interface FrameWorld {
  /** Записи поставки, которые отдаёт `aspect=orbis/supply` (архивные сервер не отдаёт). */
  supply: readonly WireEntityFixture[];
  /** Все записи, которые видит `entity.get`/`entity.resolveRefs` (включая архивные). */
  all: readonly WireEntityFixture[];
  /** Бейдж раздела: id страницы → число первого блока. Нет ключа — `kind:'none'`. */
  badges: Readonly<Record<string, number>>;
  /** Запись треда (`chat.threadEntity`). */
  threads: Readonly<Record<string, string | null>>;
  /** Строки списка «Записей» (`{{records}}`). */
  recordsList: readonly WireEntityFixture[];
  /** Сообщения глобального треда (`chat.listMessages`). */
  chat: readonly unknown[];
}

export function frameWorld(over: Partial<FrameWorld> = {}): FrameWorld {
  const supply = over.supply ?? [SHELL_ROW, ...PAGES];
  return {
    supply,
    all: over.all ?? [...supply, ...RECORDS_WORLD],
    badges: over.badges ?? { [UPCOMING]: 3, [ALL_TASKS]: 120 },
    threads: over.threads ?? { [NOTE_THREAD]: NOTE, [GLOBAL_THREAD]: null },
    recordsList: over.recordsList ?? [RECORDS_WORLD[0] as WireEntityFixture],
    chat: over.chat ?? [],
  };
}

const suggestion = (e: WireEntityFixture) => ({
  id: e.id,
  title: e.title,
  emoji: e.emoji,
  completable: null,
  archived: e.archived,
});

/** Сеть мира рамки: ответы, которые дерево приложения спрашивает на любом экране. */
export function frameHandler(world: FrameWorld = frameWorld()): MockHandler {
  const byId = new Map(world.all.map((e) => [e.id, e]));
  return (path, input) => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    switch (path) {
      case 'entity.get': {
        const wanted = (input as { id: string }).id;
        const e = byId.get(wanted);
        if (e === undefined) throw trpcError('NOT_FOUND');
        return {
          entity: e,
          relations: [],
          backlinks: [],
          thread: { threadId: `thread-${wanted}`, messages: [] },
          registryVersion: BUILTIN_REGISTRY.version,
        };
      }
      case 'entity.query': {
        const q = (input as { query?: string }).query ?? '';
        if (q === SUPPLY_RECORDS_QUERY) return world.supply;
        // Записи-приложения (`useApps`): оболочка хоста и «Мой дом» — как их отдал бы сервер.
        if (q === APPS_QUERY) return world.all.filter((e) => e.aspects.includes(APP_ASPECT));
        if (q.includes('sortBy=orbis/updated_at:desc')) return world.recordsList;
        return [];
      }
      case 'entity.resolveRefs':
        return (input as { ids: string[] }).ids.flatMap((rid) => {
          const e = byId.get(rid);
          return e === undefined ? [] : [suggestion(e)];
        });
      case 'entity.blocks': {
        const { blocks } = entityBlocksInput.parse(input);
        return {
          results: Object.fromEntries(
            blocks.map((b): [string, BlockResult] => {
              if ('text' in b) return [b.key, { ok: true, kind: 'rows', rows: [], more: 0 }];
              const n = world.badges[b.badgeOf];
              return [
                b.key,
                n === undefined
                  ? { ok: true, kind: 'none' }
                  : { ok: true, kind: 'count', count: n },
              ];
            }),
          ),
        };
      }
      case 'chat.threadEntity':
        return { entityId: world.threads[(input as { threadId: string }).threadId] ?? null };
      case 'chat.ensureThread':
        return { threadId: GLOBAL_THREAD };
      case 'chat.listMessages':
        return world.chat;
      case 'user.getSettings':
        return {
          timezone: 'Europe/Moscow',
          defaultCurrency: 'RUB',
          weekStartDay: 1,
          installedViews: [],
          pinnedEntities: [],
          disabledModules: [],
        };
      case 'agentRun.sweep':
        return { swept: 0 };
      case 'version.list':
        return [];
      default:
        return {};
    }
  };
}

/**
 * Режим запуска для теста: `matchMedia` в jsdom нет — заглушка в самом тесте (как `lib/theme.test.ts`).
 * `app` — установленное приложение (`display-mode: standalone`), `site` — вкладка браузера.
 */
export function stubLaunchMode(mode: 'app' | 'site'): void {
  window.matchMedia = ((query: string) => ({
    matches: mode === 'app' && query.includes('standalone'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/**
 * Ширина и режим запуска для теста двух рамок (задача 25): `desktop` — `DESKTOP_QUERY` сбывается,
 * прочие запросы — только `standalone` режима приложения. Литерал брейкпоинта свой, а не импорт
 * `DESKTOP_QUERY`: съедь обе стороны вместе — и тест не заметил бы подмены порога.
 */
export function stubViewport(desktop: boolean, mode: 'app' | 'site' = 'site'): void {
  window.matchMedia = ((query: string) => ({
    matches:
      (desktop && query === '(min-width: 768px)') ||
      (mode === 'app' && query.includes('standalone')),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Снять заглушку режима: вкладка браузера без `matchMedia`, как jsdom по умолчанию. */
export function unstubLaunchMode(): void {
  delete (window as { matchMedia?: unknown }).matchMedia;
}

/** Сообщение ассистента глобального треда. */
export const chatMessage = (mid: string, content: string) => ({
  id: mid,
  threadId: GLOBAL_THREAD,
  role: 'assistant',
  content,
  metadata: {},
  createdAt: '2026-07-05T12:00:00.000Z',
});

/** Адрес в строке, как его видит человек. */
export const shownPath = (): string => window.location.pathname + window.location.search;

/** Модель навигации сейчас. */
export const navModel = (): NavModel => useNav.getState().model;

/** Модель «хост на домашней» с вглубь открытой записью в разделе `section` хоста. */
export function modelWithSection(section: string, stack: readonly string[]): NavModel {
  const base = initialModel({ kind: 'home', app: { kind: 'host' } });
  return {
    activeApp: HOST_APP,
    apps: {
      [HOST_APP]: {
        activeSection: section,
        stacks: {
          ...(base.apps[HOST_APP]?.stacks ?? {}),
          [section]: stack.map((rid) => ({
            address: { kind: 'record' as const, app: { kind: 'host' as const }, id: rid },
          })),
        },
      },
    },
  };
}

/** Чистый старт навигации: модель, режим и адресная строка — как у только что открытой вкладки. */
export function resetFrame(path = '/'): void {
  localStorage.clear();
  act(() => resetNavForTests());
  window.history.replaceState(null, '', path);
}

export { HOME_SECTION };
