import { Coffee, Sun, Moon, Apple } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';

interface MealCardProps {
  entity: {
    id: string;
    title: string;
    createdAt: Date | string;
    aspects?: unknown;
  };
}

const MEAL_ICONS: Record<string, typeof Coffee> = {
  breakfast: Coffee,
  lunch: Sun,
  dinner: Moon,
  snack: Apple,
};

export function MealCard({ entity }: MealCardProps) {
  const { openEntity } = useNavigationStore();
  const aspects = entity.aspects as Record<string, Record<string, unknown>> | undefined;
  const nut = aspects?.['orbis/nutrition'];

  if (!nut) return null;

  const mealType = String(nut.meal_type ?? 'other');
  const Icon = MEAL_ICONS[mealType] ?? Coffee;

  const calories = typeof nut.total_calories === 'number' ? nut.total_calories : 0;
  const protein = typeof nut.total_protein === 'number' ? nut.total_protein : 0;
  const carbs = typeof nut.total_carbs === 'number' ? nut.total_carbs : 0;
  const fat = typeof nut.total_fat === 'number' ? nut.total_fat : 0;

  const time = new Date(entity.createdAt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return (
    <button
      onClick={() => openEntity(entity.id)}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-surface-hover"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="h-4 w-4 text-primary" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-text">{entity.title}</span>
        <span className="text-[10px] text-text-muted">{time}</span>
      </div>

      <div className="flex shrink-0 items-center gap-2 text-[10px]">
        {calories > 0 && <span className="font-medium text-text">{calories} kcal</span>}
        {protein > 0 && <span className="text-success">P{protein}</span>}
        {carbs > 0 && <span className="text-warning">C{carbs}</span>}
        {fat > 0 && <span className="text-danger">F{fat}</span>}
      </div>
    </button>
  );
}
