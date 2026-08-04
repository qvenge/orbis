// apps/server/src/seed/smart-lists.ts
// Body восьми преднастроенных smart lists — трёх исходных и пяти горизонтов планирования
// (E4) — БАЙТ-В-БАЙТ из 02-core-os §3.3 (template-литералы с сохранением переносов строк и
// 9-пробельных отступов continuation-строк). Инвариант байт-в-байт закреплён тестом
// (onboarding.test.ts сверяет с markdown-блоками §3.3 PRD, в порядке документа).
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

// ─────────────── Горизонты планирования (E4, слайс 3, 02 §3.3/§7.2) ───────────────
// Пять списков на СУЩЕСТВУЮЩЕЙ грамматике: относительных date-токенов в ней ровно
// четыре (today, overdue, next_7d, after_7d — 01-architecture §6.1), календарных
// границ недели/месяца/года у неё нет, а абсолютные даты в сиде протухли бы через
// неделю. Поэтому там, где горизонт датами не выражается, ЭТО СКАЗАНО СЛОВАМИ в теле
// списка: «месяц» = «дальше недели», «год» держится целями, «жизнь» — вопросы ревизии.
// Заголовок при этом остаётся именем горизонта, а не обещанием точного диапазона.

export const HORIZON_DAY_BODY = `Горизонт «день»: то, у чего срок сегодня, и просроченный хвост. Более длинные горизонты — списки «Неделя», «Месяц», «Год» и «Жизнь»: они не закреплены в сайдбаре, их находит Browser по тегу smart-list.

{{query: aspect=orbis/task, due_date=today, status=!done&!cancelled&!waiting,
         excludeBlocked=true, sortBy=priority:desc, display=list, title=Срок сегодня}}

{{query: aspect=orbis/task, due_date=overdue, status=!done&!cancelled,
         sortBy=due_date:asc|priority:desc, display=list, title=Просрочено}}`;

export const HORIZON_WEEK_BODY = `Горизонт «неделя»: задачи со сроком в ближайшие 7 дней. Календарной недели грамматика не знает — относительный срок «ближайшие 7 дней» едет вместе с сегодняшним днём и границы понедельника не видит. Заблокированные остаются на виду: фокус-фильтрация — дело списка «День», а не горизонта.

{{query: aspect=orbis/task, due_date=next_7d, status=!done&!cancelled,
         sortBy=due_date:asc|priority:desc, display=list, title=Срок в ближайшие 7 дней}}`;

export const HORIZON_MONTH_BODY = `Горизонт «месяц»: всё, у чего срок дальше ближайших 7 дней. Границы месяца грамматика не знает — относительных сроков в ней четыре (сегодня, просрочено, ближайшие 7 дней, дальше 7 дней), поэтому «месяц» здесь читается как «дальше недели»: в списке видны и более далёкие сроки, вплоть до следующего года.

{{query: aspect=orbis/task, due_date=after_7d, status=!done&!cancelled,
         sortBy=due_date:asc, display=list, title=Срок дальше 7 дней}}`;

export const HORIZON_YEAR_BODY = `Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — сущностями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.

{{query: aspect=orbis/goal, sortBy=updated_at:desc, display=list, title=Цели}}`;

export const HORIZON_LIFE_BODY = `Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.

- **Ценности** — что должно остаться правдой про меня через десять лет?
- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?
- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?

Ответы держите отдельными сущностями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной сущности, блок честно покажет «ничего не найдено».

{{query: tags=life, sortBy=updated_at:desc, display=list, title=Ценности и зоны ответственности}}`;

export interface SeedSmartList {
  slug:
    | 'daily-planning'
    | 'upcoming'
    | 'all-tasks'
    | 'horizon-day'
    | 'horizon-week'
    | 'horizon-month'
    | 'horizon-year'
    | 'horizon-life';
  title: string;
  emoji: string;
  body: string;
}

/**
 * Пять горизонтов — отдельным списком: онбординг сидирует их вместе с остальными, а
 * бэкфилл (onboarding.ts, guard-ветка) досевает существующему пользователю ровно их.
 */
export const SEED_HORIZON_LISTS = [
  { slug: 'horizon-day', title: 'День', emoji: '🌅', body: HORIZON_DAY_BODY },
  { slug: 'horizon-week', title: 'Неделя', emoji: '📆', body: HORIZON_WEEK_BODY },
  { slug: 'horizon-month', title: 'Месяц', emoji: '🌙', body: HORIZON_MONTH_BODY },
  { slug: 'horizon-year', title: 'Год', emoji: '🎯', body: HORIZON_YEAR_BODY },
  { slug: 'horizon-life', title: 'Жизнь', emoji: '🧭', body: HORIZON_LIFE_BODY },
] as const satisfies readonly SeedSmartList[];

// Порядок = порядок вставки; закрепляются в сайдбаре первые три и «День» (02 §7.2,
// pinnedEntities §4.4) — остальные горизонты живут в Browser по тегу smart-list.
export const SEED_SMART_LISTS = [
  { slug: 'daily-planning', title: 'Daily Planning', emoji: '☀️', body: DAILY_PLANNING_BODY },
  { slug: 'upcoming', title: 'Upcoming', emoji: '🗓️', body: UPCOMING_BODY },
  { slug: 'all-tasks', title: 'All Tasks', emoji: '📋', body: ALL_TASKS_BODY },
  ...SEED_HORIZON_LISTS,
] as const satisfies readonly SeedSmartList[];
