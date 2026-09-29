// scripts/code-boundaries.test.ts
// СТОРОЖА ГРАНИЦ КОДА И СЛОВАРЯ (срез 1б: спека §8.4, §1, §15, С1б-10; РП-10, РП-23).
// (1) код ядра web не импортирует каталоги расширений — кроме реестра карточек (§4.1) и трёх отступлений §15;
// (2) в строках интерфейса нет слов вне словаря (§1) — три охвата: строки web, тексты отказов сервера, которые web
//     печатает как есть (R-37), и подписи реестров shared (`label`/`description`, `name`/`nameGenitive` манифестов,
//     варианты `options(…)`); «смарт-лист» держит
//     grammar-copies.test.ts — не дублируется;
// (3) «module» в именах кода — только имена провода и отказа (РП-10) и «модуль JS» (ленивый чанк).
//
// Чего стражи НЕ видят (граница названа, R-37 (4)):
//  (1) путь импорта, собранный не литералом (конкатенация, шаблон с подстановкой); спецификатор без точки — алиас
//      (`@/…`, `~/…`) считается пакетом: алиасов в `vite.config`/`tsconfig` web сегодня нет, появись они — ребро
//      через алиас страж не увидит. Литеральные `import.meta.glob('…')` и `new URL('…', import.meta.url)` — видит.
//  (2) английскую подпись «view» без кириллицы, кроме голого «Views»; текст, собранный из частей не литералами
//      (`'Сущ' + 'ность'`); у сервера — только `new ExecError(код, текст)`, `new TRPCError({ message })` (и
//      `{ code, message }` с константой файла) и помощники с текстом вторым аргументом — `err`,
//      `errorResult`, `fail`, `deltaError`. Не видит: текст, пришедший параметром или собранный другим
//      помощником (`bad(…)`, `forbiddenTarget(…)`, поле `detail` конфликтов реестра), запасной текст
//      `msg ?? '…'`, константу из другого файла, `.join()` и прочие вызовы внутри текста. У shared — только
//      каталог `registry/`: `label`/`description`/`name`/`nameGenitive` и аргументы `options(…)`; подпись,
//      заданная ссылкой на константу, и подпись, собранная другим помощником, не видны (эталоны поставки
//      `supply/` — тела страниц, не подписи).
//  (3) исключения `MODULE_NAMES` не привязаны к файлу (имя из списка разрешено везде); строки с дефисом
//      (`data-testid="module-off"`, класс `module-card`) именами не считаются.
//  Вне охвата всех трёх: тесты, `scripts/` (инструменты: `LAZY_*_MODULES` там — «модуль JS»),
//  `apps/server/test/` (обвязка тестов сервера), SQL-миграции и журнал drizzle. Исключённых каталогов
//  кода нет (последний, `legacy-1v/`, удалён срезом 1в §8.1) — держит тест «(а) в охвате нет исключений».
//
// РОЛЬ ТОКЕНА ОПРЕДЕЛЯЕТ AST TypeScript, а не построчная примета (отличие от `grammar-copies.test.ts`):
// комментарий, хвостовой комментарий после кода и строка интерфейса на одной строке построчно
// неразличимы — «// сущность» после JSX-текста покрасил бы построчный страж, а `aria-label` в
// середине строки с комментарием он бы пропустил. `git grep -l` выбирает отслеживаемые файлы-кандидаты
// (дёшево и видит ровно то, что в индексе), AST разбирает только их.
//
// Охват web — код `apps/web/src` без `*.test.*`. Охват (3) — боевой код обоих
// приложений и пакетов, `*.ts`/`*.tsx`: имя колонки в SQL-миграциях и журнале drizzle — данные, не код.
//
// Оборотная сторона `git grep` (Ф-Б2-11): виден только ЗАРЕГИСТРИРОВАННЫЙ файл. Новый файл, ещё не
// добавленный в индекс, локально страж не увидит; в CI дерево checkout'а в индексе целиком.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');

const EXTENSION_DIRS = ['apps/web/src/extensions/', 'apps/web/src/features/budget/'] as const;
interface Allowed {
  readonly count: number;
  readonly reason: string;
  readonly removedBy: string;
}

