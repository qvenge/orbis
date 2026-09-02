// scripts/legacy-aspects-map.test.ts
// СТРАЖ (заведён Задачей 23a): старой карты аспектов «ключ `aspects` с объектом из id
// аспекта в поля» в тестовых файлах репозитория нет.
//
// ЗАЧЕМ ОН БЫЛ НУЖЕН И ЗАЧЕМ НУЖЕН ТЕПЕРЬ — это разные доводы, и второй слабее первого.
//
// Когда страж заводился, союз легаси-входа исполнителя (`fromLegacyInput`) был ЖИВ: старая
// карта принималась и работала, поэтому вернувшаяся фикстура старой формы оставалась
// зелёной — её не ловил ни один сьют. «Пересев мира» (23b) снял и союз, и оба модуля
// перевода, и такая фикстура теперь падает сама: вход отвечает `VALIDATION`
// (`executor/legacy-input-rejected.test.ts`).
//
// Страж остаётся по ДРУГОЙ причине: он ловит форму ТАМ, ГДЕ ОНА НЕ ИСПОЛНЯЕТСЯ, — в
// докблоке, в строковом литерале, в фикстуре, которую никто не подаёт на вход. Такая карта
// не падает ничем и читается следующим как живой образец. Это то единственное место, где
// «форма» проверяется как форма, а не как поведение.
//
// ПОЧЕМУ ОБРАЗЕЦ ПРИКЛАДЫВАЕТСЯ К СЫРОМУ ТЕКСТУ, КОММЕНТАРИИ И СТРОКИ ВКЛЮЧИТЕЛЬНО
// (рулинг Р-23a-6). Первая версия вычёркивала комментарии своим разбором исходника — и
// разбор оказался неполным: он не знал регэксп-литералов, поэтому с первого же `/['"]/`
// или `/\/\*[\s\S]*?\*\//` расходился с настоящим синтаксисом и дальше по файлу считал код
// комментарием, а комментарий кодом. Ре-ревью намерило ~890 таких СЛЕПЫХ позиций в восьми
// файлах (включая `executor/props.test.ts`, где фикстуры и живут): вернувшаяся туда карта с
// пояснением первой строкой оставляла стража зелёным. Догонять синтаксис TS регулярками
// внутри стража — это заводить второй парсер, который будет отставать всегда; поэтому
// разбора здесь нет вовсе. Цена — карта, названная в докблоке или в строковом литерале,
// считается тоже; лечится это ровно двумя способами, и оба честные: описать старую форму
// СЛОВАМИ (так переписаны докблоки `test/helpers.ts` и `entity-detail/detail.test.tsx`) либо
// внести файл в поимённый `ALLOWLIST` ниже с причиной.
//
// Пятно охвата — ТЕСТОВЫЕ файлы (`*.test.ts(x)`, всё под `test/`, `perf/`, фикстуры): боевой
// код старой карты не пишет вовсе, а модули, описывавшие её по своему назначению
// (`legacy-form.ts`, `legacy-field-map.ts`), снесены 23b вместе с формой. Миграции под
// охват не попадают намеренно: они старую форму и создали, переписывать накаченный SQL
// нельзя.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dir, '..');
/** Пути поиска — те же три корня, что считает греп брифа. */
const SEARCH_PATHSPEC = ['apps', 'packages', 'scripts'];

/**
 * Старая карта: за `aspects:` открывается объект, и первый его ключ — СТРОКОВЫЙ литерал
 * (id аспекта). Между `{` и ключом допускается что угодно, кроме фигурных скобок, — там и
 * живут переводы строк, пустые строки и пояснения, из-за которых прежний образец
 * (`\s*` вместо `[^{}]*?`) не видел многострочную карту с комментарием.
 *
 * Новая форма под образец не подходит ни в одном из трёх видов: список
 * (`aspects: ['orbis/task']`) — не объект вовсе; патч правки — объект с ключами-
 * идентификаторами (`attach`/`detach`), а не строковыми литералами; пустой объект — пуст.
 * Отчёты дрейфа реестра (`static.test.ts`) и JSON Schema тулов тоже мимо: их первый ключ —
 * идентификатор, а вложенный объект обрывает `[^{}]*?` раньше строкового литерала.
 */
