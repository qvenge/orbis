#!/usr/bin/env bun
// biome-ignore-all lint/complexity/noUselessStringRaw: маркеры ниже переносятся между спекой,
// планом и кодом ДОСЛОВНО, поэтому все до одного обёрнуты в String.raw — включая те, где
// сегодня нет escape-последовательности. В обычном шаблонном литерале дописанный `\b`
// стал бы символом backspace, маркер перестал бы совпадать с чем-либо, и гейт молча
// показал бы ноль — тот самый отказ, против которого он написан.
/**
 * Греп-гейт старой формы данных — §А12-2 спеки «Реформа свойств», приёмка §С8-10.
 *
 * Приёмка среза требует «ноль совпадений» по маркерам старой формы (пути `aspects->`,
 * алиас `due=`, неквалифицированные имена полей в тексте запроса, обращения к колонке
 * `meta` сущности и прочее). Держать такую проверку в голове нельзя: она проверяется
 * ОДИН раз в конце среза, а нарушается по одной строке в каждой из двадцати задач.
 *
 * Почему источник — `git grep`, а не grep(1). Это ЗАМЕРЕНО, а не выведено. Файл
 * `apps/server/src/budget/aggregates.ts` содержал два литеральных NUL-байта в шаблонных
 * строках (ключи сортировки, строки :904-905 на момент написания). Реализация grep,
 * встречающая NUL, вправе объявить файл двоичным — и тогда 51 строка `aspects->` в нём
 * не попадает в приёмку вовсе.
 *
 * Оговорка: поведение зависит от РЕАЛИЗАЦИИ, и обобщать замер на «любой grep» нельзя.
 * Три замера на до-правочном блобе одного и того же файла:
 *  • ugrep 7.8.4 (то, чем `grep` оказался в оболочке разработчика) — НОЛЬ строк и молча,
 *    без пометки «Binary file matches»: при отсутствии текстовых совпадений печатать нечего;
 *  • стоковый /usr/bin/grep (BSD grep 2.6.0-FreeBSD) — находит все 51 строку;
 *  • GNU grep — печатает «Binary file … matches», то есть не молчит, но и строк не даёт.
 * Вывод для гейта тот же: закладываться на то, какой grep окажется у запускающего (и в
 * образе CI), нельзя — поэтому источник совпадений фиксирован `git grep` с флагами ниже.
 *
 * Флаги git grep здесь выбраны так:
 *  • `-a` (--text) — файлы с NUL-байтами сопоставляются как текст. Это страховка на
 *    будущее, а не только на `aggregates.ts`: NUL может появиться снова (ключ сортировки
 *    с разделителем — приём, который в этой кодовой базе уже применялся трижды).
 *  • `-I` (пропускать двоичные) сознательно НЕ ставится. Замер: на `aggregates.ts` он не
 *    менял ничего — git считает файл двоичным по первым 8000 байтам, а NUL-байты лежали
 *    на 904-й строке, далеко за этой границей, поэтому `git grep -nI` находил там все 51
 *    строку. Но стоит NUL'у оказаться в начале файла — `-I` выбросит его целиком и так
 *    же молча. Гейт не должен зависеть от того, в какой трети файла стоит байт.
 *  • `-P` (PCRE2) — маркеры пишутся в синтаксисе JS-регулярок (`\s`, `\b`, `(?:)`), и
 *    ТОТ ЖЕ текст маркера ниже перепроверяется движком JS. POSIX-ERE (`-E`) не знает
 *    `\b`: `git grep -naE '\bdue='` по дереву даёт 0 строк там, где PCRE даёт 3, то есть
 *    гейт был бы зелёным по причине, не имеющей отношения к коду.
 *
 * Оборотная сторона `git grep`: он видит только ЗАРЕГИСТРИРОВАННЫЕ файлы. Новый файл,
 * который ещё не `git add`нут, гейт не проверит — локально это стоит помнить, в CI
 * безразлично (там дерево checkout'а целиком в индексе).
 *
 * Отсев не-исходников сделан pathspec'ом, а не постфильтром: миграции (`db/migrations`)
 * содержат старую форму по определению — они её и создали, переписывать накаченный SQL
 * нельзя; снапшоты (`*.snap`) — производные файлы.
 *
 * Двойная фильтрация (git grep → JS-регулярка) не избыточность: `exclude`-формы
 * (`import.meta` и соседи) вырезаются на стороне JS, и чтобы «строк» в отчёте означало
 * ровно «строк, где маркер сработал по правилам этого файла», совпадение git'а
 * перепроверяется тем же движком, что применяет исключения.
 *
 * Запуск:
 *   bun scripts/check-legacy-form.ts          — отчёт «маркер → файлов/строк», код 0 всегда;
 *   bun scripts/check-legacy-form.ts --gate   — код 1 при любом совпадении вне allowlist.
 *
 * Сейчас (срез А) гейт стоит в режиме отчёта: маркеры описывают форму, которую срез
 * ПЕРЕВОДИТ, и до конца перевода совпадения законны. Падающим (`--gate` в CI) он
 * становится Задачей 23 — тогда же наполняется allowlist.
 */

