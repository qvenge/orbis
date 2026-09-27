import { Card } from '../../ui/Card';
import { UpdateActions } from './UpdateActions';
import { supplyTitleOf, useSupplyUpdates } from './useSupply';

/**
 * Плашка обновления на записи поставки (срез 1б §9.1 п. 2): новый эталон — ПРЕДЛОЖЕНИЕ, запись
 * релиз не трогает. Пункт ищется по id записи (`recordId`), а не по ключу: запись, выведенная из
 * поставки (снят аспект, R-17), в «Обновлениях» не бывает, и чужой пункт того же ключа к ней не
 * пристанет. Обновления нет — плашки нет.
 *
 * Модуль ЛЕНИВЫЙ (точка лени — `SupplyPlaqueSlot.tsx`): плашка нужна редкой записи, а экран записи
 * открывается на каждом жесте (РП-25, вес первого кадра).
 */
export function SupplyPlaque({
  entityId,
  settle,
}: {
  entityId: string;
  /** «Принять» и «Оставить своё» ждут досыла набранного (`settleBody` затвора тела экрана). */
  settle: () => boolean;
}) {
  const { updates } = useSupplyUpdates();
  const update = updates.find((u) => u.kind === 'update' && u.recordId === entityId);
  if (update === undefined) return null;
  return (
    <Card data-testid="supply-plaque" role="status" className="flex flex-col gap-2">
      <p className="text-sm">
        В поставке новая версия записи {supplyTitleOf(update.key)}. Ваша запись не изменится, пока
        вы не примете обновление.
      </p>
      {update.edited && (
        <p className="text-xs text-text-secondary">
          Вы правили эту запись — сравните, прежде чем принять.
        </p>
      )}
      {update.declined && (
        <p className="text-xs text-text-secondary">
          Прежнюю версию поставки вы уже оставляли без изменений — эта новее.
        </p>
      )}
      <UpdateActions update={update} settle={settle} />
    </Card>
  );
}
