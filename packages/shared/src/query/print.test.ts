/**
 * Печать канонического Q-AST (§А5-2: «два рендера одного AST — key для машин, label
 * для человека»). Key-форма каноническая: по ней меряет дифф Ш1, и она обязана быть
 * обратимой — `parse(print(a)) ≡ a` доказывается прогоном, а не обещанием.
 */
import { expect, test } from 'bun:test';
import type { PropertyDefinition } from '../registry/property-type';
import type { QueryFilterNode } from './ast';
import {
  AGENDA_QUERY_TEXTS,
  AST_FIXTURES,
  FIXTURE_PARSE_REGISTRY,
  FIXTURE_USER_LIST_ID,
  FIXTURE_USER_PROPERTY_ID,
  INEXPRESSIBLE_QUERY_TEXTS,
  PRODUCTION_QUERY_TEXTS,
} from './ast-fixtures';
import { parseQueryAst, type QueryParseCode } from './parse-ast';
import { printQueryAst } from './print';

const REG = FIXTURE_PARSE_REGISTRY;

test('key-форма обратима на всех текстовых фикстурах: print → parse → тот же AST', () => {
  const textual = AST_FIXTURES.filter((f) => f.keyText !== null);
  expect(textual.length).toBeGreaterThanOrEqual(10);
  for (const fixture of textual) {
    const printed = printQueryAst(fixture.ast, REG, 'key');
    expect(printed, fixture.name).toBe(fixture.keyText as string);
    const back = parseQueryAst(printed, REG);
    expect(back.ok, `${fixture.name}: ${back.ok ? '' : back.error.message}`).toBe(true);
    // `normalizedTo` — единственное нормативное исключение (см. докблок `AstFixture`):
    // у `in` и у `or` по одному свойству в плоской грамматике одна форма, и разбор её
    // канонизирует. Где поля нет — круг обязан сойтись точно.
    if (back.ok) expect(back.ast, fixture.name).toEqual(fixture.normalizedTo ?? fixture.ast);
  }
});

test('фикстуры без keyText действительно НЕ разбираются назад — «невыразимо» проверено', () => {
  const inexpressible = AST_FIXTURES.filter((f) => f.keyText === null);
  expect(inexpressible.length).toBeGreaterThanOrEqual(3);
  for (const fixture of inexpressible) {
    const printed = printQueryAst(fixture.ast, REG, 'key');
    expect(printed.length, fixture.name).toBeGreaterThan(0);
    const back = parseQueryAst(printed, REG);
    expect(back.ok, `${fixture.name}: «${printed}» разобралось, хотя помечено невыразимым`).toBe(
      false,
    );
    if (back.ok) continue;
    // Отказ обязан быть ПРО ТО САМОЕ: у деревьев вне плоской грамматики печать даёт
    // скобочную форму и отказ про скобки, а не случайный SYNTAX по другой причине.
    expect(back.error.code, `${fixture.name}: «${printed}»`).toBe(
      fixture.printRejects as QueryParseCode,
    );
    if (fixture.printRejects === 'SYNTAX') {
      expect(printed, fixture.name).toContain('(');
      expect(back.error.message, fixture.name).toContain('скобок');
    }
  }
});

test('нормализация |-списка — правило, а не случайность: in → or, in из одного → eq', () => {
  // Правило записано здесь, потому что иначе «print(in) даёт текст, который читается как or»
  // выглядело бы дефектом печати, а это осознанная неразличимость форм в плоской грамматике.
  const many = parseQueryAst('orbis/task_status=planned|in_progress', REG);
  expect(many.ok).toBe(true);
  if (many.ok) {
    expect(many.ast.filter).toEqual({
      or: [
        { prop: 'orbis/task_status', op: 'eq', value: 'planned' },
        { prop: 'orbis/task_status', op: 'eq', value: 'in_progress' },
      ],
    });
  }
  const single = parseQueryAst('orbis/task_status=planned', REG);
  expect(single.ok).toBe(true);
  if (single.ok) {
    expect(single.ast.filter).toEqual({ prop: 'orbis/task_status', op: 'eq', value: 'planned' });
  }
  // Печать `in` даёт ровно ту же строку — обе формы неразличимы текстом по построению.
  expect(
    printQueryAst(
      { filter: { prop: 'orbis/task_status', op: 'in', value: ['planned', 'in_progress'] } },
      REG,
      'key',
    ),
  ).toBe('orbis/task_status=planned|in_progress');
});

