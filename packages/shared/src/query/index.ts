/**
 * Вход канона Q-AST — `@orbis/shared/query` (§А5-7).
 *
 * Отдельный вход СОХРАНЁН, хотя причина его появления отпала: имена `QueryAst`,
 * `QueryDateToken`, `QuerySortField` и `QueryDisplayMode` были заняты в корневом барреле
 * старой грамматикой (`query/grammar`), и два `export *` с общими именами давали не
 * «последний побеждает», а ошибку типизации TS2308. Старая грамматика удалена (Задача 21b),
 * конфликта больше нет, и корневой баррель теперь отдаёт канон тоже — но сабпат остаётся
 * ЗАЯВЛЕННОЙ границей: `@orbis/shared/query` не тянет ни схемы сущностей, ни реестр целиком,
 * и потребители, которым нужен только разбор и печать, ходят сюда.
 *
 * Фикстуры (`ast-fixtures.ts`) сюда НЕ входят намеренно: они тянут встроенные словари и
 * разбирают их схемой на загрузке модуля — в браузерный чанк такому ехать незачем.
 */
export * from './ast';
export * from './ast-json-schema';
export type { FieldCatalog, FieldInfo, FieldType } from './catalog';
export { buildCatalogFromRegistry } from './catalog';
export * from './field-ref';
export * from './parse-ast';
export * from './print';
export * from './static';
