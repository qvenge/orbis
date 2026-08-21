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

// Сумма без знака для нейтральных мест (spent/limit, Доход/Расход §3.1):
// та же группировка, незначащие нули дробной части опускаются ('7200.00' → '7 200').
export function formatAmount(amount: string): string {
  const abs = amount.replace(/^[-−+]/, '');
  const [intRaw = '0', fracRaw = ''] = abs.split('.');
  const grouped = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = fracRaw.replace(/0+$/, '');
  return frac ? `${grouped}.${frac}` : grouped;
}

// tz необязателен: зона приезжает из user.getSettings, и до её загрузки звать было бы
// нечем. undefined Intl понимает как «зона рантайма» — ветки на это заводить не нужно.
export function formatDate(iso: string, tz?: string): string {
  // Guard: битый iso (Invalid Date) бросил бы RangeError в рендер-пути — возвращаем вход как есть.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    // Год печатается ВСЕГДА, а не «когда он не текущий». Единственный боевой потребитель —
    // список выданных агентам доступов (ConnectedAgents): PAT бессрочен, refresh катится по
    // 30 дней, и грант живёт годами, а давность последнего вызова — главный повод отзывать.
    // Без года «10 авг., 12:00» прошлогоднего вызова читается как «в этом месяце».
    // Правило «прятать год текущего года» дало бы строку короче, но зависящую от Date.now():
    // один и тот же вход давал бы разный текст в разные дни (и в первый день января —
    // задним числом другой), а проверить это можно было бы только заморозив часы.
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/**
 * Русское множественное: 1 прогон, 2–4 прогона, 5–20 прогонов (и 11–14 — «прогонов»).
 * Возвращает СЛОВО, а не готовое «N слово»: разделитель между числом и словом у вызывающих
 * свой (строка у одного, узлы разметки у другого).
 *
 * Общей функцией, а не копией в каждом месте: правило одно на язык, а мест уже два (шаги в
 * истории прогонов, прогоны с неразобранной пачкой в состоянии рутины) — копия разъехалась бы
 * на первой же правке одного из них.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const teen = n % 100;
  if (teen >= 11 && teen <= 14) return many;
  const last = n % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
