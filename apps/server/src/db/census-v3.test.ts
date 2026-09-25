// Перепись корпуса перед форматом тела v3. Базы тесту не нужно: порционность и счёт — свойства
// цикла, а не SQL (тот же приём, что у `audit-bodies.test.ts`).
import { expect, test } from 'bun:test';
import {
  CENSUS_BATCH,
  CENSUS_IDS_LIMIT,
  type CensusV3Io,
  type CensusV3Row,
  censusV3,
  formatCensusV3,
} from './census-v3';

/** Очередь тел с курсором по id — как `WHERE id > … ORDER BY id LIMIT n` в БД. */
function fakeCorpus(rows: Array<Omit<CensusV3Row, 'id'>>): {
  io: CensusV3Io;
  selects: Array<{ limit: number; afterId: string }>;
} {
  // Ведущие нули: сравнение строковое, без выравнивания 'id-10' шло бы раньше 'id-2'.
  const all: CensusV3Row[] = rows.map((row, i) => ({
    id: `id-${String(i).padStart(5, '0')}`,
    ...row,
  }));
  const selects: Array<{ limit: number; afterId: string }> = [];
  return {
    selects,
    io: {
      selectBatch: async (limit, afterId) => {
        selects.push({ limit, afterId });
        return all.filter((r) => r.id > afterId).slice(0, limit);
      },
    },
  };
}

const PLAIN = 'обычная заметка\n\n```\n{{title}}\n```'; // маркер в заборе кода — текст кода
const TITLE_LINE = 'до\n{{title}}\nпосле';
const CONTAINER =
  '{{columns}}\n{{column}}\nа\n{{/column}}\n{{column}}\nб\n{{/column}}\n{{/columns}}';
const UNCLOSED = '{{columns}}\n{{column}}\nтекст';
// Блок `list` многострочный: регэксп по строке его пропустил бы (recon-plan-4, T4).
const DISPLAY =
  '{{query:aspect=orbis/task, display=table}}\n\n{{query:aspect=orbis/goal,\n  display=list}}';

/** Документ v2, как он лежит у тела, сохранённого до выкатки: абзац с текстом маркера. */
const v2Doc = (...content: unknown[]) => ({ v: 2, doc: { type: 'doc', content } });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

test('корпус без документов: счётчики и id по группам', async () => {
  const corpus = fakeCorpus([
    { body: PLAIN, bodyDoc: null },
    { body: TITLE_LINE, bodyDoc: null },
    { body: CONTAINER, bodyDoc: null },
    { body: UNCLOSED, bodyDoc: null },
    { body: DISPLAY, bodyDoc: null },
  ]);
  expect(await censusV3(corpus.io)).toEqual({
    total: 5,
    withoutDoc: 5,
    becomeBlocksNoDoc: 2,
    markerInBodyWithDoc: 0,
    brokenMarkers: 1,
    displayTable: 1,
    displayList: 1,
    ids: {
      becomeBlocksNoDoc: ['id-00001', 'id-00002'],
      markerInBodyWithDoc: [],
      brokenMarkers: ['id-00003'],
      displayTable: ['id-00004'],
      displayList: ['id-00004'],
    },
  });
});

test('с документом маркер в body — своя группа; display= — по документу, который покажет чтение', async () => {
  const corpus = fakeCorpus([
    // Документ v2: абзац «{{title}}» — в редакторе он и останется абзацем, а body несёт маркер.
    { body: TITLE_LINE, bodyDoc: v2Doc(para('до'), para('{{title}}'), para('после')) },
    // display=list живёт в документе (v2 queryBlock); body пуст — источник именно документ.
    {
      body: '',
      bodyDoc: v2Doc({
        type: 'queryBlock',
        attrs: { ast: null, text: 'aspect=orbis/task, display=list' },
      }),
    },
    // Битый документ — чтение пересоберёт тело из body, и перепись считает так же.
    { body: DISPLAY, bodyDoc: { v: 2, doc: 'мусор' } },
  ]);
  const r = await censusV3(corpus.io);
  expect(r.withoutDoc).toBe(0);
  expect(r.becomeBlocksNoDoc).toBe(0);
  expect(r.markerInBodyWithDoc).toBe(1);
  expect(r.ids.markerInBodyWithDoc).toEqual(['id-00000']);
  expect(r.ids.displayList).toEqual(['id-00001', 'id-00002']);
  expect(r.ids.displayTable).toEqual(['id-00002']);
});

test('display=table внутри колонки и в пункте списка с отступом — считается (F2)', async () => {
  const inColumn = [
    '{{columns}}',
    '{{column}}',
    '{{query:aspect=orbis/task, display=table}}',
    '{{/column}}',
    '{{column}}',
    'б',
    '{{/column}}',
    '{{/columns}}',
  ].join('\n');
  // Отступ — препроход маркером не считает, а токенайзер queryBlock в куске делает блоком.
  const inListItem = '- пункт\n  {{query:aspect=orbis/task, display=table}}';
  const corpus = fakeCorpus([
    { body: inColumn, bodyDoc: null },
    { body: inListItem, bodyDoc: null },
  ]);
  const r = await censusV3(corpus.io);
  expect(r.displayTable).toBe(2);
  expect(r.ids.displayTable).toEqual(['id-00000', 'id-00001']);
});

