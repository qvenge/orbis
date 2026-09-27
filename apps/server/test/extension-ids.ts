// apps/server/test/extension-ids.ts — сторож «ни одного id расширения» (спека 1б §8.2, С1б-4).
//
// Отдельным файлом, а не экспортом из `*.test.ts`: `bun:test` при импорте тестового файла
// регистрирует его тесты ПОВТОРНО в импортирующем сьюте. Зовут его тесты промптов (v8,
// routine-v4), описаний core-тулов и сквозная проверка слоя 5 (задача 7, `registry/extension-off.test.ts`).
import {
  attachToolName,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  EXTENSION_MANIFESTS,
  type ExtensionId,
} from '@orbis/shared';

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

/**
 * Следы расширения, которых `extensionIdsIn` НЕ видит (перенос M-5 гейта задачи 6): имена
 * поверхностей и ключи действий вида `<расширение>/<имя>`, имена тулов расширения — core-тулы
 * манифеста, `attach_*` его аспектов, `action_*` его действий. Отсортированный список без повторов.
 *
 * Зачем отдельно от `extensionIdsIn`. Тот сторожит id аспектов и свойств, а у расширения есть и
 * другие адреса: core-тул `subscription_set` при любой маске предлагал поверхность Бюджета
 * (`finance/budget-overview`) — след, который id-сторож пропускал по построению. Ролей и
 * контрактов здесь нет намеренно: у всех встроенных `module: null` (язык), и стеречь нечего.
 *
 * Состав тулов берётся из манифеста и встроенного реестра, а не списком: новый тул или аспект
 * расширения попадает под сторож без правки тестов. `action_<расширение>_…` — регуляркой, потому
 * что ключи действий владелец заводит сам, и встроенный список их не исчерпывает.
 */
export function extensionMarksIn(text: string, ext: ExtensionId): string[] {
  const names = [
    ...EXTENSION_MANIFESTS[ext].tools,
    ...BUILTIN_ASPECT_DEFS.filter((a) => a.module === ext).map((a) => attachToolName(a.key)),
  ];
  const found: string[] = [];
  for (const name of names) {
    if (new RegExp(`(?<![a-z0-9_])${escapeRe(name)}(?![a-z0-9_])`).test(text)) found.push(name);
  }
  // Поверхность и ключ действия — одна форма `<голова>/<имя>`; граница слева не пускает
  // `orbis/finance_category` (там `finance` — хвост id свойства, а не голова адреса).
  for (const m of text.matchAll(
    new RegExp(
      `(?<![a-z0-9_/-])${ext}/[a-z][a-z0-9_-]*|(?<![a-z0-9_])action_${ext}_[a-z0-9_]+`,
      'g',
    ),
  )) {
    found.push(m[0]);
  }
  return [...new Set(found)].sort();
}
