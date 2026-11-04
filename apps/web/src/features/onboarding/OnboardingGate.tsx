import { hashKey, onlineManager, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from 'react';
import { freshnessRuntimeOf } from '../../lib/freshness/provenance';
import { usePrivacyActions } from '../../lib/local-data/privacy-actions';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';

const settingsKey = getQueryKey(trpc.user.getSettings, undefined, 'query');

function absenceOfHostShell(client: QueryClient): 'missing-settings' | 'unseeded' | undefined {
  const state = client.getQueryState<RouterOutputs['user']['getSettings']>(settingsKey);
  if (state?.fetchStatus !== 'idle') return;
  const runtime = freshnessRuntimeOf(client);
  if (state.status === 'error') {
    const error = state.error as { data?: { code?: string } } | null;
    if (error?.data?.code === 'NOT_FOUND' && (!runtime || runtime.isCurrentReadError(error)))
      return 'missing-settings';
    return;
  }
  if (state.data?.graphEstablished !== false) return;
  const read = runtime?.publicationOf(hashKey(settingsKey));
  if (!runtime || (read?.source === 'network' && runtime.isAcceptedRead(read))) return 'unseeded';
}

export function OnboardingGate({ children }: { children: ReactNode }) {
  const privacy = usePrivacyActions();
  const client = useQueryClient();
  const started = useRef(false);
  const settings = trpc.user.getSettings.useQuery();
  const seed = trpc.user.seedOnboarding.useMutation({
    onMutate: () => privacy?.scope,
    onSuccess: (result, _variables, scope) => {
      if (result.seeded && scope && privacy) {
        privacy.graphSeeded(scope);
        return;
      }
      // Настройки перечитываются после ответа: после заведения графа (в том числе после
      // reset-world, где строка настроек уже была) в них новая маска расширений. На
      // {seeded:false} перечитывать нечего, но ветка одна — лишний запрос раз за сессию.
      void settings.refetch();
    },
  });

  const absence = settings.fetchStatus === 'idle' ? absenceOfHostShell(client) : undefined;
  const needsSeed = absence === 'missing-settings';
  const needsMigration = seed.isError && seed.error.data?.code === 'CONFLICT';
  const online = useSyncExternalStore(onlineManager.subscribe, () => onlineManager.isOnline());
  const canSeed = online && (privacy?.canSeed ?? true);
  useEffect(() => {
    if (!absence || !canSeed || !seed.isIdle || started.current) return;
    let afterPaint: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      afterPaint = requestAnimationFrame(() => {
        if (started.current || !onlineManager.isOnline() || !absenceOfHostShell(client)) return;
        started.current = true;
        seed.mutate();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (afterPaint !== undefined) cancelAnimationFrame(afterPaint);
    };
  }, [absence, canSeed, client, seed.isIdle, seed.mutate]);

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
  if (
    (seed.isError && needsSeed) ||
    (settings.isError && !needsSeed && settings.data === undefined)
  ) {
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 text-sm text-danger"
      >
        <span>Не удалось загрузить настройки. Повторите позже.</span>
        <Button
          variant="outline"
          onClick={() => {
            started.current = false;
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
  if (settings.data === undefined || needsSeed) {
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
