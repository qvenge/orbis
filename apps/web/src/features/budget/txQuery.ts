// Task B5 (03-budget §3.3): чистый билдер строки грамматики §6.1 для экрана
// «Транзакции» — потребитель №3 query-движка. Периода-агрегата не нужно: месяц
// передаётся абсолютным диапазоном date-поля аспекта occurred_on=<от>..<до>
// (расширение грамматики этого же таска). Никакой логики запросов в компонентах —
// строка собирается здесь и покрыта юнит-тестами на кавычки/экранирование
// (урок бэклога об экранировании тегов).

export type TxFilters = {
  /** Месяц периода 'YYYY-MM' — единственный обязательный фильтр (◀▶ как Overview). */
  month: string;
  /** id категории → category_ref=<uuid>; null/undefined — все категории. */
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
 * Экранирование значения по лексике §6.1: `,`/`|`/`&`/`"`/краевые пробелы →
 * значение целиком в двойных кавычках; внутри — `\` → `\\` (первым! иначе двойное
 * экранирование кавычек) и `"` → `\"` (fix round B5: хвостовой `\` без `\\`-экрана
 * съедал бы закрывающую кавычку). Вне кавычек `\` — литерал, экран не нужен.
 */
function quoteValue(v: string): string {
  if (!/[,|&"]/.test(v) && v === v.trim()) return v;
  return `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Строка запроса §6.1 для экрана «Транзакции» (§3.3): фильтры → клаузы через запятую. */
export function buildTxQuery(f: TxFilters): string {
  const { start, end } = monthRange(f.month);
  const clauses = [`aspect=orbis/financial`, `occurred_on=${start}..${end}`];
  if (f.categoryId) clauses.push(`category_ref=${f.categoryId}`);
  if (f.direction) clauses.push(`direction=${f.direction}`);
  // «Факт» — noneOf `planned=!true` (IS NULL OR NOT IN ('true'), решение 10 компилятора):
  // quick-add/fast-path/LLM ключ planned не пишут (только post-due/confirmPurchase ставят),
  // а `planned=false` компилировался бы в IN ('false') и скрывал бы рукописные транзакции.
  // Семантика согласована с серверными агрегатами: отсутствие ключа = факт (coalesce(...,false)).
  if (f.planned === true) clauses.push('planned=true');
  else if (f.planned === false) clauses.push('planned=!true');
  // Обе границы — диапазон (включительно, §6.1); одна — строгое сравнение (>= в грамматике нет)
  if (f.amountFrom && f.amountTo) clauses.push(`amount=${f.amountFrom}..${f.amountTo}`);
  else if (f.amountFrom) clauses.push(`amount>${f.amountFrom}`);
  else if (f.amountTo) clauses.push(`amount<${f.amountTo}`);
  if (f.search && f.search.trim() !== '') clauses.push(`search=${quoteValue(f.search)}`);
  clauses.push('sortBy=occurred_on:desc', 'limit=200');
  return clauses.join(', ');
}
