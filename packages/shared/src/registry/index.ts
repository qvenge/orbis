// Реестры новой формы (§А2–§А4 спеки «Реформа свойств»): словарь типов, схемы деклараций
// и встроенное содержимое. `RELATION_ROLE_IDS`/`HIERARCHICAL_ROLE_IDS` живут в `constants.ts`
// рядом с `BUILTIN_ASPECT_IDS` — у имени должен быть один дом.
export * from './builtin-aspects';
export * from './builtin-properties';
export * from './builtin-roles';
export * from './contract-ids';
// Переходная карта старой формы (РП-3): экспортируется наравне с остальным, потому что её
// зовёт серверный golden приёмки §С8-1; удаляется целиком Задачей 23.
export * from './legacy-field-map';
export * from './property-type';
export * from './types';
export * from './value-schema';
