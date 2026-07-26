// Экран Agenda-lite (02-core-os §4, Task D1): «Просроченное» всегда сверху с красным
// акцентом (§4.2), ниже — 8 дневных секций «сегодня → +7» (§4.1). Собственных
// push-подэкранов нет: тап по строке пушит обычный detail той же вкладки (§1.1).
//
// Строка списка — общий EntityRow (features/browser): та же «живая строка», что в
// Browser; NativeRow брать нельзя — это типографика страницы Detail (прецедент B5).
// Слева от неё в дневных секциях — колонка времени (§4.1: время start_at, диапазон
// при end_at, «весь день» для all_day-сущностей).
import { AlertTriangle } from 'lucide-react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useNav } from '../../state/navigation';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { EntityRow, formatDay } from '../browser/EntityRow';
import {
  type AgendaEntity,
  endAt,
  isAllDay,
  isFinancial,
  localTime,
  startAt,
  useAgendaDays,
  useAgendaOverdue,
} from './useAgenda';

const ROW_CLASS =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

/** Заголовок дня: «Сегодня · Сб, 13 июня» / «Вс, 14 июня» (мокап §4). */
function dayTitle(date: string, today: string): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC', // date-only разбирается как полночь UTC — форматируем там же
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T00:00:00Z`));
  // Регистр первой буквы у weekday расходится между движками ICU — нормализуем сами
  const label = parts.charAt(0).toUpperCase() + parts.slice(1);
  return date === today ? `Сегодня · ${label}` : label;
}

/** Колонка времени строки дня (§4.1): «весь день» / «09:00» / «14:00–15:30». */
function timeLabel(e: AgendaEntity, tz: string | undefined): string {
  if (isAllDay(e)) return 'весь день';
  const start = startAt(e);
  const from = start === null ? null : localTime(start, tz);
  if (from === null) return '';
  const end = endAt(e);
  const to = end === null ? null : localTime(end, tz);
  return to === null ? from : `${from}–${to}`;
}

/**
 * Подпись строки «Просроченного» (мокап §4: «срок был 11.06») — РЕЛЕВАНТНАЯ дата
 * элемента (более ранняя из due_date и локального дня start_at, §4.2). Своя подпись
 * здесь обязательна: у задачи с прошедшим start_at и будущим сроком собственная мета
 * EntityRow показала бы в красной секции дату из будущего.
 *
 * Поэтому мету EntityRow гасим — но ТОЛЬКО там, где он нарисовал бы дату, то есть у
 * строк без `orbis/financial` (`showMeta={isFinancial(entity)}`): иначе у самой частой
 * строки (срок вчера) одна и та же дата печаталась бы дважды. У financial-сущности его
 * мета — сумма (приоритет financial → task.due_date), дублирования нет вовсе, а сумма
 * просроченного платежа — ровно то, ради чего строка и читается.
 */
function overdueLabel(date: string): string {
  return `был ${formatDay(date)}`;
}

function openEntity(id: string) {
  const { activeTab, push } = useNav.getState();
  push(activeTab, { kind: 'entity', id });
}

function AgendaRow({
  entity,
  time,
  showMeta,
}: {
  entity: AgendaEntity;
  time?: string;
  showMeta?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid="agenda-row"
        data-title={entity.title}
        onClick={() => openEntity(entity.id)}
        className={ROW_CLASS}
      >
        {time !== undefined && (
          <span className="w-24 shrink-0 text-xs tabular-nums text-text-muted">{time}</span>
        )}
        <EntityRow entity={entity} showMeta={showMeta} />
      </button>
    </li>
  );
}

export function AgendaScreen() {
  const { days, timezone, isLoading, isError } = useAgendaDays();
  const overdue = useAgendaOverdue();
  const today = days[0]?.date ?? '';

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Повестка" />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {/* Ошибку «Просроченного» показываем явно: пустая секция и упавший запрос
            выглядят одинаково, а молчаливая потеря просроченного — худший исход */}
        {overdue.isError && (
          <p className="text-sm text-text-muted">Не удалось загрузить просроченное</p>
        )}
        {/* §4.2: секция всегда сверху; пустая — не занимает экран. Пока грузятся
            настройки, дата scheduled-строк считалась бы в таймзоне браузера — ждём */}
        {!overdue.isLoading && overdue.items.length > 0 && (
          <section data-testid="agenda-overdue" className="flex flex-col gap-1">
            <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-danger">
              <AlertTriangle size={14} aria-hidden />
              Просроченное
              <span data-testid="agenda-overdue-count">({overdue.countLabel})</span>
            </h2>
            <Card className="border-danger/40 p-1">
              <ul className="flex flex-col gap-px">
                {overdue.items.map((it) => (
                  <AgendaRow
                    key={it.entity.id}
                    entity={it.entity}
                    time={overdueLabel(it.date)}
                    showMeta={isFinancial(it.entity)}
                  />
                ))}
              </ul>
            </Card>
          </section>
        )}

        {isError ? (
          <p className="text-sm text-text-muted">Не удалось загрузить повестку</p>
        ) : isLoading ? (
          <>
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </>
        ) : (
          days.map((d) => (
            <section
              key={d.date}
              data-testid={`agenda-day-${d.date}`}
              className="flex flex-col gap-1"
            >
              {/* Заголовок дня — обычным регистром (мокап §4), не капсом секций Budget */}
              <h2 className="text-sm font-medium text-text-secondary">{dayTitle(d.date, today)}</h2>
              <Card className="p-1">
                {d.entities.length === 0 ? (
                  // §4.1: пустой день не скрывается — горизонт читается целиком
                  <p className="px-2.5 py-2 text-sm text-text-muted">день свободен</p>
                ) : (
                  <ul className="flex flex-col gap-px">
                    {d.entities.map((e) => (
                      <AgendaRow key={e.id} entity={e} time={timeLabel(e, timezone)} />
                    ))}
                  </ul>
                )}
              </Card>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
