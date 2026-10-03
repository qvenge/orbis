// scripts/write-paths.test.ts — СТОРОЖА ПУТЕЙ ЗАПИСИ (спека скорости §10.1, §10.3, §13.3; РП-15).
// (1) граф — только модули executor'а: `executor/*.ts`, `registry/{ops,ref,version,extensions}.ts` (§10.1: executor, undo,
//     пересчёт предков, зеркала ссылок, слияние реестра). `registry/extensions.ts` зовёт ещё и сев (`seed/setup-graph.ts`,
//     маска при заведении — исключение §10.3), `registry/version.ts` — ещё и `db/seed-registries.ts`: сторож стережёт МЕСТО
//     записи, а не цепочку вызова; вызов из сева назван здесь, писатель остаётся одним модулем;
// (2) журнал (`action_journal`, `action_journal_entities`) — только синк `executor/journal.ts` (отмена пишет через него);
// (3) разговоры (`chat_messages`, `chat_threads`) — только модуль разговоров `chat/*`;
// (4) колонки тела `body_revision`, `body_action_id`, `body_changed_at` — нигде: их ставит триггер `entities_body_stamp` (РП-15);
// (5) запись в таблицу, названную не литералом (`${…}`), — только поимённо: иначе сторож был бы слеп к ней.
// Не граф и вне списков: замеры `perf_samples` (`routers/perf.ts`), кеш трат (`budget/spent-cache.ts` — свой владелец, §10.1),
// инфраструктура (`oauth/*`, `seed/personal-graph.ts`, `ai/metering.ts`).
// Охват — боевой код `apps/server/src` без `*.test.*`, `src/test/` (обвязка) и `db/migrations/`. Роль токена — AST
// TypeScript: Drizzle `.insert/.update/.delete(<таблица схемы>)` по импорту из `db/schema`, SQL — строковые и шаблонные
// литералы (`${…}` — исходником выражения: `RULE_TABLE[…]` — таблицы носителей правил).
// Чего сторож НЕ видит: таблицу, переданную переменной в Drizzle (`tx.insert(t)`), SQL, собранный конкатенацией строк, ключ
// колонки тела под `...spread`. Виден только ОТСЛЕЖИВАЕМЫЙ файл (`git grep`) — новый файл `git add` сразу.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { type Rule, WRITE_PATH_EXCEPTIONS } from './write-paths.exceptions';

const ROOT = join(import.meta.dir, '..');
const SCHEMA = 'apps/server/src/db/schema.ts';
const SERVER_PATHSPEC = [
  ':(glob)apps/server/src/**/*.ts',
  ':(exclude,glob)apps/server/src/**/*.test.*',
  ':(exclude)apps/server/src/db/migrations/',
  ':(exclude)apps/server/src/test/',
];
const GRAPH = new Set([
  'entities',
  'relations',
  'aspect_definitions',
  'user_settings',
  'entity_origins',
  'entity_versions',
  'property_definitions',
  'relation_role_definitions',
  'contract_definitions',
  'subscription_definitions',
  'action_definitions',
  'registry_deltas',
]);
const RULE_CARRIERS = ['aspect_definitions', 'property_definitions', 'relation_role_definitions']; // RULE_TABLE, registry/ops.ts
const JOURNAL = new Set(['action_journal', 'action_journal_entities']);
const CHAT = new Set(['chat_messages', 'chat_threads']);
const BODY_KEYS = new Set(['bodyRevision', 'bodyActionId', 'bodyChangedAt']);
const OWNED: Partial<Record<Rule, (rel: string) => boolean>> = {
  graph: (rel) =>
    /^apps\/server\/src\/executor\/[^/]+\.ts$/.test(rel) ||
    /^apps\/server\/src\/registry\/(ops|ref|version|extensions)\.ts$/.test(rel),
  journal: (rel) => rel === 'apps/server/src/executor/journal.ts',
  chat: (rel) => rel.startsWith('apps/server/src/chat/'),
};
interface Hit {
  rule: Rule;
  table: string;
  line: number;
}

