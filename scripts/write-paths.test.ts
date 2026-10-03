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

const SQL_IDENTIFIER = '(?:"(?:[^"]|"")*"|[a-z_\\u0080-\\uffff][a-z0-9_$\\u0080-\\uffff]*)';
const SQL_TABLE = `(?:\\$\\{[^}]*\\}|${SQL_IDENTIFIER}(?:\\s*\\.\\s*${SQL_IDENTIFIER})*)`;
// PostgreSQL relation_expr: ONLY имя/(имя) либо имя*. INSERT использует qualified_name.
const SQL_TARGET = `(?:ONLY\\s*(?:\\(\\s*${SQL_TABLE}\\s*\\)|\\s+${SQL_TABLE})|${SQL_TABLE}(?:\\s*\\*)?)`;
const WRITE_SQL = new RegExp(
  `\\b(?:(INSERT\\s+INTO)\\s+(${SQL_TABLE})|(UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(${SQL_TARGET}(?:\\s*,\\s*${SQL_TARGET})*))`,
  'gi',
);
const NOT_A_TABLE = new Set(['set', 'of', 'skip', 'nowait']); // DO UPDATE SET, FOR UPDATE [OF|SKIP LOCKED|NOWAIT]
const BODY_COLUMNS = new Set(['body_revision', 'body_action_id', 'body_changed_at']);
const SQL_TARGET_GAP = '(?:\\s+|(?<=[)*"]))';
const BODY_SET = new RegExp(
  `\\b(?:UPDATE\\s+${SQL_TARGET}(?:${SQL_TARGET_GAP}(?:AS(?:\\s+|(?=")))?${SQL_IDENTIFIER})?${SQL_TARGET_GAP}SET|ON\\s+CONFLICT\\b[^;]*?\\bDO\\s+UPDATE\\s+SET)\\b`,
  'gi',
);
const INSERT_COLUMNS = new RegExp(
  `\\bINSERT\\s+INTO\\s+${SQL_TABLE}(?:${SQL_TARGET_GAP}AS(?:\\s+|(?="))${SQL_IDENTIFIER})?\\s*\\(([^)]*)\\)`,
  'gi',
);
const sqlIdentifier = (name: string): string =>
  name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();
const hasBodyIdentifier = (text: string): boolean =>
  (text.match(new RegExp(SQL_IDENTIFIER, 'gi')) ?? []).some((name) =>
    BODY_COLUMNS.has(sqlIdentifier(name)),
  );
// `$` продолжает unquoted identifier (включая Unicode), delimiter начинается отдельным токеном.
const SQL_IDENTIFIER_CONTINUATION = /[a-z0-9_$\u0080-\uffff]/i;
const DOLLAR_QUOTE = /^\$(?:[a-z_\u0080-\uffff][a-z0-9_\u0080-\uffff]*)?\$/i;
type SqlCode = { text: string; opaque: Array<[number, number]> };
const opaqueAt = (code: SqlCode, i: number) => code.opaque.find(([a, b]) => a <= i && i < b);
const keywordStart = (code: SqlCode, i: number): boolean =>
  !opaqueAt(code, i) && !SQL_IDENTIFIER_CONTINUATION.test(code.text[i - 1] ?? '');

