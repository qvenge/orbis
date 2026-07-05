export type MoneyTone = 'danger' | 'positive';

// Деньги — decimal-строки. Никакого parseFloat/Number для отображения (Global Constraints).
export function formatMoney(
  amount: string,
  direction: 'expense' | 'income',
): { text: string; tone: MoneyTone } {
  const negative = direction === 'expense';
  const sign = negative ? '−' : '+'; // U+2212 minus для расхода, '+' для дохода
  const tone: MoneyTone = negative ? 'danger' : 'positive';
  const abs = amount.replace(/^[-−+]/, '');
  const [intRaw = '', fracRaw = ''] = abs.split('.');
  const grouped = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ' '); // разделитель групп — обычный пробел U+0020
  const frac = fracRaw ? `.${fracRaw}` : '';
  return { text: `${sign}${grouped}${frac}`, tone };
}

export function formatDate(iso: string, tz: string): string {
  // Guard: битый iso (Invalid Date) бросил бы RangeError в рендер-пути — возвращаем вход как есть.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
