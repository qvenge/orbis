import { ScreenHeader } from '../../app/ScreenHeader';
import { trpc } from '../../trpc';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs } from '../../ui/Tabs';
import { AspectsList } from './AspectsList';
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
              { value: 'aspects', label: 'Аспекты', content: <AspectsList /> },
              { value: 'views', label: 'Views', content: <ViewsList /> },
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
