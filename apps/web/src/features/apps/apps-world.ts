/**
 * Мир тестов приложений в web (задача 20 среза 1б): свои приложения владельца поверх мира рамки
 * (`frame-fixtures.ts`), их шаблоны, записи для правила открытия и сеть, которая помнит запись
 * «Открывать вместо» (повторное открытие после «запомнить» идёт уже по новому значению).
 *
 * Не тест и не продукт: модуль обвязки двух файлов `features/apps/*.test.tsx`; продуктовых импортёров
 * у него нет, в сборку он не попадает. Маркеров тела здесь нет литералами (сторож
 * `scripts/grammar-copies.test.ts`): тела с блоками собирают сами тесты.
 */
import {
  APP_ASPECT,
  APP_DISABLED,
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  APP_OPENS_OVER,
  HOME_PROPERTY,
  PAGE_ASPECT,
  TEMPLATE_FOR_PROPERTY,
} from '@orbis/shared';
import { frameHandler, frameWorld, PAGES, SHELL_ROW } from '../../app/frame/frame-fixtures';
import { type MockHandler, type WireEntityFixture, wireEntity } from '../../test/harness';
import { PAGE_TEMPLATES_QUERY } from '../page/usePageTemplates';
import { APPS_QUERY, HOMED_PAGES_QUERY } from './useApps';

const id = (n: number) => `00000000-0000-4000-8000-0000000020${String(n).padStart(2, '0')}`;

/** «Мой дом» 🏡 и его домашняя. */
export const MY = id(1);
export const MY_HOME = id(2);
/** «Проекты» 📁 — второе место для задач. */
export const PROJ = id(3);
export const PROJ_HOME = id(4);
/** «Заметки» 📝 — место для заметок. */
export const NOTES = id(5);
export const NOTES_HOME = id(6);
/** «Дача» 🌲 — выключенное приложение. */
export const DACHA = id(7);
/** Раздел «Мой дом» — страница с «Домом» = «Мой дом». */
export const MY_SECTION = id(8);
/** Страница хоста (пустой «Дом»), поставленная разделом в «Мой дом», — ярлык «↗». */
export const HOST_PAGE = id(9);

/** Задача, заметка, обычная запись без аспектов. */
export const TASK = id(10);
export const IDEA = id(11);
export const PLAIN = id(12);
/** Страница «Утро» с «Домом» = «Мой дом» (тело задаёт тест). */
export const UTRO = id(13);
/** Заметка с чипом (тело задаёт тест). */
export const CHIPS = id(14);

/** Шаблоны задач «Мой дом» и «Проекты», шаблон заметок «Заметки». */
export const T_MY = id(20);
export const T_PROJ = id(21);
export const T_NOTES = id(22);

export const TASK_ASPECT = 'orbis/task';
export const NOTE_ASPECT = 'orbis/note';

export function appRow(
  rid: string,
  title: string,
  emoji: string,
  props: Record<string, unknown> = {},
  over: Partial<WireEntityFixture> = {},
): WireEntityFixture {
  return wireEntity({
    id: rid,
    title,
    emoji,
    aspects: [APP_ASPECT],
    props: { [APP_NAV]: [], ...props },
    ...over,
  });
}

export const page = (
  rid: string,
  title: string,
  home: string | null,
  body = `${title}.`,
  props: Record<string, unknown> = {},
): WireEntityFixture =>
  wireEntity({
    id: rid,
    title,
    aspects: [PAGE_ASPECT],
    body,
    props: { ...(home !== null && { [HOME_PROPERTY]: home }), ...props },
  });

const template = (rid: string, title: string, aspect: string, home: string) =>
  page(rid, title, home, `Вид «${title}».`, { [TEMPLATE_FOR_PROPERTY]: [aspect] });

export const MY_ROW = appRow(MY, 'Мой дом', '🏡', { [APP_HOME]: MY_HOME });
export const PROJ_ROW = appRow(PROJ, 'Проекты', '📁', { [APP_HOME]: PROJ_HOME });
export const NOTES_ROW = appRow(NOTES, 'Заметки', '📝', { [APP_HOME]: NOTES_HOME });
export const DACHA_ROW = appRow(DACHA, 'Дача', '🌲', { [APP_DISABLED]: true });

export const TPL_MY = template(T_MY, 'Задачи дома', TASK_ASPECT, MY);
export const TPL_PROJ = template(T_PROJ, 'Задачи проектов', TASK_ASPECT, PROJ);
export const TPL_NOTES = template(T_NOTES, 'Заметки вид', NOTE_ASPECT, NOTES);

