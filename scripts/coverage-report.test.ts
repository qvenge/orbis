import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECLARED_PLACES, parseCoverage, placeNumbers, SPEC_PATH } from './coverage-report.ts';

const md = readFileSync(join(import.meta.dir, '..', SPEC_PATH), 'utf8');

test('номера мест: диапазон разворачивается, подпункт — то же место, перечисление — разные', () => {
  // Ф-14 ревизии 3: подпункты 86a–86f — ОДНО место, поэтому буква отбрасывается.
  expect(placeNumbers('Z5-74–76')).toEqual(['74', '75', '76']);
  expect(placeNumbers('Z3-86a')).toEqual(['86']);
  expect(placeNumbers('Z1-3, 4')).toEqual(['3', '4']);
  expect(placeNumbers('Z2-1')).toEqual(['1']);
});

test('счёт мест по зонам воспроизводит шапку §С1-4 (спека:644), а не «что вышло»', () => {
  const cov = parseCoverage(md);
  const actual = Object.fromEntries(cov.zones.map((z) => [z.zone, z.places]));
  expect(actual).toEqual(DECLARED_PLACES);
  expect(cov.places).toBe(642);
});

test('счётчик по родам совпадает со сводкой спеки там, где сводка считает тем же методом', () => {
  // Z1 «по основному роду места», Z2 «по ведущему роду строки», Z5 «по ведущему роду места» —
  // это тот же метод, что у парсера, и расхождение здесь означало бы ошибку разбора, а не спор
  // о методе. Клетка в клетку, а не по сумме: сумма сходится и при двух компенсирующих промахах.
  const cov = parseCoverage(md);
  const compared = cov.zones.filter((z) => z.declared?.leading === true).map((z) => z.zone);
  expect(compared).toEqual(['Z1', 'Z2', 'Z5']);
  for (const z of cov.zones) {
    if (z.declared?.leading !== true) continue;
    expect([z.zone, z.byGenus]).toEqual([z.zone, z.declared.byGenus]);
  }
});

test('Z3 и Z4 считают в сводке пометки, а не места — их сумма больше числа мест', () => {
  // Спека говорит это прямо: Z3 «включая вторые вердикты двойной разметки», Z4 «двойная
  // разметка считается в оба рода; сумма пометок 159 при 141 строке». Пин держит вывод
  // «сверять эти две зоны клетка в клетку нельзя» проверяемым, а не подразумеваемым.
  for (const z of parseCoverage(md).zones.filter((x) => ['Z3', 'Z4'].includes(x.zone))) {
    expect(z.declared?.leading).toBe(false);
    const sum = Object.values(z.declared?.byGenus ?? {}).reduce((a, b) => a + b, 0);
    expect([z.zone, sum > z.places]).toEqual([z.zone, true]);
  }
});

test('три корзины: раскладка полная — сумма корзин равна числу мест', () => {
  const cov = parseCoverage(md);
  const sum = cov.byBasket['данные'] + cov.byBasket['машинерия B'] + cov.byBasket['остаток C'];
  expect(sum).toBe(cov.places);
  // Именованный остаток по ведущему роду — 12 мест; по любому упоминанию (включая вторые
  // вердикты) — 29. Прогноз §С8-14 (≈17) лежит между ними: это разница МЕТОДА, и отчёт обязан
  // назвать оба числа, иначе «расхождение > 10 %» читается как переезд мест.
  expect(cov.byBasket['остаток C']).toBe(12);
  expect(cov.residualAny.length).toBe(29);
});
