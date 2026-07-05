import { type ReactNode, useEffect } from 'react';
import { trpc } from '../../trpc';

export function OnboardingGate({ children }: { children: ReactNode }) {
  const settings = trpc.user.getSettings.useQuery(undefined, { retry: false });
  const seed = trpc.user.seedOnboarding.useMutation({
    onSuccess: () => {
      void settings.refetch();
    },
  });

  const needsSeed = settings.isError && settings.error.data?.code === 'NOT_FOUND';

  useEffect(() => {
    if (needsSeed && seed.isIdle) seed.mutate();
  }, [needsSeed, seed.isIdle, seed]);

  if (settings.isLoading || seed.isPending || needsSeed) {
    return (
      <div
        role="status"
        data-testid="onboarding-splash"
        className="flex h-full items-center justify-center text-sm text-text-secondary"
      >
        Готовим Orbis…
      </div>
    );
  }
  if (settings.isError) {
    return (
      <div role="alert" className="flex h-full items-center justify-center text-sm text-danger">
        Не удалось загрузить настройки. Повторите позже.
      </div>
    );
  }
  return <>{children}</>;
}
