import { useMemo } from 'react';
import { trpc } from '../../lib/trpc.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import { CalendarHeader } from './CalendarHeader.tsx';
import { CalendarEvent } from './CalendarEvent.tsx';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

interface ScheduleAspect {
  start_at: string;
  end_at?: string;
  duration_min?: number;
  all_day?: boolean;
  location?: string;
  color_override?: string;
}

export function WeekCalendar() {
  const { calendarWeek, openEntity } = useNavigationStore();

  const weekEnd = useMemo(() => {
    const end = new Date(calendarWeek);
    end.setDate(end.getDate() + 7);
    return end;
  }, [calendarWeek]);

  const { data } = trpc.entity.list.useQuery({
    aspects: ['orbis/schedule'],
    archived: false,
    limit: 200,
    sortBy: 'updated_at',
    sortOrder: 'desc',
    dateRange: {
      from: calendarWeek.toISOString(),
      to: weekEnd.toISOString(),
      aspectField: 'orbis/schedule',
    },
  });

  // Build day columns with dates
  const dayDates = useMemo(() => {
    return DAYS.map((name, i) => {
      const date = new Date(calendarWeek);
      date.setDate(date.getDate() + i);
      return { name, date, dayNum: date.getDate() };
    });
  }, [calendarWeek]);

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Map events to day columns
  const eventsByDay = useMemo(() => {
    const byDay: Record<number, Array<{
      entityId: string;
      title: string;
      schedule: ScheduleAspect;
    }>> = {};

    for (let i = 0; i < 7; i++) byDay[i] = [];

    if (!data?.items) return byDay;

    for (const entity of data.items) {
      const aspects = entity.aspects as Record<string, unknown>;
      const schedule = aspects['orbis/schedule'] as ScheduleAspect | undefined;
      if (!schedule?.start_at) continue;

      const startDate = new Date(schedule.start_at);
      const dayIndex = Math.floor(
        (startDate.getTime() - calendarWeek.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (dayIndex >= 0 && dayIndex < 7) {
        byDay[dayIndex].push({
          entityId: entity.id,
          title: entity.title,
          schedule,
        });
      }
    }

    return byDay;
  }, [data?.items, calendarWeek]);

  // Current time indicator
  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowDayIndex = Math.floor(
    (today.getTime() - calendarWeek.getTime()) / (1000 * 60 * 60 * 24),
  );

  return (
    <div className="flex h-full flex-col">
      <CalendarHeader />

      {/* Day headers */}
      <div className="flex border-b border-border">
        {/* Time gutter */}
        <div className="w-12 shrink-0" />
        {dayDates.map((day, i) => {
          const dateStr = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
          const isToday = dateStr === todayStr;
          return (
            <div
              key={i}
              className="flex flex-1 flex-col items-center border-l border-border py-2"
            >
              <span className="text-[10px] uppercase text-text-muted">{day.name}</span>
              <span
                className={`mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                  isToday ? 'bg-primary text-white' : 'text-text'
                }`}
              >
                {day.dayNum}
              </span>
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div className="flex flex-1 overflow-y-auto">
        {/* Time labels */}
        <div className="w-12 shrink-0">
          {HOURS.map((h) => (
            <div key={h} className="relative h-12">
              <span className="absolute -top-2 right-2 text-[10px] text-text-muted">
                {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
              </span>
            </div>
          ))}
        </div>

        {/* Day columns */}
        {dayDates.map((_, dayIdx) => (
          <div key={dayIdx} className="relative flex-1 border-l border-border">
            {/* Hour lines */}
            {HOURS.map((h) => (
              <div key={h} className="h-12 border-b border-border/30" />
            ))}

            {/* Current time line */}
            {dayIdx === nowDayIndex && nowDayIndex >= 0 && nowDayIndex < 7 && (
              <div
                className="absolute left-0 right-0 z-10 border-t-2 border-danger"
                style={{ top: `${nowMinutes * (48 / 60)}px` }}
              >
                <div className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-danger" />
              </div>
            )}

            {/* Events */}
            {eventsByDay[dayIdx]?.map((event) => {
              const start = new Date(event.schedule.start_at);
              const startHour = start.getHours();
              const startMinute = start.getMinutes();

              let durationMin = event.schedule.duration_min ?? 60;
              if (event.schedule.end_at) {
                const end = new Date(event.schedule.end_at);
                durationMin = Math.round((end.getTime() - start.getTime()) / 60000);
              }

              return (
                <CalendarEvent
                  key={event.entityId}
                  title={event.title}
                  startHour={startHour}
                  startMinute={startMinute}
                  durationMin={durationMin}
                  color={event.schedule.color_override}
                  location={event.schedule.location}
                  onClick={() => openEntity(event.entityId)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
