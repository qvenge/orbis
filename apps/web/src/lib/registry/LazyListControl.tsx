import { effectiveLabel, OWNER_LOCALE, type PropertyDefinition } from '@orbis/shared';
import { type ComponentType, useEffect, useState } from 'react';

export type ListControlProps = {
  def: PropertyDefinition;
  value: readonly string[];
  onChange: (items: string[]) => void;
  disabled?: boolean;
};
export const loadRefManyControl = () => import('./RefManyControl').then((m) => m.RefManyControl);
export const loadScalarListControl = () =>
  import('./ScalarListControl').then((m) => m.ScalarListControl);

/** A rejected leaf import must not unmount its owning form or cache a rejected lazy identity. */
export function LazyListControl({
  load,
  ...props
}: ListControlProps & { load: () => Promise<ComponentType<ListControlProps>> }) {
  const [Control, setControl] = useState<ComponentType<ListControlProps> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt represents the explicit retry of the same loader.
  useEffect(() => {
    let live = true;
    void load()
      .then((component) => {
        if (live) setControl(() => component);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [load, attempt]);
  if (Control) return <Control {...props} />;
  const subject = `${effectiveLabel(props.def.label, OWNER_LOCALE)} (${props.def.key})`;
  return failed ? (
    <div role="alert" className="text-sm text-danger">
      Не удалось загрузить редактор: {subject}{' '}
      <button
        type="button"
        className="min-h-11 rounded-md px-2 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        disabled={props.disabled}
        onClick={() => {
          setFailed(false);
          setAttempt((value) => value + 1);
        }}
      >
        Повторить загрузку редактора: {subject}
      </button>
    </div>
  ) : (
    <p role="status" className="text-sm text-text-muted">
      Загрузка редактора: {subject}
    </p>
  );
}
