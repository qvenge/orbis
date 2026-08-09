/**
 * Каталог полей аспектов для резолва имён в query-грамматике (PRD 01 §6.1).
 *
 * Строится из JSON Schema реестра аспектов (`aspect_definitions.schema`): обходит
 * top-level `properties` каждой схемы. Эвристика `propType` подогнана под фактический
 * вывод zod-to-json-schema для встроенных аспектов и закреплена юнит-тестами
 * (`parse.test.ts`, блок «propType»): тип берётся из реального паттерна, не из догадки.
 */

export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'decimal'
  | 'date'
  | 'timestamp'
  | 'boolean'
  // Массив скаляров внутри аспекта (orbis/category.aliases): фильтруется containment'ом
  // «массив содержит значение» — см. compile.ts. Раньше приезжал сюда как 'string',
  // и `->>'aliases'` сравнивал текст всего массива: положительный фильтр давал тихий
  // ноль, отрицательный — все строки подряд.
  | 'array'
  // Объект или union (orbis/schedule.recurrence, orbis/goal.progress_source): фильтра,
  // выразимого грамматикой, для них нет — парсер отказывает с позицией.
  | 'unfilterable';

export interface FieldInfo {
  aspect: string;
  type: FieldType;
  /** Значения enum в порядке объявления в схеме — норматив сортировки enum-полей (§6.1). */
  enumValues?: string[];
}

export interface FieldCatalog {
  fields: Record<string, FieldInfo[]>;
}

/**
 * Core-поля сущности, доступные в фильтрах и сортировке (§4.1, §6.1).
 * Core-`title` здесь отсутствует: в позиции фильтра ключ `title=` занят параметром
 * заголовка, поэтому `title` участвует только в `sortBy` (§6.1); отбор — через `search=`.
 */
export const CORE_FIELDS: Readonly<Record<'created_at' | 'updated_at', FieldType>> = {
  created_at: 'timestamp',
  updated_at: 'timestamp',
};

/** Точный паттерн ISO-даты из реестра (zod `dateString`, §3.1). */
const DATE_PATTERN = String.raw`^\d{4}-\d{2}-\d{2}$`;
/** Маркер timestamp-паттерна реестра (zod `timestampString`): `...T\d{2}:...`. */
const TIMESTAMP_MARK = String.raw`T\d{2}:`;
/**
 * Общий хвост всех трёх decimal-паттернов §3.3: знаковый `^-?...`, строго положительный
 * `^(?!0+(\.0+)?$)...` и неотрицательный `^\d+...` — все заканчиваются на `\d+(\.\d+)?$`.
 * Паттерны даты/timestamp/цвета этим хвостом не заканчиваются (закреплено юнит-тестом).
 */
const DECIMAL_TAIL = String.raw`\d+(\.\d+)?$`;

/** Строит каталог полей из JSON Schema реестра аспектов. */
export function buildFieldCatalog(
  defs: Array<{ id: string; schema: Record<string, unknown> }>,
): FieldCatalog {
  const fields: Record<string, FieldInfo[]> = {};
  for (const def of defs) {
    const props =
      (def.schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
    for (const [name, prop] of Object.entries(props)) {
      const info: FieldInfo = { aspect: def.id, type: propType(prop) };
      if (Array.isArray(prop.enum)) info.enumValues = prop.enum as string[];
      let list = fields[name];
      if (!list) {
        list = [];
        fields[name] = list;
      }
      list.push(info);
    }
  }
  return { fields };
}

/** Тип поля по его JSON Schema-описанию (эвристика по фактическому выводу zod-to-json-schema). */
function propType(prop: Record<string, unknown>): FieldType {
  if (prop.type === 'number') return 'number';
  if (prop.type === 'integer') return 'integer';
  if (prop.type === 'boolean') return 'boolean';
  if (prop.type === 'string') {
    // Явный формат — на случай будущих реестров, где decimal объявлен через format.
    if (prop.format === 'decimal') return 'decimal';
    const pattern = typeof prop.pattern === 'string' ? prop.pattern : '';
    if (pattern === DATE_PATTERN) return 'date';
    if (pattern.includes(TIMESTAMP_MARK)) return 'timestamp';
    if (pattern.endsWith(DECIMAL_TAIL)) return 'decimal';
    return 'string';
  }
  if (prop.type === 'array') {
    // Containment ищет элемент массива целиком, поэтому осмыслен только для скаляров:
    // массив объектов таким предикатом грамматика выразить не может.
    const items = prop.items as Record<string, unknown> | undefined;
    const itemType = typeof items?.type === 'string' ? items.type : '';
    return itemType === 'string' || itemType === 'number' || itemType === 'integer'
      ? 'array'
      : 'unfilterable';
  }
  // object и union (anyOf/oneOf) — фильтровать нечем.
  return 'unfilterable';
}
