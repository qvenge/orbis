/**
 * Эталоны поставки хоста (срез 1б §9.1, §9.2, §6.5, §3.5, §9.4; РП-6).
 *
 * Всё, что приносит поставка хоста, — записи владельца с эталоном: шаблон хоста, оболочка хоста,
 * «Домой», «Записи», шесть списков. Здесь — ЭТАЛОНЫ КОДА (что приносит этот релиз); их печати и статус
 * записи «как в поставке» / «изменено вами» — в `./print`. Отпечаток эталона (`sha256` кодовой формы)
 * считает только сервер (`apps/server/src/supply/hash.ts`): `node:crypto` в листовой модуль web не везут.
 *
 * Две формы эталона и почему (РП-6, Э-2):
 *  - КОДОВАЯ — по ключам, одинакова в любом графе: вход отпечатка. Новый релиз с правкой эталона меняет
 *    отпечаток — и только это делает запись «с обновлением»;
 *  - ПЕЧАТЬ В ГРАФЕ (`orbis/supply_text`) — с каноническим телом этого графа и id записей вместо ключей:
 *    с ней сравнивается запись («изменено вами») и к ней возвращает «Вернуть как было».
 *
 * Модуль листовой: импортирует только `../constants` (без импортов) и тела списков `./lists` (без
 * импортов). Его берёт web через сабпат `@orbis/shared/supply` из экрана записи — баррель
 * `@orbis/shared/doc` (tiptap, marked) отсюда недостижим (сторож — `etalons.test.ts`).
 *
 * Шаблон хоста — строками по строке на маркер: это ДАННЫЕ, а не разбор; сторож одной копии правил
 * (`scripts/grammar-copies.test.ts`) держит их счёт в своём списке законных мест.
 */
import { type NavForm, SUPPLY_KEY } from '../constants';
import { SEED_SMART_LISTS } from './lists';

/** Десять ключей эталонов (РП-6) — ровно варианты `orbis/supply_key` реестра (сверка — тестом). */
export const SUPPLY_KEYS = [
  'host-template',
  'host-shell',
  'home',
  'records',
  'daily-planning',
  'upcoming',
  'all-tasks',
  'horizon-year',
  'horizon-life',
  'routines',
] as const;
export type SupplyKey = (typeof SUPPLY_KEYS)[number];

/** Ключ эталона записи «Шаблон хоста» (§9.2). */
export const HOST_TEMPLATE_KEY: SupplyKey = 'host-template';

/**
 * Ключ эталона оболочки хоста (срез 1б §6.5, §9.1): её запись — сам хост, а не «своё приложение».
 * Одна константа на всех читателей — правило открытия (`/a/host-shell` = хост), список приложений и
 * рамку web: переименование ключа в эталоне иначе молча разорвало бы копии литерала (гейт 20, m-4).
 */
export const HOST_SHELL_KEY: SupplyKey = 'host-shell';

/**
 * Запись — поставочный «Шаблон хоста» (§9.2): по ключу эталона, а не по аспекту или «Шаблону для» — у
 * неё их нет, она запасной шаблон, а не кандидат. Один признак на весь web (род тела, баннер
 * настройки, пункты меню): копии разошлись бы на первом переименовании ключа.
 */
export function isHostTemplateRecord(r: { props: Readonly<Record<string, unknown>> }): boolean {
  return r.props[SUPPLY_KEY] === HOST_TEMPLATE_KEY;
}

/**
 * Зарезервированные ключи приложений (спека §3.4): `/a/budget…` до 1в — хост и плашка «Бюджет придёт
 * со следующим срезом». В варианты `orbis/supply_key` не входят — эталона у них пока нет.
 */
export const RESERVED_APP_KEYS = ['budget'] as const;

export type SupplyEtalon =
  | { key: SupplyKey; kind: 'page' | 'template'; title: string; emoji: string; text: string }
  | {
      key: 'host-shell';
      kind: 'app';
      title: string;
      emoji: string;
      home: SupplyKey;
      nav: readonly SupplyKey[];
      navForm: NavForm;
    };

