// Тест греп-гейта старой формы данных (scripts/check-legacy-form.ts, §А12-2).
//
// Гейт проверяется НА СИНТЕТИЧЕСКОМ дереве, а не на рабочем: цифры рабочего дерева меняет
// каждая задача среза, и тест, привязанный к ним, начал бы падать по чужой причине. Здесь
// на каждый инвариант заводится крошечный временный git-репозиторий с ровно теми файлами,
// которые инвариант описывает.
//
// Почему временный репозиторий, а не подкаталог: источник совпадений — `git grep`, а он
// ищет по файлам, ЗАРЕГИСТРИРОВАННЫМ в индексе, и pathspec'ы гейта отсчитываются от корня
// репозитория.
//
// Прогоняется корневым `bun run test`: `bun run --filter '*' test` берёт только пакеты
// workspace (корневой пакет под `*` НЕ попадает — проверено), поэтому в корневой скрипт
// `test` добавлен хвост `&& bun test scripts/`. Без него этот файл не запускал бы никто —
// ни локально, ни в CI.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ALLOWLIST,
  LEGACY_MARKERS,
  type MarkerReport,
  scan,
  scanMarker,
} from './check-legacy-form.ts';

const SCRIPT = join(import.meta.dir, 'check-legacy-form.ts');
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Временный git-репозиторий с заданными файлами; файлы добавлены в индекс (без коммита). */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbis-legacy-form-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  for (const cmd of [
    ['git', 'init', '-q'],
    ['git', 'add', '-A'],
  ]) {
    const p = Bun.spawnSync(cmd, { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) {
      throw new Error(`${cmd.join(' ')} упал: ${new TextDecoder().decode(p.stderr)}`);
    }
  }
  return dir;
}

function byId(reports: MarkerReport[], id: string): MarkerReport {
  const r = reports.find((x) => x.id === id);
  if (r === undefined) throw new Error(`маркера ${id} нет в отчёте`);
  return r;
}

