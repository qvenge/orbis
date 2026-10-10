import { LazyDetailContent } from './LazyDetailContent';
import type { WireEntity } from './record-host';

type Props = { entity: WireEntity };
let modulePromise: Promise<typeof import('./AssignmentCard')> | null = null;
const load = () => {
  modulePromise ??= import('./AssignmentCard').catch((error: unknown) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise.then((module) => module.AssignmentCard);
};
export function resetAssignmentCardModuleForTests() {
  modulePromise = null;
}
export function AssignmentCardSlot(props: Props) {
  return (
    <LazyDetailContent
      load={load}
      componentProps={props}
      contentKey={props.entity.id}
      loading="Загрузка назначения…"
      error="Назначение не загрузилось"
      retry="Повторить загрузку назначения"
    />
  );
}