/** (1) Законные рёбра «ядро → каталог расширения» — ТОЧНЫЙ счёт операторов импорта (статических, `import type`, `import()`, `export … from`). */
const IMPORT_ALLOWLIST: Record<string, Allowed> = {
  'apps/web/src/app/extension-registry.tsx': {
    count: 3,
    reason:
      'реестр карточек расширений — единственный корень сборки (спека §4.1, РП-23): GoalCard, FinancialCard, usePlanToFactPrompt («план → факт» за реестром — `useExtensionRecordHooks`)',
    removedBy: 'ярусы компонентов (§15)',
  },
  'apps/web/src/features/entity-detail/NativeRow.tsx': {
    count: 1,
    reason: 'бейдж категории в строке записи (§15): budget/categories',
    removedBy: 'срез 2',
  },
  'apps/web/src/features/chat/cards/EntityCard.tsx': {
    count: 2,
    reason: 'остаток конверта в карточке чата (§15): budget/categories, budget/EnvelopeCard',
    removedBy: 'срез 2',
  },
  'apps/web/src/features/chat/useFastPath.ts': {
    count: 0,
    reason:
      'fast-path расхода (§15) знает Финансы литералами аспектов, импорта каталога нет; ноль держит, чтобы импорт и не появился',
    removedBy: 'срез 2',
  },
};

/** (2) Слова вне словаря (§1). Регистр — флагом `i` JS (кириллица в JS-регэкспе от локали не зависит). */
const BANNED = [
  { word: 'сущность', re: /сущност/i },
  { word: 'модуль', re: /модул[ьяюеи]/i },
  { word: 'Закрепить', re: /закреп/i },
  { word: 'Views', re: /\bviews?\b/i }, // только строка с кириллицей, JSX-текст или голое «Views»
] as const;
const WORD_ALLOWLIST: Record<string, Allowed> = {
  'apps/web/src/features/entity-detail/VersionsCard.tsx': {
    count: 4,
    reason:
      '«Закрепить версию» — закрепление ВЕРСИИ тела (Ш1, `entity_version_pin`), другое понятие, не навигация (§1 снимает «Закрепить» как глагол навигации, §9.3): тост «Версия закреплена», заголовок диалога, кнопка «Закрепить», пустое состояние с названием пункта меню',
    removedBy: 'решение владельца (эррата §1)',
  },
  'apps/web/src/features/entity-detail/DetailMenu.tsx': {
    count: 1,
    reason: 'пункт «Закрепить версию» — то же закрепление версии тела',
    removedBy: 'решение владельца (эррата §1)',
  },
  'apps/server/src/executor/executor.ts': {
    count: 1,
    reason:
      'отказ «id непригоден для закрепления» — то же закрепление ВЕРСИИ тела (`entity_version_pin`), что у «Закрепить версию»',
    removedBy: 'решение владельца (эррата §1)',
  },
  'packages/shared/src/registry/builtin-properties.ts': {
    count: 1,
    reason:
      'подпись «Закреплена» свойства `orbis/pinned` — место записи наверху списков, не навигация (§1 снимает «Закрепить» как глагол навигации); вопрос переименования — владельцу, 03-pending (задача 26, R-37)',
    removedBy: 'решение владельца — вопрос в 03-pending (задача 26)',
  },
  'apps/web/src/features/entity-detail/intended-1a.ts': {
    count: 1,
    reason:
      'логика эталона 1а: подпись вкладки «Сущность» снимка → «Запись» (обвязка теста снимка, не подпись интерфейса)',
    removedBy: 'никогда (эталон 1а не переписывается, РП-24)',
  },
};

/** (3) Имена с «module» в коде — только эти (РП-10) и «модуль JS». Голое `module` — имя колонки (РП-10) — разрешено всегда. */
const MODULE_NAMES: Record<string, string> = {
  disabledModules: 'поле провода `user.getSettings` и схемы drizzle (РП-10)',
  disabled_modules: 'колонка `user_settings.disabled_modules` (миграция 0018, РП-10)',
  setModuleEnabled: 'ручка tRPC `user.setModuleEnabled` (РП-10)',
  MODULE_DISABLED: 'код отказа, видит модель, стоит в эталонах (РП-10)',
  module_set: 'операция журнала (РП-10)',
  prepareModuleSet: 'подготовка операции `module_set` исполнителем — имя по операции (РП-10)',
  menuModule: 'модуль JS: промис ленивого чанка меню (`DetailMenuSlot.tsx`)',
  resetDetailMenuModuleForTests: 'модуль JS: сброс кеша ленивого чанка меню для тестов',
  resetDetailScreenModuleForTests:
    'модуль JS: сброс кеша ленивого чанка экрана записи для тестов (`app/router.tsx`)',
  resetRecordsBlockModuleForTests:
    'модуль JS: сброс кеша ленивого чанка блока «Записи» для тестов (`browser/RecordsBlockSlot.tsx`)',
};

/**
 * Запуск git с проверкой кода возврата (образец — `grammar-copies.test.ts`): молчащий страж хуже
 * отсутствующего, поэтому непонятный код — исключение, а не «совпадений нет». Локаль фиксирована
 * (`LC_ALL=C.UTF-8`): без неё `git grep -i` по кириллице зависит от окружения.
 */