const LEGACY_MAP = /aspects:\s*\{[^{}]*?(['"])[^'"\n]+\1\s*:/g;

/**
 * Файлы, где старая карта стоит НАМЕРЕННО: путь → сколько строк и почему.
 *
 * Счёт ТОЧНЫЙ, а не «не больше»: с порогом в такой файл можно было бы молча дописать ещё
 * одну фикстуру старой формы, и страж бы её пропустил.
 */
const ALLOWLIST: Record<string, { readonly count: number; readonly reason: string }> = {
  'packages/shared/src/contracts/tools.test.ts': {
    count: 3,
    reason:
      'тесты ОТКАЗА старой карты всеми тремя схемами — включая надмножество исполнителя, ' +
      'которое приняло её последним и перестало с «Пересевом мира». Карта здесь — ВХОД ' +
      'проверки: без неё утверждение «не принимают» проверять не на чем',
  },
  'apps/server/src/executor/props.test.ts': {
    count: 1,
    reason:
      'строка «Старая карта и attach-тулы — как было» в предикате замка бюджет-контура: ' +
      'докблок называет форму, которой предикат когда-то отвечал',
  },
  'apps/server/src/tools/dispatch.test.ts': {
    count: 2,
    reason:
      'тест «meta и старая карта аспектов → VALIDATION на ОБОИХ входах»: обе половины ' +
      'утверждают про саму карту — отказ тул-контрактом и отказ exec-надмножеством',
  },
  'apps/server/src/executor/legacy-input-rejected.test.ts': {
    count: 1,
    reason:
      'приёмка §С8-10 п.13: LEGACY_MAP — та самая карта, на которую вход обязан ответить ' +
      'VALIDATION; без литерала утверждение непроверяемо',
  },
  'scripts/legacy-aspects-map.test.ts': {
    count: 4,
    reason:
      'сам страж: образцы старой формы в его пин-тестах — предмет проверки, а не нарушение. ' +
      'Счёт держит и их: пропавший образец обессмыслил бы пин, а лишний означал бы, что ' +
      'кто-то дописал фикстуру в сам страж',
  },
};

/** Тестовый файл: сьют, обвязка под `test/`/`perf/` либо фикстура. */
function isTestFile(rel: string): boolean {
  return (
    /\.tsx?$/.test(rel) &&
    (/\.test\.tsx?$/.test(rel) ||
      rel.includes('/test/') ||
      rel.includes('/perf/') ||
      /fixtures?\.tsx?$/.test(rel))
  );
}

/**
 * Запуск git с проверкой кода возврата. Молчащий страж хуже отсутствующего, поэтому
 * непонятный код — исключение, а не «совпадений нет».
 *
 * `ok` — коды, которые считаются штатными: у `git grep` это 0 (есть совпадения) и 1 (нет).
 */
function git(args: readonly string[], ok: readonly number[]): string[] {
  const res = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (!ok.includes(res.exitCode)) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(`страж старой карты: git ${args[0]} вернул код ${res.exitCode}: ${err}`);
  }
  return new TextDecoder()
    .decode(res.stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** Все тестовые файлы под наблюдением — из индекса git, как и совпадения. */
function testFiles(): string[] {
  return git(['ls-files', '--', ...SEARCH_PATHSPEC], [0]).filter(isTestFile);
}

/**
 * `путь → номера строк со старой картой`.
 *
 * Кандидаты берёт `git grep -P` (флаги — как у `check-legacy-form.ts`: `-a`, потому что файл
 * с NUL-байтом реализация грепа вправе объявить двоичным и молча пропустить; `-P`, потому
 * что образец пишется в синтаксисе JS-регулярок). Точные позиции ищет тот же образец по
 * ЦЕЛОМУ тексту файла: карта бывает многострочной, а `git grep` строчный и такую не увидел
 * бы. Двойной проход не избыточен — git сужает круг до файлов, где `aspects:` вообще стоит
 * перед `{`, а решение принимает ровно тот образец, что объявлен выше.
 *
 * Оборотная сторона `git grep`/`git ls-files` (та же, что у `check-legacy-form.ts`): виден
 * только ЗАРЕГИСТРИРОВАННЫЙ файл. Локально это стоит помнить, в CI безразлично — там дерево
 * checkout'а целиком в индексе.
 */
function hits(): Map<string, number[]> {
  const candidates = git(
    ['grep', '-a', '-l', '-P', '-e', String.raw`aspects:\s*\{`, '--', ...SEARCH_PATHSPEC],
    [0, 1],
  ).filter(isTestFile);
  const found = new Map<string, number[]>();
  for (const rel of candidates) {
    const src = readFileSync(join(ROOT, rel.split('/').join(sep)), 'utf8');
    LEGACY_MAP.lastIndex = 0;
    const lines = [...src.matchAll(LEGACY_MAP)].map(
      (m) => src.slice(0, m.index).split('\n').length,
    );
    if (lines.length > 0) found.set(rel, lines);
  }
  return found;
}

/** Сколько раз образец срабатывает на куске текста. */
function matches(sample: string): number {
  LEGACY_MAP.lastIndex = 0;
  return [...sample.matchAll(LEGACY_MAP)].length;
}

describe('старой карты аспектов в тестовых фикстурах нет (Задача 23a, подготовка сноса)', () => {
  test('обход не выродился: тестовых файлов под наблюдением больше сотни', () => {
    // Положительный контроль охвата: сломайся pathspec или `isTestFile` — страж молча
    // проверял бы пустой список и зеленел бы на любом дереве.
    const files = testFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('apps/server/src/executor/props.test.ts');
    expect(files).toContain('apps/web/src/test/harness.tsx');
    expect(files).toContain(
      relative(ROOT, import.meta.path)
        .split(sep)
        .join('/'),
    );
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

  test('у каждой записи аллоулиста есть причина, и она называет тесты', () => {
    for (const [rel, entry] of Object.entries(ALLOWLIST)) {
      expect(`${rel}: ${entry.reason.length > 60}`).toBe(`${rel}: true`);
    }
  });

  test('образец ловит карту где угодно: однострочную, многострочную с пояснением, в докблоке', () => {
    // (а) Находка 1 гейт-ревью 23a: пояснение первой строкой внутри карты. Пояснения внутри
    // карт в корпусе были нормой, так что случай не гипотетический.
    expect(
      matches(
        [
          'aspects: {',
          '  // старая карта',
          '',
          "  'orbis/task': { status: 'planned' },",
          '},',
        ].join('\n'),
      ),
    ).toBe(1);

    // (б) Карта в докблоке — тоже совпадение, и это ОЖИДАЕМО (Р-23a-6): разбора синтаксиса в
    // страже нет, а докблок, которому карта нужна дословно, идёт в аллоулист по имени.
    expect(
      matches(" * старая форма: `aspects: {'orbis/financial': {category_ref}}` — мертва"),
    ).toBe(1);

    // Однострочная и с ключом в двойных кавычках — тот же образец.
    expect(matches("{ aspects: { 'orbis/note': {} }, tags: [] }")).toBe(1);
    expect(matches('{ aspects: { "orbis/note": null } }')).toBe(1);
  });

  test('новые формы под образец не подходят: список, {attach, detach}, пустой объект', () => {
    // Иначе страж краснел бы на переведённом корпусе — то есть был бы снят в тот же день.
    for (const modern of [
      "aspects: ['orbis/task'],",
      "aspects: { attach: ['orbis/task'] },",
      "aspects: { attach: ['orbis/goal'], detach: ['orbis/note'] },",
      'aspects: {},',
      'aspects: {\n  attach: [ID],\n  detach: [OTHER],\n},',
      // Отчёт дрейфа реестра и JSON Schema тула — первый ключ идентификатор, не литерал.
      "aspects: { missing: [], drifted: [{ id: 'orbis/financial' }], extra: [] },",
      "aspects: { type: 'array', items: { type: 'string' } },",
    ]) {
      expect(`${modern.split('\n')[0]}: ${matches(modern)}`).toBe(`${modern.split('\n')[0]}: 0`);
    }
  });
});
