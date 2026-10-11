import { lazy, Suspense } from 'react';
import { Skeleton } from '../../../ui/Skeleton';
import type { DayGroupsProps } from './DayGroups';

/**
 * Точка лени ленты по дням (спека 1в §5.2, РП-18) — по образцу `browser/RecordsBlockSlot.tsx`:
 * блок данных эагерен в каждом открытии записи, а группы, подписи дней и колонка времени в поясе
 * владельца нужны редкому блоку страницы. Статический импорт схлопнул бы чанк `DayGroups` в чанк
 * записи (сторож наличия чанка — `scripts/check-lazy-chunks.ts`). Здесь — только `lazy` и скелетон;
 * тип пропсов — `import type`, в сборку не попадает.
 *
 * Отказ загрузки чанка не глотается: `lazy` бросает до ближайшей границы (`ChunkErrorBoundary`).
 */
const load = () => import('./DayGroups').then((m) => ({ default: m.DayGroups }));

let LazyDayGroups = lazy(load);

/** Забыть загруженный модуль — ТОЛЬКО для тестов (довод — `resetRecordsBlockModuleForTests`). */
export function resetDayGroupsForTests(): void {
  LazyDayGroups = lazy(load);
}

export function DayGroupsSlot(props: DayGroupsProps) {
  return (
    <Suspense
      fallback={
        // Скелетон на месте ленты, а не пустота: пока чанк едет, страница не прыгает раскладкой.
        <div data-testid="day-groups-loading" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      }
    >
      <LazyDayGroups {...props} />
    </Suspense>
  );
}
