import { lazy, Suspense, useEffect, useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs } from '../../ui/Tabs';
import { AspectsList } from './AspectsList';
import { ConnectedAgents } from './ConnectedAgents';
import { ExportButton } from './ExportButton';
import { GeneralForm } from './GeneralForm';
import { useSettingsTabRequest } from './settings-tab';

/**
 * «Приложения и расширения» (срез 1б §8.6) — ЛЕНИВО: экран настроек во входном чанке, а тот входит в
 * замыкание первого кадра записи (РП-25). Статический импорт вернул бы списки и диалоги вкладки в
 * первый кадр каждого экрана (сторож — `scripts/check-lazy-chunks.ts`).
 */
const AppsAndExtensions = lazy(() =>
  import('./AppsAndExtensions').then((m) => ({ default: m.AppsAndExtensions })),
);

export function SettingsScreen() {
  const settings = trpc.user.getSettings.useQuery();
  // Вкладка по просьбе пункта меню (`openSettings`): первое значение — из просьбы (без кадра «Общих»),
  // эффект переключает уже открытый экран и гасит просьбу — повторный вход без неё идёт на «Общие».
  const requested = useSettingsTabRequest((s) => s.tab);
  const [tab, setTab] = useState(() => useSettingsTabRequest.getState().tab ?? 'general');
  useEffect(() => {
    if (requested === null) return;
    setTab(requested);
    useSettingsTabRequest.setState({ tab: null });
  }, [requested]);
  return (
    <>
      <ScreenHeader title="Настройки" />
      {settings.data ? (
        <div className="mx-auto w-full max-w-3xl">
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              {
                value: 'general',
                label: 'Общие',
                content: <GeneralForm settings={settings.data} />,
              },
              { value: 'memory', label: 'Память AI', content: <MemorySection /> },
              { value: 'aspects', label: 'Аспекты', content: <AspectsList /> },
              {
                value: 'apps',
                label: 'Приложения и расширения',
                content: (
                  <Suspense fallback={<Skeleton className="m-3 h-24" />}>
                    <AppsAndExtensions />
                  </Suspense>
                ),
              },
              { value: 'agents', label: 'Агенты', content: <ConnectedAgents /> },
              {
                value: 'export',
                label: 'Экспорт',
                content: (
                  <div className="p-3">
                    <ExportButton />
                  </div>
                ),
              },
            ]}
          />
        </div>
      ) : (
        // Скелетон формы настроек: 4 строки «лейбл + поле».
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-3">
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-9 w-1/2" />
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-9 w-1/3" />
        </div>
      )}
    </>
  );
}

// Раздел «Память AI» (02-core-os §2.7) — вход на отдельный экран хоста (`/settings/memory`), а не
// список прямо здесь: у экрана свой адрес, и тап по правилу открывает запись из хоста (срез 1б §7.2).
function MemorySection() {
  return (
    <div className="flex flex-col items-start gap-2 p-3">
      <p className="text-sm text-text-secondary">
        Факты и правила, которые AI держит в контексте: их видно, их можно править и архивировать.
      </p>
      <Button variant="outline" onClick={() => useNav.getState().openHostScreen('memory')}>
        Открыть память AI
      </Button>
    </div>
  );
}
