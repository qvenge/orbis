/**
 * Разбор текста в канонический Q-AST по реестру (§А5-3).
 *
 * Главное отличие от старого парсера — §А5-3ж: неизвестное имя поля, аспекта или роли
 * это ОТКАЗ С КОДОМ, а не молчаливый ноль результатов (сегодня `aspect=orbis/tsk`
 * проезжал и парсер, и старый компилятор — `parse.ts:469-478`, `compile.ts:233-235`;
 * второй снят Задачей 9b, адрес по git-истории).
 */
import { expect, test } from 'bun:test';
import { propertyDefinitionSchema } from '../registry/property-type';
import {
  PAGE_ONLY_HINT,
  PROJECTION_RULE_MESSAGES,
  pageQueryAstSchema,
  queryAstSchema,
} from './ast';
import {
  AST_FIXTURES,
  FIXTURE_PARSE_REGISTRY,
  FIXTURE_USER_CONTRACT_ID,
  FIXTURE_USER_PROPERTY_ID,
  INEXPRESSIBLE_QUERY_TEXTS,
  PRODUCTION_QUERY_STATS,
  PRODUCTION_QUERY_TEXTS,
} from './ast-fixtures';
import { buildCatalogFromRegistry } from './catalog';
import {
  maskQuotedValues,
  type ParseRegistry,
  parseQueryAst,
  QUERY_PARSE_CODES,
} from './parse-ast';
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

// Календарь на пути РАЗБОРА (Р-9b-5): форму даёт регексп парсера, существование дня —
// общий `hasValidCalendar` из `date.ts`. Без этой проверки `orbis/due_date=2026-02-30`
// разобрался бы в дерево и упал бы уже в Postgres (22008) — то есть кодом ошибки вместо
// отказа с именем свойства и позицией.
test('несуществующий календарный день — TYPE с позицией, а не дерево', () => {
  for (const text of ['orbis/due_date=2026-02-30', 'orbis/due_date=2026-13-01']) {
    const e = parseQueryAst(text, REG);
    expect(e.ok ? 'разобралось' : `${e.error.code}`).toBe('TYPE');
  }
  const e = err('orbis/start_at=2026-02-30T09:00:00Z');
  expect(e.code).toBe('TYPE');
  expect(e.position).toBeGreaterThan(0);
  // Нулевого года не бывает — Postgres отвечает на него тем же 22008 (I-5 гейта).
  expect(err('orbis/due_date=0000-01-01').code).toBe('TYPE');
  expect(err('orbis/start_at=0000-06-15T12:00:00Z').code).toBe('TYPE');
  // У момента «существует» — это и время суток, и смещение зоны (I-1 предфильтра).
  expect(err('orbis/start_at=2026-08-27T25:00:00Z').code).toBe('TYPE');
  expect(err('orbis/start_at=2026-08-27T12:00:00+23:00').code).toBe('TYPE');
  expect(ok('orbis/start_at=2026-08-27T23:59:59+15:59')).toEqual({
    filter: { prop: 'orbis/start_at', op: 'eq', value: '2026-08-27T23:59:59+15:59' },
  });
  // Високосный контроль: проверка обязана быть календарём, а не «в феврале всегда 28».
  expect(ok('orbis/due_date=2028-02-29')).toEqual({
    filter: { prop: 'orbis/due_date', op: 'eq', value: '2028-02-29' },
  });
  expect(err('orbis/due_date=2029-02-29').code).toBe('TYPE');
});

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
  // `excludeBlocked` — сахар ПОЛНОЙ сегодняшней формы: ребро роли `dependency` ПЛЮС
  // набор завершаемости блокирующей работы. Без второго условия «отпущенный» блокер
  // (задача в done) начал бы прятать работу, то есть реформа поменяла бы наблюдаемое
  // поведение.
  expect(ok('excludeBlocked=true').filter).toEqual({
    not: {
      rel: {
        kind: 'has_relation',
        via: 'dependency',
        sourceNotIn: { contract: 'orbis/completable', set: 'closed' },
      },
    },
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
  expect(err('class=orbis/completable:done').code).toBe('UNKNOWN_SET');
  expect(err('archived>1').code).toBe('RESERVED');
});

test('class=<контракт>:<набор> — предикат членства, а не отказ части Б', () => {
  expect(ok('class=orbis/completable:closed').filter).toEqual({
    class: { contract: 'orbis/completable', set: 'closed' },
  });
  // Отрицание — общей механикой ведущего `!`, своей ветки у него нет.
  expect(ok('!class=orbis/completable:closed').filter).toEqual({
    not: { class: { contract: 'orbis/completable', set: 'closed' } },
  });
  // key СВОЕГО контракта резолвится в uuid — §А5-2 «в дереве лежат id».
  expect(ok('class=user/reviewable:live').filter).toEqual({
    class: { contract: FIXTURE_USER_CONTRACT_ID, set: 'live' },
  });
  // §С8-3: обе половины адреса проверяются реестром, а не грамматикой.
  expect(err('class=orbis/completeable:closed').code).toBe('UNKNOWN_CONTRACT');
  expect(err('class=orbis/completable:done').code).toBe('UNKNOWN_SET'); // `done` — КЛАСС, не набор
  expect(err('class=orbis/completable').code).toBe('SYNTAX');
  expect(err('class=orbis/sensitivity:touches_money').code).toBe('UNKNOWN_SET'); // facts-контракт наборов не имеет
});

test('excludeBlocked=true — ребро dependency плюс НЕчленство источника в наборе closed', () => {
  expect(ok('excludeBlocked=true').filter).toEqual({
    not: {
      rel: {
        kind: 'has_relation',
        via: 'dependency',
        sourceNotIn: { contract: 'orbis/completable', set: 'closed' },
      },
    },
  });
  // Пользовательская запись о состоянии не спрашивает — деревья РАЗНЫЕ (два намерения).
  expect(ok('!has_relation=dependency').filter).toEqual({
    not: { rel: { kind: 'has_relation', via: 'dependency' } },
  });
});

