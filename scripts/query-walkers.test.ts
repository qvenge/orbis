// scripts/query-walkers.test.ts
// СТОРОЖ ПЕРЕЧНЯ ОБХОДЧИКОВ ДЕРЕВА ЗАПРОСА (срез 1в, РП-3 плана `2026-09-28-pages-slice-1v.md`).
//
// ЗАЧЕМ. Узлы фильтра Q-AST разбираются цепочками `'x' in node` с тихим хвостом: TypeScript ловит
// новый вид узла только там, где есть исчерпывающий `switch` (компиляция и печать), а обходчики,
// читающие дерево по ключам (`prop`/`has`/`field`), новую форму пропускают молча (Д-1, Ф-1в-15).
// 1в меняет язык для страниц, агента и рутин сразу — адрес контракта в поле, `$`-ссылка, группировка, —
// и обходчик, не знающий новой формы, это тихий дефект. Поэтому каждый обходчик назван: в перечне
// ниже (имя, файл, входная функция, что он обязан делать с новыми формами) и строкой-пометкой в
// коде над своей входной функцией. Сторож требует взаимно-однозначного совпадения перечня и пометок.
//
// ПРАВИЛА (РП-3):
//  - одна строка перечня = одно имя = один файл = одна пометка — ровно строка-комментарий
//    `// ОБХОДЧИК-Q: <имя>`; прочие функции модуля, читающие дерево, держат тесты этой строки;
//  - пометка стоит над ВХОДНОЙ функцией, названной в строке: первая строка кода после пометки
//    (комментарии и докблок пропускаются) объявляет её;
//  - слово пометки в прозе (докблок, строка кода, не строка-комментарий) — отказ: греп обязан
//    находить только пометки, иначе счёт перестаёт что-либо значить;
//  - число строк перечня пиннится: новый обходчик — видимое движение (строка перечня, пометка,
//    тест поведения у самого обходчика — в той же задаче).
//
// Оборотная сторона `git grep` (Ф-Б2-11): виден только ЗАРЕГИСТРИРОВАННЫЙ файл — новый файл
// `git add`-ится сразу при создании. Сам этот файл из охвата исключён: он и есть перечень.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SELF = 'scripts/query-walkers.test.ts';
const MARK = 'ОБХОДЧИК-Q';
const MARK_LINE_RE = /^\s*\/\/ ОБХОДЧИК-Q: ([a-z0-9-]+)$/;

interface QueryWalker {
  /** Имя пометки: `// ОБХОДЧИК-Q: <name>`. */
  name: string;
  /** Файл пометки — путь от корня репозитория. */
  file: string;
  /** Входная функция модуля: её объявление — первая строка кода после пометки. */
  entry: string;
  /** Что обходчик обязан делать с адресом контракта (A), `$`-ссылкой (P) и группировкой (G). */
  does: string;
}

/**
 * Перечень обходчиков дерева запроса — раздел «Обходчики дерева запроса» плана 1в (с 26-й строкой
 * `web-tile-form` — рулинг координатора R-4, docs-коммит `6acf05bf`; 27-я — `token-boundary` задачи 2).
 * Строки задачи 4 (`bind-query`, `placement-issue`, `page-only`, `substitute-params`) и задачи 5
 * (`web-form-parse`, `web-field-rows`, `web-block-parse`, `web-text-editor`, `web-query-widget`)
 * стоят с их пометками.
 */
