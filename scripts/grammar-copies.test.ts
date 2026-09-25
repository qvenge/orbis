// scripts/grammar-copies.test.ts
// СТРАЖ ОДНОЙ КОПИИ ПРАВИЛ МАРКЕРОВ (страницы, срез 1а: спека §5.9, РП-6, задача 17).
//
// Маркеры тела `{{…}}` распознаёт один листовой препроход `packages/shared/src/doc/page-grammar.ts`.
// До среза таких разборщиков было пять (`bodySegments` первого кадра, `parse.ts` блока запроса,
// токенайзер схемы, счётчик аудита…), и каждая новая конструкция грамматики обязана была попасть
// во все — а попадала не во все: первый кадр видел блок там, где редактор видел код (забор), и
// наоборот. Срез снял копии; страж держит, чтобы вторая не выросла снова.
//
// ПРЕДМЕТ — РАЗБОРЩИКИ, А НЕ ДАННЫЕ. Разборщик маркера узнаётся тремя родами примет:
//  - регэксп, начинающийся маркером: экранированные скобки (литерал `\{\{…`, строка для `new RegExp`
//    с `\\{\\{…`, квантификатор `\{{2}`), неэкранированные в начале литерала (`/{{`, `/^{{`), класс
//    `[{]`, строка `new RegExp('{{…')`;
//  - поиск маркера строкой: `indexOf`/`startsWith`/`includes`/`lastIndexOf`/`split` с аргументом `'{{…`;
//  - строка-открытие маркера в сравнении или константе: `= '{{…`, `=== '{{…`, `!== '{{…`, `: '{{…`,
//    `case '{{…` — так ищет блок данных сама единственная копия (`QUERY_OPEN` + `startsWith`); в
//    обратных кавычках — только голый маркер без содержимого (`` = `{{title}}` ``, `` = `{{query:` ``).
// Строки сида (`` = `{{query:aspect=…}}` ``), печать маркера с интерполяцией (`{{${name}}}`), примеры
// в текстах интерфейса сюда не попадают; строки-комментарии (начинаются с `*`, `//`, `/*`) не
// считаются вовсе — в докблоках маркеры пишут словами.
//
// Чего страж НЕ видит (граница названа, а не подразумевается): открывающую строку, собранную не
// литералом — конкатенацией (`'{' + '{'`), из кодов символов (`\x7b`, `String.fromCharCode`), шаблоном
// с интерполяцией рядом со сравнением (печать и сравнение различимы только разбором кода); литерал
// маркера, стоящий аргументом своей функции без `=`/`:`/`case` перед ним (`isMarker(line, '{{title}}')`);
// разбор посимвольным циклом; копию правил в `scripts/` и в тестах — они вне охвата.
//
// Охват — боевой код `apps/*/src` и `packages/*/src` без тестов. Тесты вправе держать образцы
// маркеров (это предмет их проверки); `scripts/` — инструменты: гейт `check-legacy-form.ts` ищет
// старые формы ДАННЫХ, а не разбирает тело.
//
// Оборотная сторона `git grep` (Ф-Б2-11): виден только ЗАРЕГИСТРИРОВАННЫЙ файл. Новый файл с копией
// правил, ещё не добавленный в индекс, локально страж не увидит; в CI дерево checkout'а в индексе
// целиком.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

/** Боевой код обоих приложений и пакетов, без тестов — pathspec `git grep`/`git ls-files`. */
const SOURCE_PATHSPEC = [
  ':(glob)apps/*/src/**',
  ':(glob)packages/*/src/**',
  ':(exclude,glob)**/*.test.*',
];

const QUOTES = ["'", '"', '`'] as const;

/** Приметы фиксированными строками (`git grep -F`): регэкспы маркера и поиск строкой. */
const FIXED_SIGNS: readonly string[] = [
  '\\{\\{',
  '\\\\{\\\\{',
  '\\{{2}',
  '/{{',
  '/^{{',
  '[{]',
  ...QUOTES.flatMap((q) => [`RegExp(${q}{{`, `RegExp(${q}^{{`]),
  ...['indexOf', 'startsWith', 'includes', 'lastIndexOf', 'split'].flatMap((fn) =>
    QUOTES.map((q) => `${fn}(${q}{{`),
  ),
];

/**
 * Строка-открытие в сравнении или константе. Один образец и для `git grep -P`, и для контроля
 * примет в самом тесте — чтобы проверялось ровно то, что ищется. В кавычках `'`/`"` — любая строка,
 * начинающаяся `{{` (данные такими не пишут: сид — шаблонными строками); в обратных кавычках — только
 * голый маркер `{{имя}}`, `{{/имя}}`, `{{имя:` без содержимого, иначе под примету попали бы тела сида.
 */
