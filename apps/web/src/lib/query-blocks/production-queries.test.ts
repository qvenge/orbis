/**
 * ВСЕ боевые тексты запросов web — каждый разбирается каноном §А5-3.
 *
 * Зачем этот файл существует отдельно от экранных тестов. Заведён он был тогда, когда разбор
 * принимал ОБЕ формы (канон, при отказе — старую грамматику через `legacy-bridge`):
 * непереведённый текст не падал, а тихо уходил в старую ветку, и «страница открылась»,
 * «список не пуст», «entity.query получил строку» доказывали ровно ничего — они одинаково
 * зелены и до перевода, и после. Мост удалён Задачей 21b, и теперь непереведённый текст
 * упал бы громко; файл при этом остаётся живым и нужным по второй причине — он проверяет
 * КАЖДЫЙ адрес поимённо, тогда как экранный тест видит только те, что попали в его сценарий.
 *
 * Тексты берутся ИЗ САМИХ МОДУЛЕЙ, а не переписаны сюда литералами: копия разъехалась бы с
 * кодом при первой же правке, и тест продолжал бы зеленеть на собственной копии. Адрес рядом
 * с каждым — та же опись, что в `PRODUCTION_QUERY_TEXTS` (`@orbis/shared/query/fixtures`),
 * поле `where`; там она снята НА МОМЕНТ ЗАДАЧИ 8 и остаётся снимком, здесь — живой код.
 *
 * Чего здесь НЕТ и почему: тексты, которые web не сочиняет, — тела сидированных смарт-листов
 * и заготовка проекта (переведены Задачей 21b, их сторож — `seed/seed-canon.test.ts`),
 * примеры в промптах и в описании тула (Задача 19).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQueryAst } from '@orbis/shared/query';
import { expect, test } from 'vitest';
import {
  AGENDA_DAYS_QUERY,
  AGENDA_OVERDUE_DUE_QUERY,
  AGENDA_OVERDUE_START_QUERY,
} from '../../features/agenda/useAgenda';
import { browserQuery, buildFilterQuery } from '../../features/browser/query';
import { envelopeTransactionsQuery } from '../../features/budget/CategoryScreen';
import { CATEGORIES_QUERY } from '../../features/budget/categories';
import { RECENT_QUERY } from '../../features/budget/QuickAddBar';
import { buildTxQuery } from '../../features/budget/txQuery';
import { MEMORY_RULES_QUERY } from '../../features/chat/memoryRules';
import { CATEGORY_QUERY } from '../../features/chat/useFastPath';
import { ticketRunsQuery } from '../../features/entity-detail/useTicketRuns';
import { NEW_QUERY_BLOCK } from '../../features/entity-editor/slash/items';
import { MEMORY_FILTER } from '../../features/settings/MemoryScreen';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { buildQueryRegistry } from './catalog';

/**
 * Текст множества категорий — ЦЕЛИКОМ и ИЗ модуля, а не переписанный сюда: копия сверялась
 * бы с копией. Целиком, а не по префиксу `aspect=orbis/category`, потому что префикс — это
 * ещё и ДРУГОЙ боевой запрос: быстрый путь чата берёт категории без сортировки и потолка
 * (`useFastPath.CATEGORY_QUERY`, он в описи выше своей строкой). Одинаковое начало не
 * делает их одним текстом.
 */
const CATEGORY_SET_TEXT = CATEGORIES_QUERY;

/** Признак контрола ссылки в разметке — его ставит `RefField` и по нему же его ищут тесты. */
const REF_CONTROL_MARK = 'data-kind="ref"';

