// scripts/legacy-aspects-map.test.ts
// СТРАЖ Задачи 23a: старой карты аспектов `aspects: {<id>: {<поле>: <значение>}}` в тестовых
// файлах репозитория больше нет.
//
// Зачем отдельный страж, а не «переписали и хорошо». Союз легаси-входа исполнителя
// (`fromLegacyInput`, `contracts/tools.ts`) ЖИВ до Задачи 23b: старая карта сегодня
// принимается и работает. Значит вернувшаяся фикстура старой формы зелёная — её не поймает
// ни один сьют, и к 23b, где союз сносится, их снова окажется полсотни. Страж — это то
// единственное место, где «форма» проверяется как форма, а не как поведение.
//
// Пятно охвата — ТЕСТОВЫЕ файлы (`*.test.ts(x)`, всё под `test/`, фикстуры): боевой код
// старой карты не пишет вовсе, а миграции и `legacy-form.ts`/`legacy-field-map.ts` описывают
// её по своему назначению и умирают вместе с ней (23b).
//
// Аллоулист — ПОИМЁННО и с ТОЧНЫМ числом: файлы, где старая карта стоит НАМЕРЕННО, потому
// что тест утверждает про неё саму (отказ тул-контракта, приём exec-надмножеством,
// невыразимый в плоской модели конфликт В1). Число точное, а не «не больше»: с порогом
// «≤ N» в такой файл можно было бы молча дописать ещё одну фикстуру старой формы.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const ROOTS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'migrations',
  '__snapshots__',
]);

/** Сам страж: образцы старой формы в нём — предмет проверки, а не нарушение. */
const SELF = relative(ROOT, import.meta.path)
  .split(sep)
  .join('/');

/**
 * Старая карта: за `aspects:` открывается объект, и первый его ключ — СТРОКОВЫЙ литерал
 * (id аспекта). Новая форма так выглядеть не может: у создания это список
 * (`aspects: ['orbis/task']`), у правки — объект с ключами-идентификаторами
 * (`aspects: { attach: […] }`), и оба под этот образец не подходят.
 *
 * Между `{` и первым ключом может стоять что угодно из пробелов и переводов строк —
 * комментарии сюда не попадают, потому что образец прикладывается к тексту, из которого они
 * уже вычеркнуты (`maskComments`). Без этого пояснительная строка первой внутри карты
 * (`aspects: {\n // старая карта\n 'orbis/task': {…} }`) оставляла стража зелёным —
 * а комментарии внутри карт в корпусе были нормой (гейт-ревью 23a, находка 1).
 */
