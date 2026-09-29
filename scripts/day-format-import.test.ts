// scripts/day-format-import.test.ts
// СТОРОЖ ЛЕНИВОСТИ ФОРМАТТЕРОВ ЛЕНТЫ ПО ДНЯМ (срез 1в, задача 7; РП-22, Д-17, Д-20).
//
// Подписи дня и колонки времени в поясе владельца (`apps/web/src/features/page/blocks/day-format.ts`)
// нужны только ленте по дням — редкому блоку страницы. Экран записи эагерен в каждом открытии, запас
// его замыкания — сотни байт (порог `--max-closure-gzip` в CI). Поэтому у модуля ОДИН импортёр —
// ленивый `DayGroups.tsx` (точка лени — `DayGroupsSlot.tsx`): второй импортёр в эагерном коде
// (строка списка, склейка блока, `lib/dates.ts`) незаметно утащил бы форматтеры в первый кадр.
// Рост замыкания держит порог, этот сторож — называет виновника до сборки.
//
// Оборотная сторона `git grep` (Ф-Б2-11): виден только ЗАРЕГИСТРИРОВАННЫЙ файл — новый импортёр,
// ещё не добавленный в индекс, локально не виден; в CI индекс — всё дерево.
import { expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function gitGrepFiles(pattern: string, pathspec: readonly string[]): string[] {
  const res = Bun.spawnSync(['git', 'grep', '-l', '-F', pattern, '--', ...pathspec], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C.UTF-8' },
  });
  // Код 1 у `git grep` — «ничего не нашлось», это не сбой.
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(`сторож day-format: git grep вернул код ${res.exitCode}: ${err}`);
  }
  return new TextDecoder()
    .decode(res.stdout)
    .split('\n')
    .filter((l) => l !== '')
    .sort();
}

test('day-format импортирует только ленивый DayGroups.tsx (вне тестов)', () => {
  const importers = gitGrepFiles("from './day-format'", ['apps/web/src', ':!*.test.*']);
  expect(importers).toEqual(['apps/web/src/features/page/blocks/DayGroups.tsx']);
});

test('модуль day-format больше ниоткуда не упомянут в боевом коде web', () => {
  // Путь другим видом (`../page/blocks/day-format`, динамический импорт) — тоже импортёр.
  const mentions = gitGrepFiles('day-format', ['apps/web/src', ':!*.test.*']).filter(
    (f) => f !== 'apps/web/src/features/page/blocks/day-format.ts',
  );
  expect(mentions).toEqual(['apps/web/src/features/page/blocks/DayGroups.tsx']);
});