export const QUERY_WALKERS: ReadonlyArray<QueryWalker> = [
  {
    name: 'schema',
    file: 'packages/shared/src/query/ast.ts',
    entry: 'queryAstSchema',
    does: 'A: адрес принят в prop/sortBy/aggregate/group, в columns — отказ формы; P, G: базовая схема — отказ с PAGE_ONLY_HINT, pageQueryAstSchema — принят (group — только при list/compact)',
  },
  {
    name: 'json-schema',
    file: 'packages/shared/src/query/ast-json-schema.ts',
    entry: 'queryAstJsonSchema',
    does: 'A: FIELD_REF = oneOf(строка, объект адреса) — вердикты совпадают с zod; P, G: {param} и ключа group JSON Schema тула не допускает (агенту они не положены)',
  },
  {
    name: 'parse',
    file: 'packages/shared/src/query/parse-ast.ts',
    entry: 'parseQueryAst',
    does: 'A: свойство → адрес слота → значение контракта → UNKNOWN_FIELD (UNKNOWN_SLOT, NO_CONTRACT_VALUE); P, G: `$имя` и group=day:<дата> только с place page, иначе PAGE_ONLY',
  },
  {
    name: 'print',
    file: 'packages/shared/src/query/print.ts',
    entry: 'printQueryAst',
    does: 'A: `контракт.слот` / `контракт` ключом контракта в обеих формах; P: `$имя`, литерал с ведущим `$` — в кавычках; G: group=day:<поле> сразу после sortBy',
  },
  {
    name: 'normalize',
    file: 'packages/shared/src/query/normalize.ts',
    entry: 'normalizeQueryAst',
    does: 'A: ключ контракта → id в prop/sortBy/aggregate/group; слот как есть; P: ссылка — как есть; G: field группы — как у sortBy',
  },
  {
    name: 'static',
    file: 'packages/shared/src/query/static.ts',
    entry: 'assertStaticQuery',
    does: 'A: адрес статичен (не токен); токен в значении — отказ, как у свойства; P: ссылка — отказ; G: проекция group — отказ',
  },
  {
    name: 'absolute-date',
    file: 'packages/shared/src/query/dates.ts',
    entry: 'absoluteDateIn',
    does: 'A: литерал у адреса слота с датой и у значения «даты» — находка; P: ссылка — не литерал',
  },
  {
    name: 'field-ref',
    file: 'packages/shared/src/query/field-ref.ts',
    entry: 'resolvePropertyFieldId',
    does: 'A: адрес — undefined (отказывает зовущий); P: не касается (поле, а не значение)',
  },
  {
    name: 'refs-index',
    file: 'packages/shared/src/doc/convert.ts',
    entry: 'queryRefsFromDoc',
    does: 'A: объект адреса в индекс свойств не едет; P: не касается (значение, а не свойство); G: field группы строкой — как свойство',
  },
  {
    name: 'token-boundary',
    file: 'packages/shared/src/query/tokens.ts',
    entry: 'tokenBoundaryForms',
    does: 'A: токен-граница у адреса учитывается наравне со свойством (обход по форме узла, не по полю); P: не касается (ссылка — не токен)',
  },
  {
    name: 'page-only',
    file: 'packages/shared/src/query/page-only.ts',
    entry: 'pageOnlyFeatureIn',
    does: 'P: находит {param} в любой границе под and/or/not; G: ключ group у корня',
  },
  {
    name: 'bind-query',
    file: 'packages/shared/src/doc/bind-query.ts',
    entry: 'bindQueryBlocks',
    does: 'A, P, G: дерево — pageQueryAstSchema, текст — разбор с местом page (род тела неизвестен)',
  },
  {
    name: 'placement-issue',
    file: 'packages/shared/src/doc/placement.ts',
    entry: 'queryIssue',
    does: 'P, G: разбор с местом по роду тела — page/template → page, заметка — отказ PAGE_ONLY',
  },
  {
    name: 'compile',
    file: 'apps/server/src/query/compile-ast.ts',
    entry: 'compileQueryAst',
    does: 'A: ветка адреса — contract-sql; сортировка, сумма и «последнее» по адресу; P: доехавшая ссылка — отказ UNKNOWN_PARAM; G: строки блока (compileBlockRowsAst) — порядок с ключа группы',
  },
  {
    name: 'contract-sql',
    file: 'apps/server/src/query/contract-sql.ts',
    entry: 'addressCond',
    does: 'A: SQL по привязкам аспектов записи; ключ сортировки РП-21 (or из eq — одно условие); P: не касается (до SQL ссылка подставлена); G: колонки ключа __key_at и дат __when_dates',
  },
  {
    name: 'materialize-window',
    file: 'apps/server/src/recurring/materialize.ts',
    entry: 'materializationWindow',
    does: 'A: окно от свойств, привязанных к адресу, ∩ триггеры правила; P: не подставлена — Error программиста',
  },
  {
    name: 'substitute-params',
    file: 'apps/server/src/query/params.ts',
    entry: 'substituteParams',
    does: 'P: {param} → {token} значения пачки; нет значения — UNKNOWN_PARAM, не токен — PARAM_VALUE',
  },
  {
    name: 'rewrite-ast',
    file: 'apps/server/src/registry/ops.ts',
    entry: 'rewriteAst',
    does: 'A: объект адреса не трогается; field строкой переписывается; P: не касается (значение не переписывается); G: field группы строкой — переписывается',
  },
  {
    name: 'property-names',
    file: 'apps/server/src/registry/ops.ts',
    entry: 'propertyNamesInAst',
    does: 'A: адрес — не имя свойства; P: не касается (значение, а не свойство); G: field группы строкой — имя свойства',
  },
  {
    name: 'rewrite-text-keys',
    file: 'apps/server/src/registry/ops.ts',
    entry: 'rewriteQueryTextKeys',
    does: 'A: часть до точки — не свойство; P: не касается',
  },
  {
    name: 'scope-shape',
    file: 'apps/server/src/registry/ops.ts',
    entry: 'assertScopeShape',
    does: 'A: в scope — отказ SCOPE_SHAPE; P: базовая схема — отказ',
  },
  {
    name: 'scope-names-aspect',
    file: 'apps/server/src/registry/deltas.ts',
    entry: 'scopeNamesAspect',
    does: 'A: смотрит только aspect, прочее тихо (форму держит scope-shape); P: базовая схема — отказ',
  },
  {
    name: 'action-query',
    file: 'apps/server/src/registry/actions.ts',
    entry: 'assertActionQuery',
    does: 'A: принят; P: базовая схема — отказ',
  },
  {
    name: 'goal-progress',
    file: 'apps/server/src/goals/progress.ts',
    entry: 'computeGoalProgress',
    does: 'A: адрес в field — invalid_field; в дереве — компилятор; P: отказ схемы',
  },
  {
    name: 'entity-blocks',
    file: 'apps/server/src/routers/entity-blocks.ts',
    entry: 'prepareQuery',
    does: 'A: компилятор; окно материализации получает реестр; P: разбор с place page → substituteParams (бейдж — умолчания тела); G: период блока и раскладка layoutDayGroups',
  },
  {
    name: 'entity-query-tool',
    file: 'apps/server/src/tools/dispatch.ts',
    entry: 'runEntityQuery',
    does: 'A: принят; P, G: текст — PAGE_ONLY, дерево — отказ базовой схемы с подсказкой',
  },
  {
    name: 'probe-p3',
    file: 'scripts/probe-p3/runner.ts',
    entry: 'evalNode',
    does: 'A: отказ «форма вне пробы»; P: не касается (проба — деревья без ссылок)',
  },
  {
    name: 'web-builder-model',
    file: 'apps/web/src/features/query-builder/model.ts',
    entry: 'fieldNodeView',
    does: 'A: у адреса строки формы нет, узел сохраняется при печати; P: узел со ссылкой получает строку поля со значением-ссылкой как есть; только-чтение строки целиком — FieldRows (web-field-rows); G: withDisplay снимает group при table/tile, при list/compact сохраняет',
  },
  {
    name: 'web-builder-form',
    file: 'apps/web/src/features/query-builder/QueryBuilderForm.tsx',
    entry: 'aggregateOf',
    does: 'A: значение <select> — fieldRefKey, узел сохраняется; P: не касается (агрегат — поле)',
  },
  {
    name: 'web-tile-form',
    file: 'apps/web/src/features/page/blocks/TileForm.tsx',
    entry: 'tileValue',
    does: 'A: latest над адресом — значение без поиска свойства по строке (не падает); валюта — задача 3; P: не касается (подставлено сервером)',
  },
  {
    name: 'web-ref-query',
    file: 'apps/web/src/lib/entity-ref/RefField.tsx',
    entry: 'refQueryAst',
    does: 'A: дерево цели проезжает как есть; P: базовая схема цели — отказ на сервере',
  },
  {
    name: 'web-form-parse',
    file: 'apps/web/src/features/query-builder/model.ts',
    entry: 'parseForForm',
    does: 'P, G: разбор и обратная печать — с местом по роду тела (page/template → page, заметка — без места)',
  },
  {
    name: 'web-field-rows',
    file: 'apps/web/src/features/query-builder/FieldRows.tsx',
    entry: 'BoundInput',
    does: 'P: строка со ссылкой — только для чтения целиком (значения `$имя`, оператор, кнопки); узел сохраняется',
  },
  {
    name: 'web-block-parse',
    file: 'apps/web/src/lib/query-blocks/parse.ts',
    entry: 'parseBlock',
    does: 'P, G: место из рода тела — page/template → page, заметка — отказ PAGE_ONLY плашкой блока',
  },
  {
    name: 'web-text-editor',
    file: 'apps/web/src/features/query-builder/QueryTextEditor.tsx',
    entry: 'QueryTextEditor',
    does: 'P, G: живой разбор — с местом по роду тела',
  },
  {
    name: 'web-query-widget',
    file: 'apps/web/src/features/entity-editor/nodes/QueryWidget.tsx',
    entry: 'astOf',
    does: 'P, G: дерево атрибута — pageQueryAstSchema (место знает тело, а не узел)',
  },
];