function git(args: readonly string[], ok: readonly number[]): string[] {
  const res = Bun.spawnSync(['git', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C.UTF-8' },
  });
  if (!ok.includes(res.exitCode)) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(`страж границ кода: git ${args[0]} вернул код ${res.exitCode}: ${err}`);
  }
  return new TextDecoder()
    .decode(res.stdout)
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** Боевой код web — pathspec `git ls-files`/`git grep`. */
//
// Исключения — С ПРЕФИКСОМ охвата, не `**/*.test.*`: git 2.50 (ls-files) при общем префиксе всех
// положительных pathspec молча отбрасывает ВСЁ, если исключение начинается с `**` (замерено: 0 файлов
// вместо 400), — ровно тот вырожденный обход, против которого стоит контроль (а).
const WEB_PATHSPEC = [
  ':(glob)apps/web/src/**/*.ts',
  ':(glob)apps/web/src/**/*.tsx',
  ':(exclude,glob)apps/web/src/**/*.test.*',
];
/**
 * Шаблон ИСКЛЮЧЁННЫЙ pathspec'ом (`null` — pathspec не исключение). Формы git: длинная `:(магия,…)шаблон`
 * со словом `exclude` и короткая `:<подпись>[:]шаблон`, где подпись — символы `/!^`, а `!`/`^` значат
 * исключение. Стражу «нет исключений каталогов» мало искать подстроку `:(exclude)`: `:(exclude,glob)dir/**`
 * и `:!dir/` исключают каталог так же молча.
 */
function excludedPattern(spec: string): string | null {
  const long = /^:\(([^)]*)\)([\s\S]*)$/.exec(spec);
  if (long !== null) {
    const words = (long[1] as string).split(',').map((w) => w.trim());
    return words.includes('exclude') ? (long[2] as string) : null;
  }
  const short = /^:([/!^]*):?([\s\S]*)$/.exec(spec);
  if (short === null) return null;
  return /[!^]/.test(short[1] as string) ? (short[2] as string) : null;
}

/** Законное исключение охвата — тестовые файлы, а не каталог. */
const TEST_FILES_PATTERN = /\*\.test\.\*$/;

/** Боевой код обоих приложений и пакетов — охват (3). */
const ALL_PATHSPEC = [
  ':(glob)apps/*/src/**/*.ts',
  ':(glob)apps/*/src/**/*.tsx',
  ':(glob)packages/*/src/**/*.ts',
  ':(glob)packages/*/src/**/*.tsx',
  ':(exclude,glob)apps/*/src/**/*.test.*',
  ':(exclude,glob)packages/*/src/**/*.test.*',
];

/** Кандидаты: отслеживаемые файлы охвата, где встречается хоть одна строка-примета. */
function candidates(fixed: readonly string[], pathspec: readonly string[], ci = false): string[] {
  return git(
    [
      'grep',
      '-l',
      '-a',
      '-F',
      ...(ci ? ['-i'] : []),
      ...fixed.flatMap((s) => ['-e', s]),
      '--',
      ...pathspec,
    ],
    [0, 1],
  );
}

function parse(rel: string, src: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    src,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const lineOf = (sf: ts.SourceFile, node: ts.Node) =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export interface ImportTarget {
  readonly spec: string;
  /** Путь от корня репозитория без расширения для относительного импорта; иначе — сам спецификатор. */
  readonly target: string;
  readonly line: number;
}

/**
 * Операторы импорта файла: статический (в том числе `import type`), `import()`, `export … from`,
 * `import x = require()` и тип `import('…').T`. Относительный путь разрешается от каталога файла.
 */
export function importTargets(rel: string, src: string): ImportTarget[] {
  const sf = parse(rel, src);
  const out: ImportTarget[] = [];
  const add = (lit: ts.Node | undefined, at: ts.Node) => {
    if (lit === undefined || !ts.isStringLiteralLike(lit)) return;
    const spec = lit.text;
    const target = spec.startsWith('.')
      ? posix.normalize(posix.join(posix.dirname(rel), spec))
      : spec;
    out.push({ spec, target, line: lineOf(sf, at) });
  };
  const isImportMeta = (e: ts.Node) =>
    ts.isMetaProperty(e) &&
    e.keywordToken === ts.SyntaxKind.ImportKeyword &&
    e.name.text === 'meta';
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) add(n.moduleSpecifier, n);
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)
      add(n.arguments[0], n);
    // `import.meta.glob('…')` / `import.meta.glob(['…', '!…'])` — Vite разрешает и кладёт в сборку.
    else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'glob' &&
      isImportMeta(n.expression.expression)
    ) {
      const arg = n.arguments[0];
      const lits = arg !== undefined && ts.isArrayLiteralExpression(arg) ? arg.elements : [arg];
      for (const lit of lits) {
        if (lit !== undefined && ts.isStringLiteralLike(lit))
          add(ts.factory.createStringLiteral(lit.text.replace(/^!/, '')), n);
      }
    }
    // `new URL('…', import.meta.url)` — ассет по пути, тоже ребро сборки.
    else if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'URL' &&
      n.arguments?.[1] !== undefined &&
      ts.isPropertyAccessExpression(n.arguments[1]) &&
      isImportMeta(n.arguments[1].expression)
    )
      add(n.arguments[0], n);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference))
      add(n.moduleReference.expression, n);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal, n);
  });
  return out;
}

