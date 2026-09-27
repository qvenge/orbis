import { APP_ASPECT, PAGE_ASPECT } from '@orbis/shared';
import { quoteQueryValue } from '@orbis/shared/query';
import { RECORDS_HIDE_PAGES_AND_APPS } from '../browser/query';

/** Группы результатов поиска хоста в порядке показа (спека 1б §6.4, §9.6). */
export const SEARCH_GROUPS = ['records', 'pages', 'apps'] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

/**
 * Строка поиска → тексты запросов трёх групп (РП-29): «Записи» — записи БЕЗ страниц и приложений,
 * их показывают свои группы (страницы и приложения скрыты из «Записей», §9.6, а в поиске видны);
 * «Страницы» и «Приложения» — по аспекту. Потолки групп — в самом тексте (`limit`): сервер отдаёт
 * `more` — сколько не поместилось («и ещё N»).
 *
 * Канон `search` — полнотекст по словам (Д-13, В-2): «Куп» не найдёт «Купить»; подстрочного поиска
 * здесь нет намеренно. Строка владельца — значением через общий квотировщик печати: пробел и запятая
 * в ней иначе рвали бы запрос на конструкции (отказ `SYNTAX`). Пустая строка (или одни пробелы) —
 * `null`: запроса нет вовсе, а не запрос с пустым значением.
 */
export function searchBlockTexts(q: string): Record<SearchGroup, string> | null {
  const trimmed = q.trim();
  if (trimmed === '') return null;
  const value = quoteQueryValue(trimmed);
  return {
    records: `search=${value}, ${RECORDS_HIDE_PAGES_AND_APPS}, limit=20`,
    pages: `aspect=${PAGE_ASPECT}, search=${value}, limit=10`,
    apps: `aspect=${APP_ASPECT}, search=${value}, limit=10`,
  };
}
