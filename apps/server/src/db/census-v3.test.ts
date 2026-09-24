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

test('корпус из пяти тел: счётчики и id по «Интерфейсам» задачи 8', async () => {
  const corpus = fakeCorpus([
    { body: PLAIN, bodyDocNull: false },
    { body: TITLE_LINE, bodyDocNull: true },
    { body: CONTAINER, bodyDocNull: false },
    { body: UNCLOSED, bodyDocNull: false },
    { body: DISPLAY, bodyDocNull: true },
  ]);
  expect(await censusV3(corpus.io)).toEqual({
    total: 5,
    withoutDoc: 2,
    becomeBlocks: 2,
    brokenMarkers: 1,
    displayTable: 1,
    displayList: 1,
    ids: {
      becomeBlocks: ['id-00001', 'id-00002'],
      displayTable: ['id-00004'],
      displayList: ['id-00004'],
    },
  });
});

test('маркеры на любой глубине и после \\r\\n; NULL-тело не рвёт перепись', async () => {
  const nested =
    '{{tabs}}\r\n{{tab: А}}\r\n{{query:aspect=orbis/task, display = "table"}}\r\n{{/tab}}\r\n{{/tabs}}';
  const corpus = fakeCorpus([
    { body: nested, bodyDocNull: false },
    { body: null, bodyDocNull: true },
    // `display=tablet` и ключ посреди значения — не форма показа.
    { body: '{{query:aspect=orbis/task, display=tablet}}', bodyDocNull: false },
    { body: '{{query:title="display=table"}}', bodyDocNull: false },
  ]);
  const r = await censusV3(corpus.io);
  expect(r.becomeBlocks).toBe(1);
  expect(r.displayTable).toBe(1);
  expect(r.ids.displayTable).toEqual(['id-00000']);
  expect(r.total).toBe(4);
});

test('корпус читается ПОРЦИЯМИ с курсором, ни одна строка не теряется', async () => {
  const n = CENSUS_BATCH * 2 + 7;
  const corpus = fakeCorpus(Array.from({ length: n }, () => ({ body: PLAIN, bodyDocNull: false })));
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
    Array.from({ length: n }, () => ({ body: TITLE_LINE, bodyDocNull: false })),
  );
  const r = await censusV3(corpus.io);
  expect(r.becomeBlocks).toBe(n);
  expect(r.ids.becomeBlocks).toHaveLength(CENSUS_IDS_LIMIT);
});

test('печать: числа и id поимённо, тел в выводе нет', async () => {
  const corpus = fakeCorpus([
    { body: TITLE_LINE, bodyDocNull: false },
    { body: DISPLAY, bodyDocNull: false },
  ]);
  const lines = formatCensusV3(await censusV3(corpus.io));
  const out = lines.join('\n');
  expect(out).toContain('тел всего: 2');
  expect(out).toContain('станут блоками');
  expect(lines).toContain('  id-00000');
  expect(lines).toContain('  id-00001');
  expect(out).not.toContain('[object Object]');
  // Ни строки тела: вывод команды попадает в транскрипты.
  expect(out).not.toContain('после');
  expect(out).not.toContain('orbis/goal');
});
