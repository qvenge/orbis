// packages/shared/src/nav/links.ts
// Контракт маршрутов приложения (02-core-os §1.3): экран ⇄ путь, в обе стороны и в одном
// месте. Deep link — единственное, что переживает перезагрузку страницы и переезд ссылки
// в другой браузер, поэтому форма пути тут не деталь реализации роутера, а контракт:
// таблица маршрутов живёт здесь, а не размазана по web-экранам.
//
// Модуль чистый TS: ни React/роутера, ни `window`/`location`/`URL`. На вход приходит уже
// готовая строка пути — сервер тоже может строить такие ссылки, если понадобится.

/**
 * UUID любой версии, регистронезависимо. Константа СКОПИРОВАНА из парсера запросов
 * осознанно (источник — снятый Задачей 21b `query/parse.ts`, читается по git-истории):
 * тянуть зависимость от парсера запросов ради одного регэкспа — связать навигацию с query-движком,
 * а версию/регистр здесь проверяем ровно так же, как везде (id приходят из БД, они v7 lowercase,
 * но ссылка может прийти из письма с заглавными буквами).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Корни вкладок — единственные односегментные пути приложения (§1.3). */
const TABS = ['chat', 'browser', 'agenda', 'budget'] as const;
type AppTab = (typeof TABS)[number];

/** Экран, на который можно сослаться ссылкой (§1.3). Всё остальное — состояние внутри экрана. */
export type AppScreen =
  | { kind: 'tab-root'; tab: 'chat' | 'browser' | 'agenda' | 'budget' }
  | { kind: 'entity'; id: string }
  | { kind: 'thread'; threadId: string }
  | { kind: 'budget-category'; id: string };

function isTab(segment: string | undefined): segment is AppTab {
  return TABS.includes(segment as AppTab);
}

function isUuid(segment: string | undefined): segment is string {
  return segment !== undefined && UUID_RE.test(segment);
}

/** Путь экрана: всегда с ведущим слэшем, без query-строки и без хеша. */
export function buildAppPath(screen: AppScreen): string {
  switch (screen.kind) {
    case 'tab-root':
      return `/${screen.tab}`;
    case 'entity':
      return `/entity/${screen.id}`;
    case 'thread':
      return `/thread/${screen.threadId}`;
    case 'budget-category':
      return `/budget/category/${screen.id}`;
  }
}

/**
 * Путь → экран. Неизвестный или битый путь — `null`: догадка тут хуже отказа, вызывающий
 * сам решает, что показывать (обычно — корень текущей вкладки).
 *
 * На вход подаётся ТОЛЬКО pathname. Query-строка и хеш путём не считаются и дают `null`
 * (`/budget?tab=1` — не `/budget`): состояние экрана в ссылке — отдельный разговор, а молча
 * отбрасывать хвост значило бы делать вид, что мы его поняли.
 *
 * Две поблажки к форме, обе покрыты тестом:
 * — ровно один завершающий слэш прощаем (`/budget/` = `/budget`) — его дописывают браузеры
 *   и почтовые клиенты, и мёртвая от этого ссылка была бы чистой обидой;
 * — UUID принимаем в любом регистре, но нормализуем в нижний, чтобы id из ссылки годился
 *   как ключ кеша наравне с id из БД. Литеральные сегменты (`entity`, `category`, имена
 *   вкладок) регистрозависимы: `/Budget` — чужой путь, а не «почти наш».
 */
export function parseAppPath(path: string): AppScreen | null {
  if (!path.startsWith('/')) return null;
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = trimmed.slice(1).split('/');
  const [first, second, third] = segments;

  if (segments.length === 1 && isTab(first)) return { kind: 'tab-root', tab: first };

  if (segments.length === 2 && isUuid(second)) {
    if (first === 'entity') return { kind: 'entity', id: second.toLowerCase() };
    if (first === 'thread') return { kind: 'thread', threadId: second.toLowerCase() };
    return null;
  }

  if (segments.length === 3 && first === 'budget' && second === 'category' && isUuid(third)) {
    return { kind: 'budget-category', id: third.toLowerCase() };
  }

  return null;
}

/**
 * Вкладка, которой принадлежит экран, — по ней системный «назад» и переключатель вкладок
 * понимают, куда падать после закрытия экрана.
 *
 * ВНИМАНИЕ, это не баг: `thread` всегда даёт `'browser'`. По §1.3 тред сущности живёт
 * в Browser, а глобальный тред — в Chat, но различить их можно только по данным треда,
 * которых у чистой функции нет. Функция обязана быть детерминированной, поэтому она
 * возвращает вкладку по умолчанию (тред сущности), а особый случай глобального треда
 * разрешает вызывающий, у которого данные есть.
 */
export function tabOfScreen(screen: AppScreen): 'chat' | 'browser' | 'agenda' | 'budget' {
  switch (screen.kind) {
    case 'tab-root':
      return screen.tab;
    case 'entity':
      return 'browser';
    case 'thread':
      return 'browser';
    case 'budget-category':
      return 'budget';
  }
}

/**
 * Путь экрана согласия OAuth (§9.3, слайс 4b) — единственная правда о нём на весь монорепо.
 *
 * Экраном приложения (`AppScreen`) он НЕ является и в `parseAppPath` не попадает намеренно:
 * согласие живёт вне вкладок и вне OnboardingGate (apps/web/src/main.tsx решает ветку по
 * pathname ДО роутера), выдача доступа агенту не требует пройденного онбординга, а системный
 * «назад» не должен считать его частью приложения. Поэтому — отдельная константа рядом с
 * таблицей маршрутов, а не новый вариант союза.
 *
 * Живёт в shared, потому что путь читают ОБА пакета и по разным поводам: сервер клеит из него
 * `authorization_endpoint` в метаданных authorization server (apps/server/src/oauth/metadata.ts),
 * SPA по нему выбирает экран. Раньше это были две независимые копии строки, и согласованное
 * переименование на сервере (вместе с его тестом) молча увело бы владельца на страницу с
 * обычным приложением вместо согласия — main.tsx не импортирует ни один тест проекта, и
 * покраснеть было нечему. Одна правда снимает вопрос, а не откладывает его до следующего пина.
 *
 * Форма: с ведущим слэшем, без хвостового — сервер строит адрес склейкой `${origin}${PATH}`.
 */
export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';

/**
 * Наш ли это путь экрана согласия. Терпимость к хвостовым слэшам — ЗДЕСЬ, а не у
 * вызывающего: канонический адрес мы публикуем без слэша, но ссылка приходит к владельцу
 * через руки и копипасту, а цена терпимости — одна замена против экрана чата вместо
 * согласия. Разъедься правило с самой строкой — и терпимость снова стала бы копией.
 *
 * Прощаются ЛЮБЫЕ хвостовые слэши (`/oauth/authorize///`), а не ровно один, как в
 * `parseAppPath`: правило перенесено из main.tsx дословно, вместе с его регэкспом, и
 * сужать его заодно с переездом — менять поведение под видом рефакторинга. Разница
 * безобидна: путей, отличающихся только числом хвостовых слэшей, у нас не бывает.
 *
 * На вход — ТОЛЬКО pathname, как и у `parseAppPath`: с query или хешем строка путём не
 * считается и даёт false.
 */
export function isOAuthAuthorizePath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === OAUTH_AUTHORIZE_PATH;
}
