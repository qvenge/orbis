export interface QueryBlockParams {
  aspect?: string;
  tags?: string[];
  excludeTags?: string[];
  status?: string[];
  excludeStatus?: string[];
  due?: string; // 'today', 'overdue', 'today|overdue', 'next_7d', 'after_7d', 'this_week'
  excludeBlocked?: boolean;
  sortBy?: Array<{ field: string; order: 'asc' | 'desc' }>;
  limit?: number;
  display?: 'compact' | 'list' | 'table';
  title?: string;
  search?: string;
}

const QUERY_BLOCK_REGEX = /\{\{query:\s*(.+?)\}\}/g;

/**
 * Parse a single query block content string into QueryBlockParams.
 * Input: "aspect=orbis/task, status=inbox, sortBy=created_at:desc, title=Inbox"
 */
export function parseQueryBlock(raw: string): QueryBlockParams {
  const params: QueryBlockParams = {};
  // Split by comma, but respect values that may contain commas within pipes
  const parts = raw.split(/,\s*(?=[a-zA-Z_]+=)/);

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;

    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();

    switch (key) {
      case 'aspect':
        params.aspect = value;
        break;
      case 'tags':
        params.tags = value.split('|').map((t) => t.trim());
        break;
      case 'excludeTags':
        params.excludeTags = value.split('|').map((t) => t.trim());
        break;
      case 'status': {
        const statuses = value.split('&').map((s) => s.trim());
        const include: string[] = [];
        const exclude: string[] = [];
        for (const s of statuses) {
          if (s.startsWith('!')) {
            exclude.push(s.slice(1));
          } else {
            // Also handle pipe-separated values
            include.push(...s.split('|').map((v) => v.trim()));
          }
        }
        if (include.length > 0) params.status = include;
        if (exclude.length > 0) params.excludeStatus = exclude;
        break;
      }
      case 'due':
        params.due = value;
        break;
      case 'excludeBlocked':
        params.excludeBlocked = value === 'true';
        break;
      case 'sortBy': {
        params.sortBy = value.split('|').map((s) => {
          const [field, order] = s.trim().split(':');
          return { field, order: (order ?? 'asc') as 'asc' | 'desc' };
        });
        break;
      }
      case 'limit':
        params.limit = parseInt(value, 10);
        break;
      case 'display':
        params.display = value as 'compact' | 'list' | 'table';
        break;
      case 'title':
        params.title = value;
        break;
      case 'search':
        params.search = value;
        break;
    }
  }

  return params;
}

/**
 * Find all query blocks in a body string.
 */
export function findQueryBlocks(
  body: string,
): Array<{ raw: string; params: QueryBlockParams; start: number; end: number }> {
  const results: Array<{ raw: string; params: QueryBlockParams; start: number; end: number }> = [];
  const regex = new RegExp(QUERY_BLOCK_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    results.push({
      raw: match[0],
      params: parseQueryBlock(match[1]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return results;
}