/** Запуск гейта как CLI — ради кода возврата, ради которого он и существует. */
function cli(dir: string, ...args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const dec = new TextDecoder();
  return { code: p.exitCode, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

test('файл с NUL-байтом сопоставляется — и когда байт в начале, и когда в середине', () => {
  // Это ЕДИНСТВЕННАЯ причина, по которой гейт написан скриптом, а не строкой `grep -r` в CI.
  // `grep -r` на обоих файлах ниже даёт ноль строк и молчит; `git grep` без `-a` даёт по
  // первому «Binary file … matches» без номера строки, а с `-I` — тоже ноль.
  const dir = repo({
    // NUL в первых байтах — сюда `-I` бы не заглянул вовсе
    'apps/server/src/nul-early.ts': '\u0000\u0000 header\nconst q = "aspects->x";\n',
    // NUL после совпадения — так выглядел budget/aggregates.ts (ключи сортировки)
    'apps/server/src/nul-late.ts':
      'const q = "select aspects->\'orbis/task\' from e";\nconst k = `a\u0000b`;\n',
  });
  const r = byId(scan(dir), 'aspects-path');
  expect(r.hits.map((h) => `${h.path}:${h.line}`).sort()).toEqual([
    'apps/server/src/nul-early.ts:2',
    'apps/server/src/nul-late.ts:1',
  ]);
});

test('entity-meta ловит АДРЕСУЕМЫЕ формы снятой колонки — и только их', () => {
  // Позитивный контроль к следующему тесту: без него «ничего не нашлось» нельзя отличить
  // от «маркер сломан и не находит ничего никогда».
  //
  // Формы-эвристики (`meta: {}`, `meta: row.meta`) маркер БОЛЬШЕ НЕ ЛОВИТ, и это не
  // послабление, а замер: они промахивались двенадцать раз из тринадцати на мешке СВЯЗИ,
  // который жив и после реформы (см. докблок маркера). Два файла ниже — контроль ровно
  // этого: форма связи проходит, адресация снятой колонки — нет.
  const dir = repo({
    'apps/server/src/a.ts': 'const v = entities.meta;\n',
    'apps/server/src/b.ts': 'const q = "entities_meta_gin";\n',
    'apps/server/src/c.ts': 'const rel = { sourceId: x, meta: {} };\n',
    'apps/server/src/d.ts': 'const p = { meta: row.meta };\n',
  });
  const r = byId(scan(dir), 'entity-meta');
  expect(r.files.slice().sort()).toEqual(['apps/server/src/a.ts', 'apps/server/src/b.ts']);
});

test('entity-meta не считает import.meta, relations.meta и metadata', () => {
  const dir = repo({
    'apps/web/src/legit.ts': [
      'const here = import.meta.dir;',
      'const also = import.meta.main;',
      'const m = relations.meta;',
      'const one = relation.meta;',
      'const md = metadata;',
      '',
    ].join('\n'),
  });
  const r = byId(scan(dir), 'entity-meta');
  expect(r.hits).toEqual([]);
});

test('COMMENT_ONLY_LINE: строка-комментарий снимается, а КОД с хвостовым комментарием — нет', () => {
  /**
   * Маска заведена Задачей 23b для трёх маркеров снятых носителей (`aspects-legacy`,
   * `relation-type`, `entity-meta`) и по Р-23b-13 обязана глушить ПРОЗУ, а не КОД.
   *
   * Проверяются обе половины сразу, потому что дефект бывает в обе стороны: слишком широкая
   * маска ослепила бы гейт на строке кода с хвостовым `// …`, слишком узкая — заставила бы
   * переписывать докблоки, объясняющие снятое, и делала бы их лживыми.
   *
   * Четыре формы начала комментария — те, что встречаются в дереве: `//` и `/*` у TS, `*`
   * у продолжения докблока, `--` у SQL внутри шаблонных литералов.
   */
  const dir = repo({
    'apps/server/src/prose.ts': [
      '// целиком комментарий: aspects_legacy и relation_type и entities.meta',
      ' * продолжение докблока: aspectsLegacy, relationType',
      '/* открывающий: legacy-form и entity.meta */',
      '        -- SQL внутри литерала: relation_type',
      '',
    ].join('\n'),
    'apps/server/src/code.ts': [
      'const a = row.aspectsLegacy; // хвост про aspects_legacy',
      "const b = 'relation_type'; // хвост",
      'const c = entities.meta; // хвост',
      '',
    ].join('\n'),
  });
  const reports = scan(dir);
  // Проза не считается ни одним из трёх маркеров…
  for (const id of ['aspects-legacy', 'relation-type', 'entity-meta']) {
    expect(`${id}: ${byId(reports, id).files.join(',')}`).toBe(`${id}: apps/server/src/code.ts`);
  }
  // …а код считается ПОСТРОЧНО: три строки, каждая своим маркером.
  expect(byId(reports, 'aspects-legacy').hits.map((h) => h.line)).toEqual([1]);
  expect(byId(reports, 'relation-type').hits.map((h) => h.line)).toEqual([2]);
  expect(byId(reports, 'entity-meta').hits.map((h) => h.line)).toEqual([3]);
});

test('COMMENT_ONLY_LINE не снимает строку у маркеров, которым её не давали', () => {
  // Маска стоит у ТРЁХ маркеров, а не у всех: `bare-field` и соседи ловят форму, которая
  // жива и в прозе (пример запроса в докблоке — тоже пример запроса).
  const dir = repo({
    'apps/server/src/prose-query.ts': '// пример: {{query: aspect=orbis/task, status=inbox}}\n',
  });
  expect(byId(scan(dir), 'bare-field').hits.map((h) => h.line)).toEqual([1]);
});

test('exclude вырезает форму, а не всю строку: соседнее нарушение остаётся видимым', () => {
  // Правило «строка со словом import.meta целиком не считается» ослепило бы гейт ровно там,
  // где законная и незаконная формы стоят рядом.
  const dir = repo({
    'apps/server/src/mixed.ts': 'const x = import.meta.dir + String(entities.meta);\n',
  });
  const r = byId(scan(dir), 'entity-meta');
  expect(r.hits.map((h) => h.line)).toEqual([1]);
});

test('aspect= сам по себе законен, неквалифицированное имя поля после него — нет', () => {
  const dir = repo({
    'apps/web/src/ok.ts': "const q = 'aspect=orbis/task';\n",
    'apps/web/src/bad.ts': 'const q = "{{query: aspect=orbis/task status=open}}";\n',
  });
  const r = byId(scan(dir), 'bare-field');
  expect(r.files).toEqual(['apps/web/src/bad.ts']);
});

test('pathspec отсекает миграции, снапшоты и файлы вне зоны поиска', () => {
  const dir = repo({
    'apps/server/src/db/migrations/0001_x.sql': "select aspects->'a';\n",
    'apps/web/src/x.snap': 'aspects->x\n',
    'docs/notes.md': 'aspects->x\n',
    'apps/server/src/real.ts': 'const q = "aspects->x";\n',
  });
  const r = byId(scan(dir), 'aspects-path');
  expect(r.files).toEqual(['apps/server/src/real.ts']);
});

test('allowlist снимает файл и печатает, сколько строк снял и почему', () => {
  const dir = repo({
    'scripts/check-legacy-form.ts': 'const q = "aspects->x";\nconst r = relation_type;\n',
    'apps/server/src/real.ts': 'const q = "aspects->x";\n',
  });
  const reports = scan(dir);
  expect(byId(reports, 'aspects-path').files).toEqual(['apps/server/src/real.ts']);
  expect(byId(reports, 'aspects-path').allowed.get('scripts/check-legacy-form.ts')).toBe(1);
  expect(byId(reports, 'relation-type').hits).toEqual([]);

  // В отчёте у записи стоит суммарное по маркерам число снятых строк: aspects-path + relation-type.
  const { out } = cli(dir);
  expect(out).toContain('scripts/check-legacy-form.ts — снято строк: 2 — сам гейт');
});

test('--gate: код 1 при совпадении вне allowlist', () => {
  const dir = repo({ 'apps/server/src/real.ts': 'const q = "aspects->x";\n' });
  expect(cli(dir).code).toBe(0); // режим отчёта не падает никогда
  const gate = cli(dir, '--gate');
  expect(gate.code).toBe(1);
  expect(gate.err).toContain('apps/server/src/real.ts:1');
});

test('--gate: код 0 на дереве без старой формы', () => {
  const dir = repo({ 'apps/server/src/ok.ts': 'export const ok = 1;\n' });
  const gate = cli(dir, '--gate');
  expect(gate.code).toBe(0);
  expect(gate.out).toContain('ok — совпадений старой формы нет');
});

test('неизвестный аргумент — код 2, а не молчаливый ноль', () => {
  const dir = repo({ 'apps/server/src/ok.ts': 'export const ok = 1;\n' });
  const r = cli(dir, '--fix');
  expect(r.code).toBe(2);
  expect(r.err).toContain('--fix');
});

/**
 * Позитивный контроль КАЖДОГО маркера: по образцу на каждую его альтернативу, по одной
 * строке на альтернативу.
 *
 * Зачем построчно, а не «по образцу на маркер». Гейт-ревью замерило: замена паттерна на
 * никогда-не-совпадающий у шести маркеров из десяти (`aspects-legacy`, `due-alias`,
 * `rule-parser`, `pseudo-aspect`, `service-const`, `prop-type-heur`) не роняла ни одного
 * теста, и точечное удаление `aspectsMap` из `aspects-legacy` — тоже. Сломанный маркер
 * молча даёт ноль, а ноль — это ровно то, чего требует приёмка §С8-10: «ноль совпадений»
 * оказался бы выполнен фиктивно, при живой старой форме в дереве.
 *
 * Число строк в образце и есть пин: выпадет альтернатива из паттерна — счёт разойдётся.
 */
const SAMPLES: ReadonlyArray<{
  readonly id: string;
  readonly lines: readonly string[];
  /**
   * Законные пересечения: какой ЧУЖОЙ маркер и на скольких строках обязан поймать этот же
   * образец. Пересечения перечислены поимённо, а не прощены оптом, — иначе тест перестал
   * бы замечать, что маркер расползся на чужую зону.
   */
  readonly alsoCaughtBy?: ReadonlyArray<{ readonly marker: string; readonly lines: number }>;
}> = [
  {
    id: 'aspects-path',
    lines: [
      `const a = "select aspects->'orbis/task' from e";`,
      `const b = "select aspects_legacy -> 'orbis/task' from e";`,
    ],
    // Вторая строка пиннит и `(_legacy)?`, и `\s*` — и по существу принадлежит обоим маркерам.
    alsoCaughtBy: [{ marker: 'aspects-legacy', lines: 1 }],
  },
  {
    id: 'aspects-legacy',
    lines: [
      'const a = aspects_legacy;',
      'const b = aspectsLegacy;',
      'const c = aspectsMap;',
      `const d = 'legacy-form';`,
    ],
  },
  {
    id: 'relation-type',
    lines: ['const a = relation_type;', 'const b = relationType;', 'const c = RELATION_TYPES;'],
  },
  {
    id: 'entity-meta',
    lines: ['const a = entities.meta;', 'const b = entity.meta;', `const c = 'entities_meta_gin';`],
  },
  { id: 'due-alias', lines: [`const a = "due=today";`] },
  {
    id: 'bare-field',
    // Три префикса × четырнадцать имён полей: префиксы пиннятся отдельными строками,
    // имена — по строке на имя (выпадет имя из паттерна — счёт строк разойдётся).
    lines: [
      `const p1 = "{{query: status=open}}";`,
      `const p2 = "aspect=orbis/task status=open";`,
      `const p3 = "sortBy=x status=open";`,
      ...[
        'stage',
        'priority',
        'kind',
        'scope',
        'outcome',
        'undecided',
        'due_date',
        'start_at',
        'occurred_on',
        'planned',
        'amount',
        'direction',
        'category_ref',
      ].map((f) => `const f = "{{query: ${f}=x}}";`),
    ],
  },
  { id: 'rule-parser', lines: ['const a = parseRuleTitle;', 'const b = formatRuleTitle;'] },
  {
    id: 'pseudo-aspect',
    lines: ['const a = ENTITY_PSEUDO_ASPECT;', `const b = 'orbis/entity';`],
  },
  { id: 'service-const', lines: ['const a = SERVICE_ASPECT_IDS;'] },
  { id: 'prop-type-heur', lines: ['const a = propType(x);'] },
  {
    id: 'legacy-grammar',
    lines: [
      "import { parseQuery } from './query/grammar';",
      'const a = parseQueryAny(t, reg);',
      'const b = serializeQuery(ast);',
      'const c = buildFieldCatalog(defs);',
    ],
  },
];

test('позитивный контроль: у каждого маркера есть образец', () => {
  // Новый маркер без образца остался бы незапиненным — тем самым отказом, что нашло ревью.
  expect(SAMPLES.map((s) => s.id)).toEqual(LEGACY_MARKERS.map((m) => m.id));
});

test('позитивный контроль: каждый маркер ловит все свои формы и только свой файл', () => {
  const files: Record<string, string> = {};
  for (const s of SAMPLES) {
    files[`apps/server/src/sample-${s.id}.ts`] = `${s.lines.join('\n')}\n`;
  }
  const reports = scan(repo(files));
  const actual = Object.fromEntries(
    reports.map((r) => [r.id, { files: r.files.slice().sort(), lines: r.hits.length }]),
  );

  const expected: Record<string, { files: string[]; lines: number }> = {};
  for (const s of SAMPLES) {
    expected[s.id] ??= { files: [], lines: 0 };
    const own = expected[s.id] as { files: string[]; lines: number };
    own.files.push(`apps/server/src/sample-${s.id}.ts`);
    own.lines += s.lines.length;
    for (const x of s.alsoCaughtBy ?? []) {
      expected[x.marker] ??= { files: [], lines: 0 };
      const foreign = expected[x.marker] as { files: string[]; lines: number };
      foreign.files.push(`apps/server/src/sample-${s.id}.ts`);
      foreign.lines += x.lines;
    }
  }
  for (const v of Object.values(expected)) v.files.sort();

  expect(actual).toEqual(expected);
});

test('гейт отказывается работать из подкаталога, а не печатает ложный ноль', () => {
  // Замер ревью: из `<корень>/apps` гейт печатал «ok» и выходил с кодом 0 при живых
  // нарушениях — pathspec'ы git grep отсчитываются от cwd и там ни с чем не совпадают.
  const dir = repo({ 'apps/server/src/real.ts': 'const q = "aspects->x";\n' });
  expect(() => scan(join(dir, 'apps'))).toThrow(/только из КОРНЯ репозитория/);

  const r = cli(join(dir, 'apps'), '--gate');
  expect(r.code).toBe(2); // не 0 («чисто») и не 1 («найдено») — отказ окружения
  expect(r.err).toContain('только из КОРНЯ репозитория');
  expect(r.out).not.toContain('ok — совпадений старой формы нет');
});

test('гейт отказывается работать вне git-репозитория', () => {
  const outside = mkdtempSync(join(tmpdir(), 'orbis-legacy-form-nogit-'));
  dirs.push(outside);
  const r = cli(outside, '--gate');
  expect(r.code).toBe(2);
  expect(r.err).toContain('не рабочее дерево git');
});

test('имена маркеров — договор: на них ссылаются брифы задач среза', () => {
  expect(LEGACY_MARKERS.map((m) => m.id)).toEqual([
    'aspects-path',
    'aspects-legacy',
    'relation-type',
    'entity-meta',
    'due-alias',
    'bare-field',
    'rule-parser',
    'pseudo-aspect',
    'service-const',
    'prop-type-heur',
    'legacy-grammar',
  ]);
});

test('у каждой записи allowlist есть непустая причина', () => {
  for (const e of ALLOWLIST) {
    expect(e.reason.trim().length).toBeGreaterThan(0);
  }
});

/**
 * ЕДИНСТВЕННАЯ проба этого файла ПО РАБОЧЕМУ ДЕРЕВУ — и исключение из его правила
 * (см. шапку) названо явно.
 *
 * Правило «синтетическое дерево» защищает от привязки к ЦИФРАМ, которые двигает каждая
 * задача среза. Здесь цифра не двигается: парсер заголовка правила УДАЛЁН (Задача 18, В7),
 * машиночитаемая часть правила уехала в свойства, и `parseRuleTitle`/`formatRuleTitle` в
 * дереве не может быть больше никогда — ни одного, кроме образцов в самом гейте и в этом
 * файле (оба в allowlist). Это закрытая дверь, а не счётчик, и проверять её на синтетике
 * бессмысленно: синтетика подтвердила бы работу регулярки, а вопрос — про РЕПОЗИТОРИЙ.
 *
 * Проверяется ТОЛЬКО маркер `rule-parser`: остальные маркеры описывают формы, которые срез
 * ещё переводит, и их совпадения законны до Задачи 23.
 */
test('старая грамматика удалена: ни импортов grammar/parse/serialize/legacy-bridge, ни их имён', () => {
  // Вторая проба ПО РАБОЧЕМУ ДЕРЕВУ, и по той же причине, что у `rule-parser` выше: цифра
  // здесь не двигается. Старая плоская грамматика §6.1 удалена Задачей 21b целиком —
  // четыре модуля, их тесты и оба каталожных имени, — и появиться снова не может ни при
  // какой задаче среза: текст запроса с этого момента ровно один, key-форма канона.
  const root = join(import.meta.dir, '..');
  const marker = LEGACY_MARKERS.find((m) => m.id === 'legacy-grammar');
  expect(marker).toBeDefined();
  if (marker === undefined) return;
  const report = scanMarker(marker, root);
  expect(report.hits.map((h) => `${h.path}:${h.line}`)).toEqual([]);
  // Проба ЗНАЧИМА только если регулярка вообще что-то находит: образцы В ЭТОМ ФАЙЛЕ обязаны
  // попасться (он в allowlist) — иначе зелёный ноль означал бы сломанный поиск, а не
  // удалённую грамматику. Их ровно четыре — по числу строк синтетического образца.
  expect([...report.allowed.entries()]).toEqual([['scripts/check-legacy-form.test.ts', 4]]);
  // САМ ГЕЙТ в этот список НЕ входит, в отличие от `rule-parser`, и причина проверяемая:
  // его строка `pattern` записывает границы слов как `\bparseQueryAny\b`, то есть перед
  // `p` в файле стоит буква `b` — границы слова там нет, и регулярка собственную запись не
  // находит. Ждать его здесь значило бы ждать совпадения, которого не бывает.
  // И ФАЙЛОВ этих в дереве нет — ни одного: имя могло исчезнуть, а модуль остаться мёртвым.
  for (const name of ['grammar', 'parse', 'serialize', 'legacy-bridge']) {
    expect([name, existsSync(join(root, 'packages/shared/src/query', `${name}.ts`))]).toEqual([
      name,
      false,
    ]);
  }
});

test('rule-parser: парсера заголовка правила в рабочем дереве нет (кроме образцов в allowlist)', () => {
  const root = join(import.meta.dir, '..');
  const marker = LEGACY_MARKERS.find((m) => m.id === 'rule-parser');
  expect(marker).toBeDefined();
  if (marker === undefined) return;
  const report = scanMarker(marker, root);
  // `hits` — совпадения ВНЕ allowlist: это и есть то, что считает приёмка.
  expect(report.hits.map((h) => `${h.path}:${h.line}`)).toEqual([]);
  // Проба ЗНАЧИМА только если регулярка вообще что-то находит: образцы в самом гейте и в
  // этом файле обязаны попасться (они в allowlist) — иначе зелёный ноль означал бы
  // сломанный поиск, а не убранный парсер.
  expect([...report.allowed.keys()].sort()).toEqual([
    'scripts/check-legacy-form.test.ts',
    'scripts/check-legacy-form.ts',
  ]);
});
