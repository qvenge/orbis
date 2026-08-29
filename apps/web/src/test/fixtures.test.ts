// Страж ФОРМЫ ФИКСТУР четырёх экранов, переведённых на новую правду (§А1-1).
//
// Зачем сторож по исходнику, а не по поведению. Старая карта аспектов из wire-формы уйдёт
// только Задачей 13c, то есть до тех пор ответ сервера несёт ОБЕ формы — и фикстура,
// написанная по старой, продолжает «работать»: тест зелен, а экран читает `props`, которых
// в ней нет. Ровно так и появляются лживые фикстуры — тест обещает защиту, которой нет.
// Поведенческого следа у этого нет никакого, пока формы совпадают; вреден он ровно тем, что
// однажды разойдётся.
//
// Границы четыре — `entity-detail`, `agenda`, `browser`, `chat`: это ровно те экраны, чьи
// читатели переведены на `props` и `aspects[]`. Финансы, импорт и настройки читают старую
// карту до Задачи 13c, и требовать от их фикстур новой формы значило бы требовать, чтобы
// тест не отвечал за то, что делает продукт.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const ROOTS = ['entity-detail', 'agenda', 'browser', 'chat'];

/**
 * Корень `src` — через `fileURLToPath(import.meta.url)`, а НЕ через `new URL('…', import.meta.url)`
 * с подставленным именем: vite разбирает вторую форму статически и подменяет адресом ассета,
 * а с вычисляемым куском подставляет `undefined` (тот же капкан обошёл `field-labels.test`,
 * спрятав литерал за параметр).
 */
const SRC = join(fileURLToPath(import.meta.url), '..', '..');

/** Все тестовые файлы под четырьмя границами; путь — относительный, чтобы падение читалось. */
function testFiles(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}${entry.name}/`);
        continue;
      }
      if (!/\.test\.tsx?$/.test(entry.name)) continue;
      out.push({ path: `${prefix}${entry.name}`, code: readFileSync(full, 'utf8') });
    }
  };
  for (const root of ROOTS) {
    walk(join(SRC, 'features', root), `features/${root}/`);
  }
  return out;
}

/**
 * Номера строк, где встречается ключ. Номер, а не сам факт: падение обязано назвать место,
 * иначе читатель отчёта пойдёт искать его грепом сам.
 */
function linesWith(code: string, key: string): number[] {
  return code.split('\n').flatMap((line, i) => (line.includes(key) ? [i + 1] : []));
}

test('фикстуры четырёх экранов не пишут старую карту аспектов', () => {
  const files = testFiles();
  // Положительный контроль ОБХОДА: пустой список файлов сделал бы проверку ниже зелёной на
  // любой форме фикстур — в том числе на всех до одной старых.
  expect(files.length).toBeGreaterThan(8);

  const offenders = files
    .filter((f) => f.code.includes('aspectsMap:'))
    .map((f) => `${f.path}: ${linesWith(f.code, 'aspectsMap:').join(', ')}`);
  expect(offenders).toEqual([]);
});

test('мешок `meta` остался только у СВЯЗЕЙ — у сущностей его нет', () => {
  /**
   * Разбор по соседству, а не по имени ключа: `meta` у СВЯЗИ жива и после реформы (её пишет
   * `toWireRelation`), а снят §А1-3 мешок СУЩНОСТИ. Различить их можно только по литералу,
   * в котором ключ стоит, и признак связи здесь — `sourceId` в тех же восьми строках:
   * фикстура связи короче этого окна во всех четырёх границах.
   *
   * Окно, а не полноценный разбор объекта: правило должно быть читаемым и падать понятно, а
   * парсер TS ради одного стража — вторая грамматика в дереве.
   */
  const RELATION_MARK = 'sourceId';
  const WINDOW = 8;
  const offenders: string[] = [];
  for (const { path, code } of testFiles()) {
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('meta:')) return;
      const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW).join('\n');
      if (!near.includes(RELATION_MARK)) offenders.push(`${path}:${i + 1}`);
    });
  }
  expect(offenders).toEqual([]);

  // Положительный контроль ПРАВИЛА: сущность с `meta` обязана быть поймана, связь — нет.
  const probe = (code: string) => {
    const lines = code.split('\n');
    return lines.some(
      (line, i) =>
        line.includes('meta:') &&
        !lines
          .slice(Math.max(0, i - WINDOW), i + WINDOW)
          .join('\n')
          .includes(RELATION_MARK),
    );
  };
  expect(probe('const e = {\n  title: "x",\n  meta: {},\n};')).toBe(true);
  expect(probe('const r = {\n  sourceId: "a",\n  meta: {},\n};')).toBe(false);
});
