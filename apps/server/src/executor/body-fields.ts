// apps/server/src/executor/body-fields.ts
//
// ОДИН путь «markdown-строка → четыре колонки тела» на всех, кто кладёт в тело строку.
//
// Живёт отдельным модулем, а не приватной функцией исполнителя, потому что вызывающих стало
// ПЯТЬ и один из них — вне исполнителя: сид онбординга пишет строки смарт-листов напрямую
// (до Задачи 23, где сиды переезжают на `execute()`). Импортировать ради трёх строк весь
// `executor.ts` значило бы завести ребро «сид → исполнитель» ради конверсии, которая ни
// журнала, ни транзакции не требует.
import {
  type BodyDoc,
  bindQueryBlocks,
  bodyRefsFromDoc,
  parseBody,
  queryRefsFromDoc,
  serializeBody,
} from '@orbis/shared/doc';
import { parseRegistryOfSnapshot } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';

/**
 * Четыре поля тела из markdown-строки: канон, документ и два индекса имён. Второй экземпляр
 * этих строчек означал бы, что засеянное тело и написанное автором считаются по разным
 * правилам, и расхождение вылезло бы не здесь, а в backlinks, в держателях свойства или в
 * первом же пересчёте канона.
 *
 * Возвращает ПОЛЯ, а не пишет патч, потому что общая у вызывающих только конверсия, а
 * семантика записи у каждого своя: create кладёт их в values (и вдобавок в body_before_doc по
 * своему правилу), update — в EntityPatch рядом с preserveBodyBeforeDoc, attach расширяет свой
 * узкий .set() ТОЛЬКО при засеве, сид — в строку `insert`. Хелпер, пишущий патч, пришлось бы
 * параметризовать всеми различиями — то есть вернуть их обратно вызывающим, но уже неявно.
 */
export function bodyFieldsFromMarkdown(
  markdown: string,
  reg: RegistrySnapshot,
): {
  body: string;
  bodyDoc: BodyDoc;
  bodyRefs: string[];
  queryRefs: string[];
} {
  // КАНОН, а не строка входа: body — производная документа (вердикт Б1). Между разбором и
  // печатью стоит ПРИВЯЗКА (Р-21-1): реестра у `canonicalizeBody` нет и быть не должно, а без
  // привязки в `body_doc` уехали бы блоки без дерева, и единственным, кто их когда-либо
  // разберёт, оказалось бы чтение — которое в БД не пишет.
  const doc = bindQueryBlocks(parseBody(markdown), parseRegistryOfSnapshot(reg));
  // Печать — ПОСЛЕ привязки: `text` блока стал key-формой, и `body` обязан её нести, иначе
  // проекция разошлась бы с документом на первом же смарт-листе.
  const body = serializeBody(doc);
  // Ссылки — из ДЕРЕВА ∪ raw-блоков (Б2): backlinks не зависят от разбираемости тела.
  return {
    body,
    bodyDoc: doc,
    bodyRefs: bodyRefsFromDoc(doc),
    queryRefs: queryRefsFromDoc(doc),
  };
}
