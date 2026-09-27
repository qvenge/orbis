/**
 * «Сегодня» 'YYYY-MM-DD' в таймзоне пользователя (03-budget §2.3): до загрузки настроек и при битой
 * tz — таймзона браузера (не роняем рендер).
 *
 * Общий помощник (срез 1б §8.4, границы кода): его берут и ядро (Повестка), и Финансы (быстрая
 * запись, «план → факт»), поэтому он живёт не в каталоге расширения — ядро не импортирует каталоги
 * расширений.
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
