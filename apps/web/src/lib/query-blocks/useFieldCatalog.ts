import { useMemo } from 'react';
import { trpc } from '../../trpc';
import { type QueryRegistry, registryOf } from './catalog';

export interface FieldCatalogState {
  /** null — реестр ещё едет; потребитель обязан показать загрузку, а не пустой каталог. */
  registry: QueryRegistry | null;
}

/**
 * Реестр запросов (§А2-2, §А5-3а) — ОДИН источник на всех потребителей блоков: виджет,
 * строковый редактор и форма-редактор.
 *
 * Источник — tRPC, а не встроенные словари из shared: реестр живёт в БД (там же приезжают
 * пользовательские свойства и аспекты), и статика показывала бы форме поля, которых на
 * сервере нет, а те, что есть, прятала. Дедупликацию одновременных вызовов делает React
 * Query — своего провайдера реестру не нужно.
 *
 * Запросов ДВА, и до готовности ОБОИХ каталога нет вовсе: аспекты резолвят неоднозначные
 * подписи (§А5-3б), свойства и роли — сами имена, и на половине снимка разбор врал бы
 * `UNKNOWN_FIELD` там, где имя просто ещё не доехало. Обе ручки уходят одним раундом и делят
 * кэш со всеми блоками экрана. Что считать полным снимком — решает `registryOf`.
 */
export function useFieldCatalog(): FieldCatalogState {
  const aspects = trpc.aspect.list.useQuery();
  const registry = trpc.aspect.properties.useQuery();
  const defs = aspects.data;
  const props = registry.data;
  return useMemo(() => ({ registry: registryOf(defs, props) }), [defs, props]);
}
