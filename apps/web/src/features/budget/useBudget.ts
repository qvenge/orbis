// Хуки Budget Overview (Task B1, 03-budget §3.1): чтение агрегата месяца +
// один postDue на mount (переход due planned→fact, §2.8). Формулы считает
// ТОЛЬКО сервер — клиент отображает готовые decimal-строки.
import { useEffect, useRef } from 'react';
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
 * «Сегодня» 'YYYY-MM-DD' в таймзоне пользователя (03-budget §2.3): до загрузки
 * настроек / при битой tz — таймзона браузера (не роняем рендер). Общая для
 * CategoryScreen (дата запроса конверта) и QuickAddBar (occurred_on §3.6).
 */
export function todayISO(tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      ...(tz ? { timeZone: tz } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return todayISO(); // невалидная tz из настроек
  }
}

/**
 * Гейт вкладки Budget (03-budget §1.2): вкладка видна только когда view
 * 'orbis-budget' установлен (installedViews из user.getSettings).
 */
export function useBudgetTabVisible(): boolean {
  const settings = trpc.user.getSettings.useQuery();
  return settings.data?.installedViews?.includes('orbis-budget') ?? false;
}

/** Инвалидация budget-запросов — звать после любой мутации транзакций/конвертов (B2+). */
export function invalidateBudget(utils: ReturnType<typeof trpc.useUtils>) {
  return utils.budget.invalidate();
}

/**
 * Бейдж вкладки Budget (§6.1, B7): число конвертов текущего месяца в тревоге/
 * перерасходе (spent > 85% × effectiveLimit, считает сервер). Гейт — как у самой
 * вкладки (installedViews); 0, ошибка или отсутствие view → бейджа нет (возврат 0).
 * Пересчёт приходит инвалидацией: invalidateBudget → utils.budget.invalidate()
 * покрывает и alertCount (§6.1 «count-запрос при инвалидации кэша»).
 */
export function useBudgetAlertCount(): number {
  const visible = useBudgetTabVisible();
  const q = trpc.budget.alertCount.useQuery({}, { enabled: visible });
  return visible && typeof q.data === 'number' ? q.data : 0;
}

/**
 * Overview месяца (§3.1). На mount ровно один budget.postDue: due-инстансы
 * recurring переходят planned→fact до чтения агрегатов (сервер идемпотентен,
 * overview сам гоняет конвейер §2.8 — вызов здесь закрывает гонку кэша).
 * posted>0 меняет spent → alertCount перечитывается (ревью B7: иначе Overview
 * покажет тревогу, а вечно смонтированный бейдж вкладки §6.1 — нет).
 */
export function useBudgetOverview(month: string) {
  const utils = trpc.useUtils();
  const postDue = trpc.budget.postDue.useMutation({
    onSuccess: (r) => {
      if (r.posted > 0) void utils.budget.alertCount.invalidate();
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