test('свойство с key ≠ id: в дереве id, в тексте key, в label-форме подпись (§А5-2)', () => {
  const r = parseQueryAst('user/effort_points>3, sortBy=user/effort_points:desc', REG);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  // id пользовательского свойства — uuid; key — слаг. В дереве обязан лежать ИМЕННО id,
  // иначе всё, что резолвит по id (компилятор, CAS, `query_refs`), промахнётся молча.
  expect(r.ast.filter).toEqual({ prop: FIXTURE_USER_PROPERTY_ID, op: 'gt', value: 3 });
  expect(r.ast.sortBy).toEqual([{ field: FIXTURE_USER_PROPERTY_ID, dir: 'desc' }]);
  expect(FIXTURE_USER_PROPERTY_ID).not.toBe('user/effort_points');
  // Обратно имя подставляется на печати — по key для машин, по подписи для человека.
  expect(printQueryAst(r.ast, REG, 'key')).toBe(
    'user/effort_points>3, sortBy=user/effort_points:desc',
  );
  expect(printQueryAst(r.ast, REG, 'label')).toBe('"Баллы усилия">3, sortBy="Баллы усилия":desc');
});

test('label-форма экранирует кавычки в подписи — иначе имя не читается обратно', () => {
  const reg: typeof REG = {
    ...REG,
    properties: new Map([
      [
        'user/quoted',
        {
          ...(REG.properties.get(FIXTURE_USER_PROPERTY_ID) as PropertyDefinition),
          id: 'user/quoted',
          key: 'user/quoted',
          label: { ru: 'Он "сказал"', en: 'He "said"' },
        },
      ],
    ]),
  };
  const ast = { filter: { prop: 'user/quoted', op: 'eq' as const, value: 7 } };
  const printed = printQueryAst(ast, reg, 'label');
  expect(printed).toBe('"Он \\"сказал\\""=7');
  const back = parseQueryAst(printed, reg);
  expect(back.ok, back.ok ? '' : back.error.message).toBe(true);
  if (back.ok) expect(back.ast).toEqual(ast);
});

