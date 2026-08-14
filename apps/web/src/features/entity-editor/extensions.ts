import { DOC_EXTENSIONS } from '@orbis/shared/doc';
import type { AnyExtension } from '@tiptap/core';
import UniqueID from '@tiptap/extension-unique-id';

/**
 * Блочные id сегодня не читает никто. Ставятся с первого дня потому, что на них ляжет будущий
 * блочный контракт агента (`body_replace_block(id, md)`): добавить их позже — мигрировать все
 * документы, добавить сейчас — один параметр расширения. В markdown-проекцию id не печатаются.
 *
 * Расширение живёт ТОЛЬКО здесь и не входит в DOC_EXTENSIONS: документы, которые сервер
 * собирает из строкового body модели, приезжают без id, и это нормально. Оно АТРИБУТНОЕ, а не
 * нодовое, — потому и безопасно: серверный гейт спрашивает схему документа напрямую, и любая
 * лишняя НОДА или МАРКА редактора сделала бы нерабочим каждое сохранение, а незнакомый
 * `attrs.id` разбор молча отбрасывает до проверки схемы (проверено Задачей 4).
 */
const UNIQUE_ID_TYPES = ['paragraph', 'heading', 'queryBlock', 'rawBlock', 'listItem', 'taskItem'];

/**
 * Состав редактора: схема документа + блочные id.
 *
 * Link и trailingNode настроены в САМОЙ схеме (@orbis/shared/doc, Задача 2) — здесь их не
 * трогать: пересборка StarterKit тут затёрла бы конфиг схемы. Ровно так в плане v1 умер белый
 * список протоколов: `DOC_EXTENSIONS.map(e => e.name === 'link' ? …)` не находил никого, потому
 * что Link живёт ВНУТРИ StarterKit, и map по имени молча возвращал массив без изменений.
 *
 * Задача 8 заменяет здесь EntityRef → EntityRefWithView, Задача 9 — QueryBlock →
 * QueryBlockWithView (фильтром+concat над DOC_EXTENSIONS ВНУТРИ этого массива, а не
 * пересборкой файла), Задача 11 добавляет MoveBlock в конец, Задача 10 — плейсхолдер.
 * Больше этот файл не меняется.
 */
export const EDITOR_EXTENSIONS: AnyExtension[] = [
  ...DOC_EXTENSIONS,
  UniqueID.configure({ types: UNIQUE_ID_TYPES }),
];
