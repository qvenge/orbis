import { useEffect, useState } from 'react';
import { trpc } from '../../trpc';
import { planningDayOffset } from './model';

export function usePlanningDay() {
  const settings = trpc.user.getSettings.useQuery();
  const { refetch } = settings;
  const [selection, select] = useState('today');
  const today = settings.data?.today;
  const nextMidnightAt = settings.data?.nextMidnightAt;

  useEffect(() => {
    if (!nextMidnightAt) return;
    const deadline = Date.parse(nextMidnightAt);
    if (!Number.isFinite(deadline)) return;
    const refreshIfExpired = () => {
      if (Date.now() >= deadline && document.visibilityState !== 'hidden')
        void refetch({ cancelRefetch: false });
    };
    let timer: number | undefined;
    const schedule = () => {
      const delay = Math.max(0, deadline - Date.now());
      timer = window.setTimeout(
        () => {
          if (Date.now() < deadline) schedule();
          else refreshIfExpired();
        },
        Math.min(delay, 2_147_483_647),
      );
    };
    schedule();
    window.addEventListener('focus', refreshIfExpired);
    document.addEventListener('visibilitychange', refreshIfExpired);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refreshIfExpired);
      document.removeEventListener('visibilitychange', refreshIfExpired);
    };
  }, [nextMidnightAt, refetch]);

  const day =
    selection === 'today'
      ? (today ?? '')
      : selection === 'tomorrow'
        ? today
          ? planningDayOffset(today, 1)
          : ''
        : selection;
  return {
    day,
    today,
    selection,
    select,
    ready: today !== undefined,
    failed: settings.isError && today === undefined,
    retry: refetch,
  };
}
