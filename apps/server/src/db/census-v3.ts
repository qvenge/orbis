// Read-only перепись корпуса тел ПЕРЕД выкаткой формата тела v3 (спека страниц 1а §5.9, Ф-1а-22).
//
// Зачем. С v3 строка-маркер (`{{title}}`, `{{columns}}`, `{{card: …}}`) в уже лежащем теле
// перестаёт быть текстом и становится блоком, а блок данных с `display=table`/`list` начинает
// рисоваться таблицей или списком. Числа владелец видит ДО прода — чтобы не удивиться, открыв
// заметку. Это не гейт: текст ни в одном случае не теряется.
//
// Цикл живёт здесь, а не в `scripts/ops.ts`, по той же причине, что у `audit-bodies`: прод-обёртка
// тестами не покрыта по построению, а порционность и счёт проверяются здесь без базы.
import { type BodyDoc, bodyDocError, parseBody, upgradeBodyDoc } from '@orbis/shared/doc';
import { type PageNode, parsePageText } from '@orbis/shared/doc/page-grammar';
import { maskQuotedValues } from '@orbis/shared/query';
import type { JSONContent } from '@tiptap/core';

/** Строка корпуса: тело и хранимый документ (`body_doc`, `null` — документа ещё нет). */
export type CensusV3Row = { id: string; body: string | null; bodyDoc: unknown };

export interface CensusV3Io {
  /** Строки с `id > afterId`, по возрастанию id, не больше `limit` штук. */
  selectBatch(limit: number, afterId: string): Promise<CensusV3Row[]>;
}

/**
 * Отличие от «Интерфейсов» брифа задачи 8 (фикс-раунд 1, F2): одно число `becomeBlocks` разделено
 * на два по наличию документа — у этих групп разные последствия; добавлен список id для
 * `brokenMarkers`; строка корпуса несёт сам `bodyDoc`, а не признак `bodyDocNull` — по нему
 * считается `display=`.
 */
export interface CensusV3Result {
  total: number;
  withoutDoc: number;
  /**
   * Тела БЕЗ документа, где строка `{{…}}` станет блоком обвязки, карточкой или контейнером:
   * их первое чтение или бэкфилл соберёт документ разбором v3 — и строка станет блоком.
   */
  becomeBlocksNoDoc: number;
  /**
   * Тела С документом, у которых в `body` стоит такой маркер с колонки 0. В редакторе ничего не
   * меняется (документ v2 поднимается тем же деревом, абзац остаётся абзацем), но `body` читают
   * MCP, откат по `prior.body` и первый кадр — они увидят блок.
   */
  markerInBodyWithDoc: number;
  /** Тела с ошибкой разбора контейнера в `body` (текст цел, на экране — плашка). */
  brokenMarkers: number;
  displayTable: number;
  displayList: number;
  /** Не больше `CENSUS_IDS_LIMIT` на список. */
  ids: {
    becomeBlocksNoDoc: string[];
    markerInBodyWithDoc: string[];
    brokenMarkers: string[];
    displayTable: string[];
    displayList: string[];
  };
}

/** Размер порции — как у `audit-bodies`: запросов на запись нет, порция бережёт память. */
export const CENSUS_BATCH = 200;
/** Сколько id печатать на список: для разбора нужен вход в корпус, а не весь его список. */
export const CENSUS_IDS_LIMIT = 50;

/** Начало курсора: меньше любого существующего uuid (та же константа, что у бэкфилла). */
const ID_START = '00000000-0000-0000-0000-000000000000';

