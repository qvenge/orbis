import { SUPPLY_ASPECT } from '@orbis/shared';
import { lazy, Suspense } from 'react';

const SupplyPlaque = lazy(() =>
  import('./SupplyPlaque').then((m) => ({ default: m.SupplyPlaque })),
);

/**
 * Точка лени плашки обновления поставки (срез 1б §9.1 п. 2) — эагерная и лёгкая: её рисуют экран
 * записи и страница (`RecordView`, `PageView`) на каждом открытии. Плашку, её запрос `supply.updates`
 * и кнопки получает только запись, которая НЕСЁТ аспект «поставка» сейчас: прочим записям обновлений
 * не бывает, и запрос на каждом открытии записи был бы лишним (С1б-16); запись, выведенная из
 * поставки (R-17), — уже не запись поставки. Статический импорт `SupplyPlaque` вернул бы кнопки и
 * сравнение в первый кадр записи (сторож — `scripts/check-lazy-chunks.ts`).
 */
export function SupplyPlaqueSlot({
  entity,
}: {
  entity: { id: string; aspects: readonly string[] };
}) {
  if (!entity.aspects.includes(SUPPLY_ASPECT)) return null;
  return (
    <Suspense fallback={null}>
      <SupplyPlaque entityId={entity.id} />
    </Suspense>
  );
}