/** Корень `src` — тем же приёмом, что у стража фикстур (`test/fixtures.test.ts`). */
const SRC = join(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * Исходники web БЕЗ тестов: тест вправе содержать образец запрещённой формы — он её и
 * проверяет (тот же довод, что у allowlist'а `scripts/check-legacy-form.ts`).
 */
function sourceFiles(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}${entry.name}/`);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      out.push({ path: `${prefix}${entry.name}`, code: readFileSync(full, 'utf8') });
    }
  };
  walk(SRC, '');
  return out;
}

const registry = buildQueryRegistry(BUILTIN_REGISTRY).parse;

/** uuid из корпуса фикстур — подставляется туда, где текст собирается вокруг id сущности. */
const ID = '019d48ea-4188-765d-8e96-93a0ad9c262a';

/**
 * Адрес → текст. Динамические тексты собраны с ХУДШИМ входом, какой даёт интерфейс:
 * тег и строка поиска с пробелом — ровно те два адреса описи, чей вердикт был `SYNTAX`
 * (пробел разделяет конструкции, §А5-3), и ломает их подстановка, а не литерал.
 */
const PRODUCTION_TEXTS: ReadonlyArray<readonly [string, string]> = [
  ['features/agenda/useAgenda.ts (AGENDA_DAYS_QUERY)', AGENDA_DAYS_QUERY],
  ['features/agenda/useAgenda.ts (AGENDA_OVERDUE_DUE_QUERY)', AGENDA_OVERDUE_DUE_QUERY],
  ['features/agenda/useAgenda.ts (AGENDA_OVERDUE_START_QUERY)', AGENDA_OVERDUE_START_QUERY],
  [
    'features/browser/query.ts (buildFilterQuery+browserQuery)',
    browserQuery({
      limit: 50,
      filters: buildFilterQuery({
        tags: ['дом', 'дача'],
        aspects: ['orbis/task'],
        createdFrom: null,
        createdTo: null,
      }),
    }),
  ],
  [
    'features/browser/query.ts (тег владельца с пробелом)',
    browserQuery({
      limit: 50,
      filters: buildFilterQuery({
        tags: ['личные дела'],
        aspects: [],
        createdFrom: null,
        createdTo: null,
      }),
    }),
  ],
  ['features/budget/QuickAddBar.tsx (RECENT_QUERY)', RECENT_QUERY],
  [
    'features/budget/txQuery.ts (buildTxQuery, все фильтры)',
    buildTxQuery({
      month: '2026-06',
      categoryId: ID,
      direction: 'expense',
      planned: false,
      amountFrom: '0.10',
      amountTo: '99999.99',
      search: 'кофе',
      limit: 50,
    }),
  ],
  [
    'features/budget/txQuery.ts (поиск с пробелом)',
    buildTxQuery({ month: '2026-06', search: 'кофе эклер', limit: 50 }),
  ],
  ['features/budget/CategoryScreen.tsx (транзакции конверта)', envelopeTransactionsQuery(ID, 50)],
  ['features/budget/categories.ts (CATEGORIES_QUERY)', CATEGORIES_QUERY],
  ['features/chat/memoryRules.ts (MEMORY_RULES_QUERY)', MEMORY_RULES_QUERY.query],
  ['features/chat/useFastPath.ts (CATEGORY_QUERY)', CATEGORY_QUERY.query],
  ['features/entity-detail/useTicketRuns.ts (прогоны тикета)', ticketRunsQuery(ID)],
  ['features/entity-editor/slash/items.ts (NEW_QUERY_BLOCK)', NEW_QUERY_BLOCK],
  [
    'features/settings/MemoryScreen.tsx (MEMORY_FILTER)',
    browserQuery({ limit: 50, filters: MEMORY_FILTER }),
  ],
];

test.each(PRODUCTION_TEXTS)('%s разбирается каноном §А5-3 без моста', (_where, text) => {
  const r = parseQueryAst(text, registry);
  expect(r.ok ? null : `${r.error.code}: ${r.error.message}`).toBeNull();
});

/**
 * ОДИН ДОМ У СТРОКИ КАТЕГОРИЙ — правило, а не разовая уборка.
 *
 * История: `EnvelopeCreateSheet` носил ИНЛАЙН-ДУБЛЬ `CATEGORIES_QUERY`, и перевод
 * `categories.ts` на namespaced key его не касался вовсе — дубль пережил правку молча
 * (опись, вердикт `RESERVED`). Задача 13c сняла у листа конверта саму надобность в списке
 * (выбор идёт общим `RefField` по цели свойства из реестра), но правило осталось прежним и
 * стало шире: текст множества категорий существует В ОДНОМ месте на весь web.
 *
 * Проверяется ИСХОДНИК, а не поведение: копия, набранная заново, зелена во всех экранных
 * тестах — она возвращает те же строки. Увидеть её можно только в тексте.
 */
test('строка множества категорий живёт в ОДНОМ файле', () => {
  const offenders = sourceFiles()
    .filter(({ code }) => code.includes(CATEGORY_SET_TEXT))
    .map(({ path }) => path);
  expect(offenders).toEqual(['features/budget/categories.ts']);

  // Положительный контроль ПРАВИЛА: обход обязан видеть текст там, где он есть. Без него
  // пустой список файлов (промах пути, сменившееся расширение) читался бы как «дублей нет».
  const scanned = sourceFiles();
  expect(scanned.length).toBeGreaterThan(100);
  expect(scanned.some(({ code }) => code.includes(CATEGORY_SET_TEXT))).toBe(true);
});

/**
 * ОДНА РЕАЛИЗАЦИЯ ПИКЕРА ССЫЛКИ (§А6-1, ref Р6).
 *
 * До Задачи 13c «выбрать сущность» было написано пять раз (карточка записи, быстрая запись,
 * форма конверта, лист рекатегоризации, сверка импорта), и все пять умели ровно одно
 * множество — категории. Признак пикера в разметке — атрибут `data-kind="ref"`: его ставит
 * контрол ссылки, и по нему же его находят тесты экранов.
 *
 * Тест ловит ВОЗВРАТ КОПИИ, а не факт существования файла: второй контрол ссылки, где бы он
 * ни появился, красит эту проверку — и красит именно тем, что копия существует, а не тем,
 * что она чем-то плоха.
 */
test('контрол ссылки — ровно одна реализация на весь web', () => {
  const offenders = sourceFiles()
    .filter(({ code }) => code.includes(REF_CONTROL_MARK))
    .map(({ path }) => path);
  expect(offenders).toEqual(['lib/entity-ref/RefField.tsx']);
});

/**
 * Список ПОЛОН: пятнадцать адресов против шестнадцати в описи Задачи 8 (владелец `10c`).
 * Разница ровно одна и названа: `EnvelopeCreateSheet.tsx` носил ИНЛАЙН-ДУБЛЬ строки
 * категорий, дубля больше нет (тест выше), и отдельного текста у него не осталось.
 * `SmartListSave.tsx` собственного текста не имел (он оборачивал в `{{query:…}}` строку
 * Browser, покрытую записями `browser/query.ts`) и снят Задачей 21b как механизм без
 * единого вызывателя — причина записана в докблоке `BrowserScreen.tsx`.
 *
 * Число пиннится, потому что молча УКОРОТИТЬ этот список — самый дешёвый способ сделать тест
 * зелёным, не переведя текст.
 */
test('в списке боевых текстов ровно пятнадцать адресов', () => {
  expect(PRODUCTION_TEXTS.length).toBe(15);
  expect(new Set(PRODUCTION_TEXTS.map(([where]) => where)).size).toBe(15);
});
