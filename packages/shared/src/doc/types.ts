import type { JSONContent } from '@tiptap/core';

/**
 * Версия схемы документа. Поднимается при КАЖДОМ изменении состава нод И при смене АТРИБУТОВ
 * существующей ноды: ProseMirror молча выбрасывает и узлы, и атрибуты, которых нет в текущей
 * схеме, и без версии откат релиза съел бы содержимое без следа.
 *
 * 2 — query-блок хранит разобранное дерево запроса (`ast`) и его печатную key-форму (`text`)
 * вместо одной строки `query` (§А11-1). Правило разрешения — `readBodyDoc`, и оно НЕСИММЕТРИЧНО
 * гейту записи: чтение принимает v1 и конвертирует его по дереву (`upgradeBodyDoc` ниже),
 * запись принимает только текущую версию. Это не оплошность, а следствие того, что конверсия
 * вверх проверяема, а вниз — нет.
 */
export const DOC_SCHEMA_VERSION = 2;

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

/**
 * Конверсия хранимого документа к ТЕКУЩЕЙ версии схемы — по ДЕРЕВУ, а не пересборкой из
 * markdown: пересборка теряет блочные id (UniqueID схеме неизвестен) и часть оформления.
 *
 * Что делает 1 → 2: переносит содержимое старого атрибута `query` query-блока в новый `text`
 * и ставит `ast: null`, то есть объявляет блок НЕ РАЗОБРАННЫМ. Дерево здесь не собирается
 * намеренно — для разбора нужен реестр (`bindQueryBlocks`), а этот модуль ЛИСТОВОЙ и его
 * читают те, кому рантайм-импорт `@orbis/shared/doc` запрещён стражем чанка (хук сохранения
 * тела). Привязку делает тот, у кого реестр есть: `readBodyDoc` на чтении и executor на
 * записи, — поэтому данные целы, а вес первого кадра не двигается.
 *
 * `null` — «конвертировать нечем»: версия из будущего (откат релиза) или не число вовсе. Вниз
 * не штампуем: имена нод могут совпасть, а контент-модель и атрибуты — нет.
 *
 * Возврат — ТОТ ЖЕ объект документа, если менять было нечего: чтение обязано отдавать вход, а
 * не свою копию (блочные id живут чужими схеме атрибутами).
 */
export function upgradeBodyDoc(stored: BodyDoc): BodyDoc | null {
  if (stored.v === DOC_SCHEMA_VERSION) return stored;
  if (stored.v !== 1) return null;
  return { v: DOC_SCHEMA_VERSION, doc: queryAttrsV1ToV2(stored.doc) };
}

/** Обход с СОХРАНЕНИЕМ ИДЕНТИЧНОСТИ: узел пересобирается, только если он сам или потомок изменился. */
function queryAttrsV1ToV2(node: JSONContent): JSONContent {
  const content = node.content;
  const nextContent = content?.map(queryAttrsV1ToV2);
  const contentChanged = nextContent?.some((child, i) => child !== content?.[i]) === true;
  if (node.type !== 'queryBlock') {
    return contentChanged ? { ...node, content: nextContent } : node;
  }
  const attrs = node.attrs ?? {};
  if (!('query' in attrs)) return contentChanged ? { ...node, content: nextContent } : node;
  const { query, ...rest } = attrs as Record<string, unknown>;
  return {
    ...node,
    attrs: { ...rest, ast: null, text: typeof query === 'string' ? query : '' },
    ...(nextContent === undefined ? {} : { content: nextContent }),
  };
}
