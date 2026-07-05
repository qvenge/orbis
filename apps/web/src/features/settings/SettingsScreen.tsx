import { trpc } from '../../trpc';
import { Tabs } from '../../ui/Tabs';
import { AspectsList } from './AspectsList';
import { ExportButton } from './ExportButton';
import { GeneralForm } from './GeneralForm';
import { ViewsList } from './ViewsList';

export function SettingsScreen() {
  const settings = trpc.user.getSettings.useQuery();
  if (!settings.data)
    return (
      <div role="status" className="p-4 text-sm text-text-muted">
        Загрузка…
      </div>
    );
  return (
    <Tabs
      defaultValue="general"
      tabs={[
        { value: 'general', label: 'Общие', content: <GeneralForm settings={settings.data} /> },
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
  );
}
