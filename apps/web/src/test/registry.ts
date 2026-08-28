/**
 * Встроенные реестры в форме ответов tRPC — общая обвязка тестов, которым нужен каталог полей
 * запроса (виджет блока, строковый редактор, форма-конструктор, `/`-меню редактора).
 *
 * Реестр НАСТОЯЩИЙ: каталог полей в тесте обязан совпадать с каталогом прода — иначе
 * «неразбираемый блок» в тесте оказался бы разбираемым в продукте (и наоборот). Раньше каждый
 * сьют строил ответ `aspect.list` сам одной строкой; с §А5-3а ответов стало ДВА
 * (`aspect.list` + `aspect.properties`), и восемь копий этой пары разъехались бы на первом же
 * изменении формы ответа.
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

/** Ответ `aspect.properties`: словари свойств и ролей рёбер владельца. */
export const BUILTIN_WIRE_REGISTRY = {
  properties: BUILTIN_PROPERTY_META,
  roles: BUILTIN_RELATION_ROLE_META,
};

/**
 * Ответ на реестровые ручки; `undefined` — путь не реестровый, отвечает сам сьют.
 * Именно `undefined`, а не `{}`: пустой объект — законный ответ мутации, и подменять им
 * «не моё дело» значило бы отвечать за чужие пути.
 */
export function registryReply(path: string): unknown | undefined {
  if (path === 'aspect.list') return BUILTIN_WIRE_ASPECTS;
  if (path === 'aspect.properties') return BUILTIN_WIRE_REGISTRY;
  return undefined;
}
