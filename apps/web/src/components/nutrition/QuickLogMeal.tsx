import { useState } from 'react';
import { Check } from 'lucide-react';
import { MEAL_TYPES } from '@orbis/shared';
import { trpc } from '../../lib/trpc.ts';

export function QuickLogMeal() {
  const utils = trpc.useUtils();

  const [mealType, setMealType] = useState('lunch');
  const [description, setDescription] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const createEntity = trpc.entity.create.useMutation({
    onSuccess: () => {
      setDescription('');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 1200);
      utils.entity.nutritionSummary.invalidate();
      utils.entity.nutritionMeals.invalidate();
      utils.entity.list.invalidate();
    },
  });

  const handleSubmit = () => {
    const title = description.trim() || `${mealType}`;
    if (!title) return;

    createEntity.mutate({
      title,
      aspects: {
        'orbis/nutrition': {
          meal_type: mealType,
          items: [],
          total_calories: 0,
          total_protein: 0,
          total_carbs: 0,
          total_fat: 0,
          ai_estimated: true,
        },
        'orbis/schedule': {
          start_at: new Date().toISOString(),
        },
      },
      tags: [mealType, 'meal'],
    });
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface-dim px-3 py-2">
      {/* Meal type pills */}
      <div className="mb-2 flex gap-1 overflow-x-auto">
        {MEAL_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => setMealType(type)}
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] capitalize transition-colors duration-150 ${
              mealType === type
                ? 'bg-primary text-white'
                : 'bg-surface-hover text-text-secondary hover:text-text'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="What did you eat?"
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
        />

        <button
          onClick={handleSubmit}
          disabled={createEntity.isPending}
          className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-primary/80 disabled:opacity-40"
        >
          {showSuccess ? <Check className="h-3.5 w-3.5" /> : 'Log'}
        </button>
      </div>
    </div>
  );
}
