// apps/server/test/extension-ids.ts — сторож «ни одного id расширения» (спека 1б §8.2, С1б-4).
//
// Отдельным файлом, а не экспортом из `*.test.ts`: `bun:test` при импорте тестового файла
// регистрирует его тесты ПОВТОРНО в импортирующем сьюте. Зовут его тесты промптов (v8,
// routine-v4), описаний core-тулов и сквозная проверка слоя 5 (задача 7).
import { BUILTIN_ASPECT_DEFS, BUILTIN_PROPERTY_META } from '@orbis/shared';

/**
 * id аспектов и свойств, принадлежащих расширению (`module ≠ null`). Берутся из встроенного
 * реестра, а не списком: новое свойство расширения попадает под сторож без правки тестов.
 */
export const EXTENSION_OWNED_IDS: readonly string[] = [
  ...BUILTIN_ASPECT_DEFS,
  ...BUILTIN_PROPERTY_META,
]
  .filter((x) => x.module !== null && x.module !== undefined)
  .map((x) => x.id);

/** Экранирование id для регулярки: в id бывают «/», «-», «.». */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/**
 * id расширений, встреченные в тексте, — отсортированный список без повторов.
 *
 * Сверка по ГРАНИЦАМ имени, а не подстрокой: `orbis/goal` подстрокой входит в гипотетическое
 * `orbis/goal_note`, и сторож краснел бы на чужом имени; но и промолчать о `orbis/goal` в конце
 * предложения («…aspect=orbis/goal.») он не должен — точка не продолжает имя.
 */
export function extensionIdsIn(text: string): string[] {
  const found = EXTENSION_OWNED_IDS.filter((id) =>
    new RegExp(`(?<![a-z0-9_/-])${escapeRe(id)}(?![a-z0-9_-])`).test(text),
  );
  return [...new Set(found)].sort();
}