/** Пробелы/комментарии между U& identifier и его необязательным UESCAPE. */
function sqlTriviaEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (/\s/.test(text[i] ?? '')) i++;
    else if (text.startsWith('--', i)) {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
    } else if (text.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
    } else break;
  }
  return i;
}
/** SCONST после UESCAPE: обычный/E literal с newline continuation либо dollar literal. */
function escapeConstant(text: string, start: number): { end: number; value: string | null } {
  const delimiter = text.slice(start).match(DOLLAR_QUOTE)?.[0];
  if (delimiter) {
    const close = text.indexOf(delimiter, start + delimiter.length);
    return close < 0
      ? { end: text.length, value: null }
      : { end: close + delimiter.length, value: text.slice(start + delimiter.length, close) };
  }
  const escaped = /^[eE]'/.test(text.slice(start));
  let i = start + (escaped ? 1 : 0);
  if (text[i] !== "'") return { end: text.length, value: null };
  let raw = '';
  while (text[i] === "'") {
    i++;
    let closed = false;
    while (i < text.length) {
      if (escaped && text[i] === '\\') {
        raw += text.slice(i, i + 2);
        i += 2;
      } else if (text[i] !== "'") raw += text[i++] ?? '';
      else if (text[i + 1] === "'") {
        raw += "'";
        i += 2;
      } else {
        i++;
        closed = true;
        break;
      }
    }
    if (!closed) return { end: text.length, value: null };
    const next = sqlTriviaEnd(text, i);
    if (!/[\n\r]/.test(text.slice(i, next)) || text[next] !== "'") break;
    i = next;
  }
  let valid = true;
  const value = escaped
    ? raw.replace(
        /\\(?:([0-7]{1,3})|x([a-fA-F0-9]{1,2})|u([a-fA-F0-9]{4})|U([a-fA-F0-9]{8})|([\s\S]))/g,
        (_, octal: string, hex: string, small: string, big: string, other: string) => {
          if (octal) return String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
          if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
          if (small || big) {
            const n = Number.parseInt(small || big, 16);
            if (n > 0x10ffff) {
              valid = false;
              return '';
            }
            return String.fromCodePoint(n);
          }
          if (other === 'u' || other === 'U') valid = false;
          return (
            ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[other] ??
            other
          );
        },
      )
    : raw;
  return { end: i, value: valid ? value : null };
}
/** PostgreSQL U& quoted identifier: case сохраняется, escape относится только к этому токену. */
function unicodeIdentifier(text: string, start: number): { end: number; name: string | null } {
  const token = text.slice(start).match(/^u&"((?:[^"]|"")*)"/i);
  if (!token) return { end: text.length, name: null };
  let end = start + token[0].length;
  let escapeChar = '\\';
  const clause = sqlTriviaEnd(text, end);
  if (/^UESCAPE(?![a-z0-9_$\u0080-\uffff])/i.test(text.slice(clause))) {
    const literalStart = sqlTriviaEnd(text, clause + 'UESCAPE'.length);
    const literal = escapeConstant(text, literalStart);
    end = literal.end;
    if (literal.value === null) return { end, name: null };
    escapeChar = literal.value;
    // PostgreSQL требует один байт escape character; Unicode multibyte здесь syntax error.
    if (
      escapeChar.length !== 1 ||
      escapeChar.charCodeAt(0) === 0 ||
      escapeChar.charCodeAt(0) > 0x7f ||
      /[0-9a-f+'"\s]/i.test(escapeChar)
    )
      return { end, name: null };
  }
  const raw = (token[1] ?? '').replaceAll('""', '"');
  let name = '';
  for (let i = 0; i < raw.length; ) {
    if (!raw.startsWith(escapeChar, i)) {
      name += raw[i++] ?? '';
      continue;
    }
    i += escapeChar.length;
    if (raw.startsWith(escapeChar, i)) {
      name += escapeChar;
      i += escapeChar.length;
      continue;
    }
    const hex = raw.slice(i).match(/^(?:\+[0-9a-f]{6}|[0-9a-f]{4})/i)?.[0];
    if (!hex) return { end, name: null };
    const codepoint = Number.parseInt(hex.replace(/^\+/, ''), 16);
    if (codepoint === 0 || codepoint > 0x10ffff) return { end, name: null };
    name += String.fromCodePoint(codepoint);
    i += hex.length;
  }
  // Итерация по строке объединяет surrogate pairs; одинокие surrogates и ноль недопустимы.
  if (!name || [...name].some((c) => c.codePointAt(0) === 0 || /^[\ud800-\udfff]$/.test(c)))
    return { end, name: null };
  return { end, name };
}

/**
 * Комментарии снимаются только вне SQL literals. Их содержимое тоже маскируется: SELECT строки
 * «UPDATE ...» не писатель. Quoted identifiers и ${…} остаются токенами; иначе пропадали
 * реальные writes после '--' и ломалась динамическая таблица с join(', '). Это lexer, не SQL parser.
 */