function git(args: readonly string[], ok: readonly number[]): string[] {
  const res = Bun.spawnSync(['git', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C.UTF-8' },
  });
  if (!ok.includes(res.exitCode))
    throw new Error(
      `сторож путей записи: git ${args[0]} вернул ${res.exitCode}: ${new TextDecoder().decode(res.stderr).trim()}`,
    );
  return new TextDecoder()
    .decode(res.stdout)
    .split('\n')
    .filter((l) => l.trim() !== '');
}
const parse = (rel: string, src: string) =>
  ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(n: ts.Node, visit: (n: ts.Node) => void): void {
  visit(n);
  ts.forEachChild(n, (c) => walk(c, visit));
}

/** Имя переменной Drizzle → имя таблицы — из самой схемы (`export const X = pgTable('x', …)`). */
function schemaTables(): Map<string, string> {
  const out = new Map<string, string>();
  walk(parse(SCHEMA, readFileSync(join(ROOT, SCHEMA), 'utf8')), (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      ts.isIdentifier(n.initializer.expression) &&
      n.initializer.expression.text === 'pgTable'
    ) {
      const first = n.initializer.arguments[0];
      if (first && ts.isStringLiteral(first)) out.set(n.name.text, first.text);
    }
  });
  return out;
}

const WRITE_SQL =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?((?:"?[a-z_][a-z0-9_]*"?|\$\{[^}]*\})(?:\s*,\s*(?:"?[a-z_][a-z0-9_]*"?|\$\{[^}]*\}))*)/gi;
const NOT_A_TABLE = new Set(['set', 'of', 'skip', 'nowait']); // DO UPDATE SET, FOR UPDATE [OF|SKIP LOCKED|NOWAIT]
const BODY_SQL = [
  /\bUPDATE\s+\S+\s+(?:\w+\s+)?SET\b[\s\S]*?\bbody_(?:revision|action_id|changed_at)\s*=/i,
  /\bINSERT\s+INTO\s+\S+\s*\([^)]*\bbody_(?:revision|action_id|changed_at)\b/i,
];

/** Таблицы, в которые пишет SQL-текст; `${…}` — по исходнику выражения. */
export function sqlWrites(text: string): Array<{ table: string; dynamic: boolean }> {
  const out: Array<{ table: string; dynamic: boolean }> = [];
  for (const m of text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').matchAll(WRITE_SQL)) {
    const verb = (m[1] ?? '').toUpperCase();
    // Запятая внутри ${WORLD_TABLES.join(', ')} — часть выражения, а не разделитель таблиц.
    const list = (m[2] ?? '').match(/\$\{[^}]*\}|"?[a-z_][a-z0-9_]*"?/gi) ?? [];
    for (const raw of verb.startsWith('TRUNCATE') ? list : list.slice(0, 1)) {
      const t = raw.trim().replaceAll('"', '');
      if (verb === 'UPDATE' && NOT_A_TABLE.has(t.toLowerCase())) continue;
      if (!t.startsWith('${')) out.push({ table: t.toLowerCase(), dynamic: false });
      else if (t.includes('RULE_TABLE'))
        for (const c of RULE_CARRIERS) out.push({ table: c, dynamic: false });
      else out.push({ table: t, dynamic: true });
    }
  }
  return out;
}
export const bodyColumnSql = (text: string): boolean =>
  BODY_SQL.some((re) => re.test(text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')));

function literalText(n: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n))
    return (
      n.head.text +
      n.templateSpans.map((s) => `\${${s.expression.getText(sf)}}${s.literal.text}`).join('')
    );
  return null;
}
function hasBodyKey(n: ts.Node): boolean {
  let found = false;
  walk(n, (x) => {
    if (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) {
      if ((ts.isIdentifier(x.name) || ts.isStringLiteral(x.name)) && BODY_KEYS.has(x.name.text))
        found = true;
    }
  });
  return found;
}
const byTable = (table: string, line: number): Hit[] => [
  ...(GRAPH.has(table) ? [{ rule: 'graph' as const, table, line }] : []),
  ...(JOURNAL.has(table) ? [{ rule: 'journal' as const, table, line }] : []),
  ...(CHAT.has(table) ? [{ rule: 'chat' as const, table, line }] : []),
];