/** Пути, внутри которых ищется старая форма. Формат — git pathspec, `:!` — исключение. */
export const SEARCH_PATHSPEC: readonly string[] = [
  'apps/server/src',
  'apps/server/test',
  'apps/server/perf',
  'packages/shared/src',
  'apps/web/src',
  'scripts',
  ':!*.snap',
  ':!apps/server/src/db/migrations/**',
];

export type LegacyMarker = {
  /** Имя маркера. На него ссылаются брифы задач среза — переименование ломает ссылки. */
  readonly id: string;
  /** Текст регулярки: отдаётся в `git grep -P` и перепроверяется движком JS. */
  readonly pattern: string;
  /**
   * Формы, которые из строки вырезаются ПЕРЕД перепроверкой маркера. Именно вырезаются,
   * а не «строка со словом X целиком не считается»: правило «содержит — пропустить»
   * ослепило бы гейт на строке, где рядом с законным `relations.meta` стоит настоящее
   * обращение к колонке сущности.
   */
  readonly exclude?: readonly RegExp[];
};

export const LEGACY_MARKERS: ReadonlyArray<LegacyMarker> = [
  { id: 'aspects-path', pattern: String.raw`aspects(_legacy)?\s*->` },
  // `aspectsMap` — имя старой карты в WIRE-форме — жил с Задачи 4a до 13c и снят ею: в
  // продуктовом коде его больше нет ни одного (остались утверждения об его ОТСУТСТВИИ в
  // тестах и образцы в самом гейте). `aspects_legacy`/`aspectsLegacy` — имя КОЛОНКИ, и она
  // живёт до «Пересева мира» (РП-2): её пишет дуальная запись исполнителя, читает слой
  // памяти чата, и снимает её миграция 0017 (Задача 23) — до тех пор совпадения по ней
  // законны и считаются отчётом, а не нарушением. Маркер `->>'` из §А12-2 НЕ заводится:
  // после перевода `props->>'orbis/…'` — законная форма доступа, а старую форму целиком
  // покрывает `aspects(_legacy)?\s*->`.
  {
    id: 'aspects-legacy',
    pattern: String.raw`aspects_legacy|aspectsLegacy|aspectsMap|legacy-form`,
  },
  { id: 'relation-type', pattern: String.raw`relation_type|relationType|RELATION_TYPES` },
  // entity-meta — адресуемые формы КОЛОНКИ сущности, не голое слово: `\bmeta\b` по этим же
  // путям давало 281 совпадение (41 в миграциях и живые `relations.meta` в executor.ts) —
  // гейт на 281 строке неисполним. Места `relations.meta`, которые останутся законными,
  // перечисляет allowlist Задачи 23.
  {
    id: 'entity-meta',
    pattern: String.raw`entities?\.meta\b|entity_meta_gin|\bmeta:\s*(row|input|values)\.meta\b|input\.meta\b|meta: \{\}`,
    exclude: [/import\.meta/, /relations?\.meta/, /\bmetadata\b/],
  },
  { id: 'due-alias', pattern: String.raw`\bdue=` },
  // Голое имя поля в тексте запроса — и в `{{query:}}`, и в строковых литералах web
  // (useAgenda/txQuery/browser/query). Сам по себе `aspect=` маркером НЕ является:
  // `aspect=orbis/…` — законная конструкция канона (§А5-3в, §А5-7); ловится только
  // неквалифицированное имя поля ПОСЛЕ него.
  {
    id: 'bare-field',
    pattern: String.raw`(\{\{query:|aspect=|sortBy=)[^}'"\n]*\b(status|stage|priority|kind|scope|outcome|undecided|due_date|start_at|occurred_on|planned|amount|direction|category_ref)=`,
  },
  // Парсер заголовка правила УДАЛЁН (Задача 18, В7): образец и цель уехали в свойства
  // (`orbis/rule_pattern`, `orbis/rule_target`), заголовок стал генерируемой подписью.
  // Маркер с этого момента обязан давать НОЛЬ вне allowlist — и это проверяется по
  // рабочему дереву (`check-legacy-form.test.ts`), а не только на синтетике.
  // `rulePatternFromTitle` переехала в `server/memory/rules.ts` под честным именем
  // `patternFromTransactionTitle` (она про заголовок ТРАНЗАКЦИИ) — маркером не является;
  // `formatRuleLabel` — новая генерация подписи, тоже не она.
  { id: 'rule-parser', pattern: String.raw`parseRuleTitle|formatRuleTitle` },
  { id: 'pseudo-aspect', pattern: String.raw`ENTITY_PSEUDO_ASPECT|'orbis/entity'` },
  { id: 'service-const', pattern: String.raw`SERVICE_ASPECT_IDS` },
  { id: 'prop-type-heur', pattern: String.raw`\bpropType\(` },
];

