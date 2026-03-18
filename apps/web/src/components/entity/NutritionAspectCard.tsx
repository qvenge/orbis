import { useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { MEAL_TYPES } from '@orbis/shared';
import { AspectCard } from '../ui/AspectCard.tsx';

interface FoodItem {
  name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

interface NutritionAspectCardProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function parseItems(raw: unknown): FoodItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    name: String(item?.name ?? ''),
    calories: Number(item?.calories ?? 0),
    protein_g: Number(item?.protein_g ?? 0),
    carbs_g: Number(item?.carbs_g ?? 0),
    fat_g: Number(item?.fat_g ?? 0),
  }));
}

function computeTotals(items: FoodItem[]) {
  return items.reduce(
    (acc, item) => ({
      calories: acc.calories + item.calories,
      protein_g: acc.protein_g + item.protein_g,
      carbs_g: acc.carbs_g + item.carbs_g,
      fat_g: acc.fat_g + item.fat_g,
    }),
    { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );
}

export function NutritionAspectCard({ data, onChange }: NutritionAspectCardProps) {
  const items = parseItems(data.items);
  const totals = useMemo(() => computeTotals(items), [items]);

  const updateItem = (index: number, field: keyof FoodItem, value: string | number) => {
    const updated = items.map((item, i) =>
      i === index ? { ...item, [field]: field === 'name' ? value : Number(value) || 0 } : item,
    );
    const newTotals = computeTotals(updated);
    onChange({
      ...data,
      items: updated,
      total_calories: newTotals.calories,
      total_protein: newTotals.protein_g,
      total_carbs: newTotals.carbs_g,
      total_fat: newTotals.fat_g,
    });
  };

  const addItem = () => {
    const updated = [...items, { name: '', calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }];
    onChange({ ...data, items: updated });
  };

  const removeItem = (index: number) => {
    const updated = items.filter((_, i) => i !== index);
    const newTotals = computeTotals(updated);
    onChange({
      ...data,
      items: updated,
      total_calories: newTotals.calories,
      total_protein: newTotals.protein_g,
      total_carbs: newTotals.carbs_g,
      total_fat: newTotals.fat_g,
    });
  };

  return (
    <AspectCard title="Nutrition">
      <div className="grid grid-cols-2 gap-3">
        {/* Meal Type */}
        <div>
          <label className="text-xs text-text-muted">Meal type</label>
          <select
            value={(data.meal_type as string) ?? ''}
            onChange={(e) => onChange({ ...data, meal_type: e.target.value })}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
          >
            <option value="">Select...</option>
            {MEAL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </div>

        {/* AI Estimated */}
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={data.ai_estimated === true}
              onChange={(e) => onChange({ ...data, ai_estimated: e.target.checked })}
              className="rounded border-border accent-primary"
            />
            AI estimated
          </label>
        </div>
      </div>

      {/* Totals */}
      {items.length > 0 && (
        <div className="mt-3 flex gap-3 rounded-md bg-surface px-2.5 py-1.5">
          <span className="text-xs text-text-secondary">
            <span className="font-medium text-text">{totals.calories}</span> kcal
          </span>
          <span className="text-xs text-text-secondary">
            P <span className="font-medium text-text">{totals.protein_g}</span>g
          </span>
          <span className="text-xs text-text-secondary">
            C <span className="font-medium text-text">{totals.carbs_g}</span>g
          </span>
          <span className="text-xs text-text-secondary">
            F <span className="font-medium text-text">{totals.fat_g}</span>g
          </span>
        </div>
      )}

      {/* Food Items */}
      <div className="mt-3">
        <label className="text-xs text-text-muted">Items</label>
        <div className="mt-2 space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="text"
                value={item.name}
                onChange={(e) => updateItem(i, 'name', e.target.value)}
                placeholder="Food"
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
              <input
                type="number"
                value={item.calories || ''}
                onChange={(e) => updateItem(i, 'calories', e.target.value)}
                placeholder="kcal"
                title="Calories"
                className="w-14 rounded-md border border-border bg-surface px-1.5 py-1 text-center text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
              <input
                type="number"
                value={item.protein_g || ''}
                onChange={(e) => updateItem(i, 'protein_g', e.target.value)}
                placeholder="P"
                title="Protein (g)"
                className="w-10 rounded-md border border-border bg-surface px-1.5 py-1 text-center text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
              <input
                type="number"
                value={item.carbs_g || ''}
                onChange={(e) => updateItem(i, 'carbs_g', e.target.value)}
                placeholder="C"
                title="Carbs (g)"
                className="w-10 rounded-md border border-border bg-surface px-1.5 py-1 text-center text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
              <input
                type="number"
                value={item.fat_g || ''}
                onChange={(e) => updateItem(i, 'fat_g', e.target.value)}
                placeholder="F"
                title="Fat (g)"
                className="w-10 rounded-md border border-border bg-surface px-1.5 py-1 text-center text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
              <button
                onClick={() => removeItem(i)}
                className="rounded p-0.5 text-text-muted transition-colors hover:text-danger"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={addItem}
          className="mt-2 flex items-center gap-1 text-xs text-primary transition-colors hover:text-primary/80"
        >
          <Plus className="h-3 w-3" /> Add item
        </button>
      </div>
    </AspectCard>
  );
}
