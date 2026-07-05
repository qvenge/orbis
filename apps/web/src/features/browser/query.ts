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

export function firstQueryBlock(body: string): string | null {
  const m = body.match(/\{\{query:([\s\S]*?)\}\}/);
  return m ? (m[1] ?? '').trim() : null;
}
