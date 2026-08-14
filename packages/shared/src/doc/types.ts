import type { JSONContent } from '@tiptap/core';

/**
 * Версия схемы документа. Поднимается при КАЖДОМ изменении состава нод: ProseMirror молча
 * выбрасывает узлы, которых нет в текущей схеме, и без версии откат релиза съел бы содержимое
 * без следа. Правило разрешения — readBodyDoc.
 */
export const DOC_SCHEMA_VERSION = 1;

/** Хранимая форма `entities.body_doc`. Голый документ не хранится — только с версией. */
export type BodyDoc = { v: number; doc: JSONContent };
