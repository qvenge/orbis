import type { ExtensionId } from '@orbis/shared';
import { lazy, Suspense } from 'react';
import { useRegistry } from '../../lib/registry/useRegistry';
import type { RouterOutputs } from '../../trpc';
import { useDisabledExtensions } from '../settings/extension-mask';
import { useHostReadOnly } from './record-host';

export type Entity = RouterOutputs['entity']['get']['entity'];
export interface AspectSnapshot {
  registry: ReturnType<typeof useRegistry>;
  readOnly: boolean;
  disabled: readonly ExtensionId[];
}
/** R60: общие чтения остаются синхронными; форма получает текущий снимок без новых query observers. */
function useSnapshot(): AspectSnapshot {
  return {
    registry: useRegistry(),
    readOnly: useHostReadOnly(),
    disabled: useDisabledExtensions(),
  };
}
const One = lazy(() =>
  import('./AspectSectionView').then((m) => ({ default: m.AspectSectionView })),
);
const Many = lazy(() =>
  import('./AspectSectionView').then((m) => ({ default: m.AspectSectionsView })),
);
export function AspectSection({ entity, aspectId }: { entity: Entity; aspectId: string }) {
  const snapshot = useSnapshot();
  if (
    !entity.aspects.includes(aspectId) ||
    !snapshot.registry.data?.aspects.some((a) => a.id === aspectId)
  )
    return null;
  return (
    <Suspense fallback={null}>
      <One entity={entity} aspectId={aspectId} snapshot={snapshot} />
    </Suspense>
  );
}
export function AspectSections({
  entity,
  exclude,
}: {
  entity: Entity;
  exclude: ReadonlySet<string>;
}) {
  const snapshot = useSnapshot();
  return (
    <Suspense fallback={null}>
      <Many entity={entity} exclude={exclude} snapshot={snapshot} />
    </Suspense>
  );
}
