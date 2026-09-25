// scripts/grammar-copies.test.ts
// СТРАЖ ОДНОЙ КОПИИ ПРАВИЛ МАРКЕРОВ (страницы, срез 1а: спека §5.9, РП-6, задача 17).
//
// Маркеры тела `{{…}}` распознаёт один листовой препроход `packages/shared/src/doc/page-grammar.ts`.
// До среза таких разборщиков было пять (`bodySegments` первого кадра, `parse.ts` блока запроса,
// токенайзер схемы, счётчик аудита…), и каждая новая конструкция грамматики обязана была попасть
// во все — а попадала не во все: первый кадр видел блок там, где редактор видел код (забор), и
// наоборот. Срез снял копии; страж держит, чтобы вторая не выросла снова.
//
// ПРЕДМЕТ — РАЗБОРЩИКИ, А НЕ ДАННЫЕ. Разборщик маркера узнаётся по экранированным фигурным скобкам:
// регэксп-литерал `\{\{…` или строка для `new RegExp` с `\\{\\{…`. Строки сида, примеры `{{query:…}}`
// в текстах интерфейса и докблоках, печать маркера шаблонной строкой (`{{${name}}}`) регэкспами не
// являются и сюда не попадают — ни одну из них менять ради стража не нужно. Отдельно ловится поиск
// маркера строкой (`indexOf('{{…')`, `startsWith('{{…')`): регэкспа там нет, а копия правил та же.
//
// Чего страж НЕ видит (граница названа, а не подразумевается): копию, собранную из кодов символов
// (`\x7b`, `String.fromCharCode`), и разбор посимвольным циклом. Такое пишут только нарочно.
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

/**
 * Приметы разборщика маркера, фиксированными строками для `git grep -F`:
 *  - `\{\{` — регэксп-литерал (`/^\{\{query:/`) и `String.raw` с ним же;
 *  - `\\{\\{` — строка для `new RegExp` (так собран образец экранирования в `manager.ts`);
 *  - `\{{2}` — те же скобки квантификатором;
 *  - поиск строкой — `indexOf`/`startsWith`/`includes`/`lastIndexOf`/`split` с аргументом,
 *    начинающимся на `{{`, в трёх видах кавычек.
 */
const PARSER_SIGNS: readonly string[] = [
  '\\{\\{',
  '\\\\{\\\\{',
  '\\{{2}',
  ...['indexOf', 'startsWith', 'includes', 'lastIndexOf', 'split'].flatMap((fn) =>
    ["'", '"', '`'].map((q) => `${fn}(${q}{{`),
  ),
];

/**
 * Законные места, поимённо: путь → сколько строк с приметой и почему.
 *
 * Счёт ТОЧНЫЙ, а не «не больше»: с порогом в разрешённый файл можно было бы молча дописать ещё
 * один разборщик — например, второй токенайзер в `query-block.ts`, — и страж бы его пропустил.
 */
const ALLOWLIST: Record<string, { readonly count: number; readonly reason: string }> = {
  'packages/shared/src/doc/page-grammar.ts': {
    count: 4,
    reason:
      'ЕДИНСТВЕННАЯ копия правил маркеров (РП-6): контейнеры, подпись вкладки, девять блоков ' +
      'обвязки, карточка аспекта. Её читают разбор тела (`parseBody`), первый кадр, рендерер ' +
      'показа, бейдж закреплённого и обёртка блока запроса',
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
 */
function git(args: readonly string[], ok: readonly number[]): string[] {
  const res = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (!ok.includes(res.exitCode)) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(`страж одной копии правил: git ${args[0]} вернул код ${res.exitCode}: ${err}`);
  }
  return new TextDecoder()
    .decode(res.stdout)
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** `путь → номера строк с приметой разборщика`. `-a` — файл с NUL-байтом не пропускается молча. */
function parserHits(): Map<string, number[]> {
  const lines = git(
    ['grep', '-a', '-n', '-F', ...PARSER_SIGNS.flatMap((s) => ['-e', s]), '--', ...SOURCE_PATHSPEC],
    [0, 1],
  );
  const found = new Map<string, number[]>();
  for (const line of lines) {
    const m = /^([^:]+):(\d+):/.exec(line);
    if (!m) throw new Error(`страж одной копии правил: непонятная строка git grep: ${line}`);
    const [, rel, no] = m as unknown as [string, string, string];
    found.set(rel, [...(found.get(rel) ?? []), Number(no)]);
  }
  return found;
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

  test('приметы ловят все три формы разборщика и не ловят данные', () => {
    // Контроль самих примет на образцах: регэксп-литерал, строка для RegExp, квантификатор,
    // поиск строкой — ловятся; строка сида, печать маркера, пример в тексте — нет.
    const caught = (src: string) => PARSER_SIGNS.some((s) => src.includes(s));
    expect(caught(String.raw`const RE = /^\{\{query:([\s\S]*?)\}\}/;`)).toBe(true);
    expect(caught(String.raw`new RegExp('^\\{\\{(title|tags)\\}\\}')`)).toBe(true);
    expect(caught(String.raw`/^\{{2}query:/`)).toBe(true);
    expect(caught(`line.startsWith('{{query:')`)).toBe(true);
    expect(caught('const body = `{{query:aspect=orbis/task, display=list}}`;')).toBe(false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: образец печати маркера — текст
    expect(caught('label={`{{${name}}}`}')).toBe(false);
    expect(caught(' * пример: `{{card: Цель}}` ставит карточку')).toBe(false);
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
    const lines = git(
      [
        'grep',
        '-a',
        '-n',
        '-i',
        '-e',
        'смарт-лист',
        '--',
        ':(glob)apps/web/src/**',
        ':(exclude,glob)**/*.test.*',
      ],
      [0, 1],
    );
    const inCode = lines.filter((l) => {
      const text = l.replace(/^[^:]+:\d+:/, '').trim();
      return !/^(\*|\/\/|\/\*|\{\/\*)/.test(text);
    });
    expect(inCode).toEqual([]);
  });
});
