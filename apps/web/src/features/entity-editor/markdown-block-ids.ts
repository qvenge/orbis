import { type BodyDoc, serializeBody } from '@orbis/shared/doc';
import type { JSONContent } from '@tiptap/core';

/** Markdown carries no block IDs. First match surviving blocks by their projection,
 * including moved blocks and legacy raw blocks upgraded into literal paragraphs. For
 * edited siblings, a same-type pair between surviving neighbours keeps its old ID. */
export function retainMarkdownBlockIds(before: BodyDoc, after: BodyDoc): BodyDoc {
  function reconcile(previous: JSONContent, next: JSONContent) {
    const id = previous.attrs?.id;
    if (typeof id === 'string') next.attrs = { ...next.attrs, id };
    const old = previous.content ?? [];
    const fresh = next.content ?? [];
    if (!old.length || !fresh.length) return;

    const candidates = new Map<string, number[]>();
    const matches = new Map<number, number>();
    const used = new Set<number>();
    const key = (node: JSONContent) => serializeBody({ type: 'doc', content: [node] });
    old.forEach((node, index) => {
      const text = key(node);
      const list = candidates.get(text);
      if (list) list.push(index);
      else candidates.set(text, [index]);
    });
    fresh.forEach((node, index) => {
      const match = candidates.get(key(node))?.shift();
      if (match !== undefined) {
        matches.set(index, match);
        used.add(match);
      }
    });

    // Do not lend identities across insertions or deletions. An edited run is paired
    // by type only where old and new have the same number of siblings of that type.
    const anchors = [...matches, [fresh.length, old.length] as const];
    let oldStart = 0;
    let newStart = 0;
    for (const [newEnd, oldEnd] of anchors) {
      const oldTypes = new Map<string, number[]>();
      const newTypes = new Map<string, number[]>();
      function group(
        nodes: JSONContent[],
        start: number,
        end: number,
        groups: Map<string, number[]>,
        skip: (i: number) => boolean,
      ) {
        for (let i = start; i < end; i++) {
          const type = nodes[i]?.type;
          if (!type || skip(i)) continue;
          const indexes = groups.get(type);
          if (indexes) indexes.push(i);
          else groups.set(type, [i]);
        }
      }
      group(old, oldStart, oldEnd, oldTypes, (i) => used.has(i));
      group(fresh, newStart, newEnd, newTypes, (i) => matches.has(i));
      for (const [type, indexes] of newTypes) {
        const prior = oldTypes.get(type);
        if (prior?.length !== indexes.length) continue;
        indexes.forEach((index, j) => {
          const from = prior[j];
          if (from !== undefined) matches.set(index, from);
        });
      }
      oldStart = Math.max(oldStart, oldEnd + 1);
      newStart = newEnd + 1;
    }
    for (const [to, from] of matches) {
      const a = old[from];
      const b = fresh[to];
      if (a && b) reconcile(a, b);
    }
  }
  reconcile(before.doc, after.doc);
  return after;
}
