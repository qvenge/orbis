import type { FieldCatalog } from '@orbis/shared';
import { useMemo } from 'react';
import { trpc } from '../../trpc';
import { buildCatalogFromAspects } from './catalog';

export interface FieldCatalogState {
  /** null — реестр ещё едет; потребитель обязан показать загрузку, а не пустой каталог. */
  catalog: FieldCatalog | null;
  /** id аспектов реестра в порядке ответа — список выбора «Аспекты» в форме-редакторе. */
  aspectIds: string[];
}

/**
 * Каталог полей query-грамматики (§6.1) — ОДИН источник на всех потребителей блоков:
 * виджет, строковый редактор и форма-редактор. До формы обвязка «useQuery + useMemo +
 * buildCatalogFromAspects» жила двумя копиями; третий потребитель сделал её хуком.
 *
 * Источник — tRPC-реестр, а не статический BUILTIN_ASPECT_IDS из shared: реестр живёт в БД
 * (там же приезжают кастомные аспекты и встроенные из будущих фаз), и статика показывала бы
 * форме поля, которых на сервере нет, а те, что есть, прятала. Дедупликацию одновременных
 * вызовов делает React Query — своего провайдера реестру не нужно.
 */
export function useFieldCatalog(): FieldCatalogState {
  const aspects = trpc.aspect.list.useQuery();
  const defs = aspects.data;
  return useMemo(
    () => ({
      catalog: defs ? buildCatalogFromAspects(defs) : null,
      aspectIds: defs ? defs.map((d) => d.id) : [],
    }),
    [defs],
  );
}
