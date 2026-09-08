// СЛОВАРЬ МОДУЛЕЙ И ПОВЕРХНОСТЕЙ (§Б5-1, §Б8-1; форма имени — ревизия 3).
// Имя — `<модуль>/<поверхность>`, и модуль подписки читается ИЗ ИМЕНИ: второй источник ответа «чья
// это поверхность» разъехался бы с первым на первом переносе поверхности между модулями.
// Словарь ЗАКРЫТ и держит РОВНО поверхности, у которых в Б-1 есть движок (Р-К-10): по нему отказывает
// SURFACE_UNKNOWN, а имя без исполнителя — обещание, которое некому сдержать. `core/row` и
// `core/exclude-blocked` (`apps/server/test/surfaces.ts`) сюда НЕ входят: правило строки живёт
// константой M14_ROW_ELEMENTS (Р-К-1), excludeBlocked — частный случай Q, строки реестра у них нет.
export const MODULE_IDS = ['finance', 'planner', 'goals', 'ade', 'memory'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export const SURFACES = ['planner/agenda', 'finance/budget-overview'] as const;
export type SurfaceName = (typeof SURFACES)[number];
/** Форма имени: `core` — ядро (модуля нет), остальные головы — id модуля. */
export const SURFACE_RE = /^(core|finance|planner|goals|ade|memory)\/[a-z][a-z0-9-]*$/;
/** Модуль поверхности; `core/…` — ядро, выключению не подлежит (§Б8-3). */
export function surfaceModuleOf(surface: string): ModuleId | null {
  const head = surface.split('/')[0] ?? '';
  return (MODULE_IDS as readonly string[]).includes(head) ? (head as ModuleId) : null;
}

/**
 * КАКОЙ ДВИЖОК ОБСЛУЖИВАЕТ ПОВЕРХНОСТЬ. Таблица нужна потому, что дискриминант декларации — `engine`,
 * а адрес показа — `surface`, и без сверки декларация Budget, объявленная на повестку, проходила бы
 * все проверки формы: движок повестки получил бы чужую форму уже на исполнении, то есть у владельца,
 * а не у автора декларации.
 *
 * Имена движков написаны здесь литералами, а не импортом из `subscription-type.ts`: стрелка между
 * файлами односторонняя (форма подписки читает словарь поверхностей), и обратная замкнула бы цикл.
 * `satisfies` держит таблицу ПОЛНОЙ: новая поверхность без движка не скомпилируется.
 */
export const SURFACE_ENGINE = {
  'planner/agenda': 'agenda',
  'finance/budget-overview': 'budget',
} as const satisfies Readonly<Record<SurfaceName, string>>;
