// apps/server/src/seed/smart-lists.ts
// Body трёх преднастроенных smart lists — БАЙТ-В-БАЙТ из 02-core-os §3.3 (template-литералы
// с сохранением переносов строк и 9-пробельных отступов continuation-строк). Инвариант
// байт-в-байт закреплён тестом (onboarding.test.ts сверяет с markdown-блоками §3.3 PRD).
// Query-блоки — строго по грамматике 01-architecture §6.1 (парсуемость проверена тестом).

export const DAILY_PLANNING_BODY = `Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».

{{query: aspect=orbis/task, status=inbox,
         sortBy=created_at:desc, display=list, title=Inbox}}

{{query: aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting,
         excludeBlocked=true, sortBy=priority:desc|due_date:asc,
         display=list, title=Сегодня}}

{{query: aspect=orbis/task, status=waiting,
         sortBy=updated_at:asc, display=compact, title=Ожидание}}`;

export const UPCOMING_BODY = `Горизонт планирования: неделя и дальше.

{{query: aspect=orbis/task, due_date=next_7d, status=!done&!cancelled,
         sortBy=due_date:asc|priority:desc, display=list, title=Ближайшие 7 дней}}

{{query: aspect=orbis/task, due_date=after_7d, status=!done&!cancelled,
         sortBy=due_date:asc, limit=30, display=compact, title=Позже}}`;

export const ALL_TASKS_BODY = `{{query: aspect=orbis/task, status=!done&!cancelled,
         sortBy=updated_at:desc, display=list, title=Все незакрытые задачи}}`;

export interface SeedSmartList {
  slug: 'daily-planning' | 'upcoming' | 'all-tasks';
  title: string;
  emoji: string;
  body: string;
}

// Порядок = порядок закрепления в сайдбаре (02 §7.2, pinnedEntities §4.4).
export const SEED_SMART_LISTS = [
  { slug: 'daily-planning', title: 'Daily Planning', emoji: '☀️', body: DAILY_PLANNING_BODY },
  { slug: 'upcoming', title: 'Upcoming', emoji: '🗓️', body: UPCOMING_BODY },
  { slug: 'all-tasks', title: 'All Tasks', emoji: '📋', body: ALL_TASKS_BODY },
] as const satisfies readonly SeedSmartList[];
