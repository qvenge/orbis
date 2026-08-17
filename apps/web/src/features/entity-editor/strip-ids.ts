import type { JSONContent } from '@tiptap/core';

/**
 * Сравнение документов «по смыслу» — и список типов, у которых блочный id за смысл не считается.
 *
 * Файл ЛИСТОВОЙ и обязан таким остаться: рантайм-импортов у него нет ни одного (тип JSONContent
 * стирается компилятором). Сравнение зовёт не только редактор, но и автосохранение
 * (useBodySave), а его монтирует экран detail — он открывается ЗАДОЛГО до того, как понадобится
 * редактор, и в том и смысл двухфазного монтирования. Лежи этот код в BodyEditor.tsx или тяни
 * он `UNIQUE_ID_TYPES` из `extensions.ts`, схема Tiptap (~156 кБ gzip) уехала бы в чанк detail
 * вместе с ним. Поэтому список живёт ЗДЕСЬ, а конфиг расширения читает его отсюда, а не наоборот.
 */

/**
 * Блочные id: типы, которым их ставит UniqueID (`extensions.ts` берёт список отсюда, поэтому
 * «чему ставят» и «у чего снимают при сравнении» не могут разойтись).
 *
 * readonly, а не голый string[]: список читают два модуля, и общий изменяемый массив кто угодно
 * мог бы дополнить у себя — с тихим расхождением между этими двумя ответами.
 */
export const UNIQUE_ID_TYPES: readonly string[] = [
  'paragraph',
  'heading',
  'queryBlock',
  'rawBlock',
  'listItem',
  'taskItem',
];

/**
 * UniqueID кладёт `attrs.id` во все перечисленные ему блоки ОТДЕЛЬНОЙ транзакцией уже после
 * монтирования, поэтому по строковому равенству документ «менялся» при каждом открытии записи —
 * и через две секунды уходило автосохранение без единого нажатия клавиши: рос updated_at, в
 * журнал ложился фантомный entity_updated, и «отмени последнее» отменяло бы открытие записи
 * (ревью Б4).
 *
 * Снимается атрибут ТОЛЬКО у тех типов, которым его ставит UniqueID. Прежний фильтр по одному
 * имени `id` на любой глубине был правилен ровно потому, что сегодня ни одна другая нода схемы
 * атрибута с таким именем не имеет: появись он у ноды-новичка (или переедь туда цель чипа) —
 * правка, меняющая только его, молча перестала бы считаться правкой и не сохранялась бы.
 * Долг Задачи 7.
 */
export function stripIds(node: JSONContent): JSONContent {
  const { attrs, content, ...rest } = node;
  const managed = typeof node.type === 'string' && UNIQUE_ID_TYPES.includes(node.type);
  const cleaned =
    attrs && managed
      ? Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'id'))
      : attrs;
  return {
    ...rest,
    ...(cleaned && Object.keys(cleaned).length ? { attrs: cleaned } : {}),
    ...(content ? { content: content.map(stripIds) } : {}),
  };
}

/**
 * Ключи сортируются, и это НЕ перестраховка. Сравниваются документы из двух источников —
 * разбора markdown и `editor.getJSON()`, — и порядок полей у них разный: parseBody отдаёт
 * текстовый узел как `{type,text,marks}`, а ProseMirror после прохода через схему —
 * `{type,marks,text}` (замерено на сиде «Жизнь»). Голое `JSON.stringify`-сравнение из брифа
 * считало бы правкой открытие ЛЮБОЙ записи с жирным, курсивом или ссылкой в тексте —
 * то есть возвращало бы фантомную запись на самом бытовом теле.
 */
function stable(doc: JSONContent): string {
  return JSON.stringify(doc, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
}

/** Равны ли документы по смыслу: с точностью до блочных id и порядка ключей. */
export const sameDoc = (a: JSONContent, b: JSONContent): boolean =>
  stable(stripIds(a)) === stable(stripIds(b));
