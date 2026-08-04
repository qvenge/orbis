// apps/server/src/seed/smart-lists.ts
// Body пяти преднастроенных smart lists — трёх исходных и двух верхних горизонтов
// планирования (E4) — БАЙТ-В-БАЙТ из 02-core-os §3.3 (template-литералы с сохранением
// переносов строк и 9-пробельных отступов continuation-строк). Инвариант байт-в-байт
// закреплён тестом (onboarding.test.ts сверяет с markdown-блоками §3.3 PRD, по порядку).
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
// Лестница горизонтов «день → неделя → месяц → год → жизнь» доставляется тем, чего в ней
// НЕ ХВАТАЕТ (решение владельца Р29), а не пятью новыми списками рядом с существующими:
// день закрывает Daily Planning, неделю и месяц — Upcoming (его тело так и озаглавлено:
// «Горизонт планирования: неделя и дальше»). Сидируются только два недостающих верхних
// горизонта — «Год» и «Жизнь». Отдельные списки «День»/«Неделя»/«Месяц» отличались бы от
// существующих одним лишь параметром `title=` (у «Недели» — дословно им; `display=` виджет
// не читает вовсе, 02 §3.4), то есть добавляли бы сущности с нулевой информационной
// дельтой. Само отображение лестницы на списки — не подразумевается, а сказано словами в
// теле «Года» и в §3.3 PRD: без этого её пришлось бы угадывать.
//
// Оба горизонта — на СУЩЕСТВУЮЩЕЙ грамматике. Относительных date-токенов в ней ровно
// четыре (today, overdue, next_7d, after_7d — 01-architecture §6.1), годового и «жизненного»
// масштаба она не выражает вовсе, а абсолютные даты в сиде протухли бы через неделю.
// Поэтому «Год» держится целями, «Жизнь» — вопросами ревизии и тегом, и в обоих телах
// это сказано прямо: заголовок называет горизонт, а тело — что именно показано.

export const HORIZON_YEAR_BODY = `Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — сущностями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.

Лестница горизонтов целиком: день — список «Daily Planning», неделя и месяц — список «Upcoming», год — этот список, жизнь — список «Жизнь». «Жизнь» не закреплена в сайдбаре: её находит Browser по тегу smart-list.

{{query: aspect=orbis/goal, sortBy=updated_at:desc, display=list, title=Цели}}`;

export const HORIZON_LIFE_BODY = `Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.

- **Ценности** — что должно остаться правдой про меня через десять лет?
- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?
- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?

Ответы держите отдельными сущностями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной сущности, блок честно покажет «ничего не найдено».

{{query: tags=life, sortBy=updated_at:desc, display=list, title=Ценности и зоны ответственности}}`;

export interface SeedSmartList {
  slug: 'daily-planning' | 'upcoming' | 'all-tasks' | 'horizon-year' | 'horizon-life';
  title: string;
  emoji: string;
  body: string;
}

/**
 * Два верхних горизонта — отдельным списком: онбординг сидирует их вместе с остальными, а
 * бэкфилл (onboarding.ts, guard-ветка) досевает существующему пользователю ровно их.
 */
export const SEED_HORIZON_LISTS = [
  { slug: 'horizon-year', title: 'Год', emoji: '🎯', body: HORIZON_YEAR_BODY },
  { slug: 'horizon-life', title: 'Жизнь', emoji: '🧭', body: HORIZON_LIFE_BODY },
] as const satisfies readonly SeedSmartList[];

// Порядок = порядок вставки; закрепляются в сайдбаре первые три и «Год» (02 §7.2,
// pinnedEntities §4.4) — «Жизнь» живёт в Browser по тегу smart-list.
export const SEED_SMART_LISTS = [
  { slug: 'daily-planning', title: 'Daily Planning', emoji: '☀️', body: DAILY_PLANNING_BODY },
  { slug: 'upcoming', title: 'Upcoming', emoji: '🗓️', body: UPCOMING_BODY },
  { slug: 'all-tasks', title: 'All Tasks', emoji: '📋', body: ALL_TASKS_BODY },
  ...SEED_HORIZON_LISTS,
] as const satisfies readonly SeedSmartList[];
