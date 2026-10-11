import { type ReactNode, useEffect } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';

export function OnboardingGate({ children }: { children: ReactNode }) {
  const settings = trpc.user.getSettings.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const seed = trpc.user.seedOnboarding.useMutation({
    onSuccess: (r) => {
      // Заведение графа создаёт записи (мир, записи поставки). Списки, успевшие прочитаться
      // пустыми до его конца, сами не протухнут — на первом запуске это ровно тот случай.
      // Только при фактическом заведении: на заведённом графе вход ничего не пишет
      // ({seeded:false}, срез 1б §8.6), и гонять инвалидацию на каждом старте сессии не за что.
      if (r?.seeded) invalidateGraph(utils);
      // Настройки перечитываются после ответа: после заведения графа (в том числе после
      // reset-world, где строка настроек уже была) в них новая маска расширений. На
      // {seeded:false} перечитывать нечего, но ветка одна — лишний запрос раз за сессию.
      void settings.refetch();
    },
  });

  const needsSeed = settings.isError && settings.error.data?.code === 'NOT_FOUND';
  // Граф старой формы (срез 1б, Э-18): сервер его не заводит и отвечает CONFLICT — у
  // seedOnboarding другого CONFLICT нет (R-19). Код tRPC, а не имя отказа: cause по HTTP не
  // сериализуется, а PRECONDITION_FAILED на проводе занят «клиент устарел».
  const needsMigration = seed.isError && seed.error.data?.code === 'CONFLICT';

  // seedOnboarding вызывается один раз при старте сессии и БЕЗ условия по настройкам: признак
  // «граф заведён» — запись оболочки хоста, а не строка настроек (после reset-world строка есть,
  // а графа нет — вход заводит его заново, срез 1б §8.6). На заведённом графе вход ничего не
  // пишет. Для пользователя С настройками вызов идёт параллельно рендеру и его не блокирует.
  useEffect(() => {
    if (seed.isIdle) seed.mutate();
  }, [seed.isIdle, seed.mutate]);

  // Экран перевода — НЕЗАВИСИМО от needsSeed: у графа старой формы строка настроек есть, и
  // фоновый отказ, который ниже приложение «не блокирует», здесь обязан его остановить —
  // иначе владелец работал бы в графе, который код 1б не понимает.
  if (needsMigration) {
    return (
      <div
        role="alert"
        data-testid="migration-screen"
        className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm"
      >
        {/* Перевод 1б `migrate-1b` исполнен в проде 28.09 и снят срезом 1в (РП-13): перевода графа
            старой формы больше нет — только пересев мира `reset-world`, и он сносит данные графа, а не
            переводит их (гейт m-4, Fable M-2 задачи 9). Ссылка — на настоящий раздел ранбука. */}
        <span>
          Граф старой формы: перевода на новую версию нет. Мир пересевается операцией reset-world —
          данные графа сносятся.
        </span>
        <code className="font-mono">
          docs/implementation/02-ops-runbook.md — «Что делает пересев и что он сносит»
        </code>
      </div>
    );
  }

  // Ветка восстановления: сидирование упало И без него не продолжить (настроек нет),
  // ИЛИ getSettings упал не-NOT_FOUND ошибкой. Фоновый провал заведения у пользователя
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
