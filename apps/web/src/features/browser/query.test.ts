import { DAILY_PLANNING_BODY, SEED_SMART_LISTS } from '@orbis/server/src/seed/smart-lists';
import { parseBody } from '@orbis/shared/doc';
import { expect, test } from 'vitest';
import {
  bodySegments,
  browserQuery,
  buildFilterQuery,
  firstQueryBlock,
  queryBlocks,
} from './query';

test('browserQuery включает limit и сортировку по orbis/updated_at desc', () => {
  const q = browserQuery({ limit: 50, filters: '' });
  expect(q).toContain('limit=50');
  // Namespaced key core-свойства (§А5-3а): голое `updated_at` новая грамматика не резолвит.
  expect(q).toContain('sortBy=orbis/updated_at:desc');
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
    createdFrom: null,
    createdTo: null,
  });
  expect(s).toContain('tags=работа|дом');
  expect(s).toContain('aspect=orbis/task');
});

// Тег владельца с пробелом — отдельный класс отказа описи (вердикт SYNTAX): пробел стал
// разделителем КОНСТРУКЦИЙ (§А5-3), и незакавыченный тег рвал запрос надвое. Проверяем на
// самом тексте, а не на «страница открылась»: без кавычек `tags=личные` и `дела` — два слова.
test('buildFilterQuery квотирует тег с пробелом', () => {
  const s = buildFilterQuery({
    tags: ['личные дела'],
    aspects: [],
    createdFrom: null,
    createdTo: null,
  });
  expect(s).toContain('tags="личные дела"');
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

// --- сегментация body для первого кадра (C4b) -------------------------------------------
// Первый кадр записи рендерит текст markdown'ом, а {{query:...}}-блоки — виджетами, ВПЕРЕМЕЖКУ
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

// --- Р-v2-6: разбор первого кадра и схема документа согласны про начало блока -----------
// Первый кадр рисует bodySegments, редактор строится по parseBody. Разойдись правила —
// человек увидит виджет, который через мгновение станет фигурными скобками (или наоборот).

test('bodySegments: обёртка с отступом 1–3 пробела блоком НЕ считается', () => {
  for (const pad of [' ', '  ', '   ']) {
    const body = `${pad}{{query:a=1}}`;
    expect(bodySegments(body)).toEqual([{ kind: 'text', text: '{{query:a=1}}' }]);
    expect(queryBlocks(body)).toEqual([]);
  }
  // …и то же посреди текста, а не только в начале записи.
  const inside = `до\n\n  {{query:a=1}}\n\nпосле`;
  expect(queryBlocks(inside)).toEqual([]);
});

test('bodySegments: обёртка посреди строки блоком НЕ считается', () => {
  const body = 'смотри {{query:a=1}} тут';
  expect(bodySegments(body)).toEqual([{ kind: 'text', text: 'смотри {{query:a=1}} тут' }]);
  expect(queryBlocks(body)).toEqual([]);
  // Обёртка с колонки 1 в том же теле блоком остаётся: правило про КОЛОНКУ, а не про
  // «где-то есть текст».
  expect(queryBlocks('смотри {{query:a=1}} тут\n{{query:b=2}}')).toEqual(['b=2']);
});

/**
 * Блоки тела ГЛАЗАМИ СХЕМЫ документа — то, что построит редактор. Второй стороной сверки во
 * всех тестах ниже стоит именно она, а не копия регэкспа: копия разъехалась бы с редактором
 * молча, и «правила совпадают» осталось бы зелёным.
 */
function blocksFromSchema(body: string): string[] {
  return (
    (parseBody(body).doc.content ?? [])
      .filter((n) => n.type === 'queryBlock')
      // `text` — тот же неразобранный текст блока: `parseBody` реестра не видит и дерева не
      // строит (Р-21-1), поэтому сверка со схемой осталась сверкой ТЕКСТОВ.
      .map((n) => String(n.attrs?.text ?? '').trim())
  );
}

test('bodySegments видит ровно те же блоки, что и схема документа', () => {
  // Сверка с parseBody — единственная честная: она сравнивает не с копией регэкспа, а с тем,
  // что построит редактор. Тела — пять сидов и краевые случаи правила про колонку.
  const bodies = [
    ...SEED_SMART_LISTS.map((s) => s.body),
    '{{query:a=1}}',
    ' {{query:a=1}}',
    '   {{query:a=1}}',
    'смотри {{query:a=1}} тут',
    'до\n{{query:a=1}}\nпосле',
    'до\n\n{{query:a=1}}\n\nпосле',
    '{{query: tags=a}}b}}',
    'текст {{query: aspect=orbis/task и всё',
  ];
  for (const body of bodies) {
    expect([body, queryBlocks(body)]).toEqual([body, blocksFromSchema(body)]);
  }
});

test('firstQueryBlock (бейдж pinned) считает по тому же правилу колонки', () => {
  // §3.2: бейдж — «число результатов ПЕРВОГО query-блока body». Обёртка посреди строки
  // блоком не является ни для detail-экрана, ни для схемы — значит и бейджу не считать.
  expect(firstQueryBlock('смотри {{query:a=1}} тут')).toBeNull();
  expect(firstQueryBlock('смотри {{query:a=1}} тут\n{{query:b=2}}')).toBe('b=2');
  // У всех пяти сидов бейдж прежний: их блоки стоят с колонки 1.
  for (const s of SEED_SMART_LISTS) {
    expect([s.slug, firstQueryBlock(s.body)]).toEqual([s.slug, queryBlocks(s.body)[0] ?? null]);
    expect(firstQueryBlock(s.body)).not.toBeNull();
  }
});

// Известное расхождение с схемой документа, записанное в комментарии QUERY_BLOCK_RE: обёртку
// внутри забора кода схема считает кодом, а этот разбор — блоком. Правило колонки его не
// лечит (забор шире одной строки), и лечить его здесь нечем — но и подразумевать нельзя:
// первый кадр живёт этим разбором до самой подмены редактором, и молча съехавшее поведение
// значило бы, что человек видит один набор виджетов, а после подмены — другой.
// Тест на это стоял в снятой замене блока по номеру (Задача 16) — свойство разбора он
// проверял заодно, поэтому переехал сюда явно.
test('bodySegments: обёртка внутри забора кода остаётся блоком (расхождение со схемой)', () => {
  const body = 'вступление\n\n```\n{{query:tags=code}}\n```\n\n{{query: tags=work}}\nхвост';
  expect(queryBlocks(body)).toEqual(['tags=code', 'tags=work']);
  // …и схема на том же теле видит ОДИН блок: расхождение именно здесь, а не выдумано.
  expect(blocksFromSchema(body)).toEqual(['tags=work']);
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
