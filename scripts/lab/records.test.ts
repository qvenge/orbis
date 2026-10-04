import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { RECORD_KINDS, searchTextOf } from './scenario';

type Entity = { id: string; title: string; archived: boolean; body: string };
type Stored = Partial<Record<(typeof RECORD_KINDS)[number], string>>;
const source = readFileSync(new URL('./scenario.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('scenario.ts', source, ts.ScriptTarget.Latest, true);
const pick = ast.statements.find(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'pickRecords',
);
const kinds = ast.statements.find(
  (n) =>
    ts.isVariableStatement(n) &&
    n.declarationList.declarations.some((d) => d.name.getText(ast) === 'KIND_SOURCES'),
);
if (!pick || !kinds) throw new Error('Не найдены actual pickRecords/KIND_SOURCES');
// Исполняем ровно закрытую функцию сценария и её правила вида. Подменены только IO: браузер и домашний records.json.
const compiled = ts.transpileModule(`${kinds.getText(ast)}\n${pick.getText(ast)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function fixture(
  stored: Stored,
  options: {
    rows?: Record<string, string[]>;
    missing?: string[];
    archived?: string[];
    unsearchable?: string[];
    firstUnsearchable?: string[];
    aliases?: Record<string, string>;
    bodies?: Record<string, string>;
  } = {},
) {
  const notes: string[] = [];
  const reads: string[] = [];
  const searched = new Set<string>();
  let written: Stored | undefined;
  const entity = (key: string): Entity => {
    const id = options.aliases?.[key] ?? key;
    return {
      id,
      title: id,
      archived: options.archived?.includes(id) ?? false,
      body: options.bodies?.[id] ?? '',
    };
  };
  const actual = new Function(
    'existsSync',
    'readFileSync',
    'writeFileSync',
    'RECORDS_FILE',
    'trpcCall',
    'searchFinds',
    'searchTextOf',
    'RECORD_KINDS',
    `${compiled}\nreturn pickRecords;`,
  )(
    () => true,
    () => JSON.stringify(stored),
    (_: string, data: string) => {
      written = JSON.parse(data);
    },
    '/fixture/records.json',
    async (_: unknown, method: string, input: { id?: string; query?: string }) => {
      if (method === 'entity.get') {
        reads.push(input.id!);
        return options.missing?.includes(input.id!) ? null : { entity: entity(input.id!) };
      }
      return (options.rows?.[input.query!] ?? []).map(entity);
    },
    async (_: unknown, id: string) => {
      const first = !searched.has(id);
      searched.add(id);
      return (
        !options.unsearchable?.includes(id) && !(first && options.firstUnsearchable?.includes(id))
      );
    },
    searchTextOf,
    RECORD_KINDS,
  ) as (
    _: unknown,
    notes: string[],
  ) => Promise<Partial<Record<(typeof RECORD_KINDS)[number], Entity>>>;
  return { out: await actual({}, notes), notes, reads, written };
}

describe('actual лаборатория: сохранённые виды и перевыбор', () => {
  test('замена раннего вида не забирает сохранённый id позднего вида', async () => {
    const r = await fixture(
      { task: 'missing', note: 'future' },
      { missing: ['missing'], rows: { 'aspect=orbis/task, limit=15': ['future', 'replacement'] } },
    );
    expect(r.out.task?.id).toBe('replacement');
    expect(r.out.note?.id).toBe('future');
    expect(r.written).toEqual({ task: 'replacement', note: 'future' });
  });
  test('повтор stored id остаётся первым видом, поздний вид отмечен и перевыбран', async () => {
    const r = await fixture(
      { task: 'duplicate', note: 'duplicate' },
      { rows: { 'aspect=orbis/note, limit=15': ['duplicate', 'replacement'] } },
    );
    expect(r.out.task?.id).toBe('duplicate');
    expect(r.out.note?.id).toBe('replacement');
    expect(
      r.notes.some((n) => n.includes('уже сохранена для другого вида') && n.includes('несравним')),
    ).toBe(true);
    expect(r.reads.filter((id) => id === 'duplicate')).toHaveLength(1);
  });
  test('разные пригодные stored записи сохранены без переписи файла', async () => {
    const r = await fixture({
      task: 'task',
      note: 'note',
      'page-with-blocks': 'page',
      project: 'project',
      'no-blocks': 'plain',
    });
    expect(Object.values(r.out).map((e) => e?.id)).toEqual([
      'task',
      'note',
      'page',
      'project',
      'plain',
    ]);
    expect(r.written).toBeUndefined();
    expect(r.notes).toEqual([]);
  });
  test('резервируются canonical returned ids, включая разные stored spelling', async () => {
    const r = await fixture(
      { task: 'UPPER', note: 'canonical' },
      {
        aliases: { UPPER: 'canonical' },
        rows: { 'aspect=orbis/note, limit=15': ['canonical', 'replacement'] },
      },
    );
    expect(r.out.task?.id).toBe('canonical');
    expect(r.out.note?.id).toBe('replacement');
  });
  for (const why of ['missing', 'archived', 'unsearchable'] as const) {
    test(`непригодный stored (${why}) не резервирует кандидата`, async () => {
      const r = await fixture(
        { task: 'replacement', note: 'invalid' },
        {
          [why]: ['invalid'],
          rows: { 'aspect=orbis/note, limit=15': ['candidate'] },
        },
      );
      expect(r.out.note?.id).toBe('candidate');
      expect(r.notes.some((n) => n.includes('(invalid)') && n.includes('несравним'))).toBe(true);
    });
  }
  for (const why of ['missing', 'archived', 'firstUnsearchable'] as const) {
    test(`отказ проверки stored (${why}) не блокирует id, вернувшийся пригодным в query`, async () => {
      const r = await fixture(
        { task: 'returned', note: 'keeper' },
        {
          [why]: ['returned'],
          rows: { 'aspect=orbis/task, limit=15': ['returned', 'replacement'] },
        },
      );
      // Между preflight и query запись стала пригодна; строка query — текущая eligible выдача сервера.
      expect(r.out.task?.id).toBe('returned');
      expect(r.out.note?.id).toBe('keeper');
    });
  }
  test('правила fits и поиска кандидатов остались настоящими правилами сценария', async () => {
    const r = await fixture(
      {},
      {
        rows: {
          'aspect=orbis/page, limit=30': ['plain', 'hidden', 'page'],
          'aspect=orbis/note, limit=15': ['blocked', 'plain'],
        },
        bodies: { hidden: '{{query: all}}', page: '{{query: all}}', blocked: '{{title}}' },
        unsearchable: ['hidden', 'blocked'],
      },
    );
    expect(r.out['page-with-blocks']?.id).toBe('page');
    expect(r.out.note?.id).toBe('plain');
    expect(r.out['no-blocks']).toBeUndefined();
  });
});