/**
 * Ключ `display` в тексте блока данных — для блока БЕЗ дерева (`ast: null`: тело без документа
 * разобрано без реестра, или блок отвергнут при записи). Разбора запроса здесь нет:
 * `parseQueryAst` требует реестра, а перепись идёт сырым пулом по всем графам разом.
 *
 * Грамматика режет запрос по запятой ИЛИ пробелу вне кавычек (`parse-ast.ts`, `SEPARATOR_RE`), а
 * пробелов вокруг `=` не допускает вовсе (`display = "table"` — отказ `SYNTAX`). Поэтому часть
 * `display=table` ищется с разделителем `[\s,]` (или краем) с обеих сторон и без пробелов у `=`, а
 * по МАСКЕ кавычек (`maskQuotedValues`): `title="x, display=table"` — значение, а не форма. Флага
 * `g` нет намеренно: у глобального регэкспа `test` тащит `lastIndex` между вызовами.
 */
const displayRe = (mode: 'table' | 'list') => new RegExp(`(?:^|[\\s,])display=${mode}(?=[\\s,]|$)`);
const DISPLAY_TABLE_RE = displayRe('table');
const DISPLAY_LIST_RE = displayRe('list');

/**
 * Форма показа блока данных документа. У привязанного блока правда — его дерево (`attrs.ast`,
 * `display` разбора), текст не нужен вовсе; у блока без дерева — ключ в тексте по маске кавычек.
 */
function displayOf(attrs: Record<string, unknown> | undefined): 'table' | 'list' | null {
  const ast = attrs?.ast;
  if (typeof ast === 'object' && ast !== null) {
    const display = (ast as { display?: unknown }).display;
    return display === 'table' || display === 'list' ? display : null;
  }
  const text = attrs?.text;
  if (typeof text !== 'string') return null;
  const masked = maskQuotedValues(text.trim());
  if (DISPLAY_TABLE_RE.test(masked)) return 'table';
  if (DISPLAY_LIST_RE.test(masked)) return 'list';
  return null;
}

/** Маркеры в тексте тела — тем же листовым препроходом, что прочтут первый кадр и `parseBody`. */
function scanMarkers(nodes: PageNode[]): { block: boolean; broken: boolean } {
  const found = { block: false, broken: false };
  const walk = (list: PageNode[]): void => {
    for (const node of list) {
      if (node.kind === 'record' || node.kind === 'card') found.block = true;
      else if (node.kind === 'broken') found.broken = true;
      else if (node.kind === 'columns') {
        found.block = true;
        for (const part of node.parts) walk(part);
      } else if (node.kind === 'tabs') {
        found.block = true;
        for (const part of node.parts) walk(part.children);
      }
    }
  };
  walk(nodes);
  return found;
}

/**
 * Документ, который покажет чтение, — правило `readBodyDoc` без привязки к реестру (привязка
 * текста `display=` не меняет, а реестра у переписи нет): годный хранимый документ, поднятый до
 * текущей версии, иначе — разбор `body`. Источник `display=` именно он, а не текст `body`:
 * рисует блок документ, и блок в пункте списка с отступом (его делает блоком токенайзер
 * `queryBlock` внутри куска, а препроход не видит) считается наравне с прочими.
 */
function documentOf(row: CensusV3Row, body: string): JSONContent {
  const stored = row.bodyDoc;
  if (
    typeof stored === 'object' &&
    stored !== null &&
    'v' in stored &&
    'doc' in stored &&
    bodyDocError(stored as BodyDoc) === undefined
  ) {
    const upgraded = upgradeBodyDoc(stored as BodyDoc);
    if (upgraded !== null) return upgraded.doc;
  }
  return parseBody(body).doc;
}