export type AllowEntry = {
  /** Путь от корня репозитория, ровно как его печатает `git grep`. */
  readonly path: string;
  /** Почему совпадения в этом файле законны. Без причины запись не заводится. */
  readonly reason: string;
};

/**
 * Файлы, совпадения в которых не считаются нарушением.
 *
 * Запись снимает файл целиком по ВСЕМ маркерам — поэтому отчёт печатает, сколько строк
 * сняла каждая запись: растущее число видно глазом и требует объяснения.
 *
 * Наполняет список Задача 23 (тесты грамматики, проверяющие ОТКАЗ старой формы, и
 * перечисленные места `relations.meta`). Сейчас в нём только два неустранимых случая —
 * сам гейт и его тест: оба обязаны содержать образцы старой формы дословно.
 */
export const ALLOWLIST: ReadonlyArray<AllowEntry> = [
  {
    path: 'scripts/check-legacy-form.ts',
    reason: 'сам гейт: маркеры перечислены в нём дословно, иначе он находит собственный список',
  },
  {
    path: 'scripts/check-legacy-form.test.ts',
    reason: 'тест гейта: образцы старой формы в нём — предмет проверки, а не нарушение',
  },
];

export type Hit = {
  readonly marker: string;
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

export type MarkerReport = {
  readonly id: string;
  /** Совпадения вне allowlist — то, что считает приёмка. */
  readonly hits: readonly Hit[];
  /** Файлы (уникальные) из `hits`. */
  readonly files: readonly string[];
  /** Снято `exclude`-формами маркера. */
  readonly excluded: number;
  /** Снято allowlist'ом, по записям. */
  readonly allowed: ReadonlyMap<string, number>;
};

const ALLOWED_PATHS = new Set(ALLOWLIST.map((e) => e.path));

/** Метка-заглушка вместо вырезанной `exclude`-формы: не буква и не цифра, границы слов не рвёт. */
const MASK_CHAR = '\u0001';

function maskExcluded(line: string, excludes: readonly RegExp[]): string {
  let masked = line;
  for (const ex of excludes) {
    // Длина сохраняется: маска не должна склеивать соседние куски строки в новое совпадение.
    masked = masked.replace(new RegExp(ex.source, `${ex.flags.replace('g', '')}g`), (m) =>
      MASK_CHAR.repeat(m.length),
    );
  }
  return masked;
}

/** `path:line:текст` — путь берётся нежадно, чтобы двоеточие внутри имени файла не съело номер. */
const GREP_LINE = /^(.*?):(\d+):([\s\S]*)$/;

export function scanMarker(marker: LegacyMarker, cwd: string): MarkerReport {
  const res = Bun.spawnSync(
    ['git', 'grep', '-n', '-a', '-P', '-e', marker.pattern, '--', ...SEARCH_PATHSPEC],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  );
  // git grep: 0 — есть совпадения, 1 — нет, >1 — ошибка (нет PCRE2 в сборке git, не репозиторий).
  // Ошибку нельзя принять за «чисто»: молчащий гейт хуже отсутствующего.
  if (res.exitCode > 1) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(
      `check-legacy-form: git grep вернул код ${res.exitCode} на маркере ${marker.id}: ${err}\n` +
        'Если git собран без PCRE2, флаг -P недоступен — гейт без него давал бы ложный ноль ' +
        'на маркерах с \\b, поэтому падаем, а не переключаемся на -E.',
    );
  }

  const hits: Hit[] = [];
  const allowed = new Map<string, number>();
  const re = new RegExp(marker.pattern);
  const excludes = marker.exclude ?? [];
  let excluded = 0;

  const out = new TextDecoder().decode(res.stdout);
  for (const raw of out.split('\n')) {
    if (raw === '') continue;
    const m = GREP_LINE.exec(raw);
    if (m === null) {
      throw new Error(`check-legacy-form: строка git grep не разобрана: ${JSON.stringify(raw)}`);
    }
    const [, path, lineNo, text] = m as unknown as [string, string, string, string];
    if (excludes.length > 0 && !re.test(maskExcluded(text, excludes))) {
      excluded += 1;
      continue;
    }
    if (ALLOWED_PATHS.has(path)) {
      allowed.set(path, (allowed.get(path) ?? 0) + 1);
      continue;
    }
    hits.push({ marker: marker.id, path, line: Number(lineNo), text });
  }

  return { id: marker.id, hits, files: [...new Set(hits.map((h) => h.path))], excluded, allowed };
}