function sqlCode(text: string): SqlCode {
  const out: string[] = [];
  const opaque: Array<[number, number]> = [];
  let length = 0;
  const append = (part: string, hidden = false) => {
    out.push(part);
    if (hidden) opaque.push([length, length + part.length]);
    length += part.length;
  };
  const mask = (part: string) => part.replace(/[^\n\r]/g, ' ');
  for (let i = 0; i < text.length; ) {
    const start = i;
    if (text.startsWith('${', i)) {
      const close = text.indexOf('}', i + 2);
      i = close < 0 ? text.length : close + 1;
      append(text.slice(start, i), true);
    } else if (
      /^u&"/i.test(text.slice(i)) &&
      !SQL_IDENTIFIER_CONTINUATION.test(text[i - 1] ?? '')
    ) {
      const identifier = unicodeIdentifier(text, i);
      i = identifier.end;
      append(
        identifier.name === null
          ? mask(text.slice(start, i))
          : `"${identifier.name.replaceAll('"', '""')}"`,
        true,
      );
    } else if (text[i] === '"') {
      i++;
      while (i < text.length) {
        if (text[i++] !== '"') continue;
        if (text[i] === '"') i++;
        else break;
      }
      append(text.slice(start, i), true);
    } else if (text[i] === "'") {
      const escaped =
        /[eE]/.test(text[i - 1] ?? '') && !SQL_IDENTIFIER_CONTINUATION.test(text[i - 2] ?? '');
      i++;
      while (i < text.length) {
        if (escaped && text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i++] !== "'") continue;
        if (text[i] === "'") i++;
        else break;
      }
      append(mask(text.slice(start, i)));
    } else if (
      text[i] === '$' &&
      !SQL_IDENTIFIER_CONTINUATION.test(text[i - 1] ?? '') &&
      DOLLAR_QUOTE.test(text.slice(i))
    ) {
      const tag = text.slice(i).match(DOLLAR_QUOTE)?.[0] ?? '$$';
      const close = text.indexOf(tag, i + tag.length);
      i = close < 0 ? text.length : close + tag.length;
      append(mask(text.slice(start, i)));
    } else if (text.startsWith('--', i)) {
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      append(mask(text.slice(start, i)));
    } else if (text.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      append(mask(text.slice(start, i)));
    } else append(text[i++] ?? '');
  }
  return { text: out.join(''), opaque };
}

