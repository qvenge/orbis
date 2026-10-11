// Листовая проекция головы документа (§9): текст блоков данных и атомов-маркеров не является превью записи.
export const BODY_START_MAX = 160;
type Node = { type?: unknown; text?: unknown; content?: unknown };
const TEXT_BLOCKS = new Set(['paragraph', 'heading']);
const LISTS = new Set(['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem']);
const nodeOf = (n: unknown): Node | null =>
  typeof n === 'object' && n !== null && !Array.isArray(n) ? (n as Node) : null;
const childrenOf = (n: Node): unknown[] => (Array.isArray(n.content) ? n.content : []);
function lines(block: Node): string[] {
  const out = [''];
  for (const child of childrenOf(block)) {
    const n = nodeOf(child);
    if (n?.type === 'hardBreak') out.push('');
    else if (n?.type === 'text' && typeof n.text === 'string') out[out.length - 1] += n.text;
  }
  return out;
}
function firstLine(nodes: readonly unknown[]): string | null {
  for (const child of nodes) {
    const n = nodeOf(child);
    if (n === null || typeof n.type !== 'string') continue;
    if (TEXT_BLOCKS.has(n.type)) {
      const line = lines(n)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .find((l) => l !== '');
      if (line !== undefined) return line;
    } else if (LISTS.has(n.type)) {
      const inner = firstLine(childrenOf(n));
      if (inner !== null) return inner;
    }
  }
  return null;
}
export function bodyStartOf(head: unknown[]): string | null {
  const line = firstLine(head);
  if (line === null || line.length <= BODY_START_MAX) return line;
  let cut = line.slice(0, BODY_START_MAX - 1);
  // Предел задан в UTF-16 символах: последний high surrogate нельзя оставлять без пары.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