test('buildCatalogFromRegistry: тип поля из PropertyType, эвристики propType нет', () => {
  const catalog = buildCatalogFromRegistry(REG);
  // `orbis/run_bucket` — kind text с паттерном, в котором есть `T…:`; старая эвристика
  // ловила timestamp по тексту регэкспа (`catalog.ts:177`), новая берёт тип из реестра.
  expect(catalog.fields['orbis/run_bucket']).toEqual([
    { aspect: 'orbis/agent-run', type: 'string', kind: 'text' },
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

  // ПОРЯДОК У `time` НЕ ТЕРЯЕТСЯ. `FieldType` такого члена не знает, и по полю `type`
  // свойство выглядит обычной строкой — читатель, поверивший ему, отобрал бы у времени
  // `>`/`<`/диапазон, которые парсер как раз разрешает (`isOrdered`). Правду несёт `kind`,
  // и он приходит из реестра дословно.
  expect(catalog.fields['orbis/routine_at']?.[0]?.type).toBe('string');
  expect(catalog.fields['orbis/routine_at']?.[0]?.kind).toBe('time');
  // Тот же разрыв на `select`, `ref` и `grant` — все трое «строки» по `type` и различимы
  // по `kind`; без него конструктор запросов (Задачи 10/13) не отличит их друг от друга.
  expect(catalog.fields['orbis/task_status']?.[0]?.kind).toBe('select');
  expect(catalog.fields['orbis/finance_category']?.[0]?.kind).toBe('ref');
  // И это не выборочная удача: у КАЖДОЙ записи каталога `kind` есть и совпадает с реестром.
  // Проверка идёт от реестра к каталогу — свойство, потерявшее `kind`, обязано краснеть,
  // а не прятаться за тем, что его не назвали поимённо выше.
  for (const [id, def] of REG.properties) {
    expect(catalog.fields[id]?.[0]?.kind, id).toBe(def.type.kind);
  }
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

  // Адреса, которые разбираются каноном, названы ПОИМЁННО: «разбирается» — это утверждение
  // о КОНКРЕТНЫХ местах, а не число, которое можно подогнать. Пятнадцать из них — тела сидов
  // и заготовка проекта, переведённые Задачей 21b: до неё они все были `UNKNOWN_FIELD`.
  expect(PRODUCTION_QUERY_TEXTS.filter((e) => e.verdict === null).map((e) => e.where)).toEqual([
    'apps/web/src/features/chat/useFastPath.ts:17 (CATEGORY_QUERY)',
    'apps/web/src/features/settings/MemoryScreen.tsx:25 (MEMORY_FILTER)',
    'packages/shared/src/supply/lists.ts:36 (daily-planning, блок 1 «Inbox»)',
    'packages/shared/src/supply/lists.ts:38 (daily-planning, блок 2 «Сегодня»)',
    'packages/shared/src/supply/lists.ts:40 (daily-planning, блок 3 «Ожидание»)',
    'packages/shared/src/supply/lists.ts:44 (upcoming, блок 1 «Ближайшие 7 дней»)',
    'packages/shared/src/supply/lists.ts:46 (upcoming, блок 2 «Позже»)',
    'packages/shared/src/supply/lists.ts:48 (all-tasks)',
    'packages/shared/src/supply/lists.ts:79 (horizon-year «Цели»)',
    'packages/shared/src/supply/lists.ts:89 (horizon-life)',
    'packages/shared/src/supply/lists.ts:134 (routines, блок 1 «Ждут ответа»)',
    'packages/shared/src/supply/lists.ts:136 (routines, блок 2 «Активные рутины»)',
    'packages/shared/src/supply/lists.ts:130 (ROUTINES_BATCH_QUERY, блок 3 «Пачка решений»)',
    'apps/server/src/seed/project-body.ts:39 (тело проекта, блок «В работе»)',
    'apps/server/src/seed/project-body.ts:43 (тело проекта, блок «Ждут меня»)',
    'apps/server/src/seed/project-body.ts:47 (тело проекта, блок «Бэклог»)',
    'apps/server/src/seed/project-body.ts:51 (тело проекта, блок «Последние прогоны»)',
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
test('excludeBlocked резолвит роль и контракт по реестру, а не подставляет литералы', () => {
  const sugar = ok('excludeBlocked=true');
  const explicit = ok('!has_relation via=dependency');
  const role = REG.roles.get('dependency');
  const completable = REG.contracts.get('orbis/completable');
  if (!role || !completable) throw new Error('роль и контракт обязаны быть в фикстурном реестре');
  expect(sugar.filter).toEqual({
    not: {
      rel: {
        kind: 'has_relation',
        via: role.id,
        sourceNotIn: { contract: completable.id, set: 'closed' },
      },
    },
  });

  // САХАР И ЯВНАЯ ЗАПИСЬ — РАЗНЫЕ ДЕРЕВЬЯ, и это норматив, а не побочный эффект.
  // `excludeBlocked=true` значит «не заблокировано ЖИВОЙ работой», `!has_relation
  // via=dependency` — «нет входящих рёбер этой роли». Слей мы их, условие состояния
  // повисло бы на пользовательском запросе, который о состоянии не спрашивал.
  expect(explicit.filter).toEqual({ not: { rel: { kind: 'has_relation', via: role.id } } });
  expect(sugar.filter).not.toEqual(explicit.filter);

  // Реестр без роли: резолвер обязан отказать так же, как на явной записи.
  const roles = new Map(REG.roles);
  roles.delete('dependency');
  for (const text of ['excludeBlocked=true', '!has_relation via=dependency']) {
    const r = parseQueryAst(text, { ...REG, roles });
    expect(r.ok, `${text} разобрался без роли в реестре`).toBe(false);
    if (!r.ok) expect(r.error.code, text).toBe('UNKNOWN_ROLE');
  }

  // Реестр без КОНТРАКТА: сахару неоткуда взять набор «closed» — отказ, а не молчаливая
  // ссылка на несуществующий контракт (§А5-3ж).
  const contracts = new Map(REG.contracts);
  contracts.delete('orbis/completable');
  const noContract = parseQueryAst('excludeBlocked=true', { ...REG, contracts });
  expect(noContract.ok).toBe(false);
  if (!noContract.ok) expect(noContract.error.code).toBe('UNKNOWN_CONTRACT');

  // Контракт есть, а набора `closed` у него нет: отказ обязан назвать ВТОРУЮ причину, а не
  // ту же — иначе «набор переименовали» читалось бы как «контракт удалили».
  const noSet = new Map(REG.contracts);
  if (completable.kind !== 'slots') throw new Error('completable обязан быть контрактом слотов');
  noSet.set('orbis/completable', { ...completable, sets: { open: ['active'] } });
  const r = parseQueryAst('excludeBlocked=true', { ...REG, contracts: noSet });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe('UNKNOWN_SET');
});

// ─────────────────── maskQuotedValues: примитив для НЕразобранного текста ───────────────────

/**
 * Прямой тест примитива в СВОЁМ пакете. До него `maskQuotedValues` был покрыт только через
 * двух серверных потребителей (признак бэкфилла D42 и перенос имени при слиянии) — то есть
 * сторожа экспорта пакета жили в чужом воркспейсе и уехали бы вместе с потребителем.
 *
 * Контракт целиком: длина сохраняется, содержимое кавычек глушится, всё остальное — включая
 * сами кавычки, `=` и разделители — видно как было.
 */
test('maskQuotedValues: длина сохраняется, содержимое кавычек глушится, разделители видны', () => {
  const M = '\u0001';
  // 1. Длина — построчно на каждом входе: по маске ИЩУТ, а правят оригинал по тем же
  //    индексам, и сдвиг на один символ испортил бы чужой текст молча.
  for (const t of [
    'aspect=orbis/task, title="Ждут ответа"',
    'title="a\\"b", tags=x',
    'search="незакрытая',
    '',
    'без кавычек вовсе',
  ]) {
    expect([t, maskQuotedValues(t).length]).toEqual([t, t.length]);
  }

  // 2. Глушится СОДЕРЖИМОЕ, а сами кавычки остаются видимыми — по ним читатель понимает,
  //    что тут было значение.
  expect(maskQuotedValues('title="Ждут ответа", tags=x')).toBe(
    `title=${M.repeat('"Ждут ответа"'.length)}, tags=x`,
  );

  // 3. Разделители и оператор ВНЕ кавычек не тронуты — на них стоит весь поиск имён поля.
  expect(maskQuotedValues('a=1, b=2|3 c>4')).toBe('a=1, b=2|3 c>4');

  // 4. `=` ВНУТРИ кавычек заглушен — ровно то, ради чего примитив и заведён: имя в подписи
  //    не должно выглядеть адресом (`title="про undecided=да"`).
  expect(maskQuotedValues('title="про undecided=да"')).not.toContain('=да');
  expect(maskQuotedValues('title="про undecided=да"').startsWith('title=')).toBe(true);

  // 5. Экранированная кавычка кавычку НЕ закрывает: иначе хвост значения снова стал бы
  //    «видимым», и имя внутри него — адресом.
  expect(maskQuotedValues('t="a\\"b=c", d=1')).toBe(`t=${M.repeat('"a\\"b=c"'.length)}, d=1`);

  // 6. Незакрытая кавычка — не отказ: у НЕразобранного текста она вероятна, и «всё после неё
  //    значение» безопаснее исключения (глушить лишнее — значит не переписать, а не испортить).
  expect(maskQuotedValues('a=1, b="хвост')).toBe(`a=1, b=${M.repeat('"хвост'.length)}`);
});

// ─────────────── Проекция блока данных (спека страниц §5.4, формы РП-4 / Э-2) ───────────────

test('§5.4: четыре примера спеки в формах РП-4 разбираются в ожидаемые деревья', () => {
  expect(ok('aspect=orbis/task, display=list')).toEqual({
    filter: { aspect: 'orbis/task' },
    display: 'list',
  });
  expect(
    ok('aspect=orbis/task, display=table, columns=orbis/due_date|orbis/priority, hide_empty'),
  ).toEqual({
    filter: { aspect: 'orbis/task' },
    display: 'table',
    columns: [{ field: 'orbis/due_date' }, { field: 'orbis/priority' }],
    hideEmpty: true,
  });
  expect(
    ok('aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount, title="Потрачено"'),
  ).toEqual({
    filter: { aspect: 'orbis/financial' },
    display: 'tile',
    aggregate: { fn: 'sum', field: 'orbis/amount' },
    title: 'Потрачено',
  });
  // `orbis/weight` спеки в реестре НЕТ (§А8: свойство без потребителя не сеется) — пример
  // взят на живом числовом свойстве той же роли, «последнее измерение».
  expect(
    ok('aspect=orbis/goal, display=tile, aggregate=latest:orbis/current_value, title="Вес"'),
  ).toEqual({
    filter: { aspect: 'orbis/goal' },
    display: 'tile',
    aggregate: { fn: 'latest', field: 'orbis/current_value' },
    title: 'Вес',
  });
  expect(ok('aspect=orbis/task, display=tile, aggregate=count')).toEqual({
    filter: { aspect: 'orbis/task' },
    display: 'tile',
    aggregate: { fn: 'count' },
  });
  // Согласованность проверяется ПОСЛЕ всех ключей: порядок слов в тексте не важен.
  expect(ok('aggregate=count, display=tile')).toEqual({
    filter: null,
    display: 'tile',
    aggregate: { fn: 'count' },
  });
  expect(ok('columns=orbis/due_date, display=table')).toEqual({
    filter: null,
    display: 'table',
    columns: [{ field: 'orbis/due_date' }],
  });
  // `hide_empty` не привязан к форме показа: прятать пустое можно у любой.
  expect(ok('hide_empty')).toEqual({ filter: null, hideEmpty: true });
});

test('§5.4: в дерево проекции пишется id свойства, а не key (§А5-2)', () => {
  const P = FIXTURE_USER_PROPERTY_ID; // number, key `user/effort_points`
  expect(ok('display=tile, aggregate=sum:user/effort_points').aggregate).toEqual({
    fn: 'sum',
    field: P,
  });
  expect(ok('display=table, columns=user/effort_points|orbis/priority').columns).toEqual([
    { field: P },
    { field: 'orbis/priority' },
  ]);
  // Подпись резолвится тем же путём, что у sortBy (§А5-3б).
  expect(ok('display=tile, aggregate=latest:"Баллы усилия"').aggregate).toEqual({
    fn: 'latest',
    field: P,
  });
});

test('§5.4: согласованность проекции — отказ SYNTAX, а не молча принятое дерево', () => {
  const noTile = err('aspect=orbis/task, aggregate=count');
  expect(noTile.code).toBe('SYNTAX');
  expect(noTile.message).toContain('aggregate — только у display=tile');
  expect(noTile.position).toBe('aspect=orbis/task, '.length);
  expect(err('aspect=orbis/task, display=list, aggregate=count').message).toContain(
    'aggregate — только у display=tile',
  );

  const tileAlone = err('aspect=orbis/task, display=tile');
  expect(tileAlone.code).toBe('SYNTAX');
  expect(tileAlone.message).toContain('display=tile требует aggregate');
  expect(tileAlone.position).toBe('aspect=orbis/task, '.length);

  const cols = err('aspect=orbis/task, columns=orbis/due_date');
  expect(cols.code).toBe('SYNTAX');
  expect(cols.message).toContain('columns — только у display=table');
  expect(err('aspect=orbis/task, display=list, columns=orbis/due_date').code).toBe('SYNTAX');
});

test('§5.4: aggregate=sum|latest — только число (как numericRef сервера), TYPE с позицией', () => {
  const text = 'display=tile, aggregate=sum:orbis/title';
  const e = err(text);
  expect(e.code).toBe('TYPE');
  expect(e.position).toBe(text.indexOf('orbis/title'));
  // Не число — отказ и у latest.
  expect(err('display=tile, aggregate=latest:orbis/due_date').code).toBe('TYPE');
  // Список — отказ, и именно ПО ПРИЗНАКУ СПИСКА: у числового списка тип элемента годится,
  // но одного значения на строку нет (сервер отвечает на такое тем же `FIELD`).
  expect(err('display=tile, aggregate=sum:user/labels').code).toBe('TYPE');
  const numericList = propertyDefinitionSchema.parse({
    id: 'user/scores',
    key: 'user/scores',
    label: { ru: 'Оценки', en: 'Scores' },
    description: { ru: 'Числовой список', en: 'A numeric list' },
    type: { kind: 'number', cardinality: 'many', maxItems: 5 },
    rank: 1100,
    graphId: null,
    status: 'active',
    module: null,
  });
  const withList: ParseRegistry = {
    ...REG,
    properties: new Map([...REG.properties, [numericList.id, numericList]]),
  };
  const listed = parseQueryAst('display=tile, aggregate=latest:user/scores', withList);
  expect(listed.ok ? 'разобралось' : listed.error.code).toBe('TYPE');
  // Core-проекция — отказ даже числовая: сервер берёт core-колонку мимо `props`, и `sum`
  // по ней `numericRef` не компилирует. Числовой core во встроенном словаре нет, поэтому
  // запись синтетическая — иначе ветку нечем было бы проверить.
  const coreNumber = propertyDefinitionSchema.parse({
    ...numericList,
    id: 'user/core_number',
    key: 'user/core_number',
    type: { kind: 'number' },
    storage: 'core',
  });
  const withCore: ParseRegistry = {
    ...REG,
    properties: new Map([...REG.properties, [coreNumber.id, coreNumber]]),
  };
  const core = parseQueryAst('display=tile, aggregate=sum:user/core_number', withCore);
  expect(core.ok ? 'разобралось' : core.error.code).toBe('TYPE');
  // decimal и number принимаются оба.
  expect(ok('display=tile, aggregate=sum:orbis/amount').aggregate).toEqual({
    fn: 'sum',
    field: 'orbis/amount',
  });
  expect(ok('display=tile, aggregate=sum:orbis/duration_min').aggregate).toEqual({
    fn: 'sum',
    field: 'orbis/duration_min',
  });
  // Неизвестное имя — тот же отказ, что у любого поля.
  expect(err('display=tile, aggregate=sum:orbis/nope').code).toBe('UNKNOWN_FIELD');
});

test('§5.4: формы aggregate — count без свойства, sum/latest со свойством, иначе SYNTAX', () => {
  expect(err('display=tile, aggregate=sum').code).toBe('SYNTAX');
  expect(err('display=tile, aggregate=latest:').code).toBe('SYNTAX');
  expect(err('display=tile, aggregate=count:orbis/amount').code).toBe('SYNTAX');
  expect(err('display=tile, aggregate=avg:orbis/amount').code).toBe('SYNTAX');
  expect(err('display=tile, aggregate=avg').code).toBe('SYNTAX');
  // Скобочная форма спеки — отказ про скобки (Ф-1а-8): скобки — знак печати невыразимого.
  const paren = err('display=tile, aggregate=sum(orbis/amount)');
  expect(paren.code).toBe('SYNTAX');
  expect(paren.message).toContain('скобок');
});

test('§5.4: повтор и отрицание ключей проекции — SYNTAX', () => {
  const twice = err('hide_empty, hide_empty');
  expect(twice.code).toBe('SYNTAX');
  expect(twice.message).toContain("повторный параметр 'hide_empty'");
  expect(err('display=tile, aggregate=count, aggregate=count').code).toBe('SYNTAX');
  expect(err('display=table, columns=orbis/due_date, columns=orbis/priority').code).toBe('SYNTAX');
  expect(err('!hide_empty').code).toBe('SYNTAX');
  expect(err('display=tile, !aggregate=count').code).toBe('SYNTAX');
  expect(err('display=table, !columns=orbis/due_date').code).toBe('SYNTAX');
  // Флаг — голое слово: второй записи того же смысла грамматика не заводит.
  expect(err('hide_empty=true').code).toBe('SYNTAX');
});

test('§5.4 / Э-2: columns=[a, b] — отказ с подсказкой «списки через |»', () => {
  const e = err('aspect=orbis/task, display=table, columns=[orbis/due_date, orbis/priority]');
  expect(e.code).toBe('SYNTAX');
  expect(e.message).toContain('списки через |');
  expect(err('display=table, columns=orbis/due_date|').code).toBe('SYNTAX');
  expect(err('display=table, columns=orbis/nope').code).toBe('UNKNOWN_FIELD');
});

test('§5.4: новые слова грамматики зарезервированы — голое имя поля не резолвится', () => {
  for (const word of ['aggregate', 'columns', 'hide_empty']) {
    expect(err(`has=${word}`).code, word).toBe('RESERVED');
  }
});

test('§5.4: разобранное дерево проекции проходит собственную схему канона', () => {
  for (const text of [
    'aspect=orbis/task, display=table, columns=orbis/due_date|orbis/priority, hide_empty',
    'aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount, title="Потрачено"',
    'display=tile, aggregate=count',
  ]) {
    expect(queryAstSchema.safeParse(ok(text)).success, text).toBe(true);
  }
});

// ─────────────── Язык контрактов (спека 1в §3.1–§3.3): адрес слота и значение ───────────────

test('1в §3.1: адрес слота `<контракт>.<слот>` — поле объединением типов, контракт — id', () => {
  expect(ok('orbis/when.deadline=today').filter).toEqual({
    prop: { contract: 'orbis/when', slot: 'deadline' },
    op: 'eq',
    value: { token: 'today' },
  });
  // Упорядоченный вид слота: `>` с токеном — как у свойства-даты.
  expect(ok('orbis/when.deadline>today').filter).toEqual({
    prop: { contract: 'orbis/when', slot: 'deadline' },
    op: 'gt',
    value: { token: 'today' },
  });
  // Слот `date` — литерал момента отвергается с позицией, как у свойства `date`.
  const e = err('orbis/when.deadline=2026-07-17T09:00');
  expect(e.code).toBe('TYPE');
  expect(e.position).toBe('orbis/when.deadline='.length);
  // Любой контракт со слотами (закладка Бюджета): decimal-слот — число-строка, `>` — `gt`.
  expect(ok('orbis/money-movement.amount>1000').filter).toEqual({
    prop: { contract: 'orbis/money-movement', slot: 'amount' },
    op: 'gt',
    value: '1000',
  });
});

test('1в §3.2: значение контракта `orbis/when` — адрес без слота; литерал дня принят', () => {
  expect(ok('orbis/when=overdue').filter).toEqual({
    prop: { contract: 'orbis/when' },
    op: 'eq',
    value: { token: 'overdue' },
  });
  expect(ok('orbis/when=2026-07-17').filter).toEqual({
    prop: { contract: 'orbis/when' },
    op: 'eq',
    value: '2026-07-17',
  });
  expect(ok('orbis/when=2026-07-16..2026-07-18').filter).toEqual({
    prop: { contract: 'orbis/when' },
    op: 'range',
    value: { from: '2026-07-16', to: '2026-07-18' },
  });
  expect(ok('!orbis/when=next_7d').filter).toEqual({
    not: { prop: { contract: 'orbis/when' }, op: 'eq', value: { token: 'next_7d' } },
  });
  expect(ok('orbis/when!=next_7d').filter).toEqual({
    prop: { contract: 'orbis/when' },
    op: 'ne',
    value: { token: 'next_7d' },
  });
  // Значение «даты» сравнивается ПО ДНЯМ: момент в литерале — не та форма.
  expect(err('orbis/when=2026-07-17T09:00:00Z').code).toBe('TYPE');
});

test('1в: неизвестный слот — UNKNOWN_SLOT с позицией слота; контракт без значения — NO_CONTRACT_VALUE', () => {
  const slot = err('orbis/when.nope=today');
  expect(slot.code).toBe('UNKNOWN_SLOT');
  expect(slot.position).toBe('orbis/when.'.length);
  expect(slot.message).toContain('nope');
  const value = err('orbis/completable=open');
  expect(value.code).toBe('NO_CONTRACT_VALUE');
  expect(value.position).toBe(0);
  expect(value.message).toContain(
    'у контракта нет значения — адресуйте слот: orbis/completable.status',
  );
  // Не контракт и не свойство — прежний отказ.
  expect(err('orbis/nope.deadline=today').code).toBe('UNKNOWN_FIELD');
});

test('1в §3.1: свойство резолвится ПЕРВЫМ — `orbis/recurrence` остаётся свойством', () => {
  // Ключ контракта «повторяемость» совпадает с ключом свойства; значения контракт не объявляет,
  // и имя обязано остаться свойством (сторож ключей — `registry/builtin.test.ts`).
  expect(ok('has=orbis/recurrence').filter).toEqual({ has: 'orbis/recurrence' });
  expect(err('orbis/recurrence=x').code).toBe('TYPE');
  expect(err('orbis/recurrence=x').message).toContain("свойству 'orbis/recurrence'");
});

test('1в §3.1: адрес в sortBy и aggregate принят; в columns — отказ', () => {
  expect(ok('sortBy=orbis/when:asc').sortBy).toEqual([
    { field: { contract: 'orbis/when' }, dir: 'asc' },
  ]);
  expect(ok('sortBy=orbis/when.deadline:desc|orbis/priority:asc').sortBy).toEqual([
    { field: { contract: 'orbis/when', slot: 'deadline' }, dir: 'desc' },
    { field: 'orbis/priority', dir: 'asc' },
  ]);
  expect(ok('display=tile, aggregate=sum:orbis/money-movement.amount').aggregate).toEqual({
    fn: 'sum',
    field: { contract: 'orbis/money-movement', slot: 'amount' },
  });
  const dates = err('display=tile, aggregate=sum:orbis/when');
  expect(dates.code).toBe('TYPE');
  expect(dates.message).toContain('даты не суммируются');
  // Слот не числового вида — та же проверка, что у свойства.
  expect(err('display=tile, aggregate=sum:orbis/when.deadline').code).toBe('TYPE');
  const columns = err('display=table, columns=orbis/when.deadline');
  expect(columns.code).toBe('TYPE');
  expect(columns.message).toContain('в columns — только свойства');
  expect(err('display=table, columns=orbis/when').code).toBe('TYPE');
});

test('1в: дерево с адресом проходит собственную схему канона', () => {
  for (const text of [
    'orbis/when.deadline=today',
    'orbis/when=overdue, class=orbis/completable:open, sortBy=orbis/when:asc',
    'aspect=orbis/financial, display=tile, aggregate=sum:orbis/money-movement.amount',
  ]) {
    expect(queryAstSchema.safeParse(ok(text)).success, text).toBe(true);
  }
});

// ─────────────── Токены дат и два края (спека 1в §3.4) ───────────────

test('1в §3.4: сравнение с несуществующим краем — TOKEN_EDGE с позицией токена и подсказкой', () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    // У `overdue` нет начала: `<` и `>=` (from) читают начало.
    ['orbis/due_date<overdue', 'orbis/due_date<', 'нет начала'],
    ['orbis/due_date>=overdue', 'orbis/due_date>=', 'нет начала'],
    ['orbis/due_date=overdue..today', 'orbis/due_date=', 'нет начала'],
    // У `after_7d` нет конца: `>` и `<=` (to) читают конец.
    ['orbis/due_date>after_7d', 'orbis/due_date>', 'нет конца'],
    ['orbis/due_date<=after_7d', 'orbis/due_date<=', 'нет конца'],
    ['orbis/due_date=today..after_7d', 'orbis/due_date=today..', 'нет конца'],
    // Значение «когда» — то же правило краёв.
    ['orbis/when<overdue', 'orbis/when<', 'нет начала'],
    ['orbis/when.moment>after_7d', 'orbis/when.moment>', 'нет конца'],
  ];
  for (const [text, before, edge] of cases) {
    const e = err(text);
    expect(e.code, text).toBe('TOKEN_EDGE');
    expect(e.position, text).toBe(before.length);
    expect(e.message, text).toContain(edge);
    expect(e.message, text).toContain('годятся');
  }
});

test('1в §3.4: формы с существующим краем разбираются', () => {
  for (const text of [
    'orbis/due_date>overdue',
    'orbis/due_date<=overdue',
    'orbis/due_date=overdue',
    'orbis/due_date!=overdue',
    'orbis/due_date<after_7d',
    'orbis/due_date>=after_7d',
    'orbis/due_date=after_7d',
    'orbis/due_date=overdue|after_7d',
    'orbis/due_date=today..next_14d',
  ]) {
    expect(parseQueryAst(text, REG).ok, text).toBe(true);
  }
});

test('1в §3.4: четыре новых токена — у date, timestamp, значения «когда» и слота', () => {
  for (const token of ['this_week', 'next_14d', 'this_month', 'last_month'] as const) {
    expect(ok(`orbis/due_date=${token}`).filter).toEqual({
      prop: 'orbis/due_date',
      op: 'eq',
      value: { token },
    });
    expect(ok(`orbis/start_at<${token}`).filter).toEqual({
      prop: 'orbis/start_at',
      op: 'lt',
      value: { token },
    });
    expect(ok(`orbis/when=${token}`).filter).toEqual({
      prop: { contract: 'orbis/when' },
      op: 'eq',
      value: { token },
    });
    expect(ok(`orbis/when.moment>=${token}`).filter).toEqual({
      prop: { contract: 'orbis/when', slot: 'moment' },
      op: 'range',
      value: { from: { token } },
    });
    // Не дата — прежний отказ вида.
    expect(err(`orbis/priority=${token}`).code).toBe('TYPE');
  }
});

test('1в (перенос гейта 1, Minor-1): края диапазона у адреса — одного вида, как у свойства timestamp', () => {
  // Эталон — свойство `timestamp`: день рядом с моментом он не принимает вовсе.
  expect(err('orbis/start_at=2026-07-16..2026-07-17T12:00:00+07:00').code).toBe('TYPE');
  // Слот `moment` (timestamp|date): день и момент в одном диапазоне — отказ, а не сравнение дня
  // с моментом.
  const mixed = err('orbis/when.moment=2026-07-16..2026-07-17T12:00:00+07:00');
  expect(mixed.code).toBe('TYPE');
  expect(mixed.position).toBe('orbis/when.moment='.length);
  expect(mixed.message).toContain('одного вида');
  expect(err('orbis/when.moment=2026-07-16T09:00:00+07:00..2026-07-17').code).toBe('TYPE');
  // Оба дня или оба момента — законно; токен рядом с литералом — законно (сравнение по дню).
  expect(ok('orbis/when.moment=2026-07-16..2026-07-17').filter).toEqual({
    prop: { contract: 'orbis/when', slot: 'moment' },
    op: 'range',
    value: { from: '2026-07-16', to: '2026-07-17' },
  });
  expect(
    parseQueryAst('orbis/when.moment=2026-07-16T09:00:00+07:00..2026-07-17T12:00:00+07:00', REG).ok,
  ).toBe(true);
  expect(parseQueryAst('orbis/when.moment=today..2026-07-17T12:00:00+07:00', REG).ok).toBe(true);
});

test('1в (М-2 финального ревью A): отказ у адреса называет «адрес слота» / «значение контракта», у свойства — как было', () => {
  const order = err('orbis/completable.status>x');
  expect(order.code).toBe('TYPE');
  expect(order.message).toContain(
    "к адресам с линейным порядком; адрес слота 'orbis/completable.status'",
  );
  expect(order.message).not.toContain('свойств');
  const range = err('orbis/completable.status=a..b');
  expect(range.message).toContain("адрес слота 'orbis/completable.status'");
  expect(range.message).not.toContain('свойств');
  const token = err('orbis/money-movement.amount=today');
  expect(token.message).toContain(
    "только к адресам типа date/timestamp; адрес слота 'orbis/money-movement.amount'",
  );
  expect(token.message).not.toContain('свойств');
  const literal = err('orbis/when.deadline=2026-07-17T09:00');
  expect(literal.message).toContain("адрес слота 'orbis/when.deadline' ожидает дату");
  const value = err('orbis/when=2026-07-17T09:00:00Z');
  expect(value.message).toContain("значение контракта 'orbis/when' ожидает дату");
  const group = parseQueryAst('group=day:orbis/money-movement.amount', REG, { place: 'page' });
  expect(group.ok ? null : group.error.message).toContain(
    "group=day: адрес слота 'orbis/money-movement.amount' — не дата",
  );
  // Слова «поле» у адреса нет ни в одном из отказов выше.
  for (const m of [order, range, token, literal, value].map((e) => e.message)) {
    expect(m).not.toMatch(/(^|[^а-яё])пол(е|я|ю|ям|ей)([^а-яё]|$)/i);
  }
  // Свойство — прежние слова.
  expect(err('orbis/due_date=банан').message).toContain("свойство 'orbis/due_date' ожидает");
  expect(err('orbis/priority>high').message).toContain('применим к свойствам с линейным порядком');
  expect(err('orbis/priority=today').message).toContain('применимо только к свойствам типа');
});

// ─────────────────────────── Параметр страницы (1в §5.1, РП-5, РП-6) ───────────────────────────

const PAGE = { place: 'page' } as const;

test('1в §5.1: `$<имя>` на месте значения-границы — только с местом page; дерево несёт {param}', () => {
  const eq = parseQueryAst('orbis/when=$period', REG, PAGE);
  expect(eq.ok && eq.ast.filter).toEqual({
    prop: { contract: 'orbis/when' },
    op: 'eq',
    value: { param: 'period' },
  });
  // Там же, где токен: сравнения, односторонняя граница, диапазон, свойство даты.
  const forms = parseQueryAst(
    'orbis/due_date>$a, orbis/due_date<=$b, orbis/start_at=$c..today, orbis/when.deadline!=$d',
    REG,
    PAGE,
  );
  expect(forms.ok && forms.ast.filter).toEqual({
    and: [
      { prop: 'orbis/due_date', op: 'gt', value: { param: 'a' } },
      { prop: 'orbis/due_date', op: 'range', value: { to: { param: 'b' } } },
      {
        prop: 'orbis/start_at',
        op: 'range',
        value: { from: { param: 'c' }, to: { token: 'today' } },
      },
      { prop: { contract: 'orbis/when', slot: 'deadline' }, op: 'ne', value: { param: 'd' } },
    ],
  });
});

test('1в §5.1 (M-2 гейта 4): `$` + имя длиннее 64 — не ссылка; схема дерева такое имя отвергает', () => {
  const long = 'a'.repeat(65);
  const r = parseQueryAst(`orbis/due_date=$${long}`, REG, PAGE);
  // Не ссылка: разбор читает `$aaa…` литералом (и у даты отвергает его как не-дату), а не `{param}`.
  expect(r.ok ? JSON.stringify(r.ast) : r.error.code).not.toContain('param');
  if (!r.ok) expect(r.error.code).not.toBe('PAGE_ONLY');
  expect(
    pageQueryAstSchema.safeParse({
      filter: { prop: 'orbis/due_date', op: 'eq', value: { param: long } },
    }).success,
  ).toBe(false);
  expect(
    pageQueryAstSchema.safeParse({
      filter: { prop: 'orbis/due_date', op: 'eq', value: { param: 'a'.repeat(64) } },
    }).success,
  ).toBe(true);
});

test('1в §3.8: без места `$` — отказ PAGE_ONLY с подсказкой и позицией ссылки', () => {
  const e = parseQueryAst('aspect=orbis/task, orbis/when=$period', REG);
  expect(e.ok).toBe(false);
  if (e.ok) return;
  expect(e.error.code).toBe('PAGE_ONLY');
  expect(e.error.message).toContain(PAGE_ONLY_HINT);
  expect(e.error.position).toBe('aspect=orbis/task, orbis/when='.length);
});

test('1в §5.1: `$x` у поля не-даты — TYPE «параметр типа period — только у дат»', () => {
  const e = parseQueryAst('orbis/title=$x', REG, PAGE);
  expect(e.ok ? 'разобралось' : e.error.code).toBe('TYPE');
  if (!e.ok) expect(e.error.message).toContain('параметр типа period — только у дат');
});

test('1в §5.1: литерал в кавычках "$x" — строка, печать берёт его в кавычки, обратный разбор — литерал', () => {
  for (const opts of [undefined, PAGE]) {
    const r = parseQueryAst('orbis/title="$x"', REG, opts);
    expect(r.ok && r.ast.filter).toEqual({ prop: 'orbis/title', op: 'eq', value: '$x' });
    if (!r.ok) continue;
    const printed = printQueryAst(r.ast, REG, 'key');
    expect(printed).toBe('orbis/title="$x"');
    const back = parseQueryAst(printed, REG, opts);
    expect(back.ok && back.ast).toEqual(r.ast);
  }
});

test('1в §5.1: печать ссылки — `$имя`, обратный разбор с местом page — то же дерево', () => {
  const r = parseQueryAst('orbis/when=$period, orbis/due_date=$a..$b', REG, PAGE);
  if (!r.ok) throw new Error(r.error.message);
  const printed = printQueryAst(r.ast, REG, 'key');
  expect(printed).toBe('orbis/when=$period, orbis/due_date=$a..$b');
  const back = parseQueryAst(printed, REG, PAGE);
  expect(back.ok && back.ast).toEqual(r.ast);
});

test('1в §5.1: ссылка с неверным именем — не ссылка: `$пери-од` у даты — отказ TYPE литерала', () => {
  expect(err('orbis/due_date=$пери-од').code).toBe('TYPE');
});

// ─────────────────────────── Группировка по дням (1в §5.2, §3.8, задача 6) ───────────────────────────

test('1в §5.2: group=day:<адрес даты> с местом page — {by:day, field}: значение «когда», свойство, адрес слота', () => {
  const when = parseQueryAst('orbis/when=next_7d, group=day:orbis/when, display=list', REG, PAGE);
  expect(when.ok && when.ast).toEqual({
    filter: { prop: { contract: 'orbis/when' }, op: 'eq', value: { token: 'next_7d' } },
    group: { by: 'day', field: { contract: 'orbis/when' } },
    display: 'list',
  });
  const prop = parseQueryAst('group=day:orbis/due_date', REG, PAGE);
  expect(prop.ok && prop.ast.group).toEqual({ by: 'day', field: 'orbis/due_date' });
  const slot = parseQueryAst('group=day:orbis/when.deadline, display=compact', REG, PAGE);
  expect(slot.ok && slot.ast.group).toEqual({
    by: 'day',
    field: { contract: 'orbis/when', slot: 'deadline' },
  });
  // Момент тоже дата дня: timestamp-свойство группируется по дню в поясе владельца.
  const moment = parseQueryAst('group=day:orbis/start_at', REG, PAGE);
  expect(moment.ok && moment.ast.group).toEqual({ by: 'day', field: 'orbis/start_at' });
});

test('1в §5.2: group по не-дате — TYPE с позицией поля; иная единица, чем day, — SYNTAX', () => {
  const title = parseQueryAst('group=day:orbis/title', REG, PAGE);
  expect(title.ok ? 'разобралось' : title.error.code).toBe('TYPE');
  if (!title.ok) expect(title.error.position).toBe('group=day:'.length);
  const week = parseQueryAst('group=week:orbis/when', REG, PAGE);
  expect(week.ok ? 'разобралось' : week.error.code).toBe('SYNTAX');
  if (!week.ok) expect(week.error.message).toContain('в 1в — только day');
  for (const text of ['group=orbis/when', 'group=day:', 'group']) {
    const r = parseQueryAst(text, REG, PAGE);
    expect(r.ok ? 'разобралось' : r.error.code, text).toBe('SYNTAX');
  }
});

test('1в §5.2: group с display=table или tile — отказ словами PROJECTION_RULE_MESSAGES.groupNeedsRows', () => {
  for (const text of [
    'group=day:orbis/when, display=table',
    'display=tile, aggregate=count, group=day:orbis/when',
  ]) {
    const r = parseQueryAst(text, REG, PAGE);
    expect(r.ok ? 'разобралось' : r.error.code, text).toBe('SYNTAX');
    if (!r.ok) expect(r.error.message).toBe(PROJECTION_RULE_MESSAGES.groupNeedsRows);
  }
  // Схема канона держит то же правило — вход мимо разбора (атрибут блока тела).
  const bad = pageQueryAstSchema.safeParse({
    filter: null,
    group: { by: 'day', field: { contract: 'orbis/when' } },
    display: 'table',
  });
  expect(bad.success).toBe(false);
  if (!bad.success) {
    expect(bad.error.issues.map((i) => i.message)).toContain(
      PROJECTION_RULE_MESSAGES.groupNeedsRows,
    );
  }
});

test('1в §3.8: group без места — PAGE_ONLY с подсказкой; `!group` — не отрицается; повтор — SYNTAX', () => {
  const e = parseQueryAst('aspect=orbis/task, group=day:orbis/when', REG);
  expect(e.ok ? 'разобралось' : e.error.code).toBe('PAGE_ONLY');
  if (!e.ok) {
    expect(e.error.message).toContain(PAGE_ONLY_HINT);
    expect(e.error.position).toBe('aspect=orbis/task, '.length);
  }
  const neg = parseQueryAst('!group=day:orbis/when', REG, PAGE);
  expect(neg.ok ? 'разобралось' : neg.error.message).toContain("'group' не отрицается");
  const twice = parseQueryAst('group=day:orbis/when, group=day:orbis/due_date', REG, PAGE);
  expect(twice.ok ? 'разобралось' : twice.error.message).toContain("повторный параметр 'group'");
  // Голое имя — слово грамматики, а не поле (как sortBy, display).
  expect(err('group=today').code).not.toBe('UNKNOWN_FIELD');
});

test('1в §3.8 (перенос Н-2 задачи 4): group у корня дерева — базовая схема отвергает С ПОДСКАЗКОЙ, схема страниц принимает', () => {
  const tree = { filter: null, group: { by: 'day', field: { contract: 'orbis/when' } } };
  const base = queryAstSchema.safeParse(tree);
  expect(base.success).toBe(false);
  if (!base.success) {
    expect(base.error.issues.map((i) => i.message)).toContain(PAGE_ONLY_HINT);
    expect(base.error.issues.map((i) => i.message).join(' ')).not.toContain('Unrecognized key');
  }
  expect(pageQueryAstSchema.safeParse(tree).success).toBe(true);
  // Форма группы строгая: единица — только day, поле обязательно.
  for (const group of [
    { by: 'week', field: 'orbis/due_date' },
    { by: 'day' },
    { by: 'day', field: 'orbis/due_date', extra: 1 },
  ]) {
    expect(
      pageQueryAstSchema.safeParse({ filter: null, group }).success,
      JSON.stringify(group),
    ).toBe(false);
  }
});