test('AGENDA_QUERY_TEXTS (три key-формы) разбираются и печатаются обратимо', () => {
  const texts = Object.values(AGENDA_QUERY_TEXTS);
  expect(texts.length).toBe(3);
  for (const text of texts) {
    const r = parseQueryAst(text, REG);
    expect(r.ok, `${text}: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (!r.ok) continue;
    expect(printQueryAst(r.ast, REG, 'key')).toBe(text);
  }
  // Три запроса Agenda сегодня склеиваются на клиенте; Задача 10c подставит эти тексты
  // в useAgenda.ts дословно, поэтому имена свойств здесь — key реестра, а не голые поля.
  expect(AGENDA_QUERY_TEXTS.days).toContain('orbis/start_at=today|next_7d');
  expect(AGENDA_QUERY_TEXTS.overdueDue).toContain('orbis/task_status=!done&!cancelled');
  expect(AGENDA_QUERY_TEXTS.overdueStart).toContain('aspect=orbis/task, aspect=orbis/schedule');
});

test('label-форма — подписи по локали, имена полей закавычены (§А5-3б)', () => {
  const ast = parseQueryAst('aspect=orbis/task orbis/due_date<=today limit=5', REG);
  expect(ast.ok).toBe(true);
  if (!ast.ok) return;
  expect(printQueryAst(ast.ast, REG, 'label')).toBe('aspect="Задача", "Срок"<=today, limit=5');
  // Обе печати — одного дерева: label-форма читается тем же парсером обратно.
  const back = parseQueryAst(printQueryAst(ast.ast, REG, 'label'), REG);
  expect(back.ok).toBe(true);
  if (back.ok) expect(back.ast).toEqual(ast.ast);
});

test('дерево, невыразимое плоской грамматикой v1, печатается скобками и не разбирается назад', () => {
  const ast = {
    filter: {
      or: [
        { prop: 'orbis/task_status', op: 'eq' as const, value: 'done' },
        { prop: 'orbis/priority', op: 'eq' as const, value: 'high' },
      ],
    },
  };
  const printed = printQueryAst(ast, REG, 'key');
  expect(printed).toBe('(orbis/task_status=done | orbis/priority=high)');
  // §А5-3д: скобок в грамматике v1 НЕТ — печать тотальна, разбор такой формы отказывает.
  const back = parseQueryAst(printed, REG);
  expect(back.ok).toBe(false);
  if (!back.ok) expect(back.error.code).toBe('SYNTAX');
});

test('sourceNotIn: сахар печатается сахаром, а скобочная форма различает КАЖДОЕ поле', () => {
  // Негатив к находке предфильтра: печать «по наличию поля» отдавала текст `excludeBlocked=true`
  // ЛЮБОМУ узлу с `sourceNotIn`, и обратный разбор возвращал каноническую тройку — то есть два
  // РАЗНЫХ дерева печатались одним текстом, а правка внутри узла в key-печати исчезала.
  // Достижимо не гипотетически: `sourceNotIn` уехал в JSON Schema провайдеру.
  const node = (via: string, prop: string, values: string[]) => ({
    filter: {
      not: { rel: { kind: 'has_relation' as const, via, sourceNotIn: { prop, values } } },
    },
  });
  const print = (ast: ReturnType<typeof node>) => printQueryAst(ast, REG, 'key');

  expect(print(node('dependency', 'orbis/task_status', ['done', 'cancelled']))).toBe(
    'excludeBlocked=true',
  );

  // ПОФИЛДОВЫЕ ПАРЫ, а не «три разных узла»: набор, где варианты отличаются двумя полями
  // сразу, переживает выброс одного поля из печати (проверено живым мутантом на гейте —
  // «скобочная форма без values» прошла весь сьют). Поэтому здесь на КАЖДОЕ поле стоит пара,
  // различающаяся ровно ИМ: выброси печать это поле — и пара схлопнется в один текст.
  const base = node('subitem', 'orbis/task_status', ['done']);
  const pairs: ReadonlyArray<readonly [string, ReturnType<typeof node>]> = [
    ['via', node('mention', 'orbis/task_status', ['done'])],
    ['prop', node('subitem', 'orbis/priority', ['done'])],
    ['values', node('subitem', 'orbis/task_status', ['cancelled'])],
  ];
  const printedBase = print(base);
  for (const [field, other] of pairs) {
    expect(print(other), `поле ${field} не различается печатью`).not.toBe(printedBase);
    // И ни один из них не притворяется сахаром.
    expect(print(other)).not.toBe('excludeBlocked=true');
  }
  expect(printedBase).not.toBe('excludeBlocked=true');

  // Скобочная форма невыразима плоской грамматикой — разбор обязан отказать, а не вернуть
  // другое дерево (§А5-3д).
  for (const ast of [base, ...pairs.map(([, a]) => a)]) {
    const back = parseQueryAst(print(ast), REG);
    expect(back.ok, `${print(ast)} разобрался, хотя невыразим`).toBe(false);
  }

  // И круг: все пять узлов (сахар + база + три соседа) дают ПЯТЬ разных текстов.
  const texts = new Set(['excludeBlocked=true', printedBase, ...pairs.map(([, a]) => print(a))]);
  expect(texts.size).toBe(5);
});

/**
 * §А5-2 «в дереве лежат id, имя подставляется на печати» — пин на КАЖДОЙ точке, где парсер
 * пишет id в дерево, а не на двух удобных.
 *
 * Урок гейт-ревью, ради которого тест такой длинный: прежняя проверка гоняла фикстуру
 * key≠id только через `>` и `sortBy`, а мутация `.id`→`.key` ставилась СРАЗУ ВО ВСЕХ
 * пятнадцати местах — краснели ровно две запиненные, и дыра выглядела закрытой. Групповая
 * мутация доказывает «хоть где-то пиннится», а не «пиннится везде», поэтому каждая точка
 * ниже проверяется отдельным разбором (и отдельной мутацией — таблица в отчёте).
 */
test('id-инвариант: КАЖДАЯ точка записи id в дерево пишет id, а печать возвращает key', () => {
  const P = FIXTURE_USER_PROPERTY_ID; // number, key `user/effort_points`
  const L = FIXTURE_USER_LIST_ID; // список, key `user/labels`
  const A = 'user/note_alias'; // аспект, key `user/note-alias`
  const R = 'user/mention_alias'; // роль, key `user/mention-alias`
  // Ни один key не равен своему id — иначе весь тест выродился бы в тавтологию.
  for (const [id, key] of [
    [P, 'user/effort_points'],
    [L, 'user/labels'],
    [A, 'user/note-alias'],
    [R, 'user/mention-alias'],
  ] as const) {
    expect(id, key).not.toBe(key);
  }

  // Четвёртый элемент — канонический текст печати, когда он НЕ равен входному: `!=` на
  // списочном свойстве и `has_relation=<роль>` — входной сахар, у канона для них другая
  // форма. Круг всё равно сходится — это проверяется разбором напечатанного.
  const cases: [string, string, unknown, string?][] = [
    ['sortBy', 'sortBy=user/effort_points:asc', null],
    ['<= (range.to)', 'user/effort_points<=5', { prop: P, op: 'range', value: { to: 5 } }],
    ['>= (range.from)', 'user/effort_points>=5', { prop: P, op: 'range', value: { from: 5 } }],
    ['> (gt)', 'user/effort_points>3', { prop: P, op: 'gt', value: 3 }],
    ['< (lt)', 'user/effort_points<3', { prop: P, op: 'lt', value: 3 }],
    ['!= (ne)', 'user/effort_points!=5', { prop: P, op: 'ne', value: 5 }],
    [
      '!= на списке',
      'user/labels!=кофе',
      { not: { prop: L, op: 'contains', value: 'кофе' } },
      'user/labels=!кофе',
    ],
    [
      'диапазон a..b',
      'user/effort_points=1..5',
      { prop: P, op: 'range', value: { from: 1, to: 5 } },
    ],
    [
      '&-форма',
      'user/effort_points=!1&!2',
      {
        not: {
          or: [
            { prop: P, op: 'eq', value: 1 },
            { prop: P, op: 'eq', value: 2 },
          ],
        },
      },
    ],
    ['одиночное !v', 'user/effort_points=!1', { not: { prop: P, op: 'eq', value: 1 } }],
    ['одиночное значение (eq)', 'user/effort_points=1', { prop: P, op: 'eq', value: 1 }],
    [
      'одиночное значение (contains)',
      'user/labels=кофе',
      { prop: L, op: 'contains', value: 'кофе' },
    ],
    [
      '|-список',
      'user/effort_points=1|2',
      {
        or: [
          { prop: P, op: 'eq', value: 1 },
          { prop: P, op: 'eq', value: 2 },
        ],
      },
    ],
    ['has=', 'has=user/effort_points', { has: P }],
    ['aspect=', 'aspect=user/note-alias', { aspect: A }],
    [
      'via= отдельным словом',
      'has_children via=user/mention-alias',
      { rel: { kind: 'has_children', via: R } },
    ],
    [
      'has_relation=<роль>',
      'has_relation=user/mention-alias',
      { rel: { kind: 'has_relation', via: R } },
      'has_relation via=user/mention-alias',
    ],
  ];

  for (const [point, text, expected, printedAs] of cases) {
    const r = parseQueryAst(text, REG);
    expect(r.ok, `${point}: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (!r.ok) continue;
    if (expected !== null) expect(r.ast.filter, point).toEqual(expected as never);
    else expect(r.ast.sortBy, point).toEqual([{ field: P, dir: 'asc' }]);
    // Обратная сторона того же инварианта: печать обязана вернуть key, а не id.
    const printed = printQueryAst(r.ast, REG, 'key');
    expect(printed, `печать ${point}`).toBe(printedAs ?? text);
    expect(printed, `печать ${point}: id не должен попадать в текст`).not.toContain(P);
    expect(printed, `печать ${point}: id не должен попадать в текст`).not.toContain(L);
    // Круг сходится и там, где печать выбрала другую форму того же дерева.
    const back = parseQueryAst(printed, REG);
    expect(back.ok, `обратный разбор ${point}`).toBe(true);
    if (back.ok) expect(back.ast, `круг ${point}`).toEqual(r.ast);
  }
  // Все семнадцать точек перечислены здесь; счётчик стережёт от «добавил ветку — забыл пин».
  expect(cases.length).toBe(17);
});

test('гарды квотирования: значение-двойник токена и `..` печатаются в кавычках', () => {
  // `orbis/location` — kind text; литерал `today` в нём законен, но без кавычек он уехал бы
  // текстом, который парсер читает как ОТНОСИТЕЛЬНОЕ ВРЕМЯ (и отвергает: тип не date).
  for (const value of ['today', 'overdue', 'next_7d', 'after_7d', 'a..b', 'дом дача', '!нет', '']) {
    const ast = { filter: { prop: 'orbis/location', op: 'eq' as const, value } };
    const printed = printQueryAst(ast, REG, 'key');
    expect(printed, value).toContain('"');
    const back = parseQueryAst(printed, REG);
    expect(back.ok, `${value}: ${back.ok ? '' : back.error.message}`).toBe(true);
    if (back.ok) expect(back.ast, value).toEqual(ast);
  }
  // А обычное значение кавычками не обрастает — гард не превратился в «квотируем всё».
  expect(
    printQueryAst({ filter: { prop: 'orbis/location', op: 'eq', value: 'дом' } }, REG, 'key'),
  ).toBe('orbis/location=дом');

  // Свод тегов в `|`-список квотирует ЭЛЕМЕНТЫ: без этого тег с пробелом или с `|` внутри
  // разъехался бы на два тега при обратном разборе. Теги владельца — свободный текст.
  for (const tags of [
    ['дом дача', 'офис'],
    ['a|b', 'c'],
    ['важно, срочно', 'потом'],
  ]) {
    const ast = { filter: { or: tags.map((tag) => ({ tag })) } };
    const printed = printQueryAst(ast, REG, 'key');
    expect(printed, tags.join('/')).toContain('"');
    const back = parseQueryAst(printed, REG);
    expect(back.ok, `${printed}: ${back.ok ? '' : back.error.message}`).toBe(true);
    if (back.ok) expect(back.ast, printed).toEqual(ast);
  }
});

/**
 * Круг `parse(print(a)) ≡ a` по КЛАССУ, а не по выборке.
 *
 * Прежняя проверка обратимости ходила только по `AST_FIXTURES` — то есть по деревьям,
 * которые я выбрал сам. Дыру нашли там, куда выборка не смотрела: `{or:[{tag},{tag}]}` —
 * дерево, которое парсер САМ делает из боевого `tags=дом|дача`. Поэтому корпус здесь
 * собирается не из фикстур, а из ВСЕГО, что в пакете есть текстом: ключ-формы фикстур,
 * тексты Agenda, боевая опись целиком И каждая её конструкция по отдельности (после
 * перевода имён Задачами 9b/10c разбираться начнут именно они), плюс тексты невыразимого.
 */
test('круг обратимости на всём, что разбирается: фикстуры, Agenda, боевая опись и её клаузы', () => {
  /** Режет текст по запятым и переводам строк ВНЕ кавычек — как это делает разбор. */
  const clauses = (text: string): string[] => {
    const out: string[] = [];
    let start = 0;
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '\\') i++;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === '\n') {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
    out.push(text.slice(start));
    return out.filter((c) => c.trim() !== '');
  };

  const corpus = new Set<string>();
  for (const f of AST_FIXTURES) if (f.keyText) corpus.add(f.keyText);
  for (const t of Object.values(AGENDA_QUERY_TEXTS)) corpus.add(t);
  for (const t of INEXPRESSIBLE_QUERY_TEXTS) corpus.add(t.text);
  for (const e of PRODUCTION_QUERY_TEXTS) {
    corpus.add(e.text);
    for (const c of clauses(e.text)) corpus.add(c);
  }

  const notReversible: string[] = [];
  let parsed = 0;
  for (const text of corpus) {
    const first = parseQueryAst(text, REG);
    if (!first.ok) continue; // не разбирается сегодня — это работа перевода, не печати
    parsed++;
    const printed = printQueryAst(first.ast, REG, 'key');
    const second = parseQueryAst(printed, REG);
    if (!second.ok || JSON.stringify(second.ast) !== JSON.stringify(first.ast)) {
      notReversible.push(`«${text}» → печать «${printed}»`);
    }
  }

  // Корпус обязан быть непустым и заметным — иначе тест зелен от того, что ничего не гонял.
  expect(corpus.size).toBeGreaterThanOrEqual(120);
  expect(parsed).toBeGreaterThanOrEqual(40);
  // Список пуст ЯВНО: если какое-то дерево напечатать обратимо нельзя, тест назовёт его,
  // а не промолчит.
  expect(notReversible).toEqual([]);
});

