/**
 * Реестр запросов на клиенте: словари свойств, аспектов и ролей → каталог полей (§А2-2) и
 * снимок разбора имён (§А5-3а).
 *
 * Что здесь изменилось против прежнего `buildCatalogFromAspects`: каталог больше НЕ строится
 * по колонке `aspect_definitions.schema`. Там тип поля выводился эвристикой по тексту
 * JSON-паттерна, и один символ в чужой схеме молча менял тип (`orbis/run_bucket` не стал
 * timestamp'ом только потому, что его паттерн начинается с `T([01]\\d|`). Теперь тип приходит
 * `PropertyType`'ом реестра, а ключ каталога — **id свойства**: именно его несёт узел
 * `{prop: <id>}` канона (§А5-7).
 */

import type {
  AspectDefinition,
  FieldCatalog,
  PropertyDefinition,
  RelationRoleDefinition,
} from '@orbis/shared';
import {
  buildCatalogFromRegistry,
  OWNER_LOCALE,
  type ParseRegistry,
  toParseRegistry,
} from '@orbis/shared/query';
import type { EffectiveRegistry } from '../registry/labels';

/** Всё, что нужно блоку и форме: чем рисовать поля и чем разбирать/печатать текст. */
export interface QueryRegistry {
  catalog: FieldCatalog;
  /** Снимок разбора имён — вход `parseQueryAst`/`printQueryAst`. */
  parse: ParseRegistry;
  /** Свойства в порядке реестра (`rank`) — порядок строк формы и списка сортировки. */
  properties: readonly PropertyDefinition[];
  /** Аспекты в порядке ответа — список выбора «Аспекты» в форме-редакторе. */
  aspects: readonly AspectDefinition[];
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Реестр запросов из ответа `registry.effective` либо `null`, если снимок ещё не приехал.
 *
 * Отсутствие снимка — это НЕ «пустой реестр», и разница наблюдаема: по пустому каталогу блок
 * нарисовался бы красной плашкой «неизвестное свойство», то есть неправдой о запросе, а по
 * отсутствующему — честной загрузкой.
 *
 * Проверка «половины снимка» здесь исчезла вместе с самой возможностью: три словаря едут
 * одним ответом (§А9-2), и `properties` без `roles` больше не бывает.
 */
export function registryOf(data: EffectiveRegistry | undefined): QueryRegistry | null {
  return data === undefined ? null : buildQueryRegistry(data);
}

/**
 * Собирает клиентский реестр запросов из ответа `registry.effective`.
 *
 * Разбора строгой схемой здесь БОЛЬШЕ НЕТ, и это не послабление: строки уже разобраны — на
 * сервере, тем же `aspectDefinitionSchema`, внутри `loadRegistry`, и отказ там fail-closed
 * (реестр, который сам не разбирается собственной схемой, до клиента не доезжает вовсе).
 * Прежний разбор стоял здесь потому, что `aspect.list` отдавал WIRE-строку — форму
 * `aspect_definitions` с колонкой `schema` и без `implements`, — и её приходилось собирать
 * обратно в декларацию §А3-1. Теперь декларация и есть ответ.
 */
export function buildQueryRegistry(data: EffectiveRegistry): QueryRegistry {
  const aspects: readonly AspectDefinition[] = data.aspects;
  const properties: readonly PropertyDefinition[] = data.properties;
  const roles: readonly RelationRoleDefinition[] = data.roles;
  const snapshot = {
    properties: byId(properties),
    aspects: byId(aspects),
    roles: byId(roles),
  };
  return {
    catalog: buildCatalogFromRegistry(snapshot),
    parse: toParseRegistry(snapshot, OWNER_LOCALE),
    properties,
    aspects,
  };
}
