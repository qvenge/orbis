import { type ReactNode, useEffect } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';

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
  }, [needsSeed, seed.isIdle, seed.mutate]);

  // Ветка восстановления: сидирование упало ИЛИ getSettings упал не-NOT_FOUND ошибкой.
  // reset() возвращает мутацию в idle → эффект перезапускает seed; refetch() — для ошибки настроек.
  if (seed.isError || (settings.isError && !needsSeed)) {
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 text-sm text-danger"
      >
        <span>Не удалось загрузить настройки. Повторите позже.</span>
        <Button
          variant="outline"
          onClick={() => {
            seed.reset();
            void settings.refetch();
          }}
        >
          Повторить
        </Button>
      </div>
    );
  }

  // Splash — только пока реально идёт загрузка/сидирование либо обнаружен NOT_FOUND (seed сейчас стартует).
  if (settings.isLoading || seed.isPending || needsSeed) {
    return (
      <div
        role="status"
        data-testid="onboarding-splash"
        className="flex h-full flex-col items-center justify-center gap-3"
      >
        <span className="text-lg font-semibold">Orbis</span>
        <Spinner size={20} aria-label="Готовим Orbis" />
      </div>
    );
  }
  return <>{children}</>;
}