/**
 * Шаблон хоста (спека 1а §8.1) в форме 1б: пять строк `{{card: …}}` вкладки «Запись» заменены одной
 * `{{cards: own}}` (спека 1б §8.5, Р-23) — шаблон хоста не называет расширений. Сверку с текстом спеки
 * 1а (с этой заменой) держит web-тест задачи 17 — одно место.
 */
export const HOST_TEMPLATE_ETALON_TEXT: string = [
  '{{title}}',
  '{{tags}}',
  '{{tabs}}',
  '{{tab: Запись}}',
  '{{cards: own}}',
  '{{body}}',
  '{{/tab}}',
  '{{tab: Детали}}',
  '{{cards}}',
  '{{versions}}',
  '{{subtasks}}',
  '{{blockers}}',
  '{{backlinks}}',
  '{{/tab}}',
  '{{tab: Тред}}',
  '{{thread}}',
  '{{/tab}}',
  '{{/tabs}}',
].join('\n');

/**
 * Эталоны в порядке ключей. «Домой» — блок «Приложения» (§6.5), «Записи» — блок-экран `{{records}}`
 * (§3.5); списки — заголовки, эмодзи и тела `SEED_SMART_LISTS` (§9.4). Оболочка хоста (§6.5): домашняя —
 * «Домой», навигация — «Записи» и пять списков из прежних закреплённых («Жизни» нет — её открывают раз в
 * год), форма — «список из заголовка».
 */
export const SUPPLY_ETALONS: readonly SupplyEtalon[] = [
  {
    key: 'host-template',
    kind: 'template',
    title: 'Шаблон хоста',
    emoji: '📄',
    text: HOST_TEMPLATE_ETALON_TEXT,
  },
  {
    key: 'host-shell',
    kind: 'app',
    title: 'Orbis',
    emoji: '🪐',
    home: 'home',
    nav: ['records', 'daily-planning', 'upcoming', 'all-tasks', 'horizon-year', 'routines'],
    navForm: 'header-list',
  },
  { key: 'home', kind: 'page', title: 'Домой', emoji: '🏠', text: '{{apps}}' },
  { key: 'records', kind: 'page', title: 'Записи', emoji: '🗂️', text: '{{records}}' },
  ...SEED_SMART_LISTS.map(
    (l): SupplyEtalon => ({
      key: l.slug,
      kind: 'page',
      title: l.title,
      emoji: l.emoji,
      text: l.body,
    }),
  ),
];

export function etalonOf(key: SupplyKey): SupplyEtalon {
  const found = SUPPLY_ETALONS.find((e) => e.key === key);
  // Недостижимо: у каждого ключа эталон есть (тест). Молча отдать `undefined` значило бы уронить
  // вызывающего дальше по стеку с непонятным сообщением.
  if (found === undefined) throw new Error(`эталона поставки с ключом «${key}» нет`);
  return found;
}

/**
 * Прежние эталоны (до 1б) — ТОЛЬКО для перевода данных задачи 13 (РП-35, В-9): тело прод-списка,
 * совпавшее с прежним эталоном, — «как в поставке» старой версии, и новый эталон приходит ему
 * предложением. Литералы — дословный перенос тел «Года» и «Жизни» до правки словарём 1б.
 */
export const LEGACY_ETALON_TEXTS: Readonly<Partial<Record<SupplyKey, string>>> = {
  'horizon-year': `Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — сущностями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.

Лестница горизонтов целиком: день — список «Daily Planning», неделя и месяц — список «Upcoming», год — этот список, жизнь — список «Жизнь». «Жизнь» не закреплена в сайдбаре: её находит Browser по тегу smart-list.

{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}`,
  'horizon-life': `Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.

- **Ценности** — что должно остаться правдой про меня через десять лет?
- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?
- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?

Ответы держите отдельными сущностями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной сущности, блок честно покажет «ничего не найдено».

{{query:tags=life, sortBy=orbis/updated_at:desc, display=list, title="Ценности и зоны ответственности"}}`,
};
