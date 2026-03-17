import { useState } from 'react';
import { UtensilsCrossed } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { MealCard } from './MealCard.tsx';

interface NutritionDayProps {
  year: number;
  month: number;
}

function getDateStrings(year: number, month: number): string[] {
  const dates: string[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date().toISOString().slice(0, 10);

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dateStr > today) break;
    dates.push(dateStr);
  }

  return dates.reverse();
}

const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'];

export function NutritionDay({ year, month }: NutritionDayProps) {
  const dates = getDateStrings(year, month);
  const [selectedDate, setSelectedDate] = useState(dates[0] ?? new Date().toISOString().slice(0, 10));

  const { data, isLoading } = trpc.entity.nutritionMeals.useQuery({
    year,
    month,
    date: selectedDate,
    limit: 100,
  });

  // Group meals by type
  const grouped: Record<string, Array<(typeof data extends undefined ? never : NonNullable<typeof data>)['items'][number]>> = {};
  if (data?.items) {
    for (const entity of data.items) {
      const aspects = entity.aspects as Record<string, Record<string, unknown>> | undefined;
      const mealType = String(aspects?.['orbis/nutrition']?.meal_type ?? 'other');
      if (!grouped[mealType]) grouped[mealType] = [];
      grouped[mealType].push(entity);
    }
  }

  // Compute day totals
  let dayCal = 0, dayPro = 0, dayCarb = 0, dayFat = 0;
  if (data?.items) {
    for (const entity of data.items) {
      const aspects = entity.aspects as Record<string, Record<string, unknown>> | undefined;
      const nut = aspects?.['orbis/nutrition'];
      dayCal += typeof nut?.total_calories === 'number' ? nut.total_calories : 0;
      dayPro += typeof nut?.total_protein === 'number' ? nut.total_protein : 0;
      dayCarb += typeof nut?.total_carbs === 'number' ? nut.total_carbs : 0;
      dayFat += typeof nut?.total_fat === 'number' ? nut.total_fat : 0;
    }
  }

  const selectedDay = new Date(selectedDate + 'T00:00:00');
  const dayLabel = selectedDay.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div>
      {/* Date strip */}
      <div className="border-b border-border/40 px-3 py-2">
        <div className="flex gap-1.5 overflow-x-auto">
          {dates.slice(0, 14).map((date) => {
            const d = new Date(date + 'T00:00:00');
            const day = d.getDate();
            const weekday = d.toLocaleDateString('en-US', { weekday: 'narrow' });
            return (
              <button
                key={date}
                onClick={() => setSelectedDate(date)}
                className={`flex shrink-0 flex-col items-center rounded-lg px-2 py-1 transition-colors duration-150 ${
                  selectedDate === date
                    ? 'bg-primary text-white'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="text-[9px]">{weekday}</span>
                <span className="text-xs font-medium">{day}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Day totals */}
      {data && data.items.length > 0 && (
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-2">
          <span className="text-xs font-medium text-text">{dayLabel}</span>
          <div className="flex gap-2 text-[10px]">
            <span className="font-medium text-text">{dayCal} kcal</span>
            <span className="text-success">P{dayPro}</span>
            <span className="text-warning">C{dayCarb}</span>
            <span className="text-danger">F{dayFat}</span>
          </div>
        </div>
      )}

      {/* Meals grouped by type */}
      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
          <UtensilsCrossed className="h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-muted">No meals on this day</p>
        </div>
      ) : (
        <div>
          {MEAL_ORDER.filter((type) => grouped[type]).map((type) => (
            <div key={type}>
              <p className="px-4 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                {type}
              </p>
              <div className="divide-y divide-border/40">
                {grouped[type].map((entity) => (
                  <MealCard key={entity.id} entity={entity} />
                ))}
              </div>
            </div>
          ))}
          {/* Other types not in MEAL_ORDER */}
          {Object.entries(grouped)
            .filter(([type]) => !MEAL_ORDER.includes(type))
            .map(([type, meals]) => (
              <div key={type}>
                <p className="px-4 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                  {type}
                </p>
                <div className="divide-y divide-border/40">
                  {meals.map((entity) => (
                    <MealCard key={entity.id} entity={entity} />
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
