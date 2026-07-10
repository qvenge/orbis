import { useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useNav } from '../../state/navigation';
import { EntityList } from './EntityList';
import { Filters } from './Filters';
import { PinnedChips } from './PinnedList';
import { QuickCapture } from './QuickCapture';

// Одна колонка: pinned на десктопе живут в глобальном SidebarNav,
// на мобиле — компактная лента чипов над списком (PinnedChips, md:hidden).
export function BrowserScreen() {
  const [filters, setFilters] = useState('');
  const push = useNav((s) => s.push);
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Обзор" />
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col md:px-6">
        <PinnedChips onOpen={(id) => push('browser', { kind: 'entity', id })} />
        <Filters onApply={setFilters} />
        <div className="flex-1 overflow-y-auto">
          <EntityList filters={filters} />
        </div>
        <QuickCapture context={{ kind: 'root' }} />
      </div>
    </div>
  );
}
