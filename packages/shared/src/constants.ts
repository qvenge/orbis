// ─── Aspect IDs ───
export const ASPECT_IDS = {
  SCHEDULE: 'orbis/schedule',
  TASK: 'orbis/task',
  FINANCIAL: 'orbis/financial',
  FITNESS: 'orbis/fitness',
  NUTRITION: 'orbis/nutrition',
  HABIT: 'orbis/habit',
  NOTE: 'orbis/note',
  GOAL: 'orbis/goal',
} as const;

export type AspectId = (typeof ASPECT_IDS)[keyof typeof ASPECT_IDS];

// ─── Relation Types ───
export const RELATION_TYPES = ['parent', 'blocks', 'related_to', 'derived_from'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

// ─── Task Statuses ───
export const TASK_STATUSES = ['inbox', 'planned', 'in_progress', 'waiting', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// ─── Task Priorities ───
export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// ─── Aspect Activation States ───
export const ASPECT_STATES = ['active', 'passive', 'inactive'] as const;
export type AspectState = (typeof ASPECT_STATES)[number];

// ─── Financial Directions ───
export const FINANCIAL_DIRECTIONS = ['income', 'expense', 'budget'] as const;
export type FinancialDirection = (typeof FINANCIAL_DIRECTIONS)[number];

// ─── Meal Types ───
export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

// ─── Habit Types ───
export const HABIT_TYPES = ['binary', 'quantitative'] as const;
export type HabitType = (typeof HABIT_TYPES)[number];

// ─── Note Content Types ───
export const NOTE_CONTENT_TYPES = ['markdown', 'plain', 'checklist'] as const;
export type NoteContentType = (typeof NOTE_CONTENT_TYPES)[number];

// ─── Default Aspect Statuses (for new users) ───
export const DEFAULT_ASPECT_STATUSES: Record<string, AspectState> = {
  [ASPECT_IDS.SCHEDULE]: 'active',
  [ASPECT_IDS.TASK]: 'active',
  [ASPECT_IDS.FINANCIAL]: 'passive',
  [ASPECT_IDS.FITNESS]: 'passive',
  [ASPECT_IDS.NUTRITION]: 'passive',
  [ASPECT_IDS.HABIT]: 'passive',
  [ASPECT_IDS.NOTE]: 'passive',
  [ASPECT_IDS.GOAL]: 'passive',
};

// ─── View IDs ───
export const VIEW_IDS = {
  BUDGET: 'orbis-budget',
  FITNESS: 'orbis-fitness',
  NUTRITION: 'orbis-nutrition',
  HABITS: 'orbis-habits',
} as const;

// ─── View → Aspect Mapping ───
export const VIEW_ASPECT_MAP: Record<string, string[]> = {
  [VIEW_IDS.BUDGET]: [ASPECT_IDS.FINANCIAL],
  [VIEW_IDS.FITNESS]: [ASPECT_IDS.FITNESS],
  [VIEW_IDS.NUTRITION]: [ASPECT_IDS.NUTRITION],
  [VIEW_IDS.HABITS]: [ASPECT_IDS.HABIT],
};
