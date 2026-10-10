import { useState } from 'react';
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
export function VersionsCardSlot(props: Props) {
  const [activated, setActivated] = useState(props.active);
  if (props.active && !activated) setActivated(true);
  if (!activated) return null;
  return (
    <LazyDetailContent
      load={load}
      componentProps={props}
      contentKey={props.entity.id}
      loading="Загрузка версий…"
      error="Версии не загрузились"
      retry="Повторить загрузку версий"
    />
  );
}
