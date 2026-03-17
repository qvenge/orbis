import { UtensilsCrossed } from 'lucide-react';

interface NutritionSummaryCardProps {
  period: string;
  dailyAvgCalories: number;
  dailyAvgProtein: number;
  dailyAvgCarbs: number;
  dailyAvgFat: number;
  totalMeals: number;
}

export function NutritionSummaryCard({
  period,
  dailyAvgCalories,
  dailyAvgProtein,
  dailyAvgCarbs,
  dailyAvgFat,
  totalMeals,
}: NutritionSummaryCardProps) {
  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UtensilsCrossed className="h-4 w-4 text-primary" />
          <span className="text-xs font-medium text-text">Nutrition — {period}</span>
        </div>
        <span className="text-[10px] text-text-muted">{totalMeals} meals</span>
      </div>
      <div className="text-lg font-semibold text-text">{Math.round(dailyAvgCalories)} kcal/day</div>
      <div className="mt-1.5 flex gap-3 text-xs">
        <span className="text-success">P {Math.round(dailyAvgProtein)}g</span>
        <span className="text-warning">C {Math.round(dailyAvgCarbs)}g</span>
        <span className="text-danger">F {Math.round(dailyAvgFat)}g</span>
      </div>
    </div>
  );
}
