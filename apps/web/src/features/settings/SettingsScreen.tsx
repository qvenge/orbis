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
import { ViewsList } from './ViewsList';

export function SettingsScreen() {
  const settings = trpc.user.getSettings.useQuery();
  return (
    <>
      <ScreenHeader title="Настройки" />
      {settings.data ? (
        <div className="mx-auto w-full max-w-3xl">
          <Tabs
            defaultValue="general"
            tabs={[
              {
                value: 'general',
                label: 'Общие',
                content: <GeneralForm settings={settings.data} />,
              },
              { value: 'memory', label: 'Память AI', content: <MemorySection /> },
              { value: 'aspects', label: 'Аспекты', content: <AspectsList /> },
              { value: 'views', label: 'Views', content: <ViewsList /> },
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

// Раздел «Память AI» (02-core-os §2.7) — вход на отдельный экран, а не список прямо
// здесь: экрану нужен свой ScreenRef, чтобы тап по правилу пушил detail в стек
// активного таба (K10), а инлайн-контент таба настроек этого не даёт.
function MemorySection() {
  return (
    <div className="flex flex-col items-start gap-2 p-3">
      <p className="text-sm text-text-secondary">
        Факты и правила, которые AI держит в контексте: их видно, их можно править и архивировать.
      </p>
      <Button
        variant="outline"
        onClick={() => {
          const { activeTab, push } = useNav.getState();
          push(activeTab, { kind: 'memory' });
        }}
      >
        Открыть память AI
      </Button>
    </div>
  );
}
