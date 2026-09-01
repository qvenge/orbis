/**
 * Каталог полей для КОНСТРУКТОРА ЗАПРОСОВ (§А2-2): чем рисовать строку формы — имя, тип,
 * аспект-носитель.
 *
 * Строится ТОЛЬКО из реестра свойств. Прежний `buildFieldCatalog` собирал его из колонки
 * `aspect_definitions.schema` и выводил тип ЭВРИСТИКОЙ по тексту JSON-паттерна — один
 * символ в чужой схеме молча менял тип поля; он удалён вместе со старой грамматикой,
 * которая его и заказывала.
 */

import type { AspectDefinition, PropertyDefinition } from '../registry/property-type';
import type { PropertyKind, PropertyType } from '../registry/types';

export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'decimal'
  | 'date'
  | 'timestamp'
  | 'boolean'
  // Массив скаляров внутри аспекта (orbis/category.aliases): фильтруется containment'ом
  // «массив содержит значение» (`query/compile-ast.ts`, listContains). Раньше приезжал
  // сюда как 'string',
  // и `->>'aliases'` сравнивал текст всего массива: положительный фильтр давал тихий
  // ноль, отрицательный — все строки подряд.
  | 'array'
  // Всё остальное: объект (orbis/schedule.recurrence), разнотипный union
  // (orbis/goal.progress_source), массив не-скаляров. Фильтра, выразимого грамматикой,
  // для них нет — парсер отказывает с позицией.
  | 'unfilterable';

export interface FieldInfo {
  aspect: string;
  type: FieldType;
  /** Значения enum в порядке объявления в схеме — норматив сортировки enum-полей (§6.1). */
  enumValues?: string[];
  /**
   * ТИП ИЗ РЕЕСТРА (§А2-2) — правда о форме значения.
   *
   * Заведён потому, что `FieldType` беднее словаря реестра: `time` в нём не представлен, и
   * приведение к `'string'` теряет ПОРЯДОК — свойство упорядочено (`>`/`<`/диапазон по
   * 'ЧЧ:ММ' хронологичны), а по `type` читатель решил бы обратное.
   *
   * ПРАВИЛО ДЛЯ ПОТРЕБИТЕЛЕЙ (конструктор запросов): читать `kind`; `type` — приближение
   * для тех строк формы, которым хватает грубого деления на «число / дата / текст».
   */
  kind?: PropertyKind;
}

/** Поля каталога по адресу свойства. */
export interface FieldCatalog {
  fields: Record<string, FieldInfo[]>;
}

/**
 * Тип поля ПО РЕЕСТРУ (§А2-2), без единой эвристики по тексту регэкспа.
 *
 * Именно этим он отличается от снятой эвристики `propType`: та выводила тип из паттерна
 * JSON Schema, и один символ в чужой схеме молча менял тип поля (`orbis/run_bucket`
 * не стал timestamp'ом только потому, что его паттерн начинается с `T([01]\d|`, а маркер
 * искался как `T\d{2}:`). Здесь тип приходит из `PropertyType` — угадывать нечего.
 */
function fieldTypeOfProperty(type: PropertyType): FieldType {
  // Список скаляров фильтруется containment'ом — как сегодняшний `array` (`orbis/aliases`).
  if (type.kind !== 'json' && 'cardinality' in type && type.cardinality === 'many') return 'array';
  switch (type.kind) {
    case 'number':
      return type.integer === true ? 'integer' : 'number';
    case 'decimal':
      return 'decimal';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamp':
      return 'timestamp';
    // Вложенный объект (`recurrence`, `progress_source`) выразимого фильтра не имеет.
    case 'json':
      return 'unfilterable';
    // text, time, select, ref, grant, registry_ref — текстовая проекция значения. `time`
    // приезжает сюда ПРИБЛИЖЕНИЕМ: у `FieldType` такого члена нет, и порядок, который у
    // времени есть, по этому полю не виден — за ним читатель идёт в `FieldInfo.kind`.
    default:
      return 'string';
  }
}

/**
 * Каталог полей из реестра свойств. Ключ — **id свойства**: именно его несёт узел
 * `{prop: <id>}` канона (§А5-7), и именно по нему компилятор адресует значение в `props`.
 * У пользовательских свойств id — uuid, а key — слаг, поэтому ключевать каталог по key
 * значило бы лишить компилятор адреса.
 *
 * `FieldInfo.aspect` заполняется единственным аспектом-носителем, если он один: адресом
 * значения аспект больше не является (значение лежит в `props` по id), и поле нужно форме
 * лишь для группировки строк. Массив на ключ — форма, оставшаяся от общего каталога со
 * старым компилятором: имя в новой адресации однозначно по построению (§А5-3а), и элемент
 * в нём всегда ровно один.
 */
export function buildCatalogFromRegistry(reg: {
  properties: ReadonlyMap<string, PropertyDefinition>;
  aspects: ReadonlyMap<string, AspectDefinition>;
}): FieldCatalog {
  const carriers = new Map<string, string[]>();
  for (const aspect of reg.aspects.values()) {
    for (const ref of aspect.properties) {
      const list = carriers.get(ref.propertyId);
      if (list) list.push(aspect.id);
      else carriers.set(ref.propertyId, [aspect.id]);
    }
  }
  const fields: Record<string, FieldInfo[]> = {};
  for (const prop of reg.properties.values()) {
    const owners = carriers.get(prop.id) ?? [];
    const info: FieldInfo = {
      aspect: owners.length === 1 ? (owners[0] as string) : '',
      type: fieldTypeOfProperty(prop.type),
      // Правда о типе — рядом с приближением (см. докблок `FieldInfo.kind`).
      kind: prop.type.kind,
    };
    // Порядок вариантов — `rank` объявления (§А2-2): на нём стоит сортировка enum-полей.
    if (prop.type.kind === 'select') {
      info.enumValues = [...prop.type.options]
        .sort((a, b) => a.rank - b.rank)
        .map((option) => option.key);
    }
    fields[prop.id] = [info];
  }
  return { fields };
}