/**
 * Гейт запускается ТОЛЬКО из корня репозитория, и это проверяется, а не подразумевается.
 *
 * Замер: в синтетическом репозитории с нарушениями запуск из `<корень>/apps` печатал
 * «ok — совпадений старой формы нет» и выходил с кодом 0. Механика отказа: pathspec'ы
 * `git grep` отсчитываются от cwd, из `apps/` ни один из них (`apps/server/src`, …) ни с
 * чем не совпадает, а `git grep` по несовпавшему pathspec не ошибается — он тихо
 * возвращает 1, то есть «совпадений нет». Ложный зелёный неотличим от чистого дерева.
 *
 * Это не теоретический риск: приёмочные шаги Задач 8 и 9 плана зовут гейт рядом с
 * `cd apps/server && bun test …`, то есть ровно из того cwd, где он врал бы.
 */
export function assertRepoRoot(cwd: string): void {
  const res = Bun.spawnSync(['git', 'rev-parse', '--show-cdup'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (res.exitCode !== 0) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(
      `check-legacy-form: ${cwd} — не рабочее дерево git, гейту неоткуда брать совпадения: ${err}`,
    );
  }
  // Пусто ровно в корне; из подкаталога git печатает путь наверх («../», «../../», …).
  const cdup = new TextDecoder().decode(res.stdout).trim();
  if (cdup !== '') {
    throw new Error(
      'check-legacy-form: гейт запускается только из КОРНЯ репозитория, а запущен из ' +
        `${cwd} (git rev-parse --show-cdup: «${cdup}»).\n` +
        "Причина: пути гейта — pathspec'ы git grep, они отсчитываются от текущего каталога. " +
        'Из подкаталога ни один не совпадёт, git grep вернёт «совпадений нет», и гейт ' +
        'напечатал бы ноль по любой зоне — ложный зелёный, неотличимый от чистого дерева.',
    );
  }
}

export function scan(cwd: string): MarkerReport[] {
  assertRepoRoot(cwd);
  return LEGACY_MARKERS.map((marker) => scanMarker(marker, cwd));
}

// --- Печать -------------------------------------------------------------------------------

/**
 * NUL и прочие управляющие байты из найденной строки — иначе вывод рвёт терминал: гейт по
 * построению читает файлы, в которых такие байты есть (ради них он и написан).
 * Сравнение по коду, а не регуляркой с диапазоном управляющих символов: эту форму biome
 * запрещает правилом noControlCharactersInRegex, и запрещает по делу.
 */
function printable(text: string): string {
  const flat = Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09) || code === 0x7f ? '·' : ch;
  })
    .join('')
    .trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

