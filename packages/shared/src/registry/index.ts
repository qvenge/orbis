// Реестры новой формы (§А2–§А4 спеки «Реформа свойств»): словарь типов, схемы деклараций
// и встроенное содержимое. `RELATION_ROLE_IDS`/`HIERARCHICAL_ROLE_IDS` живут в `constants.ts`
// рядом с `BUILTIN_ASPECT_IDS` — у имени должен быть один дом.
export * from './bindings';
export * from './builtin-aspects';
export * from './builtin-contracts';
export * from './builtin-properties';
export * from './builtin-roles';
export * from './contract-type';
// Словарь модулей и поверхностей (§Б5-1, §Б8-1): по нему отказывает `SURFACE_UNKNOWN` и по нему же
// собираются имена снимков поверхностей — второго списка имён в корпусе нет (Р-К-10).
export * from './modules';
export * from './property-type';
// Форма декларации подписки и два эталона (§Б5-4/§Б5-6). Эталоны в барреле — намеренно, в отличие
// от `query/ast-fixtures.ts`: тот вне барреля потому, что разбирает встроенные словари схемой НА
// ЗАГРУЗКЕ модуля, здесь же — два литерала без единого `parse`, и их читают серверные сьюты.
export * from './subscription-fixtures';
export * from './subscription-type';
// Модель-обращённая поверхность реестра (§А9-1): имя attach_*-тула и схема его data.
export * from './tool-schema';
export * from './types';
export * from './value-schema';
