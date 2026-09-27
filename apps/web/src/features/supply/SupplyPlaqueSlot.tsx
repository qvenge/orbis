import { SUPPLY_ASPECT } from '@orbis/shared';
import { lazy, Suspense } from 'react';
import { useToast } from '../../ui/toast-store';
import { settleBody } from '../entity-detail/body-gate';
import { useBodyGate } from '../entity-detail/EntityBody';

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
  // Правило досыла собирает эагерная точка (экран записи и `body-gate` уже в её чанке), а не ленивые
  // кнопки: их (`UpdateActions`) берёт и вкладка настроек, и ребро на `EntityBody`/`body-gate`
  // утянуло бы экран записи туда или разрезало бы общий чанк (+285 Б замыкания — замер раунда 1).
  const gate = useBodyGate();
  const { show } = useToast();
  const settle = () => settleBody(gate?.current ?? null, show);
  if (!entity.aspects.includes(SUPPLY_ASPECT)) return null;
  return (
    <Suspense fallback={null}>
      <SupplyPlaque entityId={entity.id} settle={settle} />
    </Suspense>
  );
}
