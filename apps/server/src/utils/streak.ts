import type { CheckIn } from './aspect-types.ts';

/** Compute current consecutive streak from check-ins, starting from today. */
export function computeCurrentStreak(checkIns: CheckIn[]): number {
  let streak = 0;
  const d = new Date();

  for (let i = 0; i < 365; i++) {
    const dateStr = d.toISOString().slice(0, 10);
    if (checkIns.some((ci) => ci.date === dateStr && ci.completed)) {
      streak++;
    } else if (i > 0) {
      break;
    }
    // Day 0 (today): if not checked in, don't break — check yesterday
    d.setDate(d.getDate() - 1);
  }

  return streak;
}
