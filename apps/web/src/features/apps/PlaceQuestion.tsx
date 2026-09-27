import { APP_OPENS_OVER, recordPlaceChoice } from '@orbis/shared';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useUpdateBatch } from '../page/useUpdateBatch';
import type { Apps } from './useApps';

/**
 * Вопрос спора мест (срез 1б §5.2 шаг 4, §5.3; РП-20): «Где открывать такие записи?» — приложения P
 * кнопками и галочка «запомнить» (по умолчанию включена). Неблокирующая плашка над записью: пока
 * владелец не ответил, запись видна в хосте.
 *
 * С галочкой выбор пишется ОДНОЙ пачкой `entity.updateBatch` (один Undo) — правки
 * `recordPlaceChoice`: «Открывать вместо» победителя, из списков проигравших он вычищен. Пустая
 * карта (тот же выбор повторно, победитель пропал) — пачки нет вовсе: пустая пачка — отказ сервера
 * и лишний Undo (carry задачи 20, Fable M-4). Без галочки — разово, ничего не пишется.
 *
 * Ответ уточняет место (`onGo`, РП-21): замена адреса, а не новый шаг — «‹» ведёт туда, откуда
 * пришли. Пачка отказала — остаёмся, тост скажет почему; второе нажатие до ответа заперто.
 */
export function PlaceQuestion({
  contenders,
  apps,
  onGo,
}: {
  contenders: readonly string[];
  apps: Apps;
  onGo: (appId: string) => void;
}) {
  const runBatch = useUpdateBatch();
  const [remember, setRemember] = useState(true);
  const [pending, setPending] = useState(false);
  const [closed, setClosed] = useState(false);
  if (closed) return null;

  async function choose(winner: string) {
    const changes = remember ? recordPlaceChoice(winner, contenders, apps.apps) : new Map();
    if (changes.size > 0) {
      setPending(true);
      const written = await runBatch(
        [...changes].map(([id, next]: [string, string[]]) => ({
          tool: 'entity_update' as const,
          input:
            next.length === 0
              ? { id, unset: [APP_OPENS_OVER] }
              : { id, props: { [APP_OPENS_OVER]: next } },
        })),
        'Место для таких записей запомнено',
        {
          action: 'Выбор места',
          failed: 'Не удалось запомнить, где открывать такие записи',
          undoFailed: 'Не удалось отменить выбор места',
        },
      );
      setPending(false);
      if (!written) return;
    }
    setClosed(true);
    onGo(winner);
  }

  return (
    <Card role="note" data-testid="place-question" className="flex flex-col gap-2 border-dashed">
      <p className="text-sm text-text-secondary">Где открывать такие записи?</p>
      <div className="flex flex-wrap gap-2">
        {contenders.map((id) => (
          <Button
            key={id}
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void choose(id)}
          >
            {apps.byId.get(id)?.title || id}
          </Button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="size-4 accent-accent"
        />
        Запомнить
      </label>
    </Card>
  );
}
