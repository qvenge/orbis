import { DAILY_PLANNING_BODY } from '@orbis/server/src/seed/smart-lists';
import { expect, test } from 'vitest';
import {
  bodySegments,
  browserQuery,
  buildFilterQuery,
  firstQueryBlock,
  queryBlocks,
} from './query';

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

// --- сегментация body для просмотра (C4b) ----------------------------------------------
// Просмотр detail рендерит текст markdown'ом, а {{query:...}}-блоки — виджетами, ВПЕРЕМЕЖКУ
// и в порядке текста. queryBlocks для этого мало: она отдаёт только содержимое блоков, а
// текста «между блоками» как значения не существовало вовсе.

test('bodySegments чередует текст и блоки в порядке появления', () => {
  const body = 'вступление\n{{query: aspect=orbis/task}}\nсередина\n{{query:tags=x}}\nхвост';
  expect(bodySegments(body)).toEqual([
    { kind: 'text', text: 'вступление' },
    { kind: 'query', query: 'aspect=orbis/task' },
    { kind: 'text', text: 'середина' },
    { kind: 'query', query: 'tags=x' },
    { kind: 'text', text: 'хвост' },
  ]);
});

test('bodySegments не выдумывает текст там, где его нет', () => {
  // Между блоками сида — только перевод строки: пустой абзац между виджетами был бы
  // дырой в раскладке, а не текстом записи. Пустое тело — вовсе без сегментов
  // (приглашение «Заметки…» рисует экран, а не разбор).
  expect(bodySegments('{{query:a=1}}\n\n{{query:b=2}}')).toEqual([
    { kind: 'query', query: 'a=1' },
    { kind: 'query', query: 'b=2' },
  ]);
  expect(bodySegments('')).toEqual([]);
  expect(bodySegments('   \n ')).toEqual([]);
});

test('bodySegments: незакрытый блок остаётся текстом, а не съедает хвост body', () => {
  expect(bodySegments('до {{query:aspect=orbis/task после')).toEqual([
    { kind: 'text', text: 'до {{query:aspect=orbis/task после' },
  ]);
});

// Внутренняя структура текста (переводы строк, списки) — дело markdown; сегментация
// снимает только пустые края, иначе строка с отступом после блока стала бы блоком кода.
test('bodySegments сохраняет разметку текста, убирая лишь пустые края', () => {
  expect(bodySegments('# Итоги\n\n- раз\n- два\n\n{{query:a=1}}')[0]).toEqual({
    kind: 'text',
    text: '# Итоги\n\n- раз\n- два',
  });
});

// Разбор блоков не раздваивается: у §3.4 один контракт на два потребителя.
test('bodySegments и queryBlocks видят одни и те же блоки (сид Daily Planning)', () => {
  const queries = bodySegments(DAILY_PLANNING_BODY).flatMap((s) =>
    s.kind === 'query' ? [s.query] : [],
  );
  expect(queries).toEqual(queryBlocks(DAILY_PLANNING_BODY));
  expect(queries).toHaveLength(3);
  // Текст сида — вступление перед первым блоком, и только оно.
  expect(bodySegments(DAILY_PLANNING_BODY).filter((s) => s.kind === 'text')).toEqual([
    { kind: 'text', text: 'Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».' },
  ]);
});
