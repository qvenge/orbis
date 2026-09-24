/**
 * Где работают блоки (спека страниц 1а §5.5), ошибки тела (§5.8), абсолютные даты (§5.6) и
 * «шаблон не разобран» (§4.2 шаг 7) — одна листовая функция над деревом препрохода.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FIXTURE_PARSE_REGISTRY as REG } from '../query/ast-fixtures';
import { type ParseRegistry, toParseRegistry } from '../query/parse-ast';
import { propertyDefinitionSchema } from '../registry/property-type';
import { GRAMMAR_ERROR_MESSAGES, type PageNode, parsePageText } from './page-grammar';
import {
  type BodyKind,
  blockAllowedIn,
  bodyIssues,
  MISPLACED_HINT,
  type PlacedBlock,
  templateBrokenReason,
} from './placement';

const issues = (text: string, kind: BodyKind, reg: ParseRegistry = REG) =>
  bodyIssues(parsePageText(text), kind, reg);

/** Узел по пути проблемы — так его найдёт рендерер (задача 13); формат пути — докблок модуля. */
function nodeAt(nodes: readonly PageNode[], path: readonly number[]): PageNode {
  let list: readonly PageNode[] = nodes;
  let node = list[path[0] as number] as PageNode;
  for (let i = 1; i < path.length; i += 2) {
    const part = path[i] as number;
    if (node.kind === 'columns') list = node.parts[part] as PageNode[];
    else if (node.kind === 'tabs') list = (node.parts[part] as { children: PageNode[] }).children;
    else throw new Error(`путь спускается в узел ${node.kind}, у которого нет частей`);
    node = list[path[i + 1] as number] as PageNode;
  }
  if (!node) throw new Error(`по пути ${path.join('.')} узла нет`);
  return node;
}

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

describe('bodyIssues — ошибки препрохода и пути', () => {
  test('broken-узел — его код и сообщение, в любом виде тела', () => {
    for (const kind of ['note', 'page', 'template'] as const) {
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
    expect(templateBrokenReason('{{query: неизвестное=1}}\n', REG)).toContain('неизвестное');
  });
});

describe('листовость модуля', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  // Все формы, которыми модуль тянет другой: импорт, реэкспорт, динамический импорт, require.
  const SPECIFIER_RE =
    /^\s*import\b[^'"]*?(?:\bfrom\s*)?['"]([^'"]+)['"]|^\s*export\b[^;'"]*\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]?([^'")]*)|\brequire\s*\(\s*['"]?([^'")]*)/gm;
  const specifiers = (src: string) =>
    [...src.matchAll(SPECIFIER_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
  const ALLOWED = ['./page-grammar', '../query/parse-ast', '../query/dates'];

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
