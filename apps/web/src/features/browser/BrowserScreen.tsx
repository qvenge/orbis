import { useState } from 'react';
import { trpc } from '../../trpc';
import { EntityList } from './EntityList';
import { Filters } from './Filters';
import { QuickCapture } from './QuickCapture';
import { Sidebar } from './Sidebar';

export function BrowserScreen() {
  const settings = trpc.user.getSettings.useQuery();
  const [filters, setFilters] = useState('');
  return (
    <div className="grid h-full grid-cols-[minmax(0,14rem)_1fr]">
      {settings.data && <Sidebar settings={settings.data} />}
      <div className="flex h-full flex-col">
        <Filters onApply={setFilters} />
        <div className="flex-1 overflow-y-auto">
          <EntityList filters={filters} />
        </div>
        <QuickCapture context={{ kind: 'root' }} />
      </div>
    </div>
  );
}