const LEGACY_MAP = /aspects:\s*\{\s*(['"])[^'"\n]+\1\s*:/g;

/**
 * Тот же текст, где комментарии заменены пробелами (переводы строк сохранены — номера строк
 * и смещения не съезжают).
 *
 * Зачем вычёркивать, а не отсеивать совпадения по «строка начинается с `//` или `*`», как
 * было до фикс-раунда: отсев смотрел только на строку САМОГО совпадения и потому (а) пропускал
 * карту, у которой комментарий стоит между `{` и первым ключом, (б) не увидел бы карту,
 * дописанную после кода на одной строке с `//`. Вычёркивание отвечает на вопрос один раз и
 * для обоих случаев.
 *
 * Разбор строковых литералов обязателен: `'https://…'` внутри кода не начинает комментария,
 * и наивная замена по `//` съела бы половину файла.
 */
function maskComments(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  /** Индекс ЗА закрывающей кавычкой строкового литерала, открытого на `i`. */
  const skipQuoted = (i: number, quote: string): number => {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === quote) return j + 1;
      j += 1;
    }
    return src.length;
  };
  /**
   * Индекс ЗА закрывающей `}` подстановки `${…}`, открытой на `i` (это `{`).
   *
   * Подстановки разбираются рекурсивно, а не «до первой `}`»: внутри них живут свои строки и
   * свои шаблоны (`` `[${ids.map((x) => `"${x}"`).join(',')}]` `` — реальная строка
   * `test/helpers.ts`), и наивный проход обрывал шаблон на вложенном апострофе. Дальше по
   * файлу маскер считал кодом комментарии и строками — код; ровно это и делало стража то
   * слепым, то красным на пустом месте.
   */
  const skipInterp = (i: number): number => {
    let depth = 0;
    let j = i;
    while (j < src.length) {
      const c = src.charAt(j);
      if (c === "'" || c === '"') {
        j = skipQuoted(j, c);
        continue;
      }
      if (c === '`') {
        j = skipTemplate(j);
        continue;
      }
      if (c === '{') depth += 1;
      if (c === '}') {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
      j += 1;
    }
    return src.length;
  };
  /** Индекс ЗА закрывающим бэктиком шаблона, открытого на `i`. */
  function skipTemplate(i: number): number {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') {
        j = skipInterp(j + 1);
        continue;
      }
      j += 1;
    }
    return src.length;
  }

  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(i, c);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(i);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Файлы, где старая карта стоит НАМЕРЕННО: путь → [сколько, почему]. */
const ALLOWLIST: Record<string, { readonly count: number; readonly reason: string }> = {
  'packages/shared/src/contracts/tools.test.ts': {
    count: 3,
    reason:
      'тесты ОТКАЗА старой карты: «старую карту аспектов и `meta` не принимают НИ тул, НИ ' +
      'роутер владельца», «старую карту не принимают НИ тул, НИ роутер — только исполнитель», ' +
      '«exec-схема принимает обе формы; тул-контракт модели не принимает ни одной». ' +
      'Карта здесь — ВХОД проверки; после 23b те же три станут отказом и для исполнителя',
  },
  'apps/server/src/executor/props.test.ts': {
    count: 4,
    reason:
      'тесты про саму старую форму: «entity_create со СТАРЫМ патчем aspects → props/aspects[]», ' +
      'легаси-половина пары «старая форма ≡ новая», «financial+budget с разной category_ref в ' +
      'одном create → VALIDATION (В1)» (конфликт слитого свойства выразим ТОЛЬКО картой) и ' +
      'строка «Старая карта и attach-тулы — как было» в предикате замка бюджет-контура',
  },
  'apps/server/src/tools/dispatch.test.ts': {
    count: 2,
    reason:
      'тест «meta и старая карта аспектов в LLM-туле → VALIDATION; UI-роутер старую карту ' +
      'ПРИНИМАЕТ»: обе половины утверждают про саму карту — отказ тул-контрактом и приём ' +
      'exec-надмножеством до 23b',
  },
};

/** Тестовый файл: сьют, обвязка под `test/` либо фикстура. */
function isTestFile(rel: string): boolean {
  return (
    /\.test\.tsx?$/.test(rel) ||
    rel.includes('/test/') ||
    rel.includes('/perf/') ||
    /fixtures?\.tsx?$/.test(rel)
  );
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    const rel = relative(ROOT, full).split(sep).join('/');
    if (rel === SELF) continue;
    if (isTestFile(rel)) out.push(rel);
  }
}

const files: string[] = [];
for (const r of ROOTS) walk(join(ROOT, r), files);

/**
 * `путь → номера строк со старой картой`. Комментарии вычеркнуты ДО поиска: докблоки называют
 * старую форму по имени именно затем, чтобы объяснить, чем она была и когда умрёт.
 */
function hits(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const rel of files) {
    const src = maskComments(readFileSync(join(ROOT, rel), 'utf8'));
    const lines: number[] = [];
    LEGACY_MAP.lastIndex = 0;
    for (const m of src.matchAll(LEGACY_MAP)) {
      lines.push(src.slice(0, m.index).split('\n').length);
    }
    if (lines.length > 0) found.set(rel, lines);
  }
  return found;
}

