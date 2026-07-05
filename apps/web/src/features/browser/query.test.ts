import { expect, test } from 'vitest';
import { browserQuery, buildFilterQuery, firstQueryBlock } from './query';

test('browserQuery включает limit и сортировку по updated_at desc', () => {
  const q = browserQuery({ limit: 50, filters: '' });
  expect(q).toContain('limit=50');
  expect(q).toContain('sortBy=updated_at:desc');
});

test('browserQuery дописывает фильтры перед limit', () => {
  const q = browserQuery({ limit: 100, filters: 'aspect=orbis/task' });
  expect(q).toContain('aspect=orbis/task');
  expect(q).toContain('limit=100');
});

test('buildFilterQuery собирает строку из выбранных фильтров', () => {
  const s = buildFilterQuery({
    tags: ['работа', 'дом'],
    aspects: ['orbis/task'],
    status: 'inbox',
    priority: null,
    createdFrom: null,
    createdTo: null,
  });
  expect(s).toContain('tags=работа|дом');
  expect(s).toContain('aspect=orbis/task');
  expect(s).toContain('status=inbox');
});

test('firstQueryBlock извлекает первый {{query:...}} из body', () => {
  expect(firstQueryBlock('текст\n{{query:aspect=orbis/task}}\nещё {{query:tags=x}}')).toBe(
    'aspect=orbis/task',
  );
  expect(firstQueryBlock('без блоков')).toBeNull();
});
