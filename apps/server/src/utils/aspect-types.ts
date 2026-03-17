export type FinancialAspect = {
  amount?: number;
  direction?: string;
  category?: string;
};

export type FitnessAspect = {
  workout_type?: string;
  duration_min?: number;
  perceived_effort?: number;
  total_volume_kg?: number;
  exercises?: Array<{ sets: number; reps: number; weight_kg: number }>;
};

export type NutritionAspect = {
  meal_type?: string;
  total_calories?: number;
  total_protein?: number;
  total_carbs?: number;
  total_fat?: number;
  items?: Array<{ calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number }>;
};

export type CheckIn = {
  date: string;
  value?: number;
  completed: boolean;
};

export type HabitAspect = {
  active?: boolean;
  check_ins?: CheckIn[];
  current_streak?: number;
  best_streak?: number;
};
