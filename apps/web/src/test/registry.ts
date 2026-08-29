/**
 * Встроенные реестры в форме ответов tRPC — общая обвязка тестов, которым нужны подписи полей
 * и аспектов, каталог полей запроса или разбор имён (карточки чата, шапка и свойства записи,
 * виджет блока, строковый редактор, форма-конструктор, `/`-меню редактора).
 *
 * Реестр НАСТОЯЩИЙ: каталог полей и подписи в тесте обязаны совпадать с продуктовыми — иначе
 * «неразбираемый блок» в тесте оказался бы разбираемым в продукте (и наоборот), а карточка
 * подписывала бы поле словом, которого владелец не увидит.
 *
 * До Задачи 13a ответов было ДВА (`aspect.list` + `aspect.properties`); теперь реестр едет
 * одним (`registry.effective`), а `aspect.list` остался ради экрана настроек.
 */

import type { AspectId } from '@orbis/shared';
import {
  aspectJsonSchema,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
} from '@orbis/shared';

/**
 * Ответ `aspect.list`: декларация аспекта плюс поля, которые дописывает wire-форма.
 * `schema` остаётся в выдаче (Р-24) и здесь строится тем же генератором, что на сервере.
 */
export const BUILTIN_WIRE_ASPECTS = BUILTIN_ASPECT_DEFS.map((a) => ({
  ...a,
  schema: aspectJsonSchema(a.id as AspectId),
  aggregations: null,
  createdAt: '2026-01-01T00:00:00.000Z',
}));

/**
 * Ответ `registry.effective`: три словаря владельца и версия снимка.
 *
 * Версия — литерал, и именно поэтому она наблюдаема: тест инвалидации подменяет её своей
 * и проверяет, что подписи перерисовались. Форма строки — ровно `PropertyDefinition` и
 * соседи, без всякой wire-обёртки: сервер отдаёт декларации как есть (§А9-2).
 */
export const BUILTIN_REGISTRY = {
  version: '1.0',
  properties: BUILTIN_PROPERTY_META,
  aspects: BUILTIN_ASPECT_DEFS,
  roles: BUILTIN_RELATION_ROLE_META,
};

/**
 * Ответ на реестровые ручки; `undefined` — путь не реестровый, отвечает сам сьют.
 * Именно `undefined`, а не `{}`: пустой объект — законный ответ мутации, и подменять им
 * «не моё дело» значило бы отвечать за чужие пути.
 */
export function registryReply(path: string): unknown | undefined {
  if (path === 'aspect.list') return BUILTIN_WIRE_ASPECTS;
  if (path === 'registry.effective') return BUILTIN_REGISTRY;
  return undefined;
}