function git(args: readonly string[]): string[] {
  const res = Bun.spawnSync(['git', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C.UTF-8' },
  });
  // У `git grep` 0 — нашлось, 1 — не нашлось; прочее — поломка, а не «пометок нет».
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(`сторож обходчиков: git ${args[0]} вернул код ${res.exitCode}: ${err}`);
  }
  return new TextDecoder()
    .decode(res.stdout)
    .split('\n')
    .filter((l) => l !== '');
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Все строки со словом пометки в отслеживаемом коде, кроме самого перечня. */
function hits(): Hit[] {
  return git(['grep', '-n', '-F', MARK, '--', 'apps', 'packages', 'scripts'])
    .map((raw) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(raw);
      if (!m) throw new Error(`сторож обходчиков: непонятная строка git grep: ${raw}`);
      return { file: m[1] as string, line: Number(m[2]), text: m[3] as string };
    })
    .filter((h) => h.file !== SELF);
}

/** Первая строка кода после пометки: пустые строки, `//`-комментарии и докблок пропускаются. */
function firstCodeLineAfter(file: string, line: number): string {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  let inBlock = false;
  for (let i = line; i < lines.length; i++) {
    const t = (lines[i] as string).trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t === '' || t.startsWith('//')) continue;
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    return t;
  }
  return '';
}

