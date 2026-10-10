import { type ReactNode, useState } from 'react';
import { LazyDetailContent } from './LazyDetailContent';
import type { WireEntity } from './record-host';

type Props = { entity: WireEntity; active: boolean };
let modulePromise: Promise<typeof import('./VersionsCard')> | null = null;
const load = () => {
  modulePromise ??= import('./VersionsCard').catch((error: unknown) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise.then((module) => module.VersionsCard);
};
function Placeholder({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Версии" data-testid="versions-card" className="flex flex-col gap-2">
      <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">Версии</p>
      {children}
    </section>
  );
}
export function VersionsCardSlot(props: Props) {
  const [activated, setActivated] = useState(props.active);
  if (props.active && !activated) setActivated(true);
  // Keep the existing card's place while inactive without loading its producer or queries.
  if (!activated)
    return (
      <Placeholder>
        <p className="text-sm text-text-muted">…</p>
      </Placeholder>
    );
  return (
    <LazyDetailContent
      load={load}
      componentProps={props}
      contentKey={props.entity.id}
      loading="Загрузка версий…"
      error="Версии не загрузились"
      retry="Повторить загрузку версий"
      fallback={(content) => <Placeholder>{content}</Placeholder>}
    />
  );
}