/** Таблицы, в которые пишет SQL-текст; `${…}` — по исходнику выражения. */
export function sqlWrites(text: string): Array<{ table: string; dynamic: boolean }> {
  const out: Array<{ table: string; dynamic: boolean }> = [];
  const code = sqlCode(text);
  for (const m of code.text.matchAll(WRITE_SQL)) {
    if (!keywordStart(code, m.index)) continue;
    const verb = (m[1] ?? m[3] ?? '').toUpperCase();
    // Запятая внутри ${WORLD_TABLES.join(', ')} — часть выражения, а не разделитель таблиц.
    const list = m[2] ? [m[2]] : ((m[4] ?? '').match(new RegExp(SQL_TARGET, 'gi')) ?? []);
    for (const raw of verb.startsWith('TRUNCATE') ? list : list.slice(0, 1)) {
      const only = /^ONLY(?=\s|\()/i.test(raw);
      const target = only ? raw.replace(/^ONLY\s*/i, '') : raw;
      const table = (only && target.startsWith('(') ? target.slice(1, -1).trim() : target).replace(
        /\s*\*$/,
        '',
      );
      if (!table || /^ONLY$/i.test(table)) continue;
      const name = table.match(new RegExp(SQL_IDENTIFIER, 'gi'))?.at(-1) ?? table;
      const t = table.startsWith('${') ? table : sqlIdentifier(name);
      if (verb === 'UPDATE' && NOT_A_TABLE.has(t.toLowerCase())) continue;
      if (!t.startsWith('${')) out.push({ table: t, dynamic: false });
      else if (t.includes('RULE_TABLE'))
        for (const c of RULE_CARRIERS) out.push({ table: c, dynamic: false });
      else out.push({ table: t, dynamic: true });
    }
  }
  return out;
}
/** Только левая сторона SET: WHERE equality и вложенный SELECT читают stamp, не пишут. */
function bodyAssigned(code: SqlCode, start: number): boolean {
  const assignment = new RegExp(`^\\s*(${SQL_IDENTIFIER}|\\([^)]*\\))\\s*=`, 'i');
  const assignedAt = (i: number) => {
    const left = code.text.slice(i).match(assignment)?.[1];
    return left !== undefined && hasBodyIdentifier(left);
  };
  if (assignedAt(start)) return true;
  let depth = 0;
  for (let i = start; i < code.text.length; i++) {
    const opaque = opaqueAt(code, i);
    if (opaque) {
      i = opaque[1] - 1;
      continue;
    }
    const char = code.text[i];
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (depth === 0) {
      const keyword = code.text.slice(i).match(/^(?:WHERE|RETURNING)/i)?.[0];
      if (
        char === ';' ||
        (keywordStart(code, i) &&
          keyword !== undefined &&
          !SQL_IDENTIFIER_CONTINUATION.test(code.text[i + keyword.length] ?? ''))
      )
        break;
      if (char === ',' && assignedAt(i + 1)) return true;
    }
  }
  return false;
}
export function bodyColumnSql(text: string): boolean {
  const code = sqlCode(text);
  for (const m of code.text.matchAll(INSERT_COLUMNS))
    if (keywordStart(code, m.index) && hasBodyIdentifier(m[1] ?? '')) return true;
  for (const m of code.text.matchAll(BODY_SET))
    if (keywordStart(code, m.index) && bodyAssigned(code, m.index + m[0].length)) return true;
  return false;
}

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
  test('SQL: qualified и quoted таблицы сохраняют границы всех четырёх видов записи', () => {
    for (const name of ['public.entities', '"public"."entities"', 'public . "entities"']) {
      for (const query of [
        `UPDATE ONLY ${name} SET title = 'x'`,
        `INSERT INTO ${name} (id) VALUES (1)`,
        `DELETE FROM ONLY ${name} WHERE id = 1`,
        `TRUNCATE TABLE ONLY ${name}`,
      ])
        expect(fileHits('routers/x.ts', `tx.execute(sql\`${query}\`)`, new Map())).toEqual([
          { rule: 'graph', table: 'entities', line: 1 },
        ]);
    }
    expect(sqlWrites('TRUNCATE public.entities, "public"."action_journal", chat_messages')).toEqual(
      [
        { table: 'entities', dynamic: false },
        { table: 'action_journal', dynamic: false },
        { table: 'chat_messages', dynamic: false },
      ],
    );
    expect(sqlWrites('INSERT INTO "public"."action_journal" (id) VALUES (1)')).toEqual([
      { table: 'action_journal', dynamic: false },
    ]);
    expect(sqlWrites('DELETE FROM public.chat_messages WHERE id = 1')).toEqual([
      { table: 'chat_messages', dynamic: false },
    ]);
    expect(sqlWrites('TRUNCATE entities, ONLY action_journal')).toEqual([
      { table: 'entities', dynamic: false },
      { table: 'action_journal', dynamic: false },
    ]);
    expect(sqlWrites('SELECT id FROM entities FOR UPDATE OF entities SKIP LOCKED')).toEqual([]);
    expect(sqlWrites('SELECT id FROM entities FOR UPDATE NOWAIT')).toEqual([]);
  });
  test('SQL: quoted body stamps запрещены в UPDATE и INSERT', () => {
    for (const column of ['body_revision', 'body_action_id', 'body_changed_at']) {
      expect(bodyColumnSql(`UPDATE ONLY "public"."entities" SET "${column}" = NULL`)).toBe(true);
      expect(bodyColumnSql(`INSERT INTO public.entities (id, "${column}") VALUES (1, NULL)`)).toBe(
        true,
      );
      expect(bodyColumnSql(`INSERT INTO entities AS "e" ("${column}") VALUES (NULL)`)).toBe(true);
    }
  });
  test('SQL: conflict UPDATE запрещает все body stamps даже вне INSERT columns', () => {
    for (const column of ['body_revision', 'body_action_id', 'body_changed_at'])
      for (const name of [column, `"${column}"`])
        expect(
          fileHits(
            'apps/server/src/executor/executor.ts',
            `tx.execute(sql\`INSERT INTO public.entities (id, title) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET ${name} = NULL\`)`,
            new Map(),
          )
            .map((h) => h.rule)
            .sort(),
        ).toEqual(['body-columns', 'graph']);
    expect(
      bodyColumnSql(
        'INSERT INTO entities (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET title = excluded.title',
      ),
    ).toBe(false);
    expect(bodyColumnSql('SELECT "body_revision", body_action_id FROM entities FOR UPDATE')).toBe(
      false,
    );
  });
  test('SQL: string/comment lexer сохраняет настоящий writer после литерала', () => {
    for (const literal of [
      "'--'",
      "'/* DELETE FROM entities */'",
      "'it''s --'",
      String.raw`E'it\'s --'`,
      '$$-- /* text */$$',
      '$tag$-- /* text */$tag$',
    ]) {
      expect(sqlWrites(`WITH s AS (SELECT ${literal} AS value) DELETE FROM chat_messages`)).toEqual(
        [{ table: 'chat_messages', dynamic: false }],
      );
      expect(bodyColumnSql(`UPDATE entities SET title = ${literal}, body_revision = 1`)).toBe(true);
      expect(sqlWrites(`SELECT ${literal}`)).toEqual([]);
      expect(bodyColumnSql(`SELECT ${literal}`)).toBe(false);
    }
    expect(sqlWrites('WITH s AS (SELECT "a--b", "a""/*b") DELETE FROM chat_messages')).toEqual([
      { table: 'chat_messages', dynamic: false },
    ]);
    expect(sqlWrites("SELECT 'UPDATE entities SET body_revision = 1'")).toEqual([]);
    expect(bodyColumnSql("SELECT 'UPDATE entities SET body_revision = 1'")).toBe(false);
    expect(sqlWrites('SELECT "UPDATE entities SET body_revision = 1"')).toEqual([]);
    expect(bodyColumnSql('SELECT "UPDATE entities SET body_revision = 1"')).toBe(false);
    expect(
      sqlWrites('SELECT 1; /* outer /* inner */ DELETE FROM entities */ -- UPDATE entities\n'),
    ).toEqual([]);
    expect(
      bodyColumnSql('SELECT 1; /* outer /* inner */ UPDATE entities SET body_revision = 1 */'),
    ).toBe(false);
    expect(
      sqlWrites(`TRUNCATE public.entities, \${WORLD_TABLES.join(', ')} RESTART IDENTITY`),
    ).toEqual([
      { table: 'entities', dynamic: false },
      { table: `\${WORLD_TABLES.join(', ')}`, dynamic: true },
    ]);
  });
  test('SQL: body equality в WHERE и SELECT — чтение, assignment в SET — запись', () => {
    expect(bodyColumnSql("UPDATE entities SET title='x' WHERE body_revision=1")).toBe(false);
    expect(
      bodyColumnSql(
        'UPDATE entities SET title=(SELECT title FROM entities WHERE body_revision=1) WHERE id=1',
      ),
    ).toBe(false);
    expect(
      bodyColumnSql(
        'WITH s AS (SELECT body_revision FROM entities) SELECT * FROM s WHERE body_revision=1',
      ),
    ).toBe(false);
    expect(bodyColumnSql("UPDATE entities SET title='body_revision=1' WHERE id=1")).toBe(false);
    expect(bodyColumnSql('UPDATE entities SET body_revision=1 WHERE id=1')).toBe(true);
    expect(
      bodyColumnSql(
        'UPDATE entities SET title=(SELECT title FROM entities WHERE body_revision=1), body_revision=2 WHERE id=1',
      ),
    ).toBe(true);
  });
  test('SQL: dollar delimiter внутри ASCII/Unicode identifier не скрывает writer', () => {
    for (const name of ['cte_tag', 'cte$tag$', 'λ_cte', 'λ_cte$tag$', 'имя$метка$']) {
      const query = `WITH ${name} AS (SELECT 1) UPDATE entities SET body_revision=1`;
      expect(
        fileHits('apps/server/src/routers/entity.ts', `tx.execute(sql\`${query}\`)`, new Map())
          .map((h) => h.rule)
          .sort(),
      ).toEqual(['body-columns', 'graph']);
    }
  });
  test('SQL: настоящие ASCII/Unicode dollar literals не создают fake write и сохраняют следующий', () => {
    for (const delimiter of ['$tag$', '$$', '$метка$', '$λtag$']) {
      const literal = `${delimiter}UPDATE entities SET body_revision=1; -- /* quoted text */${delimiter}`;
      expect(sqlWrites(`SELECT ${literal}`)).toEqual([]);
      expect(bodyColumnSql(`SELECT ${literal}`)).toBe(false);
      expect(
        fileHits(
          'apps/server/src/routers/entity.ts',
          `tx.execute(sql\`WITH c AS (SELECT ${literal}) UPDATE entities SET body_revision=1\`)`,
          new Map(),
        )
          .map((h) => h.rule)
          .sort(),
      ).toEqual(['body-columns', 'graph']);
    }
  });
  for (const query of [
    'UPDATE entities AS ALIAS SET body_revision=1',
    'INSERT INTO entities AS ALIAS (body_revision) VALUES(1)',
  ]) {
    test(`SQL: ASCII/Unicode alias сохраняет body hit в ${query.split(' ')[0]}`, () => {
      for (const alias of ['e', 'я', 'λ_alias'])
        expect(bodyColumnSql(query.replace('ALIAS', alias))).toBe(true);
    });
  }
  test('SQL: WHERE/RETURNING внутри ASCII/Unicode identifier не завершает SET', () => {
    for (const suffix of ['WHERE', 'RETURNING'])
      for (const prefix of ['name', 'имя'])
        for (const name of [`${prefix}${suffix}`, `${suffix}${prefix}`])
          expect(
            bodyColumnSql(
              `UPDATE entities SET title=${name}, body_revision=1 FROM (SELECT 'x' AS ${name}) s`,
            ),
          ).toBe(true);
    for (const keyword of ['WHERE', 'RETURNING'])
      expect(bodyColumnSql(`UPDATE entities SET title='x' ${keyword} body_revision=1`)).toBe(false);
    for (const name of ['nameDELETE', 'имяDELETE'])
      expect(sqlWrites(`SELECT ${name} FROM entities`)).toEqual([]);
  });
  test('SQL: ONLY parenthesized targets сохраняют graph/body/chat/journal boundaries', () => {
    const rules = (query: string) =>
      fileHits(
        'apps/server/src/executor/executor.ts',
        `tx.unsafe(${JSON.stringify(query)});`,
        new Map(),
      )
        .map((h) => h.rule)
        .sort();
    expect(rules('UPDATE ONLY (public.entities) SET body_revision=1')).toEqual([
      'body-columns',
      'graph',
    ]);
    expect(rules('UPDATE ONLY("public"."entities") AS e SET body_action_id=NULL')).toEqual([
      'body-columns',
      'graph',
    ]);
    expect(rules('DELETE FROM ONLY (public.chat_messages) WHERE id=1')).toEqual(['chat']);
    expect(rules('DELETE FROM ONLY ("public"."action_journal") WHERE id=1')).toEqual(['journal']);
    expect(rules('SELECT body_revision FROM ONLY (public.entities) FOR UPDATE')).toEqual([]);
    expect(rules("SELECT 'UPDATE ONLY (entities) SET body_revision=1'")).toEqual([]);
    expect(sqlWrites('INSERT INTO ONLY (entities) (body_revision) VALUES(1)')).toEqual([]);
    expect(sqlWrites('TRUNCATE ONLY (entities)')).toEqual([{ table: 'entities', dynamic: false }]);
  });
  test('SQL: inheritance star сохраняет UPDATE body assignment и отрицательный reader', () => {
    for (const name of [
      'entities',
      'entities *',
      'entities*',
      'public.entities *',
      'U&"entities"* AS я',
    ]) {
      expect(
        fileHits(
          'apps/server/src/executor/executor.ts',
          `tx.unsafe(${JSON.stringify(`UPDATE ${name} SET body_revision=1`)});`,
          new Map(),
        )
          .map((h) => h.rule)
          .sort(),
      ).toEqual(['body-columns', 'graph']);
    }
    expect(sqlWrites('SELECT body_revision FROM entities* FOR UPDATE')).toEqual([]);
    expect(bodyColumnSql('SELECT body_revision FROM entities* FOR UPDATE')).toBe(false);
  });
  test('SQL: punctuation target boundary отделяет SET без разрыва ordinary identifier', () => {
    for (const query of [
      'UPDATE ONLY(entities)SET body_revision=1',
      'UPDATE entities*SET body_revision=1',
      'UPDATE "entities"SET"body_revision"=1',
    ]) {
      expect(
        fileHits(
          'apps/server/src/executor/executor.ts',
          `tx.unsafe(${JSON.stringify(query)});`,
          new Map(),
        )
          .map((h) => h.rule)
          .sort(),
      ).toEqual(['body-columns', 'graph']);
    }
    expect(sqlWrites('UPDATE entitiesSET body_revision=1')).toEqual([
      { table: 'entitiesset', dynamic: false },
    ]);
    expect(bodyColumnSql('UPDATE entitiesSET body_revision=1')).toBe(false);
  });
  test('SQL: quoted INSERT target и alias отделяют AS как token без пробела', () => {
    for (const query of [
      'INSERT INTO "entities"AS e (body_revision) VALUES(1)',
      'INSERT INTO U&"entities"AS e (body_revision) VALUES(1)',
      'INSERT INTO "entities"AS"e"(body_revision) VALUES(1)',
      'UPDATE "entities"AS"e"SET body_revision=1',
    ])
      expect(
        fileHits(
          'apps/server/src/executor/executor.ts',
          `tx.unsafe(${JSON.stringify(query)});`,
          new Map(),
        )
          .map((h) => h.rule)
          .sort(),
      ).toEqual(['body-columns', 'graph']);
    expect(bodyColumnSql('INSERT INTO entitiesAS e (body_revision) VALUES(1)')).toBe(false);
    expect(sqlWrites('INSERT INTO entitiesAS e (body_revision) VALUES(1)')).toEqual([
      { table: 'entitiesas', dynamic: false },
    ]);
  });
  test('SQL: TRUNCATE relation list поддерживает ONLY parens/star/dynamic/escaped names', () => {
    expect(sqlWrites('TRUNCATE ONLY (entities)')).toEqual([{ table: 'entities', dynamic: false }]);
    expect(
      sqlWrites(
        'TRUNCATE TABLE entities*, ONLY ("public"."action_journal"), U&"chat_!006dessages" UESCAPE \'!\'',
      ),
    ).toEqual([
      { table: 'entities', dynamic: false },
      { table: 'action_journal', dynamic: false },
      { table: 'chat_messages', dynamic: false },
    ]);
    expect(
      sqlWrites(`TRUNCATE ONLY (public.entities), \${WORLD_TABLES.join(', ')} RESTART IDENTITY`),
    ).toEqual([
      { table: 'entities', dynamic: false },
      { table: `\${WORLD_TABLES.join(', ')}`, dynamic: true },
    ]);
    expect(sqlWrites('SELECT 1 FROM ONLY (entities)')).toEqual([]);
    expect(sqlWrites("SELECT 'TRUNCATE ONLY (entities)'")).toEqual([]);
  });
  test('SQL: U& quoted table identifiers декодируют carrier и сохраняют quoted case', () => {
    const rules = (query: string) =>
      fileHits(
        'apps/server/src/routers/entity.ts',
        `tx.unsafe(${JSON.stringify(query)});`,
        new Map(),
      )
        .map((h) => h.rule)
        .sort();
    for (const name of [
      'U&"public"."entities"',
      String.raw`u&"\0065ntiti\+000065s"`,
      `U&"!0065ntities" UESCAPE '!'`,
      `U&"!0065ntities"/* nested /* trivia */ */UESCAPE '!'`,
      `U&"public".U&"!0065ntities" UESCAPE '!'`,
    ]) {
      expect(rules(`UPDATE ${name} SET body_revision=1`)).toEqual(['body-columns', 'graph']);
      expect(rules(`INSERT INTO ${name} (id) VALUES(1)`)).toEqual(['graph']);
      expect(rules(`TRUNCATE ${name}`)).toEqual(['graph']);
      expect(rules(`SELECT body_revision FROM ${name} FOR UPDATE`)).toEqual([]);
    }
    expect(rules(String.raw`DELETE FROM U&"chat_\006dessages" WHERE id=1`)).toEqual(['chat']);
    expect(rules(`DELETE FROM U&"action_!006aournal" UESCAPE '!' WHERE id=1`)).toEqual(['journal']);
    expect(
      rules(`UPDATE ONLY (U&"public".U&"!0065ntities" UESCAPE '!') SET body_revision=1`),
    ).toEqual(['body-columns', 'graph']);
    expect(rules('DELETE FROM U&"Entities" WHERE id=1')).toEqual([]);
    expect(rules(String.raw`DELETE FROM "\0065ntities" WHERE id=1`)).toEqual([]);
    expect(rules(`SELECT U&'UPDATE entities SET body_revision=1'`)).toEqual([]);
    expect(rules(`SELECT U&"UPDATE entities SET body_revision=1"`)).toEqual([]);
    expect(sqlWrites(String.raw`DELETE FROM U&"a\\b"`)).toEqual([
      { table: 'a\\b', dynamic: false },
    ]);
    expect(sqlWrites(`DELETE FROM U&"a!!b" UESCAPE '!'`)).toEqual([
      { table: 'a!b', dynamic: false },
    ]);
    expect(sqlWrites(`DELETE FROM U&"a""b"`)).toEqual([{ table: 'a"b', dynamic: false }]);
    expect(sqlWrites(String.raw`DELETE FROM U&"\D83D\DE00"`)).toEqual([
      { table: '😀', dynamic: false },
    ]);
  });
  test('SQL: U& body identifiers декодируются только на assignment/insert LHS', () => {
    for (const column of ['body_revision', 'body_action_id', 'body_changed_at']) {
      const encoded = `U&"!0062${column.slice(1)}" UESCAPE '!'`;
      expect(bodyColumnSql(`UPDATE ONLY (entities) SET ${encoded}=NULL`)).toBe(true);
      expect(bodyColumnSql(`INSERT INTO U&"entities" (${encoded}) VALUES(NULL)`)).toBe(true);
      expect(
        bodyColumnSql(
          `INSERT INTO entities(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET (${encoded}, title)=(NULL, 'x')`,
        ),
      ).toBe(true);
      expect(bodyColumnSql(`UPDATE entities SET title='x' WHERE ${encoded}=NULL`)).toBe(false);
      expect(bodyColumnSql(`SELECT ${encoded} FROM entities FOR UPDATE`)).toBe(false);
    }
    expect(bodyColumnSql(String.raw`UPDATE entities SET U&"\0062ody_\+000072evision"=1`)).toBe(
      true,
    );
    expect(bodyColumnSql(String.raw`UPDATE entities SET "\0062ody_revision"=1`)).toBe(false);
    expect(bodyColumnSql('UPDATE entities SET U&"Body_revision"=1')).toBe(false);
  });
  test('SQL: UESCAPE принимает documented single, E и dollar string constants', () => {
    for (const clause of [
      "'!'",
      "E'!'",
      String.raw`E'\041'`,
      String.raw`E'\x21'`,
      String.raw`E'\u0021'`,
      '$$!$$',
      '$tag$!$tag$',
      "'!'\n''",
    ]) {
      expect(sqlWrites(`DELETE FROM U&"chat_!006dessages" UESCAPE ${clause}`)).toEqual([
        { table: 'chat_messages', dynamic: false },
      ]);
      expect(bodyColumnSql(`UPDATE entities SET U&"!0062ody_revision" UESCAPE ${clause}=1`)).toBe(
        true,
      );
      expect(sqlWrites(`SELECT ${clause}`)).toEqual([]);
    }
    expect(sqlWrites(`DELETE FROM U&"entities" UESCAPE U&'!'`)).toEqual([]);
  });
  test('SQL: ONLY token не снимает prefix обычного имени таблицы', () => {
    for (const name of [
      'onlyentities',
      'ONLYentities',
      'onlychat_messages',
      'onlyaction_journal',
    ]) {
      expect(sqlWrites(`DELETE FROM ${name}`)).toEqual([
        { table: name.toLowerCase(), dynamic: false },
      ]);
      expect(
        fileHits('routers/x.ts', `tx.unsafe(${JSON.stringify(`DELETE FROM ${name}`)});`, new Map()),
      ).toEqual([]);
    }
    expect(sqlWrites('DELETE FROM ONLY (entities)')).toEqual([
      { table: 'entities', dynamic: false },
    ]);
  });
  test('SQL: Unicode normalization сохраняет opaque offsets перед следующим writer/assignment', () => {
    expect(
      sqlWrites(
        String.raw`SELECT U&"\0055PDATE entities SET body_revision=1"; DELETE FROM chat_messages`,
      ),
    ).toEqual([{ table: 'chat_messages', dynamic: false }]);
    expect(bodyColumnSql(String.raw`SELECT U&"\0055PDATE entities SET body_revision=1"`)).toBe(
      false,
    );
    expect(
      bodyColumnSql(String.raw`UPDATE U&"entities" SET title=U&"\0057HERE", body_revision=1`),
    ).toBe(true);
    expect(
      bodyColumnSql(String.raw`UPDATE U&"entities" SET title=U&"\0057HERE" WHERE body_revision=1`),
    ).toBe(false);
    expect(
      sqlWrites(`TRUNCATE U&"entities", \${WORLD_TABLES.join(', ')} RESTART IDENTITY`),
    ).toEqual([
      { table: 'entities', dynamic: false },
      { table: `\${WORLD_TABLES.join(', ')}`, dynamic: true },
    ]);
    expect(sqlWrites(String.raw`DELETE FROM U&"\0065ntities" UESCAPE E'\\'`)).toEqual([
      { table: 'entities', dynamic: false },
    ]);
  });
  test('SQL: invalid Unicode escape tokens не нормализуются в реальные carriers/stamps', () => {
    for (const name of [
      String.raw`U&"\0000entities"`,
      String.raw`U&"\D800entities"`,
      String.raw`U&"\+110000entities"`,
      String.raw`U&"\00ZZentities"`,
      `U&"entities" UESCAPE '0'`,
      `U&"entities" UESCAPE '+'`,
      `U&"entities" UESCAPE 'xx'`,
      `U&"λ0065ntities" UESCAPE 'λ'`,
      `U&"😀0065ntities" UESCAPE '😀'`,
    ])
      expect(sqlWrites(`DELETE FROM ${name}`)).toEqual([]);
    expect(bodyColumnSql(`UPDATE entities SET U&"body_revision" UESCAPE '0'=1`)).toBe(false);
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
