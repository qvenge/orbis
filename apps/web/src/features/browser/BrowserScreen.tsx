import { useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useNav } from '../../state/navigation';
import { EntityList } from './EntityList';
import { Filters } from './Filters';
import { PinnedChips } from './PinnedList';
import { QuickCapture } from './QuickCapture';

// Одна колонка: pinned на десктопе живут в глобальном SidebarNav,
// на мобиле — компактная лента чипов над списком (PinnedChips, md:hidden).
//
// КНОПКИ «СОХРАНИТЬ КАК SMART LIST» ЗДЕСЬ НЕТ, и это не пропуск. Компонент `SmartListSave`
// её реализовывал (§3.8: сущность с телом-блоком и автозакрепом) и НИ РАЗУ не был подключён
// — ни к этому экрану, ни к какому другому: грепом по `apps`+`packages` находились ровно три
// упоминания, из них два — комментарии о нём самом. Задача 21b его сняла, а не подключила,
// по двум причинам. Первая: живой механизм без вызывателя — отдельный класс дефекта, и
// «оставить на будущее» означает код, который никто не проверял ни разу за три среза.
// Вторая: подключение — продуктовое решение (где стоит кнопка, откуда берётся заголовок,
// что делать с фильтром без результатов), и принимать его мимо владельца в задаче про
// грамматику запроса нельзя. Обещание §3.8 остаётся в PRD, а не в мёртвом файле; вернуть
// его — работа с формой, а не с этим экраном.
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
