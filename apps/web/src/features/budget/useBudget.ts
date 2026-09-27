// Хуки Budget Overview (Task B1, 03-budget §3.1): чтение агрегата месяца +
// один postDue на mount (переход due planned→fact, §2.8). Формулы считает
// ТОЛЬКО сервер — клиент отображает готовые decimal-строки.
import { useEffect, useRef } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';

/** Сдвиг месяца 'YYYY-MM' на ±1 — чистая арифметика строк, без Date-объектов. */
export function monthShift(month: string, delta: -1 | 1): string {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta; // месяцы от нулевого года
  const year = Math.floor(total / 12);
  const mon = (total % 12) + 1;
  return `${year}-${String(mon).padStart(2, '0')}`;
}

/**
 * Overview месяца (§3.1). На mount ровно один budget.postDue: due-инстансы
 * recurring переходят planned→fact до чтения агрегатов (сервер идемпотентен,
 * overview сам гоняет конвейер §2.8 — вызов здесь закрывает гонку кэша).
 * posted>0 меняет spent → alertCount перечитывается (ревью B7: иначе Overview
 * покажет тревогу, а счётчик тревог — нет). Читатель — экран Бюджета в `legacy-1v` (до 1в).
 */
export function useBudgetOverview(month: string) {
  const utils = trpc.useUtils();
  const postDue = trpc.budget.postDue.useMutation({
    onSuccess: (r) => {
      // posted>0 — это записи графа, переведённые planned→fact: помимо агрегатов
      // протухли списки и открытая сущность (прогресс цели считается на чтении).
      if (r.posted > 0) {
        void utils.budget.alertCount.invalidate();
        invalidateGraph(utils);
      }
    },
  });
  const posted = useRef(false);
  const { mutate } = postDue;
  useEffect(() => {
    if (posted.current) return;
    posted.current = true;
    mutate();
  }, [mutate]);
  return trpc.budget.overview.useQuery({ month });
}
