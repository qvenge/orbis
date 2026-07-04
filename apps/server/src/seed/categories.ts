// apps/server/src/seed/categories.ts
// Данные 12 стартовых категорий — ДОСЛОВНО из 02-core-os §7.1 (title/icon/spend_class/
// aliases). slug и color — деталь реализации сидирования (02 §7.1: «color назначается из
// стандартной палитры»; slug — стабильный ключ для детерминированного id §5.4).
// spend_class === null у доходных (Зарплата/Фриланс): при сидировании ключ spend_class
// в объект аспекта НЕ кладётся (§3.6: доходным не задаётся) — отсутствие, а не null.

export interface SeedCategory {
  slug: string;
  title: string;
  icon: string;
  spendClass: 'fixed' | 'discretionary' | null;
  color: string;
  aliases: readonly string[];
}

export const SEED_CATEGORIES = [
  {
    slug: 'food',
    title: 'Еда',
    icon: '🍔',
    spendClass: 'discretionary',
    color: '#e0885a',
    aliases: ['еда', 'food', 'продукты', 'groceries', 'обед', 'lunch', 'ужин', 'завтрак', 'кофе'],
  },
  {
    slug: 'transport',
    title: 'Транспорт',
    icon: '🚕',
    spendClass: 'fixed',
    color: '#5a9ee0',
    aliases: ['транспорт', 'transport', 'такси', 'метро'],
  },
  {
    slug: 'housing',
    title: 'Жильё',
    icon: '🏠',
    spendClass: 'fixed',
    color: '#8a7ce0',
    aliases: ['жильё', 'housing', 'аренда', 'коммуналка'],
  },
  {
    slug: 'health',
    title: 'Здоровье',
    icon: '💊',
    spendClass: 'fixed',
    color: '#e05a6f',
    aliases: ['здоровье', 'health', 'аптека', 'врач'],
  },
  {
    slug: 'subscriptions',
    title: 'Подписки',
    icon: '🔁',
    spendClass: 'fixed',
    color: '#5ac8e0',
    aliases: ['подписки', 'subscriptions'],
  },
  {
    slug: 'entertainment',
    title: 'Развлечения',
    icon: '🎉',
    spendClass: 'discretionary',
    color: '#e05ab8',
    aliases: ['развлечения', 'entertainment', 'бар', 'кино'],
  },
  {
    slug: 'clothing',
    title: 'Одежда',
    icon: '👕',
    spendClass: 'discretionary',
    color: '#a3e05a',
    aliases: ['одежда', 'clothing'],
  },
  {
    slug: 'education',
    title: 'Образование',
    icon: '📚',
    spendClass: 'discretionary',
    color: '#e0c35a',
    aliases: ['образование', 'education', 'курсы', 'книги'],
  },
  {
    slug: 'travel',
    title: 'Путешествия',
    icon: '✈️',
    spendClass: 'discretionary',
    color: '#5ae09e',
    aliases: ['путешествия', 'travel'],
  },
  {
    slug: 'gifts',
    title: 'Подарки',
    icon: '🎁',
    spendClass: 'discretionary',
    color: '#c95ae0',
    aliases: ['подарки', 'gifts'],
  },
  {
    slug: 'salary',
    title: 'Зарплата',
    icon: '💰',
    spendClass: null,
    color: '#6fe05a',
    aliases: ['зарплата', 'salary'],
  },
  {
    slug: 'freelance',
    title: 'Фриланс',
    icon: '💻',
    spendClass: null,
    color: '#5a6fe0',
    aliases: ['фриланс', 'freelance'],
  },
] as const satisfies readonly SeedCategory[];