test('маркеры на любой глубине и после \\r\\n; NULL-тело не рвёт перепись; ложные display — нет', async () => {
  const nested =
    '{{tabs}}\r\n{{tab: А}}\r\n{{query:aspect=orbis/task, display=table}}\r\n{{/tab}}\r\n{{/tabs}}';
  const corpus = fakeCorpus([
    { body: nested, bodyDoc: null },
    { body: null, bodyDoc: null },
    // `display=tablet` и ключ посреди значения — не форма показа.
    { body: '{{query:aspect=orbis/task, display=tablet}}', bodyDoc: null },
    { body: '{{query:title="display=table"}}', bodyDoc: null },
    // Пробелы у `=` грамматика отвергает (SYNTAX) — на экране плашка, а не таблица (B-I1).
    { body: '{{query:aspect=orbis/task, display = "table"}}', bodyDoc: null },
  ]);
  const r = await censusV3(corpus.io);
  expect(r.becomeBlocksNoDoc).toBe(1);
  expect(r.displayTable).toBe(1);
  expect(r.ids.displayTable).toEqual(['id-00000']);
  expect(r.total).toBe(5);
});

test('корпус читается ПОРЦИЯМИ с курсором, ни одна строка не теряется', async () => {
  const n = CENSUS_BATCH * 2 + 7;
  const corpus = fakeCorpus(Array.from({ length: n }, () => ({ body: PLAIN, bodyDoc: null })));
  const r = await censusV3(corpus.io);
  expect(r.total).toBe(n);
  expect(corpus.selects.map((s) => s.limit)).toEqual([CENSUS_BATCH, CENSUS_BATCH, CENSUS_BATCH]);
  expect(corpus.selects.map((s) => s.afterId)).toEqual([
    '00000000-0000-0000-0000-000000000000',
    `id-${String(CENSUS_BATCH - 1).padStart(5, '0')}`,
    `id-${String(CENSUS_BATCH * 2 - 1).padStart(5, '0')}`,
  ]);
});

test('id на список — не больше предела, счётчик при этом полный', async () => {
  const n = CENSUS_IDS_LIMIT + 10;
  const corpus = fakeCorpus(
    Array.from({ length: n }, () => ({ body: `${TITLE_LINE}\n\n${UNCLOSED}`, bodyDoc: null })),
  );
  const r = await censusV3(corpus.io);
  expect(r.becomeBlocksNoDoc).toBe(n);
  expect(r.brokenMarkers).toBe(n);
  expect(r.ids.becomeBlocksNoDoc).toHaveLength(CENSUS_IDS_LIMIT);
  expect(r.ids.brokenMarkers).toHaveLength(CENSUS_IDS_LIMIT);
});

test('печать: числа и id поимённо под понятными подписями, тел в выводе нет', async () => {
  const corpus = fakeCorpus([
    { body: TITLE_LINE, bodyDoc: null },
    { body: DISPLAY, bodyDoc: null },
    { body: UNCLOSED, bodyDoc: v2Doc(para('текст')) },
    { body: TITLE_LINE, bodyDoc: v2Doc(para('{{title}}')) },
  ]);
  const lines = formatCensusV3(await censusV3(corpus.io));
  const out = lines.join('\n');
  expect(out).toContain('тел всего: 4');
  expect(out).toContain(
    'без документа, строка {{…}} станет блоком при первом чтении или бэкфилле: 1',
  );
  expect(out).toContain('с документом, в body маркер с начала строки');
  expect(out).toContain('id тел с ошибкой разбора контейнера');
  for (const id of ['  id-00000', '  id-00001', '  id-00002', '  id-00003']) {
    expect(lines).toContain(id);
  }
  expect(out).not.toContain('[object Object]');
  // Ни строки тела: вывод команды попадает в транскрипты.
  expect(out).not.toContain('после');
  expect(out).not.toContain('orbis/goal');
  expect(out).not.toContain('текст\n');
});

test('display= через пробел — форма; ключ внутри кавычек — нет; у привязанного блока — по дереву (B-I1)', async () => {
  const corpus = fakeCorpus([
    // Грамматика режет по запятой ИЛИ пробелу вне кавычек: это таблица и список.
    { body: '{{query:aspect=orbis/task display=table}}', bodyDoc: null },
    { body: '{{query:aspect=orbis/task, display=table limit=5}}', bodyDoc: null },
    { body: '{{query:display=list sortBy=orbis/updated_at:desc}}', bodyDoc: null },
    // Ключ внутри значения в кавычках — не форма показа.
    { body: '{{query:title="x, display=table"}}', bodyDoc: null },
    { body: '{{query:title="a display=list b"}}', bodyDoc: null },
    // Привязанный блок: форма только в дереве, в тексте её нет — правда блока в `ast`.
    {
      body: '',
      bodyDoc: v2Doc({
        type: 'queryBlock',
        attrs: { ast: { filter: null, display: 'table' }, text: 'aspect=orbis/task' },
      }),
    },
    // Привязанный блок с ложным ключом в заголовке: дерево говорит «формы нет».
    {
      body: '',
      bodyDoc: v2Doc({
        type: 'queryBlock',
        attrs: {
          ast: { filter: null, title: 'x, display=table' },
          text: 'title="x, display=table"',
        },
      }),
    },
  ]);
  const r = await censusV3(corpus.io);
  expect(r.ids.displayTable).toEqual(['id-00000', 'id-00001', 'id-00005']);
  expect(r.ids.displayList).toEqual(['id-00002']);
});
