/** «14:02» в поясе владельца; другой день в том же поясе — «29 сент., 14:02». Битый вход — как есть (как formatDate). */
export function formatClock(iso: string, tz?: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = (x: Date) =>
    new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'short' }).format(x);
  const clock = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  if (day(d) === day(now)) return clock;
  return `${new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'short' }).format(d)}, ${clock}`;
}
