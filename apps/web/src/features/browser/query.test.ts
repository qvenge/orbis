import { expect, test } from 'vitest';
import { browserQuery, buildFilterQuery, firstQueryBlock, queryBlocks } from './query';

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

// 02-core-os §3.4: «Каждый {{query:...}}-блок в body рендерится виджетом». Первого блока
// достаточно только бейджу pinned (§3.2) — detail-экрану нужны все, иначе секции «Сегодня»
// и «Ожидание» сидированного Daily Planning (§3.3) недостижимы.
test('queryBlocks возвращает ВСЕ блоки body в порядке появления, обёртка снята', () => {
  const body = 'текст\n{{query: aspect=orbis/task, status=inbox}}\n\n{{query:\ntags=x\n}}\nхвост';
  expect(queryBlocks(body)).toEqual(['aspect=orbis/task, status=inbox', 'tags=x']);
  expect(queryBlocks('без блоков')).toEqual([]);
  // firstQueryBlock — тот же разбор, взятый по первому элементу (§3.2)
  expect(firstQueryBlock(body)).toBe(queryBlocks(body)[0]);
});
