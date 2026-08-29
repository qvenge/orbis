/**
 * ВСЕ боевые тексты запросов web — каждый разбирается НОВОЙ грамматикой §А5-3 БЕЗ отката к
 * мосту старой формы.
 *
 * Зачем этот файл существует отдельно от экранных тестов. С Задачи 9b разбор текста принимает
 * ОБЕ формы: сначала канон, при отказе кодом «текст старой формы» — старую грамматику через
 * `legacy-bridge`. Значит непереведённый текст сегодня НЕ падает — он тихо уходит в старую
 * ветку, и «страница открылась», «список не пуст», «entity.query получил строку» доказывают
 * ровно ничего: они одинаково зелены и до перевода, и после. Единственное наблюдаемое
 * различие — исход `parseQueryAst` (без моста), и он здесь и проверяется.
 *
 * Тексты берутся ИЗ САМИХ МОДУЛЕЙ, а не переписаны сюда литералами: копия разъехалась бы с
 * кодом при первой же правке, и тест продолжал бы зеленеть на собственной копии. Адрес рядом
 * с каждым — та же опись, что в `PRODUCTION_QUERY_TEXTS` (`@orbis/shared/query/fixtures`),
 * поле `where`; там она снята НА МОМЕНТ ЗАДАЧИ 8 и остаётся снимком, здесь — живой код.
 *
 * Чего здесь НЕТ и почему: тексты, которые web не сочиняет, — тела сидированных смарт-листов
 * и заготовка проекта (Задача 21), примеры в промптах и в описании тула (Задача 19). Их
 * перевод не наш, и мост живёт ради них.
 */

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
 * ИНЛАЙН-ДУБЛЬ, который правкой источника не чинился: `EnvelopeCreateSheet` носил свою копию
 * `CATEGORIES_QUERY`, и перевод `categories.ts` его не касался вовсе (опись, вердикт
 * `RESERVED`). Копии больше нет — лист берёт общую константу, и мутация «вернуть литерал»
 * наблюдаема здесь: строка `sortBy=title:asc` в этом файле отсутствует.
 */
test('инлайн-дубль запроса категорий снят: у листа конверта своей строки нет', async () => {
  const source = await import('../../features/budget/EnvelopeCreateSheet?raw');
  expect(source.default).toContain('CATEGORIES_QUERY');
  expect(source.default).not.toContain('aspect=orbis/category');
});

/**
 * Список ПОЛОН: пятнадцать адресов против шестнадцати в описи Задачи 8 (владелец `10c`).
 * Разница ровно одна и названа: `EnvelopeCreateSheet.tsx` носил ИНЛАЙН-ДУБЛЬ строки
 * категорий, дубля больше нет (тест выше), и отдельного текста у него не осталось.
 * `SmartListSave.tsx` собственного текста не имел и в описи, и в брифе — он оборачивает в
 * `{{query:…}}` строку Browser, покрытую записями `browser/query.ts`.
 *
 * Число пиннится, потому что молча УКОРОТИТЬ этот список — самый дешёвый способ сделать тест
 * зелёным, не переведя текст.
 */
test('в списке боевых текстов ровно пятнадцать адресов', () => {
  expect(PRODUCTION_TEXTS.length).toBe(15);
  expect(new Set(PRODUCTION_TEXTS.map(([where]) => where)).size).toBe(15);
});
