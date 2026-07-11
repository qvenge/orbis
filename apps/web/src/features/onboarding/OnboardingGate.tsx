import { type ReactNode, useEffect } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';

export function OnboardingGate({ children }: { children: ReactNode }) {
  const settings = trpc.user.getSettings.useQuery(undefined, { retry: false });
  const seed = trpc.user.seedOnboarding.useMutation({
    onSuccess: () => {
      // Перечитать настройки и после бэкфилла ({seeded:false}): installedViews мог
      // пополниться orbis-budget — вкладка Budget появляется в этой же сессии.
      void settings.refetch();
    },
  });

  const needsSeed = settings.isError && settings.error.data?.code === 'NOT_FOUND';

  // A9: seedOnboarding вызывается БЕЗУСЛОВНО один раз при старте сессии — мутация
  // идемпотентна (повтор → {seeded:false}), а для засиденных ДО слайса 2 сервер
  // дописывает orbis-budget в installedViews (бэкфилл). Раньше вызов шёл только по
  // NOT_FOUND — бэкфилл был недостижим: строка настроек у таких пользователей ЕСТЬ.
  // Для пользователя С настройками вызов идёт параллельно рендеру и его не блокирует.
  useEffect(() => {
    if (seed.isIdle) seed.mutate();
  }, [seed.isIdle, seed.mutate]);

  // Ветка восстановления: сидирование упало И без него не продолжить (настроек нет),
  // ИЛИ getSettings упал не-NOT_FOUND ошибкой. Фоновый провал бэкфилла у пользователя
  // С настройками приложение НЕ блокирует — попытка повторится при следующей сессии.
  // reset() возвращает мутацию в idle → эффект перезапускает seed; refetch() — для ошибки настроек.
  if ((seed.isError && needsSeed) || (settings.isError && !needsSeed)) {
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

  // Splash — только пока грузятся настройки либо их нет (NOT_FOUND: ждём seed + refetch).
  // Фоновый seed у пользователя С настройками рендер НЕ задерживает (seed.isPending
  // сюда сознательно не входит).
  if (settings.isLoading || needsSeed) {
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