test('перечень обходчиков: имена уникальны, число пиннится', () => {
  const names = QUERY_WALKERS.map((w) => w.name);
  expect(new Set(names).size).toBe(names.length);
  // 26 строк задачи 1 (25 плана + `web-tile-form`, рулинг R-4), `token-boundary` задачи 2, четыре
  // строки задачи 4 (`page-only`, `bind-query`, `placement-issue`, `substitute-params`) и пять задачи 5
  // (`web-form-parse`, `web-field-rows`, `web-block-parse`, `web-text-editor`, `web-query-widget`).
  expect(QUERY_WALKERS.length).toBe(36);
});

// Перенос ревью задачи 4 (Fable M-1): таблица плана задаёт каждому обходчику решение о `$`-ссылке —
// хотя бы «не касается». Строка без части `P` прятала бы, что о ссылке никто не подумал.
test('каждая строка перечня называет решение о $-ссылке (часть P)', () => {
  const silent = QUERY_WALKERS.filter((w) => !/(^|[\s;,])P[:,]/.test(w.does)).map((w) => w.name);
  expect(silent).toEqual([]);
});

test('слово пометки встречается только строкой-комментарием пометки, не в прозе', () => {
  const prose = hits().filter((h) => !MARK_LINE_RE.test(h.text));
  expect(prose.map((h) => `${h.file}:${h.line}: ${h.text.trim()}`)).toEqual([]);
});

test('пометки в коде ⇔ перечень: пары (имя, файл) совпадают взаимно-однозначно', () => {
  const marked = hits()
    .filter((h) => MARK_LINE_RE.test(h.text))
    .map((h) => `${(MARK_LINE_RE.exec(h.text) as RegExpExecArray)[1]} @ ${h.file}`)
    .sort();
  const listed = QUERY_WALKERS.map((w) => `${w.name} @ ${w.file}`).sort();
  // Одна пометка на строку перечня: дубль имени в коде — тоже расхождение.
  expect(marked).toEqual(listed);
});

test('пометка стоит над входной функцией, названной в перечне', () => {
  const misplaced: string[] = [];
  for (const h of hits()) {
    const m = MARK_LINE_RE.exec(h.text);
    if (!m) continue;
    const walker = QUERY_WALKERS.find((w) => w.name === m[1] && w.file === h.file);
    if (walker === undefined) continue; // расхождение называет тест выше
    const code = firstCodeLineAfter(h.file, h.line);
    const declares = new RegExp(
      `^(export\\s+)?(async\\s+)?(function\\s+${walker.entry}\\b|const\\s+${walker.entry}\\b)`,
    );
    if (!declares.test(code)) misplaced.push(`${walker.name} (${h.file}:${h.line}): «${code}»`);
  }
  expect(misplaced).toEqual([]);
});
