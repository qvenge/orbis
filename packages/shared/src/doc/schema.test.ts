// bun:test, как ВЕСЬ пакет shared (см. diff.test.ts). Файл ТЯЖЁЛЫЙ намеренно: он поднимает
// настоящую схему Tiptap, чтобы сверить с ней литерал из ЛИСТОВОГО `types.ts`. В сборку тест не
// входит, поэтому вес схемы здесь ничего не стоит — а без него литерал молча отстанет от схемы.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getSchema, type JSONContent } from '@tiptap/core';
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
