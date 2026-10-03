// Тест порогов веса сторожа ленивых чанков (scripts/check-lazy-chunks.ts, срез страниц 1б, задача 18).
//
// Пороги проверяются НА ФИКСТУРНОМ dist, а не на настоящей сборке: вес рабочей сборки меняет каждая
// задача, и тест, привязанный к её числам, падал бы по чужой причине. Настоящую сборку меряет сам
// скрипт в CI (шаг после `build`).
//
// Прогоняется корневым `bun run test` (хвост `bun test scripts/`).
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  checkBudgets,
  checkClosureText,
  closureOf,
  parseBudgetArgs,
  runtimeModuleImports,
} from './check-lazy-chunks.ts';

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Временный каталог чанков с заданными файлами. */
function assets(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbis-lazy-chunks-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/**
 * Чанк, который сжимается в разы: сырых байт много, gzip — мало. На нём сравнение «сырых» байт
 * вместо gzip отличимо от честного: порог между gzip и сырым размером даёт разные ответы.
 */
const COMPRESSIBLE = `export const x="${'a'.repeat(2000)}";`;
/** Плохо сжимаемое содержимое: у ленивого чанка C вес, который замыкание не должно считать. */
const noisy = (n: number): string =>
  `export const c=${JSON.stringify(Array.from({ length: n }, (_, i) => ((i * 7919) % 104729).toString(36)).join(''))};`;

const gz = (s: string): number => gzipSync(Buffer.from(s)).length;
const gz9 = (s: string): number => gzipSync(Buffer.from(s), { level: 9 }).length;

test('--max-gzip: превышение gzip файла чанка — код 1 с числами, запас — код 0', () => {
  const dir = assets({ 'X-abc123.js': COMPRESSIBLE });
  const size = gz(COMPRESSIBLE);
  // Фикстура та, какая нужна: gzip много меньше порога 100, сырых байт — много больше.
  expect(size).toBeLessThan(100);
  expect(COMPRESSIBLE.length).toBeGreaterThan(100);

  const over = checkBudgets(dir, parseBudgetArgs(['--max-gzip', 'X=10']));
  expect(over.code).toBe(1);
  expect(over.lines.join('\n')).toContain(`X-abc123.js`);
  expect(over.lines.join('\n')).toContain(`${size} Б`);
  expect(over.lines.join('\n')).toContain('10 Б');

  expect(checkBudgets(dir, parseBudgetArgs(['--max-gzip', 'X=100'])).code).toBe(0);
  // Граница: ровно размер — ещё можно, на байт меньше — уже нет.
  expect(checkBudgets(dir, parseBudgetArgs(['--max-gzip', `X=${size}`])).code).toBe(0);
  expect(checkBudgets(dir, parseBudgetArgs(['--max-gzip', `X=${size - 1}`])).code).toBe(1);
});

test('--max-gzip: чанка с таким именем нет — код 1, а не молчаливый ноль', () => {
  const dir = assets({ 'X-abc123.js': COMPRESSIBLE });
  const r = checkBudgets(dir, parseBudgetArgs(['--max-gzip', 'Y=100000']));
  expect(r.code).toBe(1);
  expect(r.lines.join('\n')).toContain('Y');
});

test('замыкание чанка — сам файл и статические импорты транзитивно; динамический import() — нет', () => {
  const A = 'import{b}from"./B-1a2b.js";const l=()=>import("./C-3c4d.js");export{b,l};';
  const B = 'import"./D-5e6f.js";export const b=1;';
  const D = 'export const d=2;';
  const C = noisy(4000);
  const dir = assets({ 'A-0f0f.js': A, 'B-1a2b.js': B, 'C-3c4d.js': C, 'D-5e6f.js': D });

  expect(closureOf(dir, 'A-0f0f.js').sort()).toEqual(['A-0f0f.js', 'B-1a2b.js', 'D-5e6f.js']);
  // Уровень сжатия замыкания — 9, как у замера базы задачи 1 (`closure.py`, 304 855 Б).
  const sum = gz9(A) + gz9(B) + gz9(D);
  expect(gz9(C)).toBeGreaterThan(1000);

  const ok = checkBudgets(dir, parseBudgetArgs(['--max-closure-gzip', `A=${sum}`]));
  expect(ok.code).toBe(0);
  expect(ok.lines.join('\n')).toContain(`${sum} Б`);

  const over = checkBudgets(dir, parseBudgetArgs(['--max-closure-gzip', `A=${sum - 1}`]));
  expect(over.code).toBe(1);
  const text = over.lines.join('\n');
  expect(text).toContain(`${sum} Б`);
  // Сообщение называет состав замыкания — куда смотреть, когда порог сработал.
  expect(text).toContain('B-1a2b.js');
  expect(text).not.toContain('C-3c4d.js');
});

test('оба флага вместе: файл в пределах, замыкание — нет → код 1 (утечка в общий чанк, R-3)', () => {
  const A = 'import"./B-1a2b.js";export const a=1;';
  const B = noisy(4000);
  const dir = assets({ 'A-0f0f.js': A, 'B-1a2b.js': B });
  const r = checkBudgets(
    dir,
    parseBudgetArgs(['--max-gzip', 'A=1000', '--max-closure-gzip', `A=${gz9(A) + 100}`]),
  );
  expect(r.code).toBe(1);
  expect(checkBudgets(dir, parseBudgetArgs(['--max-gzip', 'A=1000'])).code).toBe(0);
});

test('разбор флагов: неизвестный флаг и кривое значение — ошибка, а не молчаливый пропуск порога', () => {
  expect(() => parseBudgetArgs(['--max-gzp', 'X=1'])).toThrow('--max-gzp');
  expect(() => parseBudgetArgs(['--max-gzip', 'X'])).toThrow('X');
  expect(() => parseBudgetArgs(['--max-gzip', 'X=abc'])).toThrow('X=abc');
  expect(() => parseBudgetArgs(['--max-gzip'])).toThrow('--max-gzip');
  expect(parseBudgetArgs([])).toEqual({ file: [], closure: [] });
  expect(
    parseBudgetArgs(['--max-gzip', 'DetailScreen=34889', '--max-closure-gzip', 'DetailScreen=1']),
  ).toEqual({
    file: [{ chunk: 'DetailScreen', max: 34889 }],
    closure: [{ chunk: 'DetailScreen', max: 1 }],
  });
});

test('содержимое замыкания (R-19): маркер в статическом соседе — код 1; только в ленивом — код 0; нет в источнике — код 1', () => {
  const rule = {
    chunk: 'D',
    text: 'МАРКЕР-СЛОВАРЯ',
    source: 'src/dict.ts',
    hint: 'подсказка',
  };
  const source = (text: string) => (path: string) => (path === 'src/dict.ts' ? text : '');
  // D статически тянет S, лениво — L: маркер в S — в первом кадре, в L — нет.
  const leaked = assets({
    'D-1.js': 'import{a}from"./S-2.js";const l=()=>import("./L-3.js");',
    'S-2.js': 'export const a="МАРКЕР-СЛОВАРЯ";',
    'L-3.js': 'export const b=1;',
  });
  const over = checkClosureText(leaked, [rule], source('x МАРКЕР-СЛОВАРЯ y'));
  expect(over.code).toBe(1);
  expect(over.lines.join('\n')).toContain('S-2.js');
  expect(over.lines.join('\n')).toContain('подсказка');

  const lazy = assets({
    'D-1.js': 'import{a}from"./S-2.js";const l=()=>import("./L-3.js");',
    'S-2.js': 'export const a=1;',
    'L-3.js': 'export const b="МАРКЕР-СЛОВАРЯ";',
  });
  expect(checkClosureText(lazy, [rule], source('x МАРКЕР-СЛОВАРЯ y')).code).toBe(0);
  // Маркер переписан в источнике — проверка не зеленеет вечно, а требует нового текста.
  const stale = checkClosureText(lazy, [rule], source('другой текст'));
  expect(stale.code).toBe(1);
  expect(stale.lines.join('\n')).toContain('устарела');
});

test('source guard видит runtime imports/reexports, типы и dynamic import не считает', () => {
  expect(
    runtimeModuleImports(`import { PinVersionDialog } from './VersionsCard';
export { ConfigureView } from '../page/ConfigureView';`),
  ).toEqual(['./VersionsCard', '../page/ConfigureView']);
  expect(
    runtimeModuleImports(`import type { X } from './VersionsCard';
import { type Y } from './VersionsCard';
export type { Z } from './VersionsCard';
export { type A } from './VersionsCard';
const load = () => import('./VersionsCard');`),
  ).toEqual([]);
  expect(
    runtimeModuleImports(`import { type X, Y } from './VersionsCard';
export * from './VersionsCard';
import './VersionsCard';`),
  ).toEqual(['./VersionsCard', './VersionsCard', './VersionsCard']);
});