export function fileHits(rel: string, src: string, tables: Map<string, string>): Hit[] {
  const sf = parse(rel, src);
  const local = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (
      !ts.isImportDeclaration(st) ||
      !ts.isStringLiteral(st.moduleSpecifier) ||
      !/(^|\/)schema$/.test(st.moduleSpecifier.text)
    )
      continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamedImports(b))
      for (const el of b.elements) {
        const t = tables.get((el.propertyName ?? el.name).text);
        if (t) local.set(el.name.text, t);
      }
    if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
  }
  const tableOf = (e: ts.Expression | undefined): string | null => {
    if (e && ts.isIdentifier(e)) return local.get(e.text) ?? null;
    if (
      e &&
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      namespaces.has(e.expression.text)
    )
      return tables.get(e.name.text) ?? null;
    return null;
  };
  // Map.set читателя — не запись БД. Связь с insert/update сохраняется и у builder-переменной
  // того же scope; локальное объявление и параметр затеняют внешнюю переменную.
  const scopeOf = (n: ts.Node): ts.Node => {
    let scope = n.parent;
    while (
      scope &&
      !ts.isBlock(scope) &&
      !ts.isSourceFile(scope) &&
      !ts.isFunctionLike(scope) &&
      !ts.isForStatement(scope) &&
      !ts.isForOfStatement(scope) &&
      !ts.isForInStatement(scope) &&
      !ts.isCatchClause(scope)
    )
      scope = scope.parent;
    return scope ?? sf;
  };
  const bindings = new Map<ts.Node, Map<string, ts.Expression | undefined>>();
  walk(sf, (n) => {
    if ((!ts.isVariableDeclaration(n) && !ts.isParameter(n)) || !ts.isIdentifier(n.name)) return;
    const scope = scopeOf(n);
    const names = bindings.get(scope) ?? new Map<string, ts.Expression | undefined>();
    names.set(n.name.text, n.initializer);
    bindings.set(scope, names);
  });
  const bindingOf = (e: ts.Identifier): ts.Expression | undefined => {
    let scope: ts.Node | undefined = e;
    while (scope) {
      const names = bindings.get(scope);
      if (names?.has(e.text)) return names.get(e.text);
      scope = scope.parent;
    }
    return undefined;
  };
  const isWriteBuilder = (e: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(e)) return false;
    seen.add(e);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      if (['insert', 'update'].includes(e.expression.name.text) && tableOf(e.arguments[0]) !== null)
        return true;
      return isWriteBuilder(e.expression.expression, seen);
    }
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
      return isWriteBuilder(e.expression, seen);
    if (ts.isIdentifier(e)) {
      const value = bindingOf(e);
      return value !== undefined && isWriteBuilder(value, seen);
    }
    return false;
  };
  // Переданный именем literal patch столь же прямой писатель колонок, как .set({ ... }).
  // Разрешение ограничено объявлениями того же дерева и соблюдает затенение имён.
  const bodyArgument = (e: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(e)) return false;
    seen.add(e);
    if (hasBodyKey(e)) return true;
    if (ts.isIdentifier(e)) {
      const value = bindingOf(e);
      return value !== undefined && bodyArgument(value, seen);
    }
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
      return bodyArgument(e.expression, seen);
    return false;
  };
  const hits: Hit[] = [];
  walk(sf, (n) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const t = ['insert', 'update', 'delete'].includes(method) ? tableOf(n.arguments[0]) : null;
      if (t !== null) hits.push(...byTable(t, line));
      if (
        ['set', 'values', 'onConflictDoUpdate'].includes(method) &&
        isWriteBuilder(n.expression.expression) &&
        n.arguments.some((argument) => bodyArgument(argument))
      )
        hits.push({ rule: 'body-columns', table: 'ключ колонки тела', line });
    }
    const text = literalText(n, sf);
    if (text === null) return;
    for (const w of sqlWrites(text))
      hits.push(
        ...(w.dynamic
          ? [{ rule: 'dynamic-table' as const, table: w.table, line }]
          : byTable(w.table, line)),
      );
    if (bodyColumnSql(text)) hits.push({ rule: 'body-columns', table: 'колонка тела', line });
  });
  return hits;
}

