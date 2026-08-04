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

/** Кусок body для рендера: обычный текст (markdown) либо {{query:...}}-блок (виджет). */
export type BodySegment = { kind: 'text'; text: string } | { kind: 'query'; query: string };

const QUERY_BLOCK_RE = /\{\{query:([\s\S]*?)\}\}/g;

// Body в порядке текста: что между блоками — текст, сами блоки — отдельными сегментами.
// Просмотр detail рисует текст markdown'ом, а блоки — виджетами ВПЕРЕМЕЖКУ (C4b), поэтому
// одного списка блоков (queryBlocks) для него мало.
//
// Разбор для РЕНДЕРА, не для реконструкции body: пустые края текста сняты (пустой абзац
// между двумя виджетами — дыра в раскладке, а отступ в начале куска markdown сделал бы из
// него блок кода), промежутки из одних пробелов выброшены целиком. Незакрытая обёртка
// блоком не считается и остаётся текстом — иначе опечатка съедала бы весь хвост записи.
export function bodySegments(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let cursor = 0;
  const pushText = (raw: string) => {
    const text = raw.trim();
    if (text !== '') segments.push({ kind: 'text', text });
  };
  for (const m of body.matchAll(QUERY_BLOCK_RE)) {
    pushText(body.slice(cursor, m.index));
    segments.push({ kind: 'query', query: (m[1] ?? '').trim() });
    cursor = m.index + m[0].length;
  }
  pushText(body.slice(cursor));
  return segments;
}

// ВСЕ {{query:...}}-блоки body в порядке появления; значение — inner (обёртка снята),
// то есть готовый аргумент entity.query. 02-core-os §3.4: «Каждый {{query:...}}-блок в body
// рендерится виджетом» — у Daily Planning их три (Inbox / «Сегодня» / «Ожидание», §3.3),
// у Upcoming два, поэтому detail-экран обязан ходить сюда, а не за первым блоком.
// Тот же разбор, что у bodySegments: второй регэксп для того же контракта §3.4 разъехался бы.
export function queryBlocks(body: string): string[] {
  return bodySegments(body).flatMap((s) => (s.kind === 'query' ? [s.query] : []));
}

// Первый блок — и только он: §3.2 нормирует бейдж pinned-сущности как «число результатов
// ПЕРВОГО query-блока её body» (у Daily Planning это размер Inbox). Единственный потребитель
// — PinnedList; detail-экран рендерит все блоки через queryBlocks.
export function firstQueryBlock(body: string): string | null {
  return queryBlocks(body)[0] ?? null;
}
