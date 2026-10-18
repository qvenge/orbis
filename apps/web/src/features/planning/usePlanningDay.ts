import { useEffect, useState } from 'react';
import { todayISO } from '../../lib/dates';
import { trpc } from '../../trpc';
import { planningDayOffset } from './model';

export function usePlanningDay() {
  const settings = trpc.user.getSettings.useQuery();
  const [selection, select] = useState('today');
  const [, tick] = useState(0);
  useEffect(() => {
    const refresh = () => tick((n) => n + 1);
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  const today = todayISO(settings.data?.timezone);
  const day =
    selection === 'today'
      ? today
      : selection === 'tomorrow'
        ? planningDayOffset(today, 1)
        : selection;
  return {
    day,
    today,
    selection,
    select,
    ready: settings.isSuccess,
    failed: settings.isError,
    retry: settings.refetch,
  };
}
