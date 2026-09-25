import { SlidersHorizontal } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';

/**
 * Кнопка «Настроить» — вход в редактор ЭТОГО блока. Рисуется только когда вызывающий дал
 * onConfigure: виджет монтируют и там, где править нечего (первый кадр, где редактора ещё нет),
 * и кнопка «в никуда» была бы там обманом. Иконка с aria-label, а не подпись: шапка блока — одна
 * строка с заголовком и счётчиком, и слово «Настроить» вытеснило бы из неё сам заголовок.
 */
export function ConfigureButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Настроить"
      title="Настроить"
      data-testid="qb-configure"
      onClick={onClick}
    >
      <SlidersHorizontal size={16} aria-hidden />
    </Button>
  );
}

/**
 * Плашка на месте блока (спека страниц 1а §5.5, §6.5): пустоты вместо ошибки не бывает, и
 * неуместный блок тоже не исчезает молча — текст его остаётся в документе, плашка только на
 * экране.
 *
 * Три рода: `error` — блок данных не исполнился (разбор, дата, отказ сервера; красная рамка,
 * `role="alert"`); `misplaced` — блок стоит там, где не работает (§5.5; спокойная рамка:
 * это не поломка, а подсказка, и ассертивная озвучка на каждом открытии заметки была бы шумом);
 * `unresolved` — блок стоит на своём месте, но его имя не узнано (`{{card: X}}` с аспектом,
 * которого реестр не знает или знает не один). Рамка та же спокойная — чинится правкой текста,
 * а не срочно, — но ориентир свой: «неуместным» такой блок не является.
 */
/** Ориентир плашки по роду — у каждого свой: тест «неуместного» не должен находить «неузнанный». */
const PLAQUE_TESTID = {
  error: 'qb-error',
  misplaced: 'block-misplaced',
  unresolved: 'block-unresolved',
} as const;

export function BlockPlaque({
  message,
  hint,
  position,
  tone = 'error',
  onConfigure,
}: {
  message: string;
  hint?: string;
  /** Позиция ошибки разбора в тексте запроса — у отказа канона она необязательна. */
  position?: number;
  tone?: 'error' | 'misplaced' | 'unresolved';
  onConfigure?: () => void;
}) {
  const error = tone === 'error';
  return (
    <Card
      role={error ? 'alert' : 'note'}
      data-testid={PLAQUE_TESTID[tone]}
      className={error ? 'border-danger' : 'border-dashed'}
    >
      <p className={error ? 'text-danger text-sm' : 'text-sm text-text-secondary'}>{message}</p>
      {/* «позиция undefined» хуже, чем ничего: печатается только известная. */}
      {position !== undefined && <p className="text-text-muted text-xs">позиция {position}</p>}
      {hint !== undefined && <p className="text-text-muted text-xs">{hint}</p>}
      {/* Битый блок — ровно тот случай, когда «настроить» нужнее всего: без кнопки чинить его
          пришлось бы правкой всего тела руками. */}
      {onConfigure && (
        <div className="mt-2 flex justify-end">
          <ConfigureButton onClick={onConfigure} />
        </div>
      )}
    </Card>
  );
}