function allHits(): Map<string, Hit[]> {
  const tables = schemaTables();
  const found = new Map<string, Hit[]>();
  const files = git(
    [
      'grep',
      '-l',
      '-a',
      '-F',
      '-i',
      '-e',
      'insert',
      '-e',
      'update',
      '-e',
      'delete',
      '-e',
      'truncate',
      '-e',
      'bodyRevision',
      '-e',
      'bodyActionId',
      '-e',
      'bodyChangedAt',
      '--',
      ...SERVER_PATHSPEC,
    ],
    [0, 1],
  );
  for (const rel of files) {
    const hits = fileHits(rel, readFileSync(join(ROOT, rel), 'utf8'), tables);
    if (hits.length > 0) found.set(rel, hits);
  }
  return found;
}
describe('сторожа путей записи (спека скорости §10.3)', () => {
  const hits = allHits();
  test('(а) обход не выродился: боевой код сервера, без тестов, обвязки и миграций; схема прочитана', () => {
    const files = git(['ls-files', '--', ...SERVER_PATHSPEC], [0]);
    expect(files.length).toBeGreaterThan(150); // 168 на main 2cb14d0f
    expect(files).toContain('apps/server/src/executor/executor.ts');
    expect(files).toContain('apps/server/src/routers/user.ts');
    expect(files.some((f) => /\.test\.|\/migrations\/|\/src\/test\//.test(f))).toBe(false);
    const tables = schemaTables();
    expect(tables.get('entities')).toBe('entities');
    expect(tables.get('chatMessages')).toBe('chat_messages');
    expect(tables.get('actionJournal')).toBe('action_journal');
  });
  test('(б) приметы на образцах', () => {
    const t = new Map([
      ['entities', 'entities'],
      ['userSettings', 'user_settings'],
      ['chatMessages', 'chat_messages'],
    ]);
    const rules = (src: string) =>
      fileHits(
        'apps/server/src/routers/x.ts',
        `import { entities, userSettings, chatMessages as cm } from '../db/schema';\n${src}`,
        t,
      )
        .map((h) => `${h.rule}:${h.table}`)
        .sort();
    expect(rules('tx.update(entities).set({ title: "x" });')).toEqual(['graph:entities']);
    expect(rules('tx.insert(cm).values({});')).toEqual(['chat:chat_messages']);
    expect(rules(`tx.execute(sql\`UPDATE \${RULE_TABLE[k]} SET rules = 1\`);`)).toEqual([
      'graph:aspect_definitions',
      'graph:property_definitions',
      'graph:relation_role_definitions',
    ]);
    expect(rules("tx.unsafe('TRUNCATE a, entities RESTART IDENTITY');")).toEqual([
      'graph:entities',
    ]);
    expect(
      rules(`tx.execute(sql\`SELECT id FROM entities WHERE id = \${id} FOR UPDATE\`);`),
    ).toEqual([]);
    expect(
      rules(
        'tx.execute(sql`INSERT INTO relations (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1`);',
      ),
    ).toEqual(['graph:relations']);
    expect(rules('tx.update(entities).set({ bodyRevision: 1 });')).toEqual([
      'body-columns:ключ колонки тела',
      'graph:entities',
    ]);
    expect(rules('rows.set(id, { bodyRevision: row.bodyRevision });')).toEqual([]);
    expect(rules('const patch = { bodyRevision: 1 }; rows.set(id, patch);')).toEqual([]);
    expect(rules('const q = tx.update(entities); q.set({ bodyRevision: 1 });')).toEqual([
      'body-columns:ключ колонки тела',
      'graph:entities',
    ]);
    expect(rules('const patch = { bodyRevision: 1 }; tx.update(entities).set(patch);')).toEqual([
      'body-columns:ключ колонки тела',
      'graph:entities',
    ]);
    expect(rules("tx.update(entities).set({ 'bodyRevision': 1 });")).toEqual([
      'body-columns:ключ колонки тела',
      'graph:entities',
    ]);
    expect(
      rules(
        'const patch = { bodyActionId: id }; const next = patch; tx.insert(entities).values(next);',
      ),
    ).toEqual(['body-columns:ключ колонки тела', 'graph:entities']);
    expect(
      rules(
        'const patch = { bodyRevision: 1 }; { const patch = { title: "x" }; tx.update(entities).set(patch); }',
      ),
    ).toEqual(['graph:entities']);
    expect(rules('const a = b; const b = a; tx.update(entities).set(a);')).toEqual([
      'graph:entities',
    ]);
    expect(rules('tx.insert(entities).values({ bodyRevision: 1 });')).toEqual([
      'body-columns:ключ колонки тела',
      'graph:entities',
    ]);
    expect(
      rules(
        'tx.insert(entities).values({}).onConflictDoUpdate({ target: entities.id, set: { bodyActionId: id } });',
      ),
    ).toEqual(['body-columns:ключ колонки тела', 'graph:entities']);
    expect(
      rules(
        'const q = tx.update(entities); { const q = new Map(); q.set(id, { bodyRevision: 1 }); }',
      ),
    ).toEqual(['graph:entities']);
    expect(rules('tx.execute(sql`SELECT 1; -- UPDATE entities SET body_revision = 1`);')).toEqual(
      [],
    );
    expect(
      fileHits(
        'apps/server/src/x.ts',
        'import * as schema from "./db/schema"; tx.update(schema.entities).set({ bodyChangedAt: now });',
        t,
      )
        .map((h) => `${h.rule}:${h.table}`)
        .sort(),
    ).toEqual(['body-columns:ключ колонки тела', 'graph:entities']);
    expect(
      rules(`tx.execute(sql\`UPDATE entities SET body_action_id = \${a} WHERE id = \${id}\`);`),
    ).toEqual(['body-columns:колонка тела', 'graph:entities']);
    expect(
      rules(`tx.execute(sql\`SELECT body_revision FROM entities WHERE id = \${id} FOR UPDATE\`);`),
    ).toEqual([]);
    expect(rules(`tx.unsafe(\`DELETE FROM \${table} WHERE graph_id IS NOT NULL\`);`)).toEqual([
      `dynamic-table:\${table}`,
    ]);
    expect(sqlWrites(`TRUNCATE \${WORLD_TABLES.join(', ')} RESTART IDENTITY`)).toEqual([
      { table: `\${WORLD_TABLES.join(', ')}`, dynamic: true },
    ]);
    expect(rules('seen.delete(key);')).toEqual([]);
    expect(
      rules(
        'tx.execute(sql`SELECT 1; -- update entities SET title = 1\n/* DELETE FROM entities */`);',
      ),
    ).toEqual([]);
  });
  test('(в) известные писатели видны: executor пишет граф, синк — журнал, модуль разговоров — сообщения', () => {
    expect(hits.get('apps/server/src/executor/executor.ts')?.some((h) => h.rule === 'graph')).toBe(
      true,
    );
    expect(hits.get('apps/server/src/executor/journal.ts')?.some((h) => h.rule === 'journal')).toBe(
      true,
    );
    expect(hits.get('apps/server/src/chat/messages.ts')?.some((h) => h.rule === 'chat')).toBe(true);
  });
  for (const rule of ['graph', 'journal', 'chat', 'body-columns', 'dynamic-table'] as const) {
    test(`(г) ${rule}: вне писателя — только исключения, счёт точный`, () => {
      const actual: Record<string, number> = {};
      for (const [rel, list] of hits) {
        const n = list.filter((h) => h.rule === rule).length;
        if (n > 0 && !(OWNED[rule]?.(rel) ?? false)) actual[rel] = n;
      }
      const expected = Object.fromEntries(
        Object.entries(WRITE_PATH_EXCEPTIONS[rule]).map(([rel, e]) => [rel, e.count]),
      );
      expect(actual).toEqual(expected);
    });
  }
  test('(д) у каждого исключения — причина и кто снимет', () => {
    for (const byFile of Object.values(WRITE_PATH_EXCEPTIONS))
      for (const e of Object.values(byFile)) {
        expect(e.reason.length).toBeGreaterThan(20);
        expect(e.removedBy.length).toBeGreaterThan(5);
      }
  });
});
