// bun:test, как ВЕСЬ пакет shared (см. diff.test.ts). Файл ТЯЖЁЛЫЙ намеренно: он поднимает
// настоящую схему Tiptap, чтобы сверить с ней литерал из ЛИСТОВОГО `types.ts`. В сборку тест не
// входит, поэтому вес схемы здесь ничего не стоит — а без него литерал молча отстанет от схемы.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getSchema, type JSONContent } from '@tiptap/core';
import { bodyDocError } from './convert';
import { LAYOUT_NODES, PAGE_BLOCK_GROUP, PAGE_BLOCK_PARENTS } from './placement';
import { DOC_EXTENSIONS } from './schema';
import { collectNodeTypes, KNOWN_NODE_TYPES } from './types';

const schema = getSchema(DOC_EXTENSIONS);

describe('KNOWN_NODE_TYPES', () => {
  test('совпадает с составом нод настоящей схемы — поимённо', () => {
    // Двусторонне и по ИМЕНАМ: пропущенная нода объявила бы штатный документ «составом
    // неизвестным» (человек получил бы диалог на ровном месте), лишняя — пропустила бы чужую
    // ноду молча, то есть ровно ту потерю содержимого, ради которой контракт и написан.
    expect([...KNOWN_NODE_TYPES].sort()).toEqual(Object.keys(schema.nodes).sort());
  });

  test('марки схемы в набор НЕ входят — иначе `⊆` рвалось бы на первой же ссылке', () => {
    // Положительный контроль состава: `code` — МАРКА, а не нода, и в `schema.nodes` её нет.
    // Без этой пары сверка выше была бы зелена и у набора, собранного из нод и марок разом.
    expect(Object.keys(schema.marks)).toContain('code');
    for (const mark of Object.keys(schema.marks)) expect(KNOWN_NODE_TYPES.has(mark)).toBe(false);
  });
});

describe('collectNodeTypes', () => {
  const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

  test('собирает типы нод рекурсивно — и весь штатный документ оказывается известным', () => {
    const tree = doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'а' }] }],
        },
      ],
    });
    expect([...collectNodeTypes(tree)].sort()).toEqual([
      'bulletList',
      'doc',
      'listItem',
      'paragraph',
      'text',
    ]);
    // То, ради чего набор и собирают: штатный документ обязан быть подмножеством схемы.
    for (const type of collectNodeTypes(tree)) expect(KNOWN_NODE_TYPES.has(type)).toBe(true);
  });

  test('марки не собираются: `node.marks[].type` — не тип ноды', () => {
    // Ссылка и жирный — самое обычное содержимое абзаца. Собери обход марки, и `⊆` рвалось бы
    // на любом форматированном тексте: человека спрашивали бы про черновик, с которым всё в
    // порядке. Граница осознанная: потеря марки — потеря оформления, потеря ноды — потеря
    // содержимого, и контракт защищает содержимое.
    const tree = doc({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'ссылка',
          marks: [{ type: 'link', attrs: { href: 'https://x' } }, { type: 'bold' }],
        },
      ],
    });
    const types = collectNodeTypes(tree);
    expect([...types].sort()).toEqual(['doc', 'paragraph', 'text']);
    expect(types.has('link')).toBe(false);
    expect(types.has('bold')).toBe(false);
  });

  test('незнакомую ноду видит — иначе проверка подмножества была бы вакуумной', () => {
    const types = collectNodeTypes(doc({ type: 'unknownNode' }));
    expect(types.has('unknownNode')).toBe(true);
    expect(KNOWN_NODE_TYPES.has('unknownNode')).toBe(false);
  });

  test('узел без `content` и без типа обход не роняет', () => {
    // Диск браузера отдаёт чужую строку: там бывает что угодно, а падение обхода стоило бы
    // человеку набранного текста (эффект открытия записи упал бы целиком).
    expect([...collectNodeTypes({ type: 'doc' })]).toEqual(['doc']);
    expect([...collectNodeTypes({} as JSONContent)]).toEqual([]);
  });
});

