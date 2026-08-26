/**
 * Разбор текста в канонический Q-AST по реестру (§А5-3).
 *
 * Главное отличие от старого парсера — §А5-3ж: неизвестное имя поля, аспекта или роли
 * это ОТКАЗ С КОДОМ, а не молчаливый ноль результатов (сегодня `aspect=orbis/tsk`
 * проезжает и парсер, и компилятор — `parse.ts:469-478`, `compile.ts:233-235`).
 */
import { expect, test } from 'bun:test';
import { queryAstSchema } from './ast';
import {
  AST_FIXTURES,
  FIXTURE_PARSE_REGISTRY,
  INEXPRESSIBLE_QUERY_TEXTS,
  PRODUCTION_QUERY_STATS,
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

test('опись боевых текстов: вердикт и флаги каждого адреса совпадают с записанным', () => {
  // Опись — рабочее задание Задачам 9b/10c/19/21. Тест падает, когда вердикт разошёлся:
  // либо текст в коде изменили, либо парсер стал разбирать/отвергать иначе.
  for (const entry of PRODUCTION_QUERY_TEXTS) {
    const r = parseQueryAst(entry.text, REG);
    const got = r.ok ? null : r.error.code;
    expect(got, `${entry.where}: «${entry.text}»`).toBe(entry.verdict);
  }

  // Флаги — не на слово: оба пересчитываются ИЗ САМОГО ТЕКСТА.
  const stripQuoted = (text: string): string => text.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const hasUnquotedSpacedValue = (text: string): boolean =>
    stripQuoted(text)
      .split(/[,\n]/)
      .some((chunk) => {
        const op = chunk.search(/[=<>]/);
        return op !== -1 && /\s/.test(chunk.slice(op + 1).trim());
      });
  // `title` — ядро только в позиции сортировки: в позиции фильтра это слово грамматики
  // (параметр заголовка) и переводу не подлежит. `archived=` — тоже слово грамматики.
  const coreNamesOf = (text: string): string[] => {
    const t = stripQuoted(text);
    const found: string[] = [];
    if (/(?:^|[,\s|=])title\s*:/.test(t)) found.push('title');
    for (const name of ['created_at', 'updated_at']) {
      if (new RegExp(`(?:^|[,\\s|=])${name}\\s*(?=[=<>:])`).test(t)) found.push(name);
    }
    return found.sort();
  };
  for (const entry of PRODUCTION_QUERY_TEXTS) {
    expect(hasUnquotedSpacedValue(entry.text), `spaceRisk: ${entry.where}`).toBe(entry.spaceRisk);
    expect([...entry.coreNames].sort(), `coreNames: ${entry.where}`).toEqual(
      coreNamesOf(entry.text),
    );
  }

  // ТОЧНЫЕ числа: правка описи обязана быть видимым движением, а не тихим сдвигом.
  const verdicts = PRODUCTION_QUERY_TEXTS.map((e) => e.verdict);
  expect(PRODUCTION_QUERY_TEXTS.length).toBe(PRODUCTION_QUERY_STATS.total);
  expect(verdicts.filter((v) => v === null).length).toBe(PRODUCTION_QUERY_STATS.parses);
  for (const [code, count] of Object.entries(PRODUCTION_QUERY_STATS.byVerdict)) {
    expect(verdicts.filter((v) => v === code).length, code).toBe(count);
  }
  expect(PRODUCTION_QUERY_TEXTS.filter((e) => e.spaceRisk).length).toBe(
    PRODUCTION_QUERY_STATS.spaceRisk,
  );
  expect(PRODUCTION_QUERY_TEXTS.filter((e) => e.coreNames.length > 0).length).toBe(
    PRODUCTION_QUERY_STATS.coreNames,
  );
  expect(PRODUCTION_QUERY_TEXTS.filter((e) => e.frozen === true).length).toBe(
    PRODUCTION_QUERY_STATS.frozen,
  );
  // Сумма разбивки обязана покрывать опись целиком — иначе новый класс отказа проехал бы
  // мимо чисел, оставив их формально верными.
  const covered =
    PRODUCTION_QUERY_STATS.parses +
    Object.values(PRODUCTION_QUERY_STATS.byVerdict).reduce((a, b) => a + b, 0);
  expect(covered).toBe(PRODUCTION_QUERY_STATS.total);

  // Шесть адресов, которые разбираются уже сегодня, названы поимённо: «разбирается» — это
  // утверждение о КОНКРЕТНЫХ местах, а не число, которое можно подогнать.
  expect(PRODUCTION_QUERY_TEXTS.filter((e) => e.verdict === null).map((e) => e.where)).toEqual([
    'apps/web/src/features/chat/useFastPath.ts:17 (CATEGORY_QUERY)',
    'apps/web/src/features/settings/MemoryScreen.tsx:25 (MEMORY_FILTER)',
    'apps/server/src/tools/registry.ts:846 (описание тула entity_query, пример 1)',
    'apps/server/src/llm/prompts/v4.ts:58 (шпаргалка грамматики, пример 1)',
    'apps/server/src/llm/prompts/routine-v2.ts:83 (шпаргалка грамматики рутин, пример 1)',
    'apps/server/src/llm/prompts/v4.ts:78 (блок целей: «цели — aspect=orbis/goal»)',
  ]);
  // Класс RESERVED: слово грамматики в позиции имени свойства. Такой адрес не чинится
  // таблицей перевода полей аспектов — нужен namespaced key свойства ядра (`orbis/title`).
  const reserved = PRODUCTION_QUERY_TEXTS.filter((e) => e.verdict === 'RESERVED');
  expect(reserved.map((e) => e.where)).toEqual([
    'apps/web/src/features/budget/categories.ts:8 (CATEGORIES_QUERY — 7 потребителей)',
    'apps/web/src/features/budget/EnvelopeCreateSheet.tsx:55 (инлайн-дубль CATEGORIES_QUERY)',
  ]);
  for (const entry of reserved) expect(entry.coreNames, entry.where).toEqual(['title']);
  // Замороженные образцы сверки нельзя переводить на месте — у них отдельный владелец.
  for (const entry of PRODUCTION_QUERY_TEXTS) {
    if (entry.frozen) expect(entry.owner, entry.where).toBe('заморожен');
    else expect(entry.owner, entry.where).not.toBe('заморожен');
  }

  // `dynamic` — это РАБОТА для 10c (текст собирается из ввода, и ломает его подстановка,
  // а не литерал), поэтому поле пиннится поимённо, а не остаётся прозой рядом с таблицей.
  const dyn = PRODUCTION_QUERY_TEXTS.filter((e) => e.dynamic !== undefined);
  expect(dyn.length).toBe(PRODUCTION_QUERY_STATS.dynamic);
  expect(dyn.map((e) => e.where)).toEqual([
    'apps/web/src/features/browser/query.ts:13 (тег владельца с пробелом; buildFilterQuery не квотирует вовсе)',
    'apps/web/src/features/budget/txQuery.ts:66 + quoteValue :45 (поиск с пробелом)',
  ]);
  for (const entry of dyn) {
    // Динамический адрес попал в опись ровно потому, что подстановка ломает разбор:
    // текст-представитель обязан нести уже подставленный ломающий ввод.
    expect(entry.spaceRisk, entry.where).toBe(true);
    // Пометка обязана НАЗЫВАТЬ ломающий ввод, а не отделываться словом «динамический».
    expect(entry.dynamic, entry.where).toContain('пробел');
  }
  // Правило квотирования каждого источника названо адресом: без него 10c не поймёт, почему
  // одна строка txQuery в описи безопасна, а вторая нет.
  expect(dyn[1]?.dynamic).toContain('txQuery.ts:45');
});

test('разбор не рождает дерево, которое канон отвергает: пустое значение — SYNTAX', () => {
  // Канон объявляет `tag`, `search` и `title` непустыми (`min(1)`). Без этого гарда
  // разбор давал бы AST, который сохранился бы в query-блок и перестал читаться на первой
  // же перевалидации схемой — «сохранилось, но не читается» хуже честного отказа.
  for (const text of ['search=""', 'tags=""', 'title=""', 'tags=дом|""', 'tags=""|дом']) {
    const e = err(text);
    expect(e.code, text).toBe('SYNTAX');
    expect(e.message, text).toContain('пустое значение');
  }
  // Обратная сторона: всё, что разбор ВЕРНУЛ, обязано проходить схему канона — на всех
  // фикстурах и на всей описи это и проверяется здесь одним прогоном.
  for (const text of [
    ...AST_FIXTURES.map((f) => f.keyText),
    ...INEXPRESSIBLE_QUERY_TEXTS.map((f) => f.text),
  ]) {
    if (text === null) continue;
    const r = parseQueryAst(text, REG);
    if (!r.ok) continue;
    expect(queryAstSchema.safeParse(r.ast).success, `${text} → ${JSON.stringify(r.ast)}`).toBe(
      true,
    );
  }
});

test('отрицаемый aspect= не разводит неоднозначную подпись (§А5-3ж)', () => {
  // `!aspect=orbis/task` запрос аспект ИСКЛЮЧАЕТ. Резолвить по нему «Статус» значило бы
  // выбрать свойство, носителя которого в выдаче заведомо нет, — молчаливый ноль.
  expect(err('!aspect=orbis/task "статус"=done').code).toBe('AMBIGUOUS_LABEL');
  // Утвердительный аспект разводит по-прежнему.
  expect(ok('aspect=orbis/task "статус"=done').filter).toEqual({
    and: [{ aspect: 'orbis/task' }, { prop: 'user/task_status_alias', op: 'eq', value: 'done' }],
  });
  // Отрицаемый аспект сам по себе разбирается — снят только его вклад в разводку.
  expect(ok('!aspect=orbis/task').filter).toEqual({ not: { aspect: 'orbis/task' } });
});

/**
 * Шестнадцатая точка записи id — `excludeBlocked` (`parse-ast.ts:923`). Мутация `.id`→`.key`
 * на ней НЕДОКАЗАТЕЛЬНА, и это свойство данных, а не дыра в тесте: сахар по смыслу называет
 * КОНКРЕТНУЮ встроенную роль `dependency`, а у всех 11 встроенных ролей `key === id`
 * (`builtin-roles.ts:174` выводит key из id) — различить id и key на ней нечем ничем.
 *
 * Поэтому точка пиннится тем, что на ней РЕАЛЬНО может сломаться: резолвится ли роль по
 * реестру вообще. Литерал в дереве прошёл бы и через реестр без этой роли — и запрос
 * сослался бы на несуществующую роль молча, ровно против §А5-3ж.
 */
test('excludeBlocked резолвит роль по реестру, а не подставляет литерал', () => {
  // На полном реестре сахар тождествен явной записи — включая id роли в дереве.
  const sugar = ok('excludeBlocked=true');
  const explicit = ok('!has_relation via=dependency');
  expect(sugar.filter).toEqual(explicit.filter);
  const role = REG.roles.get('dependency');
  if (!role) throw new Error('роль dependency обязана быть в фикстурном реестре');
  expect(sugar.filter).toEqual({ not: { rel: { kind: 'has_relation', via: role.id } } });

  // Реестр без этой роли: резолвер обязан отказать так же, как на явной записи.
  const roles = new Map(REG.roles);
  roles.delete('dependency');
  const without: typeof REG = { ...REG, roles };
  for (const text of ['excludeBlocked=true', '!has_relation via=dependency']) {
    const r = parseQueryAst(text, without);
    expect(r.ok, `${text} разобрался без роли в реестре`).toBe(false);
    if (!r.ok) expect(r.error.code, text).toBe('UNKNOWN_ROLE');
  }
});
