import type { JSONContent } from '@tiptap/core';

/**
 * Версия схемы документа. Поднимается при КАЖДОМ изменении состава нод: ProseMirror молча
 * выбрасывает узлы, которых нет в текущей схеме, и без версии откат релиза съел бы содержимое
 * без следа. Правило разрешения — readBodyDoc.
 */
export const DOC_SCHEMA_VERSION = 1;

/** Хранимая форма `entities.body_doc`. Голый документ не хранится — только с версией. */
export type BodyDoc = { v: number; doc: JSONContent };

/**
 * Имена нод ТЕКУЩЕЙ схемы документа — литералом.
 *
 * Литерал, а не `Object.keys(getSchema(DOC_EXTENSIONS).nodes)`, ровно по одной причине: этот
 * модуль ЛИСТОВОЙ (единственный импорт файла — тип), и спрашивают его те, кому запрещён
 * рантайм-импорт `@orbis/shared/doc` (хук сохранения тела и хранилище черновиков — поимённый
 * список стража чанка в `apps/web/src/features/entity-editor/save.test.tsx`). Вычисли список из
 * схемы — и вся схема Tiptap (154.5 кБ gzip) уехала бы в первый кадр каждого открытия записи.
 *
 * Со схемой литерал не разъезжается: `schema.test.ts` сверяет его с настоящей
 * `getSchema(DOC_EXTENSIONS).nodes` поимённо и двусторонне. Тот же приём и по той же причине,
 * что у таблиц умолчаний в `apps/web/src/features/entity-editor/strip-ids.ts`.
 *
 * МАРОК здесь нет и быть не может: `schema.nodes` их не содержит (`code`, `link`, `bold`… —
 * марки), и набор нужен для проверки «состав документа ⊆ схема», которая порвалась бы на первом
 * же форматированном тексте.
 */
export const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set([
  'blockquote',
  'bulletList',
  'codeBlock',
  'doc',
  'entityRef',
  'hardBreak',
  'heading',
  'horizontalRule',
  'listItem',
  'orderedList',
  'paragraph',
  'queryBlock',
  'rawBlock',
  'table',
  'tableCell',
  'tableHeader',
  'tableRow',
  'taskItem',
  'taskList',
  'text',
]);

/**
 * Состав нод документа: обход по `content`, имена берутся из `node.type`.
 *
 * Считается ОБХОДОМ, а не хранится рядом с документом, и это решение: множество имён нод —
 * функция самого документа, обход даёт верный ответ всегда и не зависит от честности той версии
 * приложения, которая документ записала. Поле на диске сделало бы каждую уже лежащую там запись
 * «составом неизвестным» — то есть выдало бы человеку диалог на ровном месте.
 *
 * МАРКИ (`node.marks[].type`) НЕ собираются намеренно. Граница проходит здесь потому, что
 * потеря марки — потеря оформления, а потеря ноды — потеря содержимого; контракт офлайн-
 * черновиков (§А11-2) защищает содержимое. Собирай обход и марки, `⊆ KNOWN_NODE_TYPES` рвалось
 * бы на любой ссылке, и человека спрашивали бы про черновик, с которым всё в порядке.
 */
export function collectNodeTypes(doc: JSONContent): Set<string> {
  const types = new Set<string>();
  const walk = (node: JSONContent | undefined): void => {
    if (!node) return;
    if (typeof node.type === 'string') types.add(node.type);
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return types;
}
