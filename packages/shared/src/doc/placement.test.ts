/**
 * Где работают блоки (спека страниц 1а §5.5), ошибки тела (§5.8), абсолютные даты (§5.6) и
 * «шаблон не разобран» (§4.2 шаг 7) — одна листовая функция над деревом препрохода.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/core';
import { FIXTURE_PARSE_REGISTRY as REG } from '../query/ast-fixtures';
import { type ParseRegistry, toParseRegistry } from '../query/parse-ast';
import { propertyDefinitionSchema } from '../registry/property-type';
import { GRAMMAR_ERROR_MESSAGES, parsePageText } from './page-grammar';
import {
  type BodyKind,
  blockAllowedIn,
  bodyIssues,
  EMPTY_QUERY_MESSAGE,
  kindsAllowing,
  layoutMisplaced,
  layoutPlaceAllows,
  MISPLACED_HINT,
  nodeAt,
  type PlacedBlock,
  SECOND_CARDS_MESSAGE,
  secondCardMessage,
  templateBrokenReason,
} from './placement';
import { DOC_EXTENSIONS } from './schema';

const issues = (text: string, kind: BodyKind, reg: ParseRegistry = REG) =>
  bodyIssues(parsePageText(text), kind, reg);

const HOST_TEMPLATE = `{{title}}
{{tags}}
{{tabs}}
{{tab: Запись}}
{{card: orbis/goal}}
{{card: orbis/assignment}}
{{card: orbis/routine}}
{{card: orbis/agent-run}}
{{card: orbis/financial}}
{{body}}
{{/tab}}
{{tab: Детали}}
{{cards}}
{{versions}}
{{subtasks}}
{{blockers}}
{{backlinks}}
{{/tab}}
{{tab: Тред}}
{{thread}}
{{/tab}}
{{/tabs}}
`;

const ABS_QUERY = '{{query: aspect=orbis/task, orbis/due_date<=2026-01-01}}\n';

describe('матрица §5.5', () => {
  test('blockAllowedIn — 5 блоков × 3 вида тела', () => {
    const blocks: PlacedBlock[] = ['container', 'record', 'body', 'card', 'query'];
    const kinds: BodyKind[] = ['note', 'page', 'template'];
    const table = Object.fromEntries(
      blocks.map((b) => [b, kinds.map((k) => blockAllowedIn(b, k))]),
    );
    expect(table).toEqual({
      //           note   page   template
      container: [false, true, true],
      record: [false, true, true],
      body: [false, false, true],
      card: [false, true, true],
      query: [true, true, true],
    });
  });
});

describe('bodyIssues — неуместные блоки', () => {
  test('{{title}} в заметке — BLOCK_MISPLACED с подсказкой; в странице и шаблоне — нет', () => {
    const found = issues('текст\n{{title}}\n', 'note');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'BLOCK_MISPLACED', hint: MISPLACED_HINT, path: [1] });
    expect(found[0]?.message).toContain('{{title}}');
    expect(issues('текст\n{{title}}\n', 'page')).toEqual([]);
    expect(issues('текст\n{{title}}\n', 'template')).toEqual([]);
  });

  test('карточка в заметке — неуместна, в странице — нет', () => {
    expect(issues('{{card: orbis/goal}}\n', 'note')).toMatchObject([
      { code: 'BLOCK_MISPLACED', hint: MISPLACED_HINT, path: [0] },
    ]);
    expect(issues('{{card: orbis/goal}}\n', 'page')).toEqual([]);
  });

  test('{{body}} в странице и в заметке — BLOCK_MISPLACED без подсказки «сделать страницей»', () => {
    for (const kind of ['page', 'note'] as const) {
      const found = issues('{{body}}\n', kind);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ code: 'BLOCK_MISPLACED', path: [0] });
      // Страницей её делать бессмысленно: `{{body}}` работает только в шаблоне.
      expect(found[0]?.hint).toBeUndefined();
      expect(found[0]?.message).toContain('{{body}}');
    }
    expect(issues('{{body}}\n', 'template')).toEqual([]);
  });

  test('два {{body}} в шаблоне — SECOND_BODY на втором, счёт идёт и сквозь контейнеры', () => {
    const flat = parsePageText('{{body}}\nтекст\n{{body}}\n');
    expect(bodyIssues(flat, 'template', REG)).toMatchObject([{ code: 'SECOND_BODY', path: [2] }]);

    const text = '{{body}}\n{{tabs}}\n{{tab: А}}\n{{body}}\n{{/tab}}\n{{/tabs}}\n{{body}}\n';
    const nodes = parsePageText(text);
    const found = bodyIssues(nodes, 'template', REG);
    expect(found.map((i) => i.code)).toEqual(['SECOND_BODY', 'SECOND_BODY']);
    expect(found.map((i) => i.path)).toEqual([[1, 0, 0], [2]]);
    for (const i of found) expect(nodeAt(nodes, i.path)).toMatchObject({ name: 'body' });
  });

  test('контейнер в заметке — BLOCK_MISPLACED одной плашкой на весь контейнер', () => {
    const text =
      'до\n{{columns}}\n{{column}}\n{{title}}\n{{/column}}\n{{column}}\nb\n{{/column}}\n{{/columns}}\n';
    const found = issues(text, 'note');
    // Контейнер не рисуется целиком, его содержимое — тоже: вложенная плашка `{{title}}` не
    // показалась бы никогда.
    expect(found).toMatchObject([{ code: 'BLOCK_MISPLACED', hint: MISPLACED_HINT, path: [1] }]);
    expect(found[0]?.message).toContain('{{columns}}');
    expect(issues(text, 'page')).toEqual([]);
    expect(issues('до\n{{tabs}}\n{{tab: А}}\nа\n{{/tab}}\n{{/tabs}}\n', 'note')).toMatchObject([
      { code: 'BLOCK_MISPLACED', hint: MISPLACED_HINT, path: [1] },
    ]);
  });
});

describe('bodyIssues — второй блок карточек (SECOND_BLOCK, 1а новое-11)', () => {
  test('второй {{cards}} на странице — одна SECOND_BLOCK на втором узле', () => {
    const found = issues('{{cards}}\n{{cards}}\n', 'page');
    expect(found).toEqual([{ code: 'SECOND_BLOCK', message: SECOND_CARDS_MESSAGE, path: [1] }]);
  });

  test('{{card: X}} дважды одним текстом в шаблоне — SECOND_BLOCK у второго', () => {
    const found = issues('{{card: orbis/goal}}\nтекст\n{{card: orbis/goal}}\n', 'template');
    expect(found).toEqual([
      {
        code: 'SECOND_BLOCK',
        message: secondCardMessage('{{card: orbis/goal}}'),
        path: [2],
      },
    ]);
  });

  test('ключ и подпись одного аспекта — не здесь: разные написания узнаёт план рендера с реестром', () => {
    expect(issues('{{card: orbis/goal}}\n{{card: "Цель"}}\n', 'template')).toEqual([]);
  });

  test('счёт идёт в порядке документа сквозь контейнеры', () => {
    const text =
      '{{cards}}\n{{columns}}\n{{column}}\nа\n{{/column}}\n{{column}}\n{{cards}}\n{{/column}}\n{{/columns}}\n';
    const nodes = parsePageText(text);
    const found = bodyIssues(nodes, 'page', REG);
    expect(found).toMatchObject([{ code: 'SECOND_BLOCK', path: [1, 1, 0] }]);
    expect(nodeAt(nodes, found[0]?.path ?? [])).toMatchObject({ kind: 'record', name: 'cards' });
  });

  test('в заметке два {{cards}} — две BLOCK_MISPLACED, неуместные не считаются', () => {
    expect(issues('{{cards}}\n{{cards}}\n', 'note').map((i) => i.code)).toEqual([
      'BLOCK_MISPLACED',
      'BLOCK_MISPLACED',
    ]);
  });

  test('{{cards}} внутри сломанного контейнера не считается', () => {
    const text = '{{columns}}\n{{column}}\n{{cards}}\n{{/column}}\n{{/columns}}\n{{cards}}\n';
    expect(issues(text, 'page').map((i) => i.code)).toEqual(['PART_COUNT']);
  });

  test('второй {{body}} — по-прежнему SECOND_BODY', () => {
    expect(issues('{{body}}\n{{body}}\n', 'template').map((i) => i.code)).toEqual(['SECOND_BODY']);
  });
});

describe('bodyIssues — блок данных', () => {
  test('абсолютная дата на странице и в шаблоне — ABSOLUTE_DATE с подсказкой токенов; в заметке — нет (С1а-9)', () => {
    for (const kind of ['page', 'template'] as const) {
      const found = issues(ABS_QUERY, kind);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ code: 'ABSOLUTE_DATE', path: [0] });
      expect(found[0]?.hint).toContain('today, overdue, next_7d, after_7d');
      expect(found[0]?.message).toContain('2026-01-01');
    }
    expect(issues(ABS_QUERY, 'note')).toEqual([]);
    expect(issues('{{query: aspect=orbis/task, orbis/due_date<=today}}\n', 'page')).toEqual([]);
  });

  test('своё свойство владельца по key (id ≠ key) — дата находится: проверка идёт по дереву разбора', () => {
    // Перенос из ревью задачи 6: `absoluteDateIn` ищет свойство только по id. Дерево, где в
    // `prop` лежит key, обходит правило молча. Встроенные свойства это не ловят (у них key = id),
    // поэтому — своё свойство с uuid.
    const id = '019d48ea-4188-7c02-8e96-1f00000000d9';
    const deadline = propertyDefinitionSchema.parse({
      id,
      key: 'user/deadline',
      label: { ru: 'Дедлайн', en: 'Deadline' },
      description: { ru: 'Своя дата владельца', en: 'An owner date' },
      type: { kind: 'date' },
      rank: 1010,
      graphId: null,
      status: 'active',
      module: null,
    });
    const reg = toParseRegistry(
      {
        properties: new Map([...REG.properties, [id, deadline]]),
        aspects: REG.aspects,
        roles: REG.roles,
        contracts: REG.contracts,
      },
      'ru',
    );
    const found = issues('{{query: user/deadline>=2026-03-01}}\n', 'page', reg);
    expect(found).toMatchObject([{ code: 'ABSOLUTE_DATE', path: [0] }]);
    // В сообщении — подпись свойства, а не uuid из дерева.
    expect(found[0]?.message).toContain('Дедлайн');
    expect(found[0]?.message).not.toContain(id);
    expect(issues('{{query: user/deadline>=today}}\n', 'page', reg)).toEqual([]);
  });

  test('неразобранный запрос — QUERY_INVALID с сообщением разбора и позицией, в любом виде тела', () => {
    for (const kind of ['note', 'page', 'template'] as const) {
      const found = issues('{{query: неизвестное=1}}\n', kind);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ code: 'QUERY_INVALID', path: [0] });
      expect(found[0]?.message).toContain("неизвестное свойство 'неизвестное'");
      // Позиция — в запросе без обёртки и краевых пробелов, как у плашки блока данных.
      expect(found[0]?.message).toContain('позиция 0');
    }
  });
});

test('пустой и пробельный блок данных — QUERY_INVALID «не настроен» в любом виде тела (Р-21-8)', () => {
  // Разбор принял бы пустой текст деревом `{filter: null}` — «все записи владельца».
  for (const kind of ['note', 'page', 'template'] as const) {
    for (const text of ['{{query:}}\n', '{{query:   }}\n', '{{query: \n }}\n']) {
      expect(issues(text, kind)).toEqual([
        { code: 'QUERY_INVALID', message: EMPTY_QUERY_MESSAGE, path: [0] },
      ]);
    }
  }
  expect(EMPTY_QUERY_MESSAGE).toBe('пустой запрос: блок ничего не выбирает — настройте его');
});

describe('bodyIssues — ошибки препрохода и пути', () => {
  test('broken-узел на странице и в шаблоне — его код и сообщение', () => {
    for (const kind of ['page', 'template'] as const) {
      const found = issues('текст\n{{/column}}\n', kind);
      expect(found).toEqual([
        {
          code: 'CLOSE_WITHOUT_OPEN',
          message: GRAMMAR_ERROR_MESSAGES.CLOSE_WITHOUT_OPEN,
          path: [1],
        },
      ]);
    }
    expect(issues('{{columns}}\n{{column}}\nа\n{{/column}}\n', 'page')).toMatchObject([
      { code: 'CONTAINER_UNCLOSED', message: GRAMMAR_ERROR_MESSAGES.CONTAINER_UNCLOSED, path: [0] },
    ]);
  });

  test('broken-узел в заметке — BLOCK_MISPLACED с подсказкой, а не совет чинить контейнер', () => {
    // Контейнер в заметке не работает и починенным (§5.5): грамматический совет вёл бы в тупик.
    for (const text of [
      'текст\n{{/column}}\n',
      '{{columns}}\n{{column}}\nа\n{{/column}}\n{{/columns}}\n', // PART_COUNT
      '{{columns}}\n{{column}}\nа\n{{/column}}\n', // CONTAINER_UNCLOSED
    ]) {
      const nodes = parsePageText(text);
      const at = nodes.findIndex((n) => n.kind === 'broken');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(bodyIssues(nodes, 'note', REG)).toEqual([
        {
          code: 'BLOCK_MISPLACED',
          message: 'Разметка контейнера не показывается в заметке.',
          hint: MISPLACED_HINT,
          path: [at],
        },
      ]);
    }
  });

  test('проблемы внутри частей контейнеров находятся — путь спускается в часть', () => {
    const text = [
      'шапка',
      '{{columns}}',
      '{{column}}',
      'левая',
      '{{/column}}',
      '{{column}}',
      'правая',
      '{{tabs}}',
      '{{tab: Один}}',
      '{{body}}',
      '{{/tab}}',
      '{{tab: Два}}',
      'x',
      '{{query: неизвестное=1}}',
      '{{/tab}}',
      '{{/tabs}}',
      ABS_QUERY.trimEnd(),
      '{{/column}}',
      '{{/columns}}',
      '',
    ].join('\n');
    const nodes = parsePageText(text);
    const found = bodyIssues(nodes, 'page', REG);
    expect(found.map((i) => [i.code, i.path])).toEqual([
      ['BLOCK_MISPLACED', [1, 1, 1, 0, 0]],
      ['QUERY_INVALID', [1, 1, 1, 1, 1]],
      ['ABSOLUTE_DATE', [1, 1, 2]],
    ]);
    expect(nodeAt(nodes, found[0]?.path ?? [])).toMatchObject({ kind: 'record', name: 'body' });
    expect(nodeAt(nodes, found[1]?.path ?? [])).toMatchObject({ kind: 'query' });
    expect(nodeAt(nodes, found[2]?.path ?? [])).toMatchObject({ kind: 'query' });
    expect((nodeAt(nodes, found[2]?.path ?? []) as { text: string }).text).toContain('2026-01-01');
  });
});

describe('templateBrokenReason — §4.2 шаг 7', () => {
  test('текст шаблона хоста §8.1 разбирается чисто', () => {
    expect(templateBrokenReason(HOST_TEMPLATE, REG)).toBeNull();
    expect(bodyIssues(parsePageText(HOST_TEMPLATE), 'template', REG)).toEqual([]);
  });

  test('незакрытый контейнер — сообщение CONTAINER_UNCLOSED', () => {
    expect(templateBrokenReason('{{title}}\n{{tabs}}\n{{tab: А}}\n{{body}}\n{{/tab}}\n', REG)).toBe(
      GRAMMAR_ERROR_MESSAGES.CONTAINER_UNCLOSED,
    );
  });

  test('второй {{body}}, абсолютная дата, неразобранный запрос — тоже «не разобран»', () => {
    expect(templateBrokenReason('{{body}}\n{{body}}\n', REG)).toContain('{{body}}');
    expect(templateBrokenReason(ABS_QUERY, REG)).toContain('2026-01-01');
    // С подсказкой токенов (С1а-9; финальное ревью, F-M1) — плашка сломанного шаблона её покажет.
    expect(templateBrokenReason(ABS_QUERY, REG)).toContain(
      'Замените на относительный токен: today',
    );
    expect(templateBrokenReason('{{query: неизвестное=1}}\n', REG)).toContain('неизвестное');
    expect(templateBrokenReason('{{title}}\n{{query:  }}\n{{body}}\n', REG)).toBe(
      EMPTY_QUERY_MESSAGE,
    );
  });
});

describe('место узлов страницы в документе (§5.2) — layoutMisplaced', () => {
  // Настоящая схема документа: правило обязано работать на живом узле ProseMirror, который
  // редактор отдаёт стражу транзакций, а не на своей подделке.
  const schema = getSchema(DOC_EXTENSIONS as never);
  type J = Record<string, unknown>;
  const p = (text = 'x'): J => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const title: J = { type: 'recordBlock', attrs: { name: 'title' } };
  const card: J = { type: 'aspectCard', attrs: { aspect: null, text: 'orbis/goal' } };
  const cols = (...parts: J[][]): J => ({
    type: 'columns',
    content: parts.map((content) => ({ type: 'column', content })),
  });
  const tabs = (...parts: J[][]): J => ({
    type: 'tabs',
    content: parts.map((content, i) => ({ type: 'tab', attrs: { label: `В${i}` }, content })),
  });
  const doc = (...content: J[]) => {
    const node = schema.nodeFromJSON({ type: 'doc', content });
    node.check(); // схема такой документ ПРИНИМАЕТ — ловит только правило места
    return node;
  };
  const bullet = (...content: J[]): J => ({
    type: 'bulletList',
    content: [{ type: 'listItem', content }],
  });
  const quote = (...content: J[]): J => ({ type: 'blockquote', content });
  const cell = (...content: J[]): J => ({
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content }] }],
  });

  test('на своём месте — верх, часть колонок, часть вкладок, контейнер в части (глубина 2)', () => {
    expect(layoutMisplaced(doc(p(), title, card, cols([p()], [p()])))).toBe(false);
    expect(layoutMisplaced(doc(cols([title, card], [p()])))).toBe(false);
    expect(layoutMisplaced(doc(tabs([card, p()])))).toBe(false);
    expect(layoutMisplaced(doc(cols([tabs([title])], [p()])))).toBe(false);
    expect(layoutMisplaced(doc(tabs([cols([p()], [card])])))).toBe(false);
    // Обычные блоки в чужих узлах — не его забота.
    expect(layoutMisplaced(doc(bullet(p()), quote(p()), cell(p())))).toBe(false);
  });

  test('не на своём месте — пункт списка, цитата, ячейка таблицы', () => {
    expect(layoutMisplaced(doc(bullet(p(), cols([p()], [p()]))))).toBe(true);
    expect(layoutMisplaced(doc(quote(p(), title, p())))).toBe(true);
    expect(layoutMisplaced(doc(bullet(p(), card)))).toBe(true);
    expect(layoutMisplaced(doc(cell(tabs([p()]))))).toBe(true);
    // Глубже: цитата внутри части — место части не спасает.
    expect(layoutMisplaced(doc(cols([quote(title)], [p()])))).toBe(true);
  });

  test('глубина 3 — контейнер в части контейнера в части контейнера', () => {
    expect(layoutMisplaced(doc(cols([tabs([cols([p()], [p()])])], [p()])))).toBe(true);
    // Блок обвязки на той же глубине законен: предел — только для контейнеров.
    expect(layoutMisplaced(doc(cols([tabs([title])], [p()])))).toBe(false);
  });

  test('layoutPlaceAllows — цепочка предков', () => {
    expect(layoutPlaceAllows(['doc'], true)).toBe(true);
    expect(layoutPlaceAllows(['doc', 'columns', 'column'], true)).toBe(true);
    expect(layoutPlaceAllows(['doc', 'columns', 'column', 'tabs', 'tab'], true)).toBe(false);
    expect(layoutPlaceAllows(['doc', 'columns', 'column', 'tabs', 'tab'], false)).toBe(true);
    expect(layoutPlaceAllows(['doc', 'bulletList', 'listItem'], false)).toBe(false);
    expect(layoutPlaceAllows(['doc', 'blockquote'], true)).toBe(false);
  });

  test('kindsAllowing — строка матрицы §5.5', () => {
    expect(kindsAllowing('container')).toEqual(['page', 'template']);
    expect(kindsAllowing('record')).toEqual(['page', 'template']);
    expect(kindsAllowing('card')).toEqual(['page', 'template']);
    expect(kindsAllowing('body')).toEqual(['template']);
    expect(kindsAllowing('query')).toEqual(['note', 'page', 'template']);
  });
});

describe('листовость модуля', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  // Все формы, которыми модуль тянет другой: импорт, реэкспорт, динамический импорт, require.
  const SPECIFIER_RE =
    /^\s*import\b[^'"]*?(?:\bfrom\s*)?['"]([^'"]+)['"]|^\s*export\b[^;'"]*\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]?([^'")]*)|\brequire\s*\(\s*['"]?([^'")]*)/gm;
  const specifiers = (src: string) =>
    [...src.matchAll(SPECIFIER_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
  // `../contracts/block-messages` — строки отказов без единого импорта (фикс-раунд 1 задачи 11:
  // `EMPTY_QUERY_MESSAGE` переехал туда ради веса начальной загрузки web); его листовость —
  // отдельным тестом ниже, иначе разрешение было бы дырой в стороже.
  const ALLOWED = [
    './page-grammar',
    '../query/parse-ast',
    '../query/dates',
    '../contracts/block-messages',
  ];

  test('contracts/block-messages.ts не импортирует НИЧЕГО', () => {
    expect(specifiers(read('../contracts/block-messages.ts'))).toEqual([]);
  });

  test('placement.ts импортирует только page-grammar и разбор запроса с датами', () => {
    // Потребители — первый кадр, рендерер экрана записи, редактор и выбор шаблона: из экрана
    // записи нельзя дотянуться до барреля `@orbis/shared/doc` (tiptap, marked).
    const found = specifiers(read('./placement.ts'));
    expect(found.length).toBeGreaterThan(0);
    for (const s of found) expect(ALLOWED).toContain(s);
    // Положительный контроль: регэксп видит все четыре формы — иначе зелёный сторож мог бы
    // значить лишь сломанный регэксп.
    expect(specifiers("import { parseBody } from './convert';")).toEqual(['./convert']);
    expect(specifiers("import type { X } from './schema';")).toEqual(['./schema']);
    expect(specifiers("import './side-effect';")).toEqual(['./side-effect']);
    expect(specifiers("export { parseBody } from './convert';")).toEqual(['./convert']);
    expect(specifiers("export * from './convert'")).toEqual(['./convert']);
    expect(specifiers("const m = await import ('./convert');")).toEqual(['./convert']);
    expect(specifiers("require('./convert')")).toEqual(['./convert']);
    expect(specifiers(read('./index.ts')).some((s) => !ALLOWED.includes(s))).toBe(true);
  });

  test('сабпат @orbis/shared/doc/placement объявлен в exports', () => {
    const pkg = JSON.parse(read('../../package.json')) as { exports: Record<string, string> };
    expect(pkg.exports['./doc/placement']).toBe('./src/doc/placement.ts');
  });
});