function table(reports: readonly MarkerReport[]): string {
  const idWidth = Math.max(...LEGACY_MARKERS.map((m) => m.id.length), 'ИТОГО'.length);
  const head = `  ${'маркер'.padEnd(idWidth)}  строк  файлов  снято`;
  const rule = `  ${'-'.repeat(idWidth)}  -----  ------  -----`;
  const rows = reports.map((r) => {
    const suppressed = r.excluded + [...r.allowed.values()].reduce((a, b) => a + b, 0);
    return (
      `  ${r.id.padEnd(idWidth)}  ${String(r.hits.length).padStart(5)}  ` +
      `${String(r.files.length).padStart(6)}  ${String(suppressed).padStart(5)}`
    );
  });
  const totalLines = reports.reduce((a, r) => a + r.hits.length, 0);
  const totalFiles = new Set(reports.flatMap((r) => r.files)).size;
  const totalSuppressed = reports.reduce(
    (a, r) => a + r.excluded + [...r.allowed.values()].reduce((x, y) => x + y, 0),
    0,
  );
  // «файлов» в итоге — объединение, а не сумма: один файл обычно нарушает несколькими маркерами.
  const total =
    `  ${'ИТОГО'.padEnd(idWidth)}  ${String(totalLines).padStart(5)}  ` +
    `${String(totalFiles).padStart(6)}  ${String(totalSuppressed).padStart(5)}`;
  return [head, rule, ...rows, rule, total].join('\n');
}

function allowlistNote(reports: readonly MarkerReport[]): string {
  if (ALLOWLIST.length === 0) return '  (пуст)';
  return ALLOWLIST.map((e) => {
    const n = reports.reduce((a, r) => a + (r.allowed.get(e.path) ?? 0), 0);
    return `  ${e.path} — снято строк: ${n} — ${e.reason}`;
  }).join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const gate = args.includes('--gate');
  const unknown = args.filter((a) => a !== '--gate');
  if (unknown.length > 0) {
    console.error(
      `check-legacy-form: неизвестные аргументы: ${unknown.join(', ')}\n` +
        'Использование: bun scripts/check-legacy-form.ts [--gate]',
    );
    process.exit(2);
  }

  const cwd = process.cwd();
  let reports: MarkerReport[];
  try {
    reports = scan(cwd);
  } catch (e) {
    // Код 2, а не 1: единица означает «найдена старая форма», и спутать отказ окружения
    // с находкой нельзя — обе ветки читает CI.
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  console.log('check-legacy-form: маркеры старой формы данных (§А12-2, приёмка §С8-10)');
  console.log(`пути: ${SEARCH_PATHSPEC.join(' ')}`);
  console.log('');
  console.log(table(reports));
  console.log('');
  console.log('allowlist:');
  console.log(allowlistNote(reports));

  const failing = reports.filter((r) => r.hits.length > 0);

  if (!gate) {
    console.log('');
    console.log('Режим отчёта: код возврата 0 при любых цифрах. Падающим гейт делает флаг --gate.');
    return;
  }

  if (failing.length === 0) {
    console.log('');
    console.log('check-legacy-form: ok — совпадений старой формы нет.');
    return;
  }

  console.error('');
  console.error('check-legacy-form: найдена старая форма данных — приёмка §С8-10 требует нуля.');
  for (const r of failing) {
    console.error(`\n[${r.id}] ${r.hits.length} строк в ${r.files.length} файлах:`);
    for (const h of r.hits) {
      console.error(`  ${h.path}:${h.line}: ${printable(h.text)}`);
    }
  }
  console.error(
    '\nЕсли совпадение законно — заведите файл в ALLOWLIST внутри этого скрипта ' +
      'с причиной, по которой старая форма в нём остаётся.',
  );
  process.exit(1);
}

// Скрипт одновременно и деливеребл, и модуль: тест импортирует LEGACY_MARKERS/ALLOWLIST,
// поэтому сам прогон запускается только при прямом вызове.
if (import.meta.main) {
  main();
}