export const TASK_ROW = wireEntity({ id: TASK, title: 'Починить кран', aspects: [TASK_ASPECT] });
export const IDEA_ROW = wireEntity({ id: IDEA, title: 'Идея', aspects: [NOTE_ASPECT] });
export const PLAIN_ROW = wireEntity({ id: PLAIN, title: 'Купить хлеб' });

const PAGES_OF_APPS = [
  page(MY_HOME, 'Дом приложения', MY),
  page(PROJ_HOME, 'Проекты: домашняя', PROJ),
  page(NOTES_HOME, 'Заметки: домашняя', NOTES),
  page(MY_SECTION, 'Ремонт', MY),
  page(HOST_PAGE, 'Общая страница', null),
];

export interface AppsWorld {
  /** Записи-приложения (без оболочки хоста — её мир добавляет сам). */
  apps: WireEntityFixture[];
  /** Шаблоны владельца и приложений (`PAGE_TEMPLATES_QUERY`). */
  templates: readonly WireEntityFixture[];
  /** Прочие записи графа. */
  records: readonly WireEntityFixture[];
  /** Строки блока данных по тексту блока (ключ — текст без краёв). */
  blockRows?: Readonly<Record<string, readonly WireEntityFixture[]>>;
}

export function appsWorld(over: Partial<AppsWorld> = {}): AppsWorld {
  return {
    apps: over.apps ?? [MY_ROW, PROJ_ROW],
    templates: over.templates ?? [TPL_MY],
    records: over.records ?? [TASK_ROW, IDEA_ROW, PLAIN_ROW],
    ...(over.blockRows !== undefined && { blockRows: over.blockRows }),
  };
}

/**
 * Сеть: мир рамки + приложения. `entity.updateBatch` правит «Открывать вместо» и «в архиве» в самом
 * мире — перечитывание после пачки видит записанное, как на сервере; `app.setDisabled` — «Выключено».
 */
export function appsHandler(w: AppsWorld): MockHandler {
  const all = (): WireEntityFixture[] => [
    SHELL_ROW,
    ...PAGES,
    ...PAGES_OF_APPS,
    ...w.apps,
    ...w.templates,
    ...w.records,
  ];
  return (path, input, type) => {
    if (path === 'entity.query') {
      const q = (input as { query?: string }).query ?? '';
      if (q === APPS_QUERY) return [SHELL_ROW, ...w.apps];
      if (q === PAGE_TEMPLATES_QUERY) return w.templates;
      if (q === HOMED_PAGES_QUERY) {
        return all().filter((e) => e.aspects.includes(PAGE_ASPECT) && HOME_PROPERTY in e.props);
      }
    }
    if (path === 'entity.blocks' && w.blockRows !== undefined) {
      const { blocks } = input as { blocks: { key: string; text?: string }[] };
      return {
        results: Object.fromEntries(
          blocks.map((b) => [
            b.key,
            {
              ok: true,
              kind: 'rows',
              rows: (b.text !== undefined && w.blockRows?.[b.text.trim()]) || [],
              more: 0,
            },
          ]),
        ),
      };
    }
    if (path === 'entity.updateBatch') {
      const { operations } = input as {
        operations: {
          input: {
            id: string;
            props?: Record<string, unknown>;
            unset?: string[];
            archived?: boolean;
          };
        }[];
      };
      for (const { input: op } of operations) {
        const i = w.apps.findIndex((a) => a.id === op.id);
        const cur = w.apps[i];
        if (cur === undefined) continue;
        const props = { ...cur.props, ...op.props };
        for (const k of op.unset ?? []) delete props[k];
        w.apps[i] = { ...cur, props, ...(op.archived !== undefined && { archived: op.archived }) };
      }
      return { actionId: 'act-1' };
    }
    if (path === 'app.setDisabled') {
      const { appId, disabled } = input as { appId: string; disabled: boolean };
      const i = w.apps.findIndex((a) => a.id === appId);
      const cur = w.apps[i];
      if (cur !== undefined) {
        const props = { ...cur.props };
        if (disabled) props[APP_DISABLED] = true;
        else delete props[APP_DISABLED];
        w.apps[i] = { ...cur, props };
      }
      return { actionId: 'act-2' };
    }
    return frameHandler(frameWorld({ all: all() }))(path, input, type);
  };
}

export { APP_DISABLED, APP_NAV, APP_NAV_FORM, APP_OPENS_OVER };
