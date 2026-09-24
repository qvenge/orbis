import { DAILY_PLANNING_BODY, SEED_SMART_LISTS } from '@orbis/server/src/seed/smart-lists';
import { parseBody } from '@orbis/shared/doc';
import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { expect, test } from 'vitest';
import { browserQuery, buildFilterQuery, firstQueryBlock } from './query';

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
  // Края текста блока сняты — как у запроса, который уходит на сервер.
  expect(firstQueryBlock('{{query:\n  tags=x\n}}')).toBe('tags=x');
});

// --- первый кадр и схема документа согласны про блоки (Р-v2-6, РП-6) ----------------------
// Первый кадр читает тело препроходом (`parsePageText`), редактор строится по `parseBody`.
// Разойдись правила — человек увидит виджет, который через мгновение станет фигурными скобками
// (или наоборот), а блок, которого не было на первом кадре, уйдёт за данными отдельной пачкой.
// Свой регэксп первого кадра (`bodySegments`) снят: блоки знает одна копия правил маркеров.

/** Блоки глазами первого кадра — препроход тела, верхний уровень. */
function blocksOfFrame(body: string): string[] {
  return parsePageText(body).flatMap((n) => (n.kind === 'query' ? [n.text.trim()] : []));
}

/**
 * Блоки тела ГЛАЗАМИ СХЕМЫ документа — то, что построит редактор, на ЛЮБОЙ глубине (блок в
 * пункте списка или цитате — тоже блок). Второй стороной сверки стоит именно она, а не копия
 * правил: копия разъехалась бы с редактором молча.
 */
function blocksFromSchema(body: string): string[] {
  const out: string[] = [];
  const walk = (n: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    // `text` — неразобранный текст блока: `parseBody` реестра не видит и дерева не строит
    // (Р-21-1), поэтому сверка со схемой — сверка ТЕКСТОВ.
    if (n.type === 'queryBlock') out.push(String(n.attrs?.text ?? '').trim());
    for (const c of n.content ?? []) walk(c as typeof n);
  };
  walk(parseBody(body).doc);
  return out;
}

test('первый кадр видит ровно те же блоки, что и схема документа', () => {
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
    '- пункт\n{{query:a=1}}',
    '- {{query:a=1}}',
    // Забор кода: прежний регэксп первого кадра видел здесь блок, а схема — код (расхождение
    // было записано тестом). Препроход знает заборы — расхождения больше нет.
    'вступление\n\n```\n{{query:tags=code}}\n```\n\n{{query: tags=work}}\nхвост',
  ];
  for (const body of bodies) {
    expect([body, blocksOfFrame(body)]).toEqual([body, blocksFromSchema(body)]);
  }
});

/**
 * ИЗВЕСТНОЕ расхождение, записанное тестом, а не подразумеваемое (перенос ревью задач 8 и 17):
 * токенайзер `queryBlock` работает ВНУТРИ markdown-блоков, препроход — только по строкам с
 * колонки 0. Блок с отступом в пункте списка, блок в цитате и второй блок на той же строке
 * редактор видит, а первый кадр — нет. Следствие наблюдаемо и ограничено: на первом кадре такой
 * блок — текст, после подъёма редактора он становится виджетом и уходит за данными отдельной
 * пачкой; блоки, которые видят оба, делят ключ и повторно не запрашиваются. Так же было и при
 * прежнем регэкспе (`^\{\{query:` с флагом `m`). Лечится одной копией правил в задаче 17, а не
 * второй копией регэкспа здесь.
 */
test('первый кадр НЕ видит блок в пункте списка, в цитате и второй блок строки (расхождение)', () => {
  expect(blocksOfFrame('- пункт\n  {{query:a=1}}')).toEqual([]);
  expect(blocksFromSchema('- пункт\n  {{query:a=1}}')).toEqual(['a=1']);
  expect(blocksOfFrame('> {{query:a=1}}')).toEqual([]);
  expect(blocksFromSchema('> {{query:a=1}}')).toEqual(['a=1']);
  expect(blocksOfFrame('{{query:a=1}}{{query:b=2}}')).toEqual(['a=1']);
  expect(blocksFromSchema('{{query:a=1}}{{query:b=2}}')).toEqual(['a=1', 'b=2']);
});

test('firstQueryBlock (бейдж pinned) считает по тому же правилу колонки', () => {
  // §3.2: бейдж — «число результатов ПЕРВОГО query-блока body». Обёртка посреди строки
  // блоком не является ни для первого кадра, ни для схемы — значит и бейджу не считать.
  expect(firstQueryBlock('смотри {{query:a=1}} тут')).toBeNull();
  expect(firstQueryBlock('смотри {{query:a=1}} тут\n{{query:b=2}}')).toBe('b=2');
  // …и обёртка в заборе кода — код, а не блок.
  expect(firstQueryBlock('```\n{{query:a=1}}\n```\n{{query:b=2}}')).toBe('b=2');
  // У всех сидов бейдж прежний: их блоки стоят с колонки 1.
  for (const s of SEED_SMART_LISTS) {
    expect([s.slug, firstQueryBlock(s.body)]).toEqual([s.slug, blocksFromSchema(s.body)[0]]);
    expect(firstQueryBlock(s.body)).not.toBeNull();
  }
  // Daily Planning — три блока, бейдж по первому (Inbox).
  expect(blocksOfFrame(DAILY_PLANNING_BODY)).toHaveLength(3);
  expect(firstQueryBlock(DAILY_PLANNING_BODY)).toBe(blocksOfFrame(DAILY_PLANNING_BODY)[0]);
});
