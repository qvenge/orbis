/**
 * Шаблон повторения — запись с заданным `orbis/recurrence`.
 *
 * Повестке больше не нужен: там шаблоны прячет набор `templates` контракта повторения, объявленный
 * подпиской (§Б5-6). Живёт ради экранов Финансов (`legacy-1v/budget/CategoryScreen.tsx`,
 * `TransactionsScreen.tsx`): своей подписки у Финансов ещё нет, и они фильтруют шаблоны сами (Б-2).
 * Общий код, а не Повестка (срез 1б §8.4): расширение не берёт помощников из чужого каталога.
 */
export function isRecurringTemplate(e: { props: Record<string, unknown> }): boolean {
  return e.props['orbis/recurrence'] !== undefined;
}