test('OR по не-тегам плоским текстом не выражается — и печать говорит это вслух', () => {
  // Свод в `|`-список законен только для однородных тегов: `aspect=a|b` разбор прочитал бы
  // как ОДНО имя аспекта, `has=a|b` — как одно имя свойства, `search=a|b` дал бы ДРУГОЕ
  // дерево (строку поиска `a|b`). Для них скобки — честный отказ, а не потеря.
  const cases: [string, QueryFilterNode][] = [
    ['aspect', { or: [{ aspect: 'orbis/task' }, { aspect: 'orbis/note' }] }],
    ['has', { or: [{ has: 'orbis/recurrence' }, { has: 'orbis/location' }] }],
    ['search', { or: [{ search: 'кофе' }, { search: 'чай' }] }],
  ];
  for (const [name, filter] of cases) {
    const printed = printQueryAst({ filter }, REG, 'key');
    expect(printed, name).toContain('(');
    const back = parseQueryAst(printed, REG);
    expect(back.ok, name).toBe(false);
    if (!back.ok) expect(back.error.code, name).toBe('SYNTAX');
  }
  // А однородные теги — сводятся, и круг сходится в обе стороны.
  expect(printQueryAst({ filter: { or: [{ tag: 'дом' }, { tag: 'дача' }] } }, REG, 'key')).toBe(
    'tags=дом|дача',
  );
  expect(
    printQueryAst({ filter: { not: { or: [{ tag: 'дом' }, { tag: 'дача' }] } } }, REG, 'key'),
  ).toBe('!tags=дом|дача');
});