/** Формы показа блоков данных документа — на любой глубине (колонки, вкладки, списки, цитаты). */
function scanDisplay(doc: JSONContent): { table: boolean; list: boolean } {
  const found = { table: false, list: false };
  const walk = (node: JSONContent): void => {
    if (node.type === 'queryBlock') {
      const display = displayOf(node.attrs);
      if (display === 'table') found.table = true;
      if (display === 'list') found.list = true;
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return found;
}

/**
 * Считает корпус. Маркеры — листовым препроходом по `body` (`parsePageText`), а не регэкспом по
 * строкам: многострочный `{{query:…}}` регэксп по строке пропустил бы, а маркер внутри забора
 * кода — посчитал бы. Формы показа — по документу, который покажет чтение (`documentOf`).
 *
 * Тела НЕ печатаются и НЕ покидают процесс: это личные записи, а вывод команды попадает в
 * транскрипты. Наружу выходят только числа и id (uuid — не персональные данные).
 */
export async function censusV3(io: CensusV3Io): Promise<CensusV3Result> {
  const result: CensusV3Result = {
    total: 0,
    withoutDoc: 0,
    becomeBlocksNoDoc: 0,
    markerInBodyWithDoc: 0,
    brokenMarkers: 0,
    displayTable: 0,
    displayList: 0,
    ids: {
      becomeBlocksNoDoc: [],
      markerInBodyWithDoc: [],
      brokenMarkers: [],
      displayTable: [],
      displayList: [],
    },
  };
  const count = (key: keyof CensusV3Result['ids'], id: string) => {
    result[key] += 1;
    if (result.ids[key].length < CENSUS_IDS_LIMIT) result.ids[key].push(id);
  };
  let afterId = ID_START;
  for (;;) {
    const rows = await io.selectBatch(CENSUS_BATCH, afterId);
    if (rows.length === 0) break;
    for (const row of rows) {
      result.total += 1;
      afterId = row.id; // выборка отсортирована по id — последний id порции наибольший
      const hasDoc = row.bodyDoc !== null && row.bodyDoc !== undefined;
      if (!hasDoc) result.withoutDoc += 1;
      // `?? ''` — про прод: его схема та, что развёрнута, и NULL не должен рвать перепись.
      // Переводы строк — как у `parseBody`: он нормализует их до препрохода.
      const body = String(row.body ?? '').replace(/\r\n?/g, '\n');
      const markers = scanMarkers(parsePageText(body));
      if (markers.block) count(hasDoc ? 'markerInBodyWithDoc' : 'becomeBlocksNoDoc', row.id);
      if (markers.broken) count('brokenMarkers', row.id);
      const display = scanDisplay(documentOf(row, body));
      if (display.table) count('displayTable', row.id);
      if (display.list) count('displayList', row.id);
    }
    if (rows.length < CENSUS_BATCH) break; // неполная порция — корпус исчерпан
  }
  return result;
}

/**
 * Строки вывода — отдельной функцией, чтобы печать проверялась тестом: прод-обёртка
 * (`scripts/ops.ts census-v3`) тестами не покрыта, и её печать уже однажды выдавала
 * `[object Object]` вместо id (урок `formatFlagged` в `audit-bodies.ts`).
 */
export function formatCensusV3(r: CensusV3Result): string[] {
  const lines = [
    `тел всего: ${r.total}`,
    `без документа (body_doc IS NULL): ${r.withoutDoc}`,
    `без документа, строка {{…}} станет блоком при первом чтении или бэкфилле: ${r.becomeBlocksNoDoc}`,
    `с документом, в body маркер с начала строки (редактор — абзац; MCP, откат и первый кадр — блок): ${r.markerInBodyWithDoc}`,
    `ошибка разбора контейнера в body (текст цел, на экране — плашка): ${r.brokenMarkers}`,
    `блоки данных display=table (начнут рисоваться таблицей): ${r.displayTable}`,
    `блоки данных display=list (начнут рисоваться списком): ${r.displayList}`,
  ];
  const ids = (title: string, list: string[]) => {
    if (list.length === 0) return;
    lines.push('', `${title} (не больше ${CENSUS_IDS_LIMIT}):`, ...list.map((id) => `  ${id}`));
  };
  ids('id тел без документа, где строки станут блоками', r.ids.becomeBlocksNoDoc);
  ids('id тел с документом и маркером в body', r.ids.markerInBodyWithDoc);
  ids('id тел с ошибкой разбора контейнера', r.ids.brokenMarkers);
  ids('id тел с display=table', r.ids.displayTable);
  ids('id тел с display=list', r.ids.displayList);
  return lines;
}