describe('старой карты аспектов в тестовых фикстурах нет (Задача 23a, подготовка сноса)', () => {
  test('обход не выродился: тестовых файлов найдено больше сотни', () => {
    // Положительный контроль охвата: сломайся `walk` или `isTestFile` — страж молча
    // проверял бы пустой список и зеленел бы на любом дереве.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('apps/server/src/executor/props.test.ts');
    expect(files).toContain('apps/web/src/test/harness.tsx');
  });

  test('вне аллоулиста старой карты нет ни одной строки', () => {
    const offenders = [...hits().entries()]
      .filter(([rel]) => ALLOWLIST[rel] === undefined)
      .map(([rel, lines]) => `${rel}: ${lines.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  test('в аллоулисте — ТОЧНО столько строк, сколько объявлено, и ни одной лишней', () => {
    const found = hits();
    const actual: Record<string, number> = {};
    for (const rel of Object.keys(ALLOWLIST)) actual[rel] = found.get(rel)?.length ?? 0;
    const expected: Record<string, number> = {};
    for (const [rel, entry] of Object.entries(ALLOWLIST)) expected[rel] = entry.count;
    expect(actual).toEqual(expected);
  });

  test('маскер комментариев: докблок вычеркнут, код и строковые литералы целы, шаблон с подстановкой не рвёт разбор', () => {
    // Пин самого маскера: от него зависят ОБА утверждения выше, и его ошибка проявляется
    // молча — либо слепотой (код принят за строку), либо ложной тревогой (комментарий принят
    // за код). Образец собран из тех форм, на которых он уже ломался.
    const sample = [
      "const url = 'https://example.com/a'; // хвостовой комментарий",
      '/**',
      " * докблок: `aspects: {'orbis/financial': {category_ref}}` — про мёртвую форму",
      ' */',
      // Образец исходника, а не строка с подстановкой: подстановка здесь и есть предмет проверки.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: образец разбираемого исходника
      "const sql = `[${ids.map((x) => `'${x}'`).join(',')}]`;",
      "const fixture = { aspects: { 'orbis/task': { status: 'inbox' } } };",
    ].join('\n');
    const masked = maskComments(sample);

    // Длина и разбиение на строки не меняются — номера строк в отчёте остаются верными.
    expect(masked.length).toBe(sample.length);
    expect(masked.split('\n')).toHaveLength(sample.split('\n').length);
    // Комментарии вычеркнуты: и хвостовой, и докблок со старой картой внутри.
    expect(masked).not.toContain('хвостовой');
    expect(masked).not.toContain('мёртвую форму');
    // Код цел: и адрес внутри строкового литерала, и шаблон с вложенной подстановкой, и
    // фикстура ПОСЛЕ шаблона — именно её терял разбор, обрывавший шаблон на апострофе.
    expect(masked).toContain("'https://example.com/a'");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: тот же образец исходника
    expect(masked).toContain("const sql = `[${ids.map((x) => `'${x}'`).join(',')}]`;");
    expect(masked).toContain("aspects: { 'orbis/task': {");

    // И итог, ради которого маскер существует: карта ловится, докблок — нет.
    LEGACY_MAP.lastIndex = 0;
    expect([...masked.matchAll(LEGACY_MAP)]).toHaveLength(1);
  });

  test('образец ловит карту с комментарием и пустой строкой между `{` и первым ключом', () => {
    // Находка 1 гейт-ревью 23a: `\s*` не пропускает `// …`, и вернувшаяся фикстура с
    // пояснением первой строкой внутри карты оставляла стража зелёным. Пояснения внутри карт
    // в корпусе были нормой, так что случай не гипотетический.
    const withComment = maskComments(
      ['aspects: {', '  // старая карта', '', "  'orbis/task': { status: 'planned' },", '},'].join(
        '\n',
      ),
    );
    LEGACY_MAP.lastIndex = 0;
    expect([...withComment.matchAll(LEGACY_MAP)]).toHaveLength(1);

    // Новая форма под образец не подходит ни у создания, ни у правки — иначе страж краснел бы
    // на переведённом корпусе.
    for (const modern of ["aspects: ['orbis/task'],", "aspects: { attach: ['orbis/task'] },"]) {
      LEGACY_MAP.lastIndex = 0;
      expect(`${modern}: ${[...maskComments(modern).matchAll(LEGACY_MAP)].length}`).toBe(
        `${modern}: 0`,
      );
    }
  });

  test('у каждой записи аллоулиста есть причина, и она называет тесты', () => {
    for (const [rel, entry] of Object.entries(ALLOWLIST)) {
      expect(`${rel}: ${entry.reason.length > 60}`).toBe(`${rel}: true`);
    }
  });
});
