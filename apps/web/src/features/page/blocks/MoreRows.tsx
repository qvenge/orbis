import { Button } from '../../../ui/Button';

/**
 * «ещё N» (спека страниц 1а §7.2): обрезанный лимитом список показывает остаток и раскрывается
 * НА МЕСТЕ — подъёмом `limit` этого блока, то есть просьбой пачкой из одного, а не переходом.
 */
export function MoreRows({
  more,
  pending,
  onMore,
}: {
  more: number;
  pending: boolean;
  onMore: () => void;
}) {
  return (
    <Button variant="ghost" size="sm" className="self-start" disabled={pending} onClick={onMore}>
      ещё {more}
    </Button>
  );
}
