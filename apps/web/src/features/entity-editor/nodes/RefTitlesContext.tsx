import { createContext, type ReactNode, useContext } from 'react';
import { type RefTitle, useResolvedRefs } from '../../../lib/entity-ref/useResolvedRefs';

export type { RefTitle } from '../../../lib/entity-ref/useResolvedRefs';

const Ctx = createContext<ReadonlyMap<string, RefTitle>>(new Map());

/** One shared bounded resolver for every chip; stable byId avoids rerenders on body typing. */
export function RefTitlesProvider({ ids, children }: { ids: string[]; children: ReactNode }) {
  const { byId } = useResolvedRefs(ids);
  return <Ctx.Provider value={byId}>{children}</Ctx.Provider>;
}

/** Заголовок ссылки или undefined — пока резолв едет и если сущность не найдена. */
export function useRefTitle(id: string): RefTitle | undefined {
  return useContext(Ctx).get(id);
}
