/**
 * Разбор текста в канонический Q-AST по реестру (§А5-3).
 *
 * Главное отличие от старого парсера — §А5-3ж: неизвестное имя поля, аспекта или роли
 * это ОТКАЗ С КОДОМ, а не молчаливый ноль результатов (сегодня `aspect=orbis/tsk`
 * проезжает и парсер, и компилятор — `parse.ts:469-478`, `compile.ts:233-235`).
 */
import { expect, test } from 'bun:test';
import {
  FIXTURE_PARSE_REGISTRY,
  INEXPRESSIBLE_QUERY_TEXTS,
  PRODUCTION_QUERY_TEXTS,
} from './ast-fixtures';
import { buildCatalogFromRegistry } from './catalog';
import { parseQueryAst, QUERY_PARSE_CODES } from './parse-ast';
import { printQueryAst } from './print';

const REG = FIXTURE_PARSE_REGISTRY;

function ok(text: string) {
  const r = parseQueryAst(text, REG);
  if (!r.ok) throw new Error(`ожидался разбор, получен отказ ${r.error.code}: ${r.error.message}`);
  return r.ast;
}

function err(text: string) {
  const r = parseQueryAst(text, REG);
  if (r.ok) throw new Error(`ожидался отказ, получен разбор: ${JSON.stringify(r.ast)}`);
  return r.error;
}

test('дерево and/not/or, включающий range из `<=` и обратимая печать key-формы', () => {
  const text =
    'aspect=orbis/task orbis/task_status=!done&!cancelled orbis/due_date<=today sortBy=orbis/priority:desc limit=20';
  const ast = ok(text);
  expect(ast).toEqual({
    filter: {
      and: [
        { aspect: 'orbis/task' },
        {
          not: {
            or: [
              { prop: 'orbis/task_status', op: 'eq', value: 'done' },
              { prop: 'orbis/task_status', op: 'eq', value: 'cancelled' },
            ],
          },
        },
        { prop: 'orbis/due_date', op: 'range', value: { to: { token: 'today' } } },
      ],
    },
    sortBy: [{ field: 'orbis/priority', dir: 'desc' }],
    limit: 20,
  });
  // `<=` — ВКЛЮЧАЮЩАЯ граница: отдельных `gte`/`lte` в каноне нет (находка 8).
  const printed = printQueryAst(ast, REG, 'key');
  expect(printed).toBe(
    'aspect=orbis/task, orbis/task_status=!done&!cancelled, orbis/due_date<=today, sortBy=orbis/priority:desc, limit=20',
  );
  expect(ok(printed)).toEqual(ast);
});

test('label-форма: закавыченное имя — всегда поле; неоднозначность лечится aspect=', () => {
  expect(ok('"срок"<=today').filter).toEqual({
    prop: 'orbis/due_date',
    op: 'range',
    value: { to: { token: 'today' } },
  });
  // Две записи словаря с одной подписью «Статус» — на orbis/task и на orbis/project.
  const ambiguous = err('"статус"=done');
  expect(ambiguous.code).toBe('AMBIGUOUS_LABEL');
  expect(ambiguous.message).toContain('aspect=');
  expect(ok('aspect=orbis/task "статус"=done').filter).toEqual({
    and: [{ aspect: 'orbis/task' }, { prop: 'user/task_status_alias', op: 'eq', value: 'done' }],
  });
  // Аспект принимается и по key, и по label (§А5-3в).
  expect(ok('aspect="Задача"').filter).toEqual({ aspect: 'orbis/task' });
});

test('has= и отрицание реляционного предиката с via=', () => {
  expect(ok('has=orbis/recurrence').filter).toEqual({ has: 'orbis/recurrence' });
  expect(ok('!has_children via=subitem').filter).toEqual({
    not: { rel: { kind: 'has_children', via: 'subitem' } },
  });
  expect(ok('has_children').filter).toEqual({ rel: { kind: 'has_children' } });
  // excludeBlocked остаётся сахаром сегодняшней формы (набор closed приедет с Б-1).
  expect(ok('excludeBlocked=true').filter).toEqual({
    not: { rel: { kind: 'has_relation', via: 'dependency' } },
  });
});

test('невыразимое — отказ с кодом, опечатка аспекта — UNKNOWN_ASPECT (§А5-3ж)', () => {
  expect(err('descendants_of=this').code).toBe('QUERY_MULTI_ROLE');
  expect(err('ancestors_of=this').code).toBe('QUERY_MULTI_ROLE');
  expect(ok('descendants_of=this via=subitem').filter).toEqual({
    rel: { kind: 'descendants_of', via: 'subitem', of: 'this' },
  });
  // Соединение двух свободных сущностей — за границей Q (паспорт Q, §А5-1).
  expect(err('children_of=aspect=orbis/project').code).toBe('QUERY_JOIN');
  expect(err('aspect=orbis/tsk').code).toBe('UNKNOWN_ASPECT');
  expect(err('orbis/task_statuz=done').code).toBe('UNKNOWN_FIELD');
  expect(err('!has_children via=subitm').code).toBe('UNKNOWN_ROLE');
  expect(err('orbis/task_status=готово').code).toBe('TYPE');
  expect(err('class=orbis/completable:done').code).toBe('CLASS_NOT_AVAILABLE');
  expect(err('archived>1').code).toBe('RESERVED');
});

