// Страж ФОРМЫ ФИКСТУР всего web-сьюта (§А1-1, §А1-3).
//
// ПРАВИЛО ИЗМЕНИЛОСЬ ЗАДАЧЕЙ 13c, и это не расширение охвата ради охвата. Пока старая карта
// ехала в wire-форме рядом с новой, страж мог требовать новой формы только от переведённых
// экранов: у Финансов, импорта и настроек продукт читал карту, и запрет писать её в их
// фикстурах требовал бы от теста не отвечать за то, что делает код. Теперь карты в
// wire-форме нет вовсе — ни у одного ответа, ни на одном экране, — поэтому и граница у
// стража одна: `apps/web/src` целиком.
//
// Зачем страж по ИСХОДНИКУ, а не по типам. Лишний ключ в объектном литерале tsc отвергает,
// но фикстуры собираются фабрикой (`wireEntity({...over})`) и раздаются через `as`, а там
// он проезжает молча. Проверяемая форма — «чего в фикстуре быть НЕ ДОЛЖНО», и единственный
// способ увидеть это без запуска — прочитать текст теста.
//
// Он же ловит и ВОЗВРАТ формы: фикстура, дописанная по старой памяти, красит страж, а не
// живёт зелёной до первого расхождения.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/**
 * Корень `src` — через `fileURLToPath(import.meta.url)`, а НЕ через `new URL('…', import.meta.url)`
 * с подставленным именем: vite разбирает вторую форму статически и подменяет адресом ассета,
 * а с вычисляемым куском подставляет `undefined` (тот же капкан обошёл `field-labels.test`,
 * спрятав литерал за параметр).
 */
const SRC = join(fileURLToPath(import.meta.url), '..', '..');

/** Путь самого стража от `src` — см. пропуск в `testFiles`. */
const SELF = 'test/fixtures.test.ts';

/** Тестовые файлы web и обвязка фикстур; путь — относительный от `src`. */
function testFiles(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}${entry.name}/`);
        continue;
      }
      // Тесты И ОБВЯЗКА: фабрика фикстур (`test/harness.tsx`) — единственный источник формы
      // на весь сьют, и вернувшаяся в НЕЁ старая карта раздала бы её всем 80 файлам разом,
      // не появившись ни в одном из них. Тип фикстуры от типа производителя независим, и
      // tsc такого расхождения не видит — ровно так 13b и получил 58 зелёных тестов на
      // форме, которой сервер не отдаёт.
      const isFixtureHarness = prefix === 'test/' && /\.tsx?$/.test(entry.name);
      if (!/\.test\.tsx?$/.test(entry.name) && !isFixtureHarness) continue;
      const path = `${prefix}${entry.name}`;
      // Сам страж — единственное исключение, и оно неустранимо: обе запрещённые формы
      // перечислены в нём ДОСЛОВНО (правило поиска и положительные контроли), иначе он
      // находил бы собственный текст. Тот же приём, что у `scripts/check-legacy-form.ts`.
      if (path === SELF) continue;
      out.push({ path, code: readFileSync(full, 'utf8') });
    }
  };
  walk(SRC, '');
  return out;
}

/**
 * Номера строк, где встречается ключ. Номер, а не сам факт: падение обязано назвать место,
 * иначе читатель отчёта пойдёт искать его грепом сам.
 */
function linesWith(code: string, key: string): number[] {
  return code.split('\n').flatMap((line, i) => (line.includes(key) ? [i + 1] : []));
}

test('ни одна фикстура web не пишет старую карту аспектов', () => {
  const files = testFiles();
  // Положительный контроль ОБХОДА: пустой список файлов сделал бы проверку ниже зелёной на
  // любой форме фикстур — в том числе на всех до одной старых. Порог — от ЧИСЛА тестовых
  // файлов сьюта (их восемьдесят с лишним): обход, свернувшийся до одной границы, красит.
  expect(files.length).toBeGreaterThan(60);

  const offenders = files
    .filter((f) => f.code.includes('aspectsMap:'))
    .map((f) => `${f.path}: ${linesWith(f.code, 'aspectsMap:').join(', ')}`);
  expect(offenders).toEqual([]);
});

test('мешок `meta` остался только у СВЯЗЕЙ — у сущностей его нет во всём сьюте', () => {
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
