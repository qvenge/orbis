import { type ComponentType, type Key, type ReactNode, useEffect, useState } from 'react';
import { Button } from '../../ui/Button';
/** Only the new detail slots share loading mechanics. The producer retains its own state,
 * keyed to the addressed entity; props changes never restart a successful module load. */
export function LazyDetailContent<P extends object>({
  load,
  componentProps,
  contentKey,
  loading,
  error,
  retry,
  fallback,
}: {
  load: () => Promise<ComponentType<P>>;
  componentProps: P;
  contentKey: Key;
  loading: string;
  error: string;
  retry: string;
  fallback?: (content: ReactNode) => ReactNode;
}) {
  const [Content, setContent] = useState<ComponentType<P> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit retry gesture; removing it would leave a failed loader stuck.
  useEffect(() => {
    let live = true;
    void load()
      .then((component) => {
        if (live) setContent(() => component);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [load, attempt]);
  if (Content) return <Content key={contentKey} {...componentProps} />;
  const content = failed ? (
    <div role="alert">
      {error}{' '}
      <Button
        onClick={() => {
          setFailed(false);
          setAttempt((value) => value + 1);
        }}
      >
        {retry}
      </Button>
    </div>
  ) : (
    <p role="status">{loading}</p>
  );
  return fallback ? fallback(content) : content;
}