const OPENER_SIGNS: readonly RegExp[] = [
  /(?:[=:]|\bcase)\s*['"]\{\{/,
  /(?:[=:]|\bcase)\s*`\{\{\/?[a-z_]+(?::|\}\})`/,
];

/** Строка-комментарий: маркеры в докблоках — слова, а не разбор. */
const isCommentLine = (text: string) => /^(\*|\/\/|\/\*|\{\/\*)/.test(text.trim());

/** Ловит ли кусок кода хоть одна примета — тот же критерий, что у `git grep` ниже. */
const caught = (src: string) =>
  !isCommentLine(src) &&
  (FIXED_SIGNS.some((s) => src.includes(s)) || OPENER_SIGNS.some((re) => re.test(src)));

/**
 * Законные места, поимённо: путь → сколько строк с приметой и почему.
 *
 * Счёт ТОЧНЫЙ, а не «не больше»: с порогом в разрешённый файл можно было бы молча дописать ещё
 * один разборщик — например, второй токенайзер в `query-block.ts`, — и страж бы его пропустил.
 */
const ALLOWLIST: Record<string, { readonly count: number; readonly reason: string }> = {
  'packages/shared/src/doc/page-grammar.ts': {
    count: 5,
    reason:
      'ЕДИНСТВЕННАЯ копия правил маркеров (РП-6): четыре регэкспа (контейнеры, подпись вкладки, ' +
      'девять блоков обвязки, карточка аспекта) и открытие блока данных `QUERY_OPEN`. Её читают ' +
      'разбор тела (`parseBody`), первый кадр, рендерер показа, бейдж закреплённого, обёртка блока ' +
      'запроса и сверка адреса `{{body}}` в «Изменить вид»',
  },
  'packages/shared/src/doc/nodes/query-block.ts': {
    count: 2,
    reason:
      'токенайзер `queryBlock` для `marked` (`start` и `tokenize`) — прежнее поведение схемы ' +
      'документа: он работает ВНУТРИ markdown-блоков, поэтому блок запроса с отступом в пункте ' +
      'списка, в цитате и второй блок на той же строке редактор видит, а препроход — нет. ' +
      'Расхождение первого кадра и редактора известно и закреплено тестом «первый кадр НЕ видит ' +
      'блок в пункте списка, в цитате и второй блок строки» (`apps/web/src/features/browser/' +
      'query.test.ts`; ревью задач 8 и 11): так было и при прежнем регэкспе первого кадра, а ' +
      'снять токенайзер значило бы сменить смысл уже сохранённых тел с блоком в пункте списка',
  },
  'packages/shared/src/doc/manager.ts': {
    count: 1,
    reason:
      'экранирование, а не разбор: абзац, чей текст начинается маркером, печатается с `\\{`, ' +
      'чтобы повторный разбор не сделал из него блок (Ф-1а-11). Имена маркеров берутся из ' +
      'экспорта препрохода (`RECORD_BLOCK_NAMES`), так что новое имя блока обвязки попадает ' +
      'сюда само',
  },
  'apps/server/src/db/audit-bodies.ts': {
    count: 1,
    reason:
      'счётчик прошлой конверсии тел (`NONTRIVIAL_RE`): отличает тело со ссылкой или блоком ' +
      'запроса от простого текста для отчёта аудита — ничего не разбирает и не показывает',
  },
};

/**
 * Запуск git с проверкой кода возврата. Молчащий страж хуже отсутствующего, поэтому непонятный
 * код — исключение, а не «совпадений нет». `ok` — штатные коды: у `git grep` это 0 и 1.
 *
 * Локаль фиксирована (`LC_ALL=C.UTF-8`): без неё `git grep -i` по кириллице и `-P` над UTF-8
 * зависят от окружения — при `LANG=C` регистронезависимый поиск кириллицы не срабатывает.
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
    throw new Error(`страж одной копии правил: git ${args[0]} вернул код ${res.exitCode}: ${err}`);
  }
  return new TextDecoder()
    .decode(res.stdout)
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** `путь:строка:текст` → части; непонятная строка — исключение, не молчание. */
function splitHit(line: string): { rel: string; no: number; text: string } {
  const m = /^([^:]+):(\d+):(.*)$/.exec(line);
  if (!m) throw new Error(`страж одной копии правил: непонятная строка git grep: ${line}`);
  const [, rel, no, text] = m as unknown as [string, string, string, string];
  return { rel, no: Number(no), text };
}

/**
 * `путь → номера строк с приметой разборщика` (объединение двух проходов `git grep`, строки-
 * комментарии отброшены). `-a` — файл с NUL-байтом не пропускается молча.
 */
function parserHits(): Map<string, number[]> {
  const fixed = git(
    ['grep', '-a', '-n', '-F', ...FIXED_SIGNS.flatMap((s) => ['-e', s]), '--', ...SOURCE_PATHSPEC],
    [0, 1],
  );
  const openers = git(
    [
      'grep',
      '-a',
      '-n',
      '-P',
      ...OPENER_SIGNS.flatMap((re) => ['-e', re.source]),
      '--',
      ...SOURCE_PATHSPEC,
    ],
    [0, 1],
  );
  const seen = new Map<string, Set<number>>();
  for (const hit of [...fixed, ...openers].map(splitHit)) {
    if (isCommentLine(hit.text)) continue;
    seen.set(hit.rel, (seen.get(hit.rel) ?? new Set()).add(hit.no));
  }
  return new Map([...seen].map(([rel, nos]) => [rel, [...nos].sort((a, b) => a - b)]));
}

describe('маркеры тела распознаёт одна копия правил (спека страниц 1а §5.9, РП-6)', () => {
  test('обход не выродился: под наблюдением боевой код обоих приложений и пакета', () => {
    // Положительный контроль охвата: сломайся pathspec — страж проверял бы пустой список и
    // зеленел бы на любом дереве.
    const files = git(['ls-files', '--', ...SOURCE_PATHSPEC], [0]);
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain('packages/shared/src/doc/page-grammar.ts');
    expect(files).toContain('apps/web/src/features/browser/query.ts');
    expect(files).toContain('apps/server/src/db/audit-bodies.ts');
    expect(files.some((f) => /\.test\./.test(f))).toBe(false);
  });

  test('приметы ловят все роды разборщика и не ловят данные', () => {
    // Контроль самих примет на образцах — теми же образцами, что уходят в `git grep`.
    const parsers = [
      String.raw`const RE = /^\{\{query:([\s\S]*?)\}\}/;`,
      String.raw`new RegExp('^\\{\\{(title|tags)\\}\\}')`,
      String.raw`/^\{{2}query:/`,
      '/^{{title}}[ \\t]*$/',
      '/^[{]{2}title[}]{2}$/',
      "new RegExp('^{{title}}')",
      "line.startsWith('{{query:')",
      "const OPEN='{{title}}'",
      "const QUERY_OPEN = '{{query:';",
      "if (line.trim() !== '{{body}}') return;",
      'if (l === "{{tabs}}") return;',
      "case '{{cards}}':",
      "const MARKERS = { open: '{{columns}}' };",
      'const OPEN = `{{title}}`;',
      'const Q = `{{query:`;',
    ];
    for (const src of parsers) expect([src, caught(src)]).toEqual([src, true]);
    const data = [
      'const body = `{{query:aspect=orbis/task, display=list}}`;',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: образец печати маркера — текст
      'label={`{{${name}}}`}',
      ' * пример: `{{card: Цель}}` ставит карточку',
      "// сравнение с '{{body}}' — в комментарии не считается",
    ];
    for (const src of data) expect([src, caught(src)]).toEqual([src, false]);
  });

  test('вне списка законных мест разборщиков маркеров нет', () => {
    const offenders = [...parserHits().entries()]
      .filter(([rel]) => ALLOWLIST[rel] === undefined)
      .map(([rel, lines]) => `${rel}: ${lines.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  test('в законных местах — ТОЧНО столько строк, сколько объявлено', () => {
    const found = parserHits();
    const actual: Record<string, number> = {};
    for (const rel of Object.keys(ALLOWLIST)) actual[rel] = found.get(rel)?.length ?? 0;
    const expected: Record<string, number> = {};
    for (const [rel, entry] of Object.entries(ALLOWLIST)) expected[rel] = entry.count;
    expect(actual).toEqual(expected);
  });
});

describe('слова «смарт-лист» в интерфейсе web нет (спека страниц 1а §7.4)', () => {
  test('ни в одной строке кода web, кроме комментариев', () => {
    // Слово ушло из словаря: пункт «/» — «Список по запросу», блок — «блок данных». Комментарий
    // вправе назвать прежнее имя («бывший «Смарт-лист»»), строка интерфейса — нет. Комментарием
    // считается строка, которая им начинается: хвостовой комментарий после кода считается кодом
    // намеренно — отличить его от текста в JSX без разбора синтаксиса нельзя.
    //
    // Регистры перечислены явно, а не `-i`: регистронезависимость кириллицы у `git grep` держится
    // на локали процесса, и при `LANG=C` `СМАРТ-ЛИСТ` проходил бы мимо. Локаль фиксирована и так
    // (`git` выше), перечень — вторая страховка, не зависящая от того, есть ли `C.UTF-8` в системе.
    const spellings = ['смарт-лист', 'Смарт-лист', 'Смарт-Лист', 'СМАРТ-ЛИСТ', 'смарт-Лист'];
    const lines = git(
      [
        'grep',
        '-a',
        '-n',
        ...spellings.flatMap((s) => ['-e', s]),
        '--',
        ':(glob)apps/web/src/**',
        ':(exclude,glob)**/*.test.*',
      ],
      [0, 1],
    );
    const inCode = lines.filter((l) => !isCommentLine(splitHit(l).text));
    expect(inCode).toEqual([]);
  });
});
