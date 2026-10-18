import { expect, test } from 'bun:test';
import { FIXTURE_PARSE_REGISTRY } from '../query/ast-fixtures';
import { parseBody, serializeBody } from './convert';
import { parsePageText } from './page-grammar';
import { bodyIssues } from './placement';

test('day and inbox blocks are interactive page nodes, not raw text', () => {
  for (const name of ['day-planner', 'inbox'] as const) {
    expect(parsePageText(`{{${name}}}`)).toEqual([{ kind: 'host', name, raw: `{{${name}}}` }]);
  }
});

test('planning blocks survive document round trip and are rejected in notes and templates', () => {
  for (const name of ['day-planner', 'inbox']) {
    const text = `{{${name}}}\n`;
    expect(serializeBody(parseBody(text))).toBe(text.trimEnd());
    const nodes = parsePageText(text);
    expect(bodyIssues(nodes, 'page', FIXTURE_PARSE_REGISTRY)).toEqual([]);
    for (const place of ['note', 'template'] as const)
      expect(bodyIssues(nodes, place, FIXTURE_PARSE_REGISTRY).map((i) => i.code)).toEqual([
        'BLOCK_MISPLACED',
      ]);
  }
});