const inExtensionDir = (path: string) => EXTENSION_DIRS.some((d) => `${path}/`.startsWith(d));

/** `путь → строки операторов импорта в каталоги расширений` по коду ядра web. */
function coreToExtensionEdges(): Map<string, number[]> {
  // Относительный путь из-за пределов каталога называет его последний сегмент после «/» — других
  // способов дотянуться до каталога литералом нет; это и примета кандидата.
  const signs = EXTENSION_DIRS.map((d) => `/${d.split('/').at(-2)}`);
  const found = new Map<string, number[]>();
  for (const rel of candidates(signs, WEB_PATHSPEC)) {
    if (inExtensionDir(rel)) continue; // каталог расширения — не ядро
    const lines = importTargets(rel, readFileSync(join(ROOT, rel), 'utf8'))
      .filter((t) => inExtensionDir(t.target))
      .map((t) => t.line);
    if (lines.length > 0) found.set(rel, lines);
  }
  return found;
}

const CYRILLIC = /[А-Яа-яЁё]/;

export interface UiText {
  readonly text: string;
  readonly line: number;
}

/**
 * Строки интерфейса файла: JSX-текст, строковые литералы и шаблоны с кириллицей и голое «Views».
 * Комментариев AST не несёт вовсе; спецификатор модуля — не подпись. Английский литерал без
 * кириллицы («view», «installedViews» — тем более имя) интерфейсом не считается: отличить подпись
 * от ключа без разбора смысла нельзя, и граница названа в заголовке файла.
 */
export function uiTexts(rel: string, src: string): UiText[] {
  const sf = parse(rel, src);
  const out: UiText[] = [];
  const isSpecifier = (n: ts.Node) =>
    (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)) &&
    n.parent.moduleSpecifier === n;
  walk(sf, (n) => {
    if (ts.isJsxText(n)) {
      const text = n.text.trim();
      if (text !== '') out.push({ text, line: lineOf(sf, n) });
      return;
    }
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (isSpecifier(n)) return;
      text = n.text;
    } else if (ts.isTemplateExpression(n)) {
      text = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join('…');
    }
    if (text === null) return;
    if (CYRILLIC.test(text) || /^Views?$/.test(text.trim()))
      out.push({ text, line: lineOf(sf, n) });
  });
  return out;
}

/** Тексты строковых узлов поддерева: литералы и шаблоны (части шаблона — через «…»). */
function stringsIn(node: ts.Node, sf: ts.SourceFile, out: UiText[]): void {
  walk(node, (n) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n))
      text = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join('…');
    if (text !== null && (CYRILLIC.test(text) || /^Views?$/.test(text.trim())))
      out.push({ text, line: lineOf(sf, n) });
  });
}

/**
 * Тексты отказов сервера (R-37): web печатает `message` отказа как есть (плашки блокировок, рутины,
 * тела, назначения), поэтому это строки интерфейса. Берётся второй аргумент `new ExecError(код, текст,
 * …)` и поле `message` у `new TRPCError({…})`; имя константы в тексте разворачивается по её объявлению в
 * том же файле (текст, собранный заранее, — частый приём). Текст, пришедший параметром функции или из
 * другого файла, страж не видит — граница названа в заголовке.
 */