describe('листовость types.ts', () => {
  // Тот же приём и та же причина, что у `diff.test.ts`: сабпат `@orbis/shared/doc/types`
  // разрешён стражу чанка detail (`save.test.tsx`, якорь `$`) РОВНО потому, что модуль листовой.
  // Появись в нём рантайм-импорт — схема уехала бы в первый кадр записи, и оба стража чанка
  // промолчали бы: они смотрят на спецификатор, а не на то, что за ним.
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const runtimeImports = (src: string) =>
    [...src.matchAll(/^import\b(?!\s+type\b)(?!\s*[.(])[^'"`]*?(['"`])([^'"`]*)\1/gm)].flatMap(
      (m) => (m[2] === undefined ? [] : [m[2]]),
    );

  test('исходник types.ts не содержит рантайм-импортов', () => {
    expect(runtimeImports(read('./types.ts'))).toEqual([]);
    // Положительный контроль: тот же разбор на тяжёлом соседе обязан сработать, иначе пустой
    // список выше означал бы лишь сломанный разбор.
    expect(runtimeImports(read('./convert.ts'))).toContain('@tiptap/core');
  });
});

describe('части контейнеров — свои группы схемы (РП-28)', () => {
  const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
  const p = (text: string): JSONContent => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  });

  test('колонка или вкладка прямо в документе — схема отвергает', () => {
    // Часть вне контейнера печаталась бы маркером без пары, и повторный разбор дал бы плашку
    // ошибки — то есть документ, который схема приняла, не пережил бы собственной печати.
    expect(bodyDocError(doc({ type: 'column', content: [p('а')] }))).toBeDefined();
    expect(
      bodyDocError(doc({ type: 'tab', attrs: { label: 'А' }, content: [p('а')] })),
    ).toBeDefined();
  });

  test('часть не того контейнера — схема отвергает; своя — принимает', () => {
    const column = { type: 'column', content: [p('а')] };
    const tab = { type: 'tab', attrs: { label: 'А' }, content: [p('а')] };
    expect(bodyDocError(doc({ type: 'tabs', content: [column] }))).toBeDefined();
    expect(bodyDocError(doc({ type: 'columns', content: [tab] }))).toBeDefined();
    // Положительный контроль: иначе «отвергает» было бы правдой и для сломанной схемы.
    expect(bodyDocError(doc({ type: 'columns', content: [column, column] }))).toBeUndefined();
    expect(bodyDocError(doc({ type: 'tabs', content: [tab] }))).toBeUndefined();
  });

  test('пустая часть схемой отвергается — содержимое части block+', () => {
    expect(
      bodyDocError(doc({ type: 'columns', content: [{ type: 'column', content: [] }] })),
    ).toBeDefined();
  });
});

describe('группа pageBlock — узлы страницы только в doc, column, tab (спека 1б §10, 1а новое-9)', () => {
  // Место узла страницы — предел СХЕМЫ, как число колонок: документ клиента с колонками под
  // цитатой гейт записи отвергает VALIDATION, а не прячет страховкой в rawBlock (рулинг F1 1а
  // сужен). Глубину схема не выражает — её держит `layoutMisplaced`, поэтому глубина 3 здесь
  // схеме годна.
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
  const quote = (...content: J[]): J => ({ type: 'blockquote', content });
  const bullet = (...content: J[]): J => ({
    type: 'bulletList',
    content: [{ type: 'listItem', content }],
  });
  const cell = (...content: J[]): J => ({
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content }] }],
  });
  const check =
    (...content: J[]) =>
    () =>
      schema.nodeFromJSON({ type: 'doc', content }).check();

  test('схема отвергает: колонки под цитатой, вкладки в ячейке, блок в пункте, карточка под цитатой', () => {
    expect(check(quote(cols([p()], [p()])))).toThrow();
    expect(check(cell(tabs([p()])))).toThrow();
    expect(check(bullet(p(), title))).toThrow();
    expect(check(quote(card))).toThrow();
  });

  test('схема принимает: верх, часть колонок, часть вкладок, вкладки в колонке; глубина 3 — тоже', () => {
    expect(check(p(), cols([p()], [p()]), tabs([p()]), title, card)).not.toThrow();
    expect(check(cols([title, card], [p()]))).not.toThrow();
    expect(check(tabs([title, card, p()]))).not.toThrow();
    expect(check(cols([tabs([p()])], [p()]))).not.toThrow();
    // Глубина 3 схеме годна — её держит `layoutMisplaced` (и страховка скелета при записи).
    expect(check(cols([tabs([cols([p()], [p()])])], [p()]))).not.toThrow();
  });

  test('узлы группы — ровно LAYOUT_NODES, её родители — ровно PAGE_BLOCK_PARENTS', () => {
    // Константы — единственный источник для правила места, переписи и узлов задачи 8
    // (`ownCards`, `hostBlock`): узел, объявленный в группе без записи в LAYOUT_NODES, прошёл бы
    // мимо `layoutMisplaced` и переписи, а родитель вне PAGE_BLOCK_PARENTS — мимо переписи.
    const members = Object.values(schema.nodes)
      .filter((type) => (type.spec.group ?? '').split(' ').includes(PAGE_BLOCK_GROUP))
      .map((type) => type.name);
    expect(members.sort()).toEqual([...LAYOUT_NODES].sort());
    // Родитель — тот, у кого узел группы пускается В ЛЮБОЙ позиции `content`, а не только первым:
    // обход всех состояний автомата `contentMatch` (гейт M-3). Иначе родитель вида
    // `paragraph (block | pageBlock)*` прошёл бы мимо сверки, а перепись сочла бы его место чужим.
    const allowsPageBlock = (start: (typeof schema.nodes)[string]['contentMatch']): boolean => {
      const seen = new Set<typeof start>();
      const queue = [start];
      while (queue.length > 0) {
        const match = queue.pop() as typeof start;
        if (seen.has(match)) continue;
        seen.add(match);
        for (let i = 0; i < match.edgeCount; i += 1) {
          const edge = match.edge(i);
          if ((edge.type.spec.group ?? '').split(' ').includes(PAGE_BLOCK_GROUP)) return true;
          queue.push(edge.next);
        }
      }
      return false;
    };
    const parents = Object.values(schema.nodes)
      .filter((type) => allowsPageBlock(type.contentMatch))
      .map((type) => type.name);
    expect(parents.sort()).toEqual([...PAGE_BLOCK_PARENTS].sort());
  });
});
