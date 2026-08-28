import { quoteQueryValue } from '@orbis/shared/query';

// Task B5 (03-budget §3.3): чистый билдер строки грамматики §А5-3 для экрана
// «Транзакции» — потребитель №3 query-движка. Периода-агрегата не нужно: месяц
// передаётся абсолютным диапазоном date-свойства orbis/occurred_on=<от>..<до>
// (расширение грамматики этого же таска). Никакой логики запросов в компонентах —
// строка собирается здесь и покрыта юнит-тестами на кавычки/экранирование
// (урок бэклога об экранировании тегов).

/**
 * Размер страницы списков транзакций (Task C6, бэклог B). Пагинация — РАСТУЩЕЕ ОКНО:
 * экран держит номер страницы и шлёт `limit = TX_PAGE_SIZE * page`, догрузка
 * перезапрашивает уже показанные записи. Цена принята осознанно: курсорной пагинации
 * в движке нет, а `offset` был бы расширением грамматики §6.1 (глобальное ограничение
 * плана — грамматика не расширяется без нужды).
 */
export const TX_PAGE_SIZE = 200;

export type TxFilters = {
  /** Месяц периода 'YYYY-MM' — единственный обязательный фильтр (◀▶ как Overview). */
  month: string;
  /** Окно выдачи: TX_PAGE_SIZE * page (растущее окно C6); по умолчанию первая страница. */
  limit?: number;
  /** id категории → orbis/finance_category=<uuid>; null/undefined — все категории. */
  categoryId?: string | null;
  direction?: 'expense' | 'income' | null;
  planned?: boolean | null;
  /** Границы суммы — уже валидированные decimal-строки (экран отсеивает мусор). */
  amountFrom?: string | null;
  amountTo?: string | null;
  search?: string | null;
};

/** Первый и последний день месяца 'YYYY-MM' (UTC-хак: день 0 следующего месяца). */
export function monthRange(month: string): { start: string; end: string } {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Строка запроса §А5-3 для экрана «Транзакции» (§3.3): фильтры → конструкции через запятую.
 *
 * Имена свойств — namespaced key реестра (§А5-3а): голых `occurred_on`/`category_ref` в
 * реестре нет, а `category_ref` вдобавок слит с `orbis/finance_category` (В1 инвентаря).
 *
 * Квотирование значения — общий `quoteQueryValue` печати, а не своя функция: прежняя
 * `quoteValue` брала в кавычки только `,`/`|`/`&`/`"` и краевые пробелы, а с §А5-3 пробел
 * стал РАЗДЕЛИТЕЛЕМ конструкций — поисковый ввод «кофе эклер» уезжал голым и рвал запрос
 * надвое (опись боевых текстов, вердикт `SYNTAX`).
 */
export function buildTxQuery(f: TxFilters): string {
  const { start, end } = monthRange(f.month);
  const clauses = [`aspect=orbis/financial`, `orbis/occurred_on=${start}..${end}`];
  if (f.categoryId) clauses.push(`orbis/finance_category=${f.categoryId}`);
  if (f.direction) clauses.push(`orbis/direction=${f.direction}`);
  // «Факт» — noneOf `orbis/planned=!true` (IS NULL OR NOT IN ('true'), решение 10 компилятора):
  // quick-add/fast-path/LLM ключ planned не пишут (только post-due/confirmPurchase ставят),
  // а `planned=false` компилировался бы в IN ('false') и скрывал бы рукописные транзакции.
  // Семантика согласована с серверными агрегатами: отсутствие ключа = факт (coalesce(...,false)).
  if (f.planned === true) clauses.push('orbis/planned=true');
  else if (f.planned === false) clauses.push('orbis/planned=!true');
  // Обе границы — диапазон (включительно, §А5-7); одна — строгое сравнение
  if (f.amountFrom && f.amountTo) clauses.push(`orbis/amount=${f.amountFrom}..${f.amountTo}`);
  else if (f.amountFrom) clauses.push(`orbis/amount>${f.amountFrom}`);
  else if (f.amountTo) clauses.push(`orbis/amount<${f.amountTo}`);
  if (f.search && f.search.trim() !== '') clauses.push(`search=${quoteQueryValue(f.search)}`);
  clauses.push('sortBy=orbis/occurred_on:desc', `limit=${f.limit ?? TX_PAGE_SIZE}`);
  return clauses.join(', ');
}