export function serverMessages(rel: string, src: string): UiText[] {
  const sf = parse(rel, src);
  const decls = new Map<string, ts.Expression>();
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined)
      decls.set(n.name.text, n.initializer);
  });
  const out: UiText[] = [];
  // Разворачивается только то, из чего СОБИРАЕТСЯ строка: литерал, шаблон, `+`, тернарный, скобки и
  // имя константы. Имя в произвольном выражении (`r.error.message`) — не текст этого файла.
  const take = (expr: ts.Expression | undefined, depth = 0): void => {
    if (expr === undefined || depth > 3) return;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      stringsIn(expr, sf, out);
    } else if (ts.isTemplateExpression(expr)) {
      stringsIn(expr, sf, out);
      for (const span of expr.templateSpans) take(span.expression, depth + 1);
    } else if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      take(expr.left, depth);
      take(expr.right, depth);
    } else if (ts.isConditionalExpression(expr)) {
      take(expr.whenTrue, depth);
      take(expr.whenFalse, depth);
    } else if (ts.isParenthesizedExpression(expr)) {
      take(expr.expression, depth);
    } else if (ts.isIdentifier(expr)) {
      take(decls.get(expr.text), depth + 1);
    }
  };
  walk(sf, (n) => {
    // Помощники отказа с текстом вторым аргументом: тулы и предложения (`err`, `errorResult`),
    // компилятор запросов и язык E (`fail(причина, текст)`), дельты реестра (`deltaError`).
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      REFUSAL_HELPERS.includes(n.expression.text)
    ) {
      take(n.arguments[1]);
      return;
    }
    if (!ts.isNewExpression(n) || !ts.isIdentifier(n.expression)) return;
    if (n.expression.text === 'ExecError') take(n.arguments?.[1]);
    else if (n.expression.text === 'TRPCError') {
      const arg = n.arguments?.[0];
      if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return;
      for (const p of arg.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'message') take(p.initializer);
        // `{ code, message }` — сокращённое свойство: текст — одноимённая константа файла.
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'message') take(p.name);
      }
    }
  });
  return out;
}

/** Помощники отказа сервера, у которых текст — второй аргумент (охват (2), R-37). */
const REFUSAL_HELPERS = ['err', 'errorResult', 'fail', 'deltaError'];

/**
 * Подписи реестров shared (R-37): `label` и `description` строк реестра — их показывают секции записи,
 * конструктор запросов и экран расширений; `name`/`nameGenitive` манифестов расширений — плашки,
 * тосты и отказы. Берутся все строки значения (обычно `{ ru, en }`) и аргументы `options(…)`.
 */
const REGISTRY_TEXT_KEYS = ['label', 'description', 'name', 'nameGenitive'];

export function registryLabels(rel: string, src: string): UiText[] {
  const sf = parse(rel, src);
  const out: UiText[] = [];
  walk(sf, (n) => {
    if (
      ts.isPropertyAssignment(n) &&
      REGISTRY_TEXT_KEYS.includes(n.name.getText(sf).replace(/['"]/g, ''))
    )
      stringsIn(n.initializer, sf, out);
    // Варианты select пишутся кортежами `options(['ключ', 'подпись ru', 'label en'], …)` —
    // `label: { ru, en }` внутри помощника собран из параметров, подписи живут в аргументах вызова.
    else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'options'
    )
      for (const arg of n.arguments) stringsIn(arg, sf, out);
  });
  return out;
}

const bannedIn = (text: string) => BANNED.filter((b) => b.re.test(text)).map((b) => b.word);

/** Тексты отказов сервера — боевой код сервера без тестов и миграций. */
const SERVER_PATHSPEC = [
  ':(glob)apps/server/src/**/*.ts',
  ':(exclude,glob)apps/server/src/**/*.test.*',
  ':(exclude)apps/server/src/db/migrations/',
];
/** Подписи реестров shared. */
const REGISTRY_PATHSPEC = [
  ':(glob)packages/shared/src/registry/**/*.ts',
  ':(exclude,glob)packages/shared/src/registry/**/*.test.*',
];
/** Три охвата (2): строки интерфейса web, тексты отказов сервера, подписи реестров shared. */
const WORD_SCOPES = [
  { pathspec: WEB_PATHSPEC, extract: uiTexts },
  { pathspec: SERVER_PATHSPEC, extract: serverMessages },
  { pathspec: REGISTRY_PATHSPEC, extract: registryLabels },
] as const;

/** `путь → строки интерфейса со словами вне словаря` по трём охватам (2). */
function bannedWordHits(): Map<string, string[]> {
  // Кандидаты — регистр перечислен явно вдобавок к `-i`: регистронезависимость кириллицы у
  // `git grep` держится на локали, перечень от неё не зависит (довод `grammar-copies.test.ts`).
  const stems = ['сущност', 'модул', 'закреп'];
  const signs = [
    ...stems.flatMap((s) => [s, s[0]?.toUpperCase() + s.slice(1), s.toUpperCase()]),
    'view',
  ];
  const found = new Map<string, string[]>();
  for (const { pathspec, extract } of WORD_SCOPES) {
    for (const rel of candidates(signs, pathspec, true)) {
      // Ключ — строка текста: константа, развёрнутая в двух отказах, — одно место, а не два.
      const hits = [
        ...new Set(
          extract(rel, readFileSync(join(ROOT, rel), 'utf8'))
            .filter((t) => bannedIn(t.text).length > 0)
            .map((t) => `${t.line}: ${bannedIn(t.text).join(', ')} — ${t.text.slice(0, 80)}`),
        ),
      ];
      if (hits.length > 0) found.set(rel, hits);
    }
  }
  return found;
}

/** Имена с «module»: идентификаторы и литералы-идентификаторы (ключ провода, операция журнала). */
export function moduleNames(rel: string, src: string): string[] {
  const sf = parse(rel, src);
  const out: string[] = [];
  walk(sf, (n) => {
    let name: string | null = null;
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) name = n.text;
    else if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      /^[A-Za-z_$][\w$]*$/.test(n.text)
    )
      name = n.text;
    if (name !== null && /module/i.test(name)) out.push(name);
  });
  return out;
}

