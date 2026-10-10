import { Button } from '../../ui/Button';
import { LazyDetailContent } from './LazyDetailContent';

type Props = { entityId: string; onClose: () => void };
let modulePromise: Promise<typeof import('./PinVersionDialog')> | null = null;
const load = () => {
  modulePromise ??= import('./PinVersionDialog').catch((error: unknown) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise.then((module) => module.PinVersionDialog);
};
export function PinVersionDialogSlot(props: Props) {
  return (
    <LazyDetailContent
      load={load}
      componentProps={props}
      contentKey={props.entityId}
      loading="Загрузка формы…"
      error="Форма не загрузилась"
      retry="Повторить загрузку формы"
      fallback={(content) => (
        <section aria-label="Загрузка закрепления версии">
          {content}
          <Button onClick={props.onClose}>Отмена</Button>
        </section>
      )}
    />
  );
}
