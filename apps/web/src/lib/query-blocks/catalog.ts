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

import {
  type AspectDefinition,
  aspectDefinitionSchema,
  type FieldCatalog,
  type PropertyDefinition,
  type RelationRoleDefinition,
} from '@orbis/shared';
import {
  buildCatalogFromRegistry,
  OWNER_LOCALE,
  type ParseRegistry,
  toParseRegistry,
} from '@orbis/shared/query';
import type { RouterOutputs } from '../../trpc';

type WireAspect = RouterOutputs['aspect']['list'][number];
/**
 * Ответ `aspect.properties`, ослабленный до `readonly`: ровно та же форма, но принимающая и
 * встроенные словари `@orbis/shared` — на них стоит тестовая обвязка, и копия реестра ради
 * одного модификатора была бы вторым источником правды о форме ответа.
 */
type WireQueryRegistry = {
  properties: readonly RouterOutputs['aspect']['properties']['properties'][number][];
  roles: readonly RouterOutputs['aspect']['properties']['roles'][number][];
};

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

/**
 * Wire-строка аспекта → декларация §А3-1. Разбор строгой схемой, а не каст: реестр, который
 * сам не разбирается собственной схемой, до резолва имён доезжать не должен (то же правило,
 * что у серверного `loadRegistry`).
 *
 * Два поля добираются здесь, и оба — правда среза А, а не заглушка:
 *  - `implements` в wire-форме нет вовсе, а в срезе А он ПУСТ у каждой строки по построению
 *    (§Б2: поле объявлено и пустует до части Б);
 *  - `viewConfig` в wire объявлен `Record<string, unknown> | null` (колонка nullable,
 *    `schema.ts:176`), и `null` здесь означает «аспект без раскладки карточки» — форме
 *    запроса она не нужна вовсе, а уронить весь экран из-за неё нельзя: error boundary у
 *    приложения нет (тот же довод, что у прежнего guard'а `d.schema ?? {}`).
 */
function toAspectDefinition(wire: WireAspect): AspectDefinition {
  return aspectDefinitionSchema.parse({
    id: wire.id,
    ownerId: wire.ownerId,
    key: wire.key,
    label: wire.label,
    description: wire.description,
    properties: wire.properties,
    aiInstructions: wire.aiInstructions,
    tagMappings: wire.tagMappings,
    implements: [],
    viewConfig: wire.viewConfig ?? { keyFields: [] },
    module: wire.module,
    service: wire.service,
    rank: wire.rank,
  });
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Реестр из ответов ДВУХ ручек либо `null`, если снимок неполон.
 *
 * Половина снимка — это НЕ «пустой реестр», и разница наблюдаема: по пустому каталогу блок
 * нарисовался бы красной плашкой «неизвестное свойство», то есть неправдой о запросе, а по
 * отсутствующему — честной загрузкой. Проверяются ОБА массива: `aspect.properties` отдаёт их
 * одной ручкой, но недоехавший ответ приезжает сюда как `undefined` — и `byId(undefined)`
 * уронил бы весь экран (error boundary у приложения нет).
 */
export function registryOf(
  defs: readonly WireAspect[] | undefined,
  wire: Partial<WireQueryRegistry> | undefined,
): QueryRegistry | null {
  if (defs === undefined || !Array.isArray(wire?.properties) || !Array.isArray(wire.roles)) {
    return null;
  }
  return buildQueryRegistry(defs, { properties: wire.properties, roles: wire.roles });
}

/** Собирает клиентский реестр запросов из ответов `aspect.list` и `aspect.properties`. */
export function buildQueryRegistry(
  wireAspects: readonly WireAspect[],
  wire: WireQueryRegistry,
): QueryRegistry {
  const aspects: AspectDefinition[] = wireAspects.map(toAspectDefinition);
  const properties: readonly PropertyDefinition[] = wire.properties;
  const roles: readonly RelationRoleDefinition[] = wire.roles;
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
