import { useState } from 'react';
import { trpc } from '../../trpc';
import { planningDayOffset } from './model';

export function usePlanningDay() {
  const settings = trpc.user.getSettings.useQuery();
  const { refetch } = settings;
  const [selection, select] = useState('today');
  const today = settings.data?.today;
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
