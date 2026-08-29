// apps/web/src/lib/registry/labels.ts
//
// Подписи полей и аспектов — ИЗ РЕЕСТРА (§А9-2), а не из рукописного словаря в коде.
//
// Что здесь заменено. До этой задачи подписи жили в `lib/field-labels.ts` тремя картами
// `Record<string, string>`: имя поля старой схемы → русское слово. Карта не знала ни
// пользовательских свойств (у них id — uuid, и в словаре их быть не может по построению),
// ни второй локали, ни переименования — а переименовать label владелец вправе бесплатно
// (§А10-2). Хуже того, ключи в ней были ИМЕНАМИ ПОЛЕЙ СТАРОЙ ФОРМЫ, и после Задачи 12,
// сменившей адрес значения на id свойства, половина её ключей перестала совпадать с тем,
// что приходит с сервера, — молча, потому что промах словаря печатает ключ как есть.
//
// Здесь подписей нет вовсе: есть ПРАВИЛА, по которым подпись берётся из реестра, и один
// fallback — показать сырой адрес, когда записи реестра нет (свойство снято, реестр ещё
// едет). Слов в этом файле нет ни одного, и это его главное свойство.
//
// Локаль читателя и правило fallback внутри `LocalizedText` — общие с сервером
// (`OWNER_LOCALE`/`effectiveLabel` в `@orbis/shared`, §А2-1). Своей копии правила здесь нет
// НАМЕРЕННО: вторая копия дала бы одну подпись печати запроса и другую — карточке, то есть
// имя, которое владелец прочитал в одном месте и не узнал в другом.
//
// Импорт идёт из корневого (эагерного) барреля `@orbis/shared`, а НЕ из `@orbis/shared/query`,
// где обе эти вещи жили раньше: этот файл читают карточки чата, то есть первый кадр, и
// импорт из `query/parse-ast` затащил бы туда весь разбор запросов.
import {
  type AspectDefinition,
  CORE_PROPERTY_IDS,
  effectiveLabel,
  legacyFieldToProperty,
  OWNER_LOCALE,
  type PropertyDefinition,
  type RelationRoleDefinition,
} from '@orbis/shared';
import type { RouterOutputs } from '../../trpc';

/**
 * Ответ `registry.effective` (§А9-2): три словаря и версия снимка, ослабленные до `readonly`.
 *
 * Ослабление, а не сам вывод tRPC, ровно по одной причине: этой же формой пользуется тестовая
 * обвязка, подставляя встроенные словари `@orbis/shared` (они `readonly` по построению), и
 * своя копия формы ради одного модификатора была бы вторым источником правды об ответе.
 * Элементы массивов взяты из вывода роутера — разъехаться с ним они не могут.
 */
type WireRegistry = RouterOutputs['registry']['effective'];
export interface EffectiveRegistry {
  version: string;
  properties: readonly WireRegistry['properties'][number][];
  aspects: readonly WireRegistry['aspects'][number][];
  roles: readonly WireRegistry['roles'][number][];
}

/**
 * Читатель реестра: поиск записи по адресу и её подпись в локали владельца.
 *
 * Интерфейс, а не конкретный объект хука, потому что читателей ДВА рода: компоненты берут
 * его из `useRegistry()`, а чистые текстовые модули (`cards/proposal-text.ts`,
 * `cards/unit-text.ts`) получают первым аргументом — им React недоступен, а подпись нужна
 * ровно та же. Тесты собирают его из встроенных словарей одной строкой (`lookupOf`).
 */
export interface RegistryLookup {
  /** Свойство по id ИЛИ по key: web адресует значения id, модель и тулы — key (§А9-2). */
  property(idOrKey: string): PropertyDefinition | undefined;
  aspect(idOrKey: string): AspectDefinition | undefined;
  role(idOrKey: string): RelationRoleDefinition | undefined;
  /**
   * Подпись записи реестра — свойства, аспекта или роли — в локали читателя.
   * Промах даёт САМ адрес: значение существует, и показать его машинным именем честнее,
   * чем пустым местом (то же правило, что у `toLlmEntity` на сервере).
   */
  label(idOrKey: string, locale?: string): string;
  /**
   * Аспект-НОСИТЕЛЬ свойства — первый по порядку реестра, у которого свойство в
   * `properties[]`. `undefined` — носителя нет вовсе: так живут core-проекции (§А1-3,
   * `orbis/archived`) и свободные свойства владельца.
   *
   * Носитель берётся из реестра, а не из переходной карты старой формы: карта знает только
   * встроенные пары и умирает Задачей 23, а вопрос «в каком аспекте это поле» остаётся.
   * Слитое свойство (В1) имеет двух носителей; берётся первый — от выбора зависит только
   * слово слева от точки, а не смысл строки.
   */
  carrierOf(propertyId: string): AspectDefinition | undefined;
}

/** Индекс по id и по key; id сильнее — по нему адресуют значения (`props`, Q-AST). */
function indexOf<T extends { id: string; key: string }>(rows: readonly T[]): Map<string, T> {
  const byAddress = new Map<string, T>();
  for (const row of rows) if (!byAddress.has(row.key)) byAddress.set(row.key, row);
  for (const row of rows) byAddress.set(row.id, row);
  return byAddress;
}

/**
 * Читатель поверх ответа `registry.effective`; `undefined` — реестр ещё едет либо запрос
 * отказал, и тогда КАЖДЫЙ адрес показывается сырым.
 *
 * Пустой читатель — не «нет подписей», а «подписи ещё не приехали», и разница наблюдаема:
 * владелец видит `orbis/task_status` ровно до первого ответа сервера, а не вместо него.
 * Прятать строку до готовности реестра нельзя — тогда карточка исчезала бы целиком.
 */
