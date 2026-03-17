export function getMonthRange(year: number, month: number): { start: Date; end: Date } {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

export function getRelativePeriodRange(
  period: 'today' | 'week' | 'month',
): { start: Date; prevStart: Date; prevEnd: Date } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (period === 'today') {
    const prevStart = new Date(todayStart);
    prevStart.setDate(prevStart.getDate() - 1);
    return { start: todayStart, prevStart, prevEnd: todayStart };
  }

  if (period === 'week') {
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() + diff);
    const prevWeekStart = new Date(weekStart);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    return { start: weekStart, prevStart: prevWeekStart, prevEnd: weekStart };
  }

  // month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { start: monthStart, prevStart: prevMonthStart, prevEnd: monthStart };
}
