export type FilterState = {
  tags: string[];
  aspects: string[];
  status: string | null;
  priority: string | null;
  createdFrom: string | null; // ISO date
  createdTo: string | null;
};

export function buildFilterQuery(f: FilterState): string {
  // Грамматика §6.1: клаузы через запятую; OR внутри значения — '|'; сравнения строгие '>'/'<'.
  const clauses: string[] = [];
  if (f.tags.length) clauses.push(`tags=${f.tags.join('|')}`);
  for (const a of f.aspects) clauses.push(`aspect=${a}`);
  if (f.status) clauses.push(`status=${f.status}`);
  if (f.priority) clauses.push(`priority=${f.priority}`);
  if (f.createdFrom) clauses.push(`created_at>${f.createdFrom}`);
  if (f.createdTo) clauses.push(`created_at<${f.createdTo}`);
  return clauses.join(', ');
}

export function browserQuery({ limit, filters }: { limit: number; filters: string }): string {
  const base = filters ? `${filters}, ` : '';
  return `${base}sortBy=updated_at:desc, limit=${limit}`;
}

// ВСЕ {{query:...}}-блоки body в порядке появления; значение — inner (обёртка снята),
// то есть готовый аргумент entity.query. 02-core-os §3.4: «Каждый {{query:...}}-блок в body
// рендерится виджетом» — у Daily Planning их три (Inbox / «Сегодня» / «Ожидание», §3.3),
// у Upcoming два, поэтому detail-экран обязан ходить сюда, а не за первым блоком.
export function queryBlocks(body: string): string[] {
  return [...body.matchAll(/\{\{query:([\s\S]*?)\}\}/g)].map((m) => (m[1] ?? '').trim());
}

// Первый блок — и только он: §3.2 нормирует бейдж pinned-сущности как «число результатов
// ПЕРВОГО query-блока её body» (у Daily Planning это размер Inbox). Единственный потребитель
// — PinnedList; detail-экран рендерит все блоки через queryBlocks.
export function firstQueryBlock(body: string): string | null {
  return queryBlocks(body)[0] ?? null;
}