export function lookupOf(
  data: EffectiveRegistry | undefined,
  locale: string = OWNER_LOCALE,
): RegistryLookup {
  const properties = indexOf(data?.properties ?? []);
  const aspects = indexOf(data?.aspects ?? []);
  const roles = indexOf(data?.roles ?? []);
  // Носитель считается ОДИН раз на снимок: у 77 свойств и 13 аспектов обход дешёв, но он
  // ушёл бы в каждую строку каждой карточки, а строк на экране прогона сотни.
  const carriers = new Map<string, AspectDefinition>();
  for (const aspect of data?.aspects ?? []) {
    for (const ref of aspect.properties) {
      if (!carriers.has(ref.propertyId)) carriers.set(ref.propertyId, aspect);
    }
  }
  return {
    property: (idOrKey) => properties.get(idOrKey),
    aspect: (idOrKey) => aspects.get(idOrKey),
    role: (idOrKey) => roles.get(idOrKey),
    label: (idOrKey, loc = locale) => {
      const def = properties.get(idOrKey) ?? aspects.get(idOrKey) ?? roles.get(idOrKey);
      return def === undefined ? idOrKey : effectiveLabel(def.label, loc);
    },
    carrierOf: (propertyId) => carriers.get(propertyId),
  };
}

/**
 * Имя поля САМОЙ ЗАПИСИ → id core-свойства (§А1-3), если оно у поля есть.
 *
 * Это ПРАВИЛО по закрытому списку, а не таблица и не догадка: у всех четырёх core-проекций
 * id — это `orbis/` плюс имя колонки, и проверка идёт по самому списку `CORE_PROPERTY_IDS`.
 * Поэтому `archived` и `title` находят своё свойство, а `body`, `tags` и `emoji`, у которых
 * свойства в срезе А нет вовсе, честно не находят ничего — и подпись им ставит тот, кто
 * знает больше (запасной текст сервера), а не выдуманное здесь слово.
 *
 * Нужно это потому, что строки отложенного действия и предложения адресуют поля записи
 * СТАРЫМ именем колонки (`snapshotDeferredUnit`, `CORE_FIELD_LABELS`), а реестр — новым id.
 */
function corePropertyOf(field: string): string | undefined {
  const id = `orbis/${field}`;
  return (CORE_PROPERTY_IDS as readonly string[]).includes(id) ? id : undefined;
}

/**
 * Адрес поля на экране → id свойства реестра; `undefined` — реестр такого свойства не знает.
 *
 * Адрес приходит в трёх формах, и все три законны прямо сейчас:
 *  - id/key свойства (`orbis/task_status`) — новая правда (§А1-1): так адресуют значения
 *    `props`, так их называют карточки чата, строки предложения и отложенного действия;
 *  - имя поля старой схемы (`status`) ВМЕСТЕ с аспектом-носителем — так лежит карта
 *    `aspects_legacy`, которую до миграции 0017 читают карточки аспектов и шапка записи.
 *    Перевод идёт по ТОЙ ЖЕ таблице `@orbis/shared`, которой его делает сервер
 *    (`legacyAspectsToProps`): второй таблицы здесь нет и не заводится;
 *  - имя колонки записи (`archived`) — core-проекция §А1-3 (см. `corePropertyOf`).
 *
 * ПОРЯДОК форм — не вкус, а закрытие дыры (Important-1 гейт-ревью 13a). Аспект-подсказка
 * ПРОБУЕТСЯ, но не обрывает резолв: у поля записи носителя нет вовсе, и вызывающий, который
 * подставил вместо «аспекта нет» пустую строку или чужой аспект, до этой правки уводил
 * `archived` в сырой ключ — притом что прежний словарь показывал ему «архив». Промах по
 * аспекту означает ровно «носителя не нашли», а не «искать больше негде».
 *
 * Единственная цена — свойство КАСТОМНОГО аспекта, названное ровно как колонка записи
 * (`title`): оно получит подпись core-проекции «Заголовок». Плата принята сознательно:
 * список core закрыт четырьмя именами, три из которых (`archived`, `created_at`,
 * `updated_at`) полем аспекта не бывают, а альтернатива — машинный ключ на живом экране.
 *
 * Отдельная функция от `fieldLabel` нужна ровно одному читателю — строке предложения: у неё
 * есть ЗАПАСНОЙ текст сервера (`summary`), и «реестр не знает» для неё не то же самое, что
 * «покажи сырой адрес».
 */
export function propertyIdOf(
  reg: RegistryLookup,
  field: string,
  aspectId?: string,
): string | undefined {
  const direct = reg.property(field);
  if (direct !== undefined) return direct.id;
  const carried = aspectId === undefined ? undefined : legacyFieldToProperty(aspectId, field);
  return carried ?? corePropertyOf(field);
}

/**
 * Подпись ПОЛЯ на экране. Промах всех трёх форм адреса — сырое имя поля: честная деградация
 * для свойства, которого в снимке нет (снято, ещё не приехало, кастомный аспект чужого
 * модуля), и ровно то, что показывал прежний словарь на неизвестном ключе.
 */
export function fieldLabel(reg: RegistryLookup, field: string, aspectId?: string): string {
  const id = propertyIdOf(reg, field, aspectId);
  return id === undefined ? field : reg.label(id);
}

/** Подпись АСПЕКТА; промах — сам id (кастомный аспект, снятая строка реестра). */
export function aspectLabel(reg: RegistryLookup, aspectId: string): string {
  return reg.label(aspectId);
}
