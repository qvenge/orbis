import { LazyDetailContent } from './LazyDetailContent';
import type { WireEntity } from './record-host';

type Props = { entity: WireEntity };
let modulePromise: Promise<typeof import('./RunFeed')> | null = null;
const load = () => {
  modulePromise ??= import('./RunFeed').catch((error: unknown) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise.then((module) => module.RunFeed);
};
export function resetRunFeedModuleForTests() {
  modulePromise = null;
}
/** The rare agent-run card adds no feed code to an ordinary record's first frame. */
export function RunFeedSlot(props: Props) {
  return (
    <LazyDetailContent
      load={load}
      componentProps={props}
      contentKey={props.entity.id}
      loading="Загрузка ленты прогона…"
      error="Лента прогона не загрузилась"
      retry="Повторить загрузку ленты"
    />
  );
}