/** `имя → файлы`, где оно встречается, по боевому коду приложений и пакетов. */
function moduleNameHits(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const rel of candidates(['module'], ALL_PATHSPEC, true)) {
    for (const name of moduleNames(rel, readFileSync(join(ROOT, rel), 'utf8'))) {
      found.set(name, (found.get(name) ?? new Set()).add(rel));
    }
  }
  return found;
}

const exactCounts = (allow: Record<string, Allowed>, found: Map<string, unknown[]>) => {
  const actual: Record<string, number> = {};
  const expected: Record<string, number> = {};
  for (const [rel, entry] of Object.entries(allow)) {
    actual[rel] = found.get(rel)?.length ?? 0;
    expected[rel] = entry.count;
  }
  return { actual, expected };
};

describe('сторожа границ кода и словаря (срез 1б §8.4, §1, С1б-10)', () => {
  test('(а) обход не выродился: под наблюдением боевой код web без тестов', () => {
    // Положительный контроль охвата: сломайся pathspec — страж проверял бы пустой список и
    // зеленел бы на любом дереве.
    const files = git(['ls-files', '--', ...WEB_PATHSPEC], [0]);
    // Порог — по факту дерева 1б: боевых `.ts`/`.tsx` web ≈260 (план называл 300 по всем приложениям).
    expect(files.length).toBeGreaterThan(250);
    expect(files).toContain('apps/web/src/app/extension-registry.tsx');
    expect(files).toContain('apps/web/src/features/entity-detail/NativeRow.tsx');
    expect(files.some((f) => /\.test\./.test(f))).toBe(false);
    // Охваты (2) сервера и shared не выродились.
    const server = git(['ls-files', '--', ...SERVER_PATHSPEC], [0]);
    expect(server).toContain('apps/server/src/executor/executor.ts');
    expect(server.some((f) => /\.test\.|\/migrations\//.test(f))).toBe(false);
    const registry = git(['ls-files', '--', ...REGISTRY_PATHSPEC], [0]);
    expect(registry).toContain('packages/shared/src/registry/builtin-properties.ts');
    expect(registry.some((f) => /\.test\./.test(f))).toBe(false);
    const all = git(['ls-files', '--', ...ALL_PATHSPEC], [0]);
    expect(all).toContain('apps/server/src/errors.ts');
    expect(all).toContain('packages/shared/src/registry/extensions.ts');
  });

  test('(а) в охвате нет исключений каталогов: только тесты вне охвата (срез 1в §8.1)', () => {
    // Исключённый каталог выпадает из всех стражей молча; 1в снял последний (`legacy-1v`). Исключение
    // тестов (`…*.test.*`) — не каталог и законно; любое другое исключение — в любой форме pathspec git
    // (перенос гейта задачи 12, m-2) — провал. Проверяются ВСЕ ЧЕТЫРЕ pathspec стражей, включая охваты (2)
    // словаря — сервер и реестры shared (M-1 финального ревью B2b: прежде смотрели только web и общий).
    // Законное исключение не-тестов одно и названо поимённо: SQL миграций — не код с текстами отказов.
    const ALLOWED_DIR_EXCLUDES = new Set(['apps/server/src/db/migrations/']);
    const dirExcludes = [
      ...WEB_PATHSPEC,
      ...ALL_PATHSPEC,
      ...SERVER_PATHSPEC,
      ...REGISTRY_PATHSPEC,
    ].filter((s) => {
      const pattern = excludedPattern(s);
      return (
        pattern !== null && !TEST_FILES_PATTERN.test(pattern) && !ALLOWED_DIR_EXCLUDES.has(pattern)
      );
    });
    expect(dirExcludes).toEqual([]);
    // Разрешённое исключение действительно стоит там, где названо (иначе список разрешённого устарел).
    expect(SERVER_PATHSPEC.map(excludedPattern)).toContain('apps/server/src/db/migrations/');
  });

  test('(а) распознаватель исключений pathspec: длинная и короткая формы git', () => {
    // Длинная форма: слово `exclude` среди магии в скобках, в любом порядке и с соседями.
    expect(excludedPattern(':(exclude)apps/web/src/legacy/')).toBe('apps/web/src/legacy/');
    expect(excludedPattern(':(exclude,glob)apps/web/src/legacy/**')).toBe('apps/web/src/legacy/**');
    expect(excludedPattern(':(glob,exclude)apps/web/src/**/*.test.*')).toBe(
      'apps/web/src/**/*.test.*',
    );
    expect(excludedPattern(':(top, exclude ,icase)apps/x')).toBe('apps/x');
    // Короткая форма: `!` или `^` в подписи магии, с `/` и без, с завершающим `:` и без.
    expect(excludedPattern(':!apps/web/src/legacy/')).toBe('apps/web/src/legacy/');
    expect(excludedPattern(':^apps/web/src/legacy/')).toBe('apps/web/src/legacy/');
    expect(excludedPattern(':/!apps/x')).toBe('apps/x');
    expect(excludedPattern(':!/:apps/x')).toBe('apps/x');
    // Не исключения.
    for (const spec of [
      ':(glob)apps/web/src/**/*.ts',
      'apps/web/src',
      ':(top)apps/x',
      ':/apps/x',
    ]) {
      expect([spec, excludedPattern(spec)]).toEqual([spec, null]);
    }
  });

  test('(а) каждый каталог расширения есть в дереве', () => {
    // Каталог, которого нет, страж (1) «охраняет» вхолостую — и прячет, что список устарел.
    const missing = EXTENSION_DIRS.filter((d) => git(['ls-files', '--', d], [0]).length === 0);
    expect(missing).toEqual([]);
  });

  test('(б) резолвер и приметы на образцах', () => {
    const from = 'apps/web/src/features/chat/cards/EntityCard.tsx';
    const targets = (src: string) => importTargets(from, src).map((t) => t.target);
    expect(targets("import { useCategoryTitle } from '../../budget/categories';")).toEqual([
      'apps/web/src/features/budget/categories',
    ]);
    expect(targets("import type { X } from '../../budget/PlannedToFactCard';")).toEqual([
      'apps/web/src/features/budget/PlannedToFactCard',
    ]);
    expect(targets("const m = () => import('../../budget/usePlanToFactPrompt');")).toEqual([
      'apps/web/src/features/budget/usePlanToFactPrompt',
    ]);
    expect(targets("export { x } from '../../budget/EnvelopeCard';")).toEqual([
      'apps/web/src/features/budget/EnvelopeCard',
    ]);
    expect(targets("type T = import('../../../extensions/goals/GoalCard').G;")).toEqual([
      'apps/web/src/extensions/goals/GoalCard',
    ]);
    expect(inExtensionDir('apps/web/src/features/budget/categories')).toBe(true);
    expect(inExtensionDir('apps/web/src/features/budget')).toBe(true);
    expect(inExtensionDir('apps/web/src/features/budgetary/x')).toBe(false);
    const shared = targets("import { isExtensionEnabled } from '@orbis/shared';");
    expect(shared).toEqual(['@orbis/shared']);
    expect(shared.some(inExtensionDir)).toBe(false);

    const caught = (src: string) => uiTexts('x.tsx', src).some((t) => bannedIn(t.text).length > 0);
    for (const src of [
      '<input aria-label="Поиск сущности" />',
      'const a = <button>Закрепить</button>;',
      "const tabs = [{ label: 'Views' }];",
      "const empty = 'Нет установленных views';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: образец шаблонной строки — текст
      'const t = `Модуль ${name} выключен`;',
    ]) {
      expect([src, caught(src)]).toEqual([src, true]);
    }
    for (const src of [
      'const x = 1; // сущность',
      'const y = /* модуль */ 2;',
      "if (mode === 'view') go();",
      'const installedViews = [];',
      "import { a } from './views';",
      'const r = /сущност/;',
    ]) {
      expect([src, caught(src)]).toEqual([src, false]);
    }

    // Vite кладёт в сборку и глоб, и ассет по `new URL(…, import.meta.url)` — это тоже рёбра.
    expect(targets("const m = import.meta.glob('../../budget/*.tsx');")).toEqual([
      'apps/web/src/features/budget/*.tsx',
    ]);
    expect(
      targets("const m = import.meta.glob(['../../budget/*.ts', '!../../budget/x.ts']);"),
    ).toEqual(['apps/web/src/features/budget/*.ts', 'apps/web/src/features/budget/x.ts']);
    expect(targets("const u = new URL('../../budget/icon.svg', import.meta.url);")).toEqual([
      'apps/web/src/features/budget/icon.svg',
    ]);
    expect(targets("const u = new URL('https://example.com/budget/x');")).toEqual([]);

    // Тексты отказов сервера (R-37): аргумент текста, константа того же файла, помощники `err`/`errorResult`.
    const refused = (src: string) =>
      serverMessages('x.ts', src).some((t) => bannedIn(t.text).length > 0);
    for (const src of [
      "throw new ExecError('NOT_FOUND', 'сущность не найдена', { id });",
      "const M = 'сущность не является покупкой: ' + 'нет аспекта'; throw new ExecError('X', M);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: образец кода — текст, а не шаблон
      "throw new TRPCError({ code: 'FORBIDDEN', message: `сущность ${id} чужая` });",
      "return err('NOT_FOUND', 'сущность не найдена');",
      "return errorResult('NOT_FOUND', 'сущность не найдена', { id });",
      "fail('this_outside', 'this вне контекста сущности');",
      "throw deltaError('merge', 'сущность уже слита', {});",
      "const message = 'сущность не найдена'; throw new TRPCError({ code: 'NOT_FOUND', message });",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: образец кода — текст, а не шаблон
      "const v = ok ? undefined : 'ожидается uuid сущности'; throw new ExecError('V', `шаг: ${v}`);",
    ]) {
      expect([src, refused(src)]).toEqual([src, true]);
    }
    for (const src of [
      "// сущность не найдена\nthrow new ExecError('NOT_FOUND', 'запись не найдена');",
      "const r = run({ label: 'сущность' }); throw new ExecError(r.code, r.error.message);",
      "log('сущность не найдена');",
    ]) {
      expect([src, refused(src)]).toEqual([src, false]);
    }
    // Подписи реестров shared (R-37): `label` и `description`, любые строки значения.
    const labelled = (src: string) =>
      registryLabels('x.ts', src).some((t) => bannedIn(t.text).length > 0);
    expect(labelled("const p = { label: { ru: 'Закреплена', en: 'Pinned' } };")).toBe(true);
    expect(labelled("const a = { description: 'Привязка сущности ко времени' };")).toBe(true);
    expect(labelled("const a = { key: 'сущность', hint: 'сущность' };")).toBe(false);
    expect(
      labelled("const p = { type: { options: options(['pin', 'Закреплена', 'Pinned']) } };"),
    ).toBe(true);
    expect(
      labelled(
        "const m = { name: { ru: 'Модуль', en: 'Module' }, nameGenitive: { ru: 'Модуля' } };",
      ),
    ).toBe(true);

    expect(
      moduleNames('x.ts', "const disabledModules = 1; const s = 'module_set'; x.module = 2;"),
    ).toEqual(['disabledModules', 'module_set', 'module']);
    expect(moduleNames('x.ts', '// hiddenToolModule\nconst t = `модуль`;')).toEqual([]);
  });

  test('(в) (1) вне списка рёбер ядро → каталог расширения нет', () => {
    const offenders = [...coreToExtensionEdges().entries()]
      .filter(([rel]) => IMPORT_ALLOWLIST[rel] === undefined)
      .map(([rel, lines]) => `${rel}: ${lines.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  test('(г) (1) в списке — точно объявленный счёт', () => {
    const { actual, expected } = exactCounts(IMPORT_ALLOWLIST, coreToExtensionEdges());
    expect(actual).toEqual(expected);
  });

  test('(д) (2) в строках интерфейса (web, отказы сервера, подписи shared) нет слов вне словаря, кроме списка', () => {
    const offenders = [...bannedWordHits().entries()]
      .filter(([rel]) => WORD_ALLOWLIST[rel] === undefined)
      .flatMap(([rel, hits]) => hits.map((h) => `${rel}:${h}`));
    expect(offenders).toEqual([]);
  });

  test('(е) (2) в списке — точный счёт', () => {
    const { actual, expected } = exactCounts(WORD_ALLOWLIST, bannedWordHits());
    expect(actual).toEqual(expected);
  });

  test('(ж) (3) имена с module/Module/MODULE — только из MODULE_NAMES и голое `module`', () => {
    const offenders = [...moduleNameHits().entries()]
      .filter(([name]) => name !== 'module' && MODULE_NAMES[name] === undefined)
      .map(([name, files]) => `${name}: ${[...files].join(', ')}`);
    expect(offenders).toEqual([]);
  });

  test('(з) (3) список не протух: каждое имя MODULE_NAMES встречается', () => {
    const seen = moduleNameHits();
    expect(Object.keys(MODULE_NAMES).filter((name) => !seen.has(name))).toEqual([]);
  });
});
