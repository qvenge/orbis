/** Extract entity UUIDs from [[entity:uuid|text]] syntax in body text. */
export function extractBodyRefs(body: string): string[] {
  const pattern = /\[\[entity:([0-9a-f-]{36})\|[^\]]*\]\]/g;
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    refs.push(match[1]);
  }
  return [...new Set(refs)];
}
