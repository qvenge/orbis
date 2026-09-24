// Read-only перепись корпуса тел ПЕРЕД выкаткой формата тела v3 (спека страниц 1а §5.9, Ф-1а-22).
//
// Зачем. С v3 строка-маркер (`{{title}}`, `{{columns}}`, `{{card: …}}`) в уже лежащем теле
// перестаёт быть текстом и становится блоком, а блок данных с `display=table`/`list` начинает
// рисоваться таблицей или списком. Оба числа владелец видит ДО прода — чтобы не удивиться,
// открыв заметку. Это не гейт: текст ни в одном случае не теряется.
//
// Цикл живёт здесь, а не в `scripts/ops.ts`, по той же причине, что у `audit-bodies`: прод-обёртка
// тестами не покрыта по построению, а порционность и счёт проверяются здесь без базы.
import { type PageNode, parsePageText } from '@orbis/shared/doc/page-grammar';

/** Строка корпуса: тело и признак «документа ещё нет». Самого документа перепись не читает. */
export type CensusV3Row = { id: string; body: string | null; bodyDocNull: boolean };

export interface CensusV3Io {
  /** Строки с `id > afterId`, по возрастанию id, не больше `limit` штук. */
  selectBatch(limit: number, afterId: string): Promise<CensusV3Row[]>;
}

export interface CensusV3Result {
  total: number;
  withoutDoc: number;
  /** Тела, где v3 даёт record/card/columns/tabs, а v2 — абзац. */
  becomeBlocks: number;
  /** Тела с broken-узлом препрохода (текст цел, на экране — плашка). */
  brokenMarkers: number;
  displayTable: number;
  displayList: number;
  /** Не больше `CENSUS_IDS_LIMIT` на список. */
  ids: { becomeBlocks: string[]; displayTable: string[]; displayList: string[] };
}

/** Размер порции — как у `audit-bodies`: запросов на запись нет, порция бережёт память. */
export const CENSUS_BATCH = 200;
/** Сколько id печатать на список: для разбора нужен вход в корпус, а не весь его список. */
export const CENSUS_IDS_LIMIT = 50;

/** Начало курсора: меньше любого существующего uuid (та же константа, что у бэкфилла). */
const ID_START = '00000000-0000-0000-0000-000000000000';

/**
 * Ключ `display` в тексте блока данных — БЕЗ разбора запроса (`parseQueryAst` требует реестра, а
 * перепись идёт сырым пулом по всем графам разом). Ключ стоит в начале части запроса: с начала
 * текста или после запятой; значение — голое или в кавычках. Флага `g` нет намеренно: у
 * глобального регэкспа `test` тащит `lastIndex` между вызовами.
 */
const displayRe = (mode: 'table' | 'list') =>
  new RegExp(`(?:^|,)\\s*display\\s*=\\s*"?${mode}"?\\s*(?:,|$)`);
const DISPLAY_TABLE_RE = displayRe('table');
const DISPLAY_LIST_RE = displayRe('list');

/** Что нашлось в теле: обход дерева препрохода на любой глубине. */
function scan(nodes: PageNode[]): {
  block: boolean;
  broken: boolean;
  table: boolean;
  list: boolean;
} {
  const found = { block: false, broken: false, table: false, list: false };
  const walk = (list: PageNode[]): void => {
    for (const node of list) {
      switch (node.kind) {
        case 'record':
        case 'card':
          found.block = true;
          break;
        case 'columns':
          found.block = true;
          for (const part of node.parts) walk(part);
          break;
        case 'tabs':
          found.block = true;
          for (const part of node.parts) walk(part.children);
          break;
        case 'query':
          if (DISPLAY_TABLE_RE.test(node.text)) found.table = true;
          if (DISPLAY_LIST_RE.test(node.text)) found.list = true;
          break;
        case 'broken':
          found.broken = true;
          break;
        case 'text':
          break;
      }
    }
  };
  walk(nodes);
  return found;
}

/**
 * Считает корпус. Разборщик — тот же листовой препроход, что пойдёт в прод (`parsePageText`), а
 * не регэксп по строкам: многострочный `{{query:…}}` регэксп по строке пропустил бы, а маркер
 * внутри забора кода — посчитал бы.
 *
 * Тела НЕ печатаются и НЕ покидают процесс: это личные записи, а вывод команды попадает в
 * транскрипты. Наружу выходят только числа и id (uuid — не персональные данные).
 */
export async function censusV3(io: CensusV3Io): Promise<CensusV3Result> {
  const result: CensusV3Result = {
    total: 0,
    withoutDoc: 0,
    becomeBlocks: 0,
    brokenMarkers: 0,
    displayTable: 0,
    displayList: 0,
    ids: { becomeBlocks: [], displayTable: [], displayList: [] },
  };
  const note = (list: string[], id: string) => {
    if (list.length < CENSUS_IDS_LIMIT) list.push(id);
  };
  let afterId = ID_START;
  for (;;) {
    const rows = await io.selectBatch(CENSUS_BATCH, afterId);
    if (rows.length === 0) break;
    for (const row of rows) {
      result.total += 1;
      afterId = row.id; // выборка отсортирована по id — последний id порции наибольший
      if (row.bodyDocNull) result.withoutDoc += 1;
      // `?? ''` — про прод: его схема та, что развёрнута, и NULL не должен рвать перепись.
      // Переводы строк — как у `parseBody`: он нормализует их до препрохода.
      const body = String(row.body ?? '').replace(/\r\n?/g, '\n');
      const found = scan(parsePageText(body));
      if (found.block) {
        result.becomeBlocks += 1;
        note(result.ids.becomeBlocks, row.id);
      }
      if (found.broken) result.brokenMarkers += 1;
      if (found.table) {
        result.displayTable += 1;
        note(result.ids.displayTable, row.id);
      }
      if (found.list) {
        result.displayList += 1;
        note(result.ids.displayList, row.id);
      }
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
    `станут блоками (строка {{…}} → блок обвязки, карточка или контейнер): ${r.becomeBlocks}`,
    `получат плашку ошибки разбора (текст цел): ${r.brokenMarkers}`,
    `блоки данных display=table (начнут рисоваться таблицей): ${r.displayTable}`,
    `блоки данных display=list (начнут рисоваться списком): ${r.displayList}`,
  ];
  const ids = (title: string, list: string[]) => {
    if (list.length === 0) return;
    lines.push('', `${title} (не больше ${CENSUS_IDS_LIMIT}):`, ...list.map((id) => `  ${id}`));
  };
  ids('id тел, где строки станут блоками', r.ids.becomeBlocks);
  ids('id тел с display=table', r.ids.displayTable);
  ids('id тел с display=list', r.ids.displayList);
  return lines;
}