test('buildCatalogFromRegistry: тип поля из PropertyType, эвристики propType нет', () => {
  const catalog = buildCatalogFromRegistry(REG);
  // `orbis/run_bucket` — kind text с паттерном, в котором есть `T…:`; старая эвристика
  // ловила timestamp по тексту регэкспа (`catalog.ts:177`), новая берёт тип из реестра.
  expect(catalog.fields['orbis/run_bucket']).toEqual([
    { aspect: 'orbis/agent-run', type: 'string' },
  ]);
  // Ловушка: паттерн специально написан так, что propType назвал бы поле timestamp.
  expect(catalog.fields['user/timestamp_trap']?.[0]?.type).toBe('string');
  expect(catalog.fields['orbis/limit']?.[0]?.type).toBe('decimal');
  expect(catalog.fields['orbis/aliases']?.[0]?.type).toBe('array');
  expect(catalog.fields['orbis/recurrence']?.[0]?.type).toBe('unfilterable');
  expect(catalog.fields['orbis/task_status']?.[0]?.enumValues).toEqual([
    'inbox',
    'planned',
    'in_progress',
    'waiting',
    'done',
    'cancelled',
  ]);
  // Ключ каталога — id свойства: именно его несёт узел `{prop: <id>}` (§А5-7).
  expect(Object.hasOwn(catalog.fields, 'task_status')).toBe(false);
});

test('фикстуры невыразимого: каждая даёт ОТКАЗ С КОДОМ, а не пустой список (§С8-3)', () => {
  expect(INEXPRESSIBLE_QUERY_TEXTS.length).toBeGreaterThanOrEqual(12);
  const seen = new Set<string>();
  for (const fixture of INEXPRESSIBLE_QUERY_TEXTS) {
    const r = parseQueryAst(fixture.text, REG);
    expect(r.ok, `«${fixture.text}» разобрался, хотя не должен`).toBe(false);
    if (r.ok) continue;
    expect(r.error.code, fixture.text).toBe(fixture.code);
    // Позиция обязательна: плашка ошибки блока показывает её человеку (§6.4).
    expect(typeof r.error.position, fixture.text).toBe('number');
    seen.add(fixture.code);
  }
  // Набор покрывает ВСЕ коды отказа разбора — иначе класс отказа остался бы без фикстуры.
  expect([...seen].sort()).toEqual([...QUERY_PARSE_CODES].sort());
});

test('AMBIGUOUS_LABEL у аспектов и ролей, а не только у свойств', () => {
  // Во встроенных наборах все подписи различны, поэтому в фикстурном реестре заведены
  // двойники: аспект `user/note_alias` («Заметка») и роль `user/mention_alias`
  // («Упоминание»). Без них «взять первый попавшийся» прошло бы незамеченным.
  const aspect = err('aspect="Заметка"');
  expect(aspect.code).toBe('AMBIGUOUS_LABEL');
  expect(aspect.message).toContain('Заметка');
  const role = err('!has_children via="Упоминание"');
  expect(role.code).toBe('AMBIGUOUS_LABEL');
  // Однозначные подписи по-прежнему резолвятся.
  expect(ok('aspect="Задача"').filter).toEqual({ aspect: 'orbis/task' });
  expect(ok('!has_children via="Подпункт"').filter).toEqual({
    not: { rel: { kind: 'has_children', via: 'subitem' } },
  });
});

test('значение с пробелом: отказ называет причину и подсказывает кавычки (§6.4)', () => {
  // Это НЕ теоретический случай: сегодняшний `serialize.ts:158` печатает такие значения
  // без кавычек, и все три формы лежат в боевых текстах (см. PRODUCTION_QUERY_TEXTS).
  for (const text of ['title=Мои задачи', 'tags=дом дача', 'search=hello world']) {
    const e = err(text);
    expect(e.code, text).toBe('SYNTAX');
    expect(e.message, text).toContain('кавычки');
  }
  // Закавыченное значение проходит — и это ровно то, что должен сделать перевод.
  expect(ok('title="Мои задачи"').title).toBe('Мои задачи');
  expect(ok('tags="дом дача"').filter).toEqual({ tag: 'дом дача' });
  expect(ok('search="hello world"').filter).toEqual({ search: 'hello world' });
});

test('опись боевых текстов: вердикт разбора каждого совпадает с записанным', () => {
  // Опись — рабочее задание Задачам 9b/10c/21. Тест падает, когда вердикт разошёлся:
  // либо текст в коде изменили, либо парсер стал разбирать/отвергать иначе.
  expect(PRODUCTION_QUERY_TEXTS.length).toBeGreaterThanOrEqual(20);
  for (const entry of PRODUCTION_QUERY_TEXTS) {
    const r = parseQueryAst(entry.text, REG);
    const got = r.ok ? null : r.error.code;
    expect(got, `${entry.where}: «${entry.text}»`).toBe(entry.verdict);
  }
  // Класс «пробел в незакавыченном значении» — тот, что НЕ чинится переименованием полей
  // (у большинства текстов первым падает имя поля, и пробел всплыл бы уже ПОСЛЕ перевода).
  // Флаг не на слово: он пересчитывается прямо здесь из самого текста.
  const hasUnquotedSpacedValue = (text: string): boolean =>
    text
      // Закавыченные куски заменяем пустыми кавычками: внутри них пробел законен.
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .split(/[,\n]/)
      .some((chunk) => {
        const op = chunk.search(/[=<>]/);
        return op !== -1 && /\s/.test(chunk.slice(op + 1).trim());
      });
  for (const entry of PRODUCTION_QUERY_TEXTS) {
    expect(hasUnquotedSpacedValue(entry.text), entry.where).toBe(entry.spaceRisk);
  }
  expect(PRODUCTION_QUERY_TEXTS.filter((e) => e.spaceRisk).length).toBe(8);
  // Ни один боевой текст сегодня новым парсером не читается, кроме одного вырожденного.
  const parses = PRODUCTION_QUERY_TEXTS.filter((e) => e.verdict === null).map((e) => e.text);
  expect(parses).toEqual(['aspect=orbis/memory']);
});
