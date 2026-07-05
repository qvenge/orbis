import { expect, test } from 'vitest';
import { buildCatalogFromAspects, parseBlock } from './parse';

const aspects = [
  {
    id: 'orbis/task',
    schema: {
      type: 'object',
      properties: { status: { type: 'string' }, priority: { type: 'string' } },
    },
  },
];

test('buildCatalogFromAspects строит каталог из schema + CORE_FIELDS', () => {
  const cat = buildCatalogFromAspects(aspects as never);
  expect(cat).toBeTruthy();
});

test('parseBlock снимает обёртку и валидный блок → ok:true с ast', () => {
  const cat = buildCatalogFromAspects(aspects as never);
  const r = parseBlock('{{query:tags=work}}', cat);
  expect(r.ok).toBe(true);
});

// Реальный parseQuery трактует пустой inner {{query:}} как валидный (пустой набор фильтров),
// поэтому заведомо-ошибочная фикстура — невалидный синтаксис {{query:foo}} (нет оператора).
test('parseBlock: невалидный синтаксис → ok:false с position', () => {
  const cat = buildCatalogFromAspects(aspects as never);
  const r = parseBlock('{{query:foo}}', cat);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(typeof r.error.position).toBe('number');
});
