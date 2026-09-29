// scripts/no-legacy-1v.test.ts
// СТОРОЖ: КАТАЛОГА `legacy-1v` НЕТ, И НЕТ ЕГО ИСКЛЮЧЕНИЙ (срез 1в: спека §8.1, С1в-10).
//
// Срез 1б увёл экраны Бюджета, Повестки и импорта в `apps/web/src/legacy-1v/` — вне сборки, проверки
// типов, vitest и biome — до 1в; 1в их удалил. Исключение каталога в конфиге пережило бы удаление
// молча: новый файл по старому пути снова выпал бы из всех проверок, и никто бы этого не увидел.
// Поэтому страж держит обе половины — пустой каталог в индексе и ни одного упоминания пути в
// трёх конфигах, где исключение стояло.
//
// Оборотная сторона `git ls-files` (Ф-Б2-11): виден только ЗАРЕГИСТРИРОВАННЫЙ файл — файл, созданный в
// каталоге и ещё не добавленный в индекс, локально страж не увидит; в CI дерево checkout'а в индексе
// целиком.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const LEGACY = 'apps/web/src/legacy-1v';
/** Конфиги, где до 1в стояло исключение каталога (спека §8.1). */
const CONFIGS = ['biome.json', 'apps/web/tsconfig.json', 'apps/web/vite.config.ts'] as const;

/** `git ls-files` с проверкой кода возврата: молчащий страж хуже отсутствующего. */
function lsFiles(path: string): string[] {
  const res = Bun.spawnSync(['git', 'ls-files', '--', path], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (res.exitCode !== 0) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(`сторож legacy-1v: git ls-files вернул код ${res.exitCode}: ${err}`);
  }
  return new TextDecoder()
    .decode(res.stdout)
    .split('\n')
    .filter((l) => l.trim() !== '');
}

describe('каталога legacy-1v нет (срез 1в §8.1, С1в-10)', () => {
  test('положительный контроль: ls-files видит отслеживаемый код web', () => {
    // Без контроля страж зеленел бы и на сломанном вызове git (пустой вывод = «каталога нет»).
    expect(lsFiles('apps/web/src/app')).toContain('apps/web/src/app/router.tsx');
  });

  test('в индексе нет ни одного файла каталога', () => {
    expect(lsFiles(LEGACY)).toEqual([]);
  });

  test.each(CONFIGS)('в %s нет исключения каталога', (rel) => {
    expect(readFileSync(join(ROOT, rel), 'utf8')).not.toContain('legacy-1v');
  });
});
