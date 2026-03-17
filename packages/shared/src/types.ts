import { z } from 'zod';
import {
  RELATION_TYPES,
  TASK_STATUSES,
  TASK_PRIORITIES,
  ASPECT_STATES,
  FINANCIAL_DIRECTIONS,
  MEAL_TYPES,
  HABIT_TYPES,
  NOTE_CONTENT_TYPES,
} from './constants.ts';

// ─── Entity ───
export const entitySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  title: z.string().min(1),
  emoji: z.string().nullable().default(null),
  body: z.string().default(''),
  bodyRefs: z.array(z.string().uuid()).default([]),
  tags: z.array(z.string()).default([]),
  meta: z.record(z.unknown()).default({}),
  aspects: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  syncedAt: z.string().datetime().nullable(),
  archived: z.boolean().default(false),
});

export type Entity = z.infer<typeof entitySchema>;

// ─── Relation ───
export const relationTypeEnum = z.enum(RELATION_TYPES);

export const relationSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  relationType: relationTypeEnum,
  meta: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
});

export type Relation = z.infer<typeof relationSchema>;

// ─── Aspect Definition ───
export const aspectDefinitionSchema = z.object({
  id: z.string(),
  userId: z.string().uuid().nullable(),
  name: z.string(),
  namespace: z.string(),
  schema: z.record(z.unknown()),
  aiInstructions: z.string().nullable(),
  tagMappings: z.array(z.string()).default([]),
  aggregations: z.record(z.unknown()).default({}),
  viewConfig: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
});

export type AspectDefinition = z.infer<typeof aspectDefinitionSchema>;

// ─── User Settings ───
export const userSettingsSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().nullable(),
  timezone: z.string().default('Europe/Moscow'),
  defaultCurrency: z.string().default('RUB'),
  weekStartDay: z.string().default('monday'),
  aspectStatuses: z.record(z.enum(ASPECT_STATES)).default({}),
  tagColors: z.record(z.string()).default({}),
  installedViews: z.array(z.string()).default([]),
  pinnedEntities: z
    .array(z.object({ id: z.string().uuid(), order: z.number() }))
    .default([]),
  statusStripMetrics: z.array(z.unknown()).default([]),
  viewPreferences: z.record(z.unknown()).default({}),
  updatedAt: z.string().datetime(),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

// ─── Aspect Data Schemas (for validation inside entities.aspects JSONB) ───

export const scheduleAspectSchema = z.object({
  start_at: z.string(),
  end_at: z.string().optional(),
  duration_min: z.number().int().optional(),
  all_day: z.boolean().optional(),
  recurrence: z.record(z.unknown()).optional(),
  location: z.string().optional(),
  timezone: z.string().optional(),
  color_override: z.string().optional(),
});

export const taskAspectSchema = z.object({
  status: z.enum(TASK_STATUSES).default('inbox'),
  priority: z.enum(TASK_PRIORITIES).default('none'),
  due_date: z.string().optional(),
  completed_at: z.string().optional(),
  effort_min: z.number().int().optional(),
  waiting_for: z.string().optional(),
  context: z.string().optional(),
});

export const financialAspectSchema = z.object({
  amount: z.number(),
  currency: z.string().optional(),
  direction: z.enum(FINANCIAL_DIRECTIONS),
  category: z.string(),
  recurring: z.boolean().optional(),
  payment_method: z.string().optional(),
  counterparty: z.string().optional(),
});

export const fitnessAspectSchema = z.object({
  workout_type: z.string().optional(),
  exercises: z.array(z.unknown()).optional(),
  program_ref: z.string().optional(),
  program_day: z.string().optional(),
  duration_actual_min: z.number().int().optional(),
  total_volume_kg: z.number().optional(),
  perceived_effort: z.number().int().min(1).max(10).optional(),
  body_metrics: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
});

export const nutritionAspectSchema = z.object({
  meal_type: z.enum(MEAL_TYPES).optional(),
  items: z.array(z.unknown()).optional(),
  total_calories: z.number().int().optional(),
  total_protein: z.number().optional(),
  total_carbs: z.number().optional(),
  total_fat: z.number().optional(),
  recipe_ref: z.string().optional(),
  ai_estimated: z.boolean().optional(),
});

export const habitAspectSchema = z.object({
  frequency: z.record(z.unknown()).optional(),
  habit_type: z.enum(HABIT_TYPES).optional(),
  target_value: z.number().optional(),
  unit: z.string().optional(),
  check_ins: z.array(z.unknown()).optional(),
  current_streak: z.number().int().optional(),
  best_streak: z.number().int().optional(),
  active: z.boolean().optional(),
  color: z.string().optional(),
  started_at: z.string().optional(),
});

export const noteAspectSchema = z.object({
  content_type: z.enum(NOTE_CONTENT_TYPES).optional(),
  pinned: z.boolean().optional(),
});

export const goalAspectSchema = z.object({
  target_value: z.number(),
  current_value: z.number().optional(),
  unit: z.string().optional(),
  deadline: z.string().optional(),
  milestones: z.array(z.unknown()).optional(),
});

// ─── AI Response Types ───
export interface ActionResult {
  type: string;
  toolCallId?: string;
  entity?: Entity;
  entities?: Entity[];
  relation?: Relation;
  aspectId?: string;
  entityId?: string;
  data?: unknown;
  message?: string;
}

export type Card =
  | { type: 'entity'; entity: Entity }
  | { type: 'entity_list'; entities: Entity[]; title: string }
  | { type: 'budget_summary'; totalIncome: number; totalExpenses: number; balance: number; currency: string }
  | { type: 'day_summary'; date: string; tasks: number; completed: number; events: number }
  | { type: 'fitness_progress'; period: string; workouts: number; totalVolume: number; totalDuration: number; avgEffort: number }
  | { type: 'nutrition_summary'; period: string; dailyAvgCalories: number; dailyAvgProtein: number; dailyAvgCarbs: number; dailyAvgFat: number; totalMeals: number }
  | { type: 'habit_streaks'; habits: Array<{ name: string; emoji: string | null; streak: number; checkedInToday: boolean }> }
  | { type: 'week_plan'; days: Array<{ date: string; weekday: string; tasks: number; events: number }> };

// ─── Status Strip Metric ───
export interface StatusStripMetric {
  id: string;
  label: string;
  aspectId: string;
  field: string;
  aggregation: 'sum' | 'avg' | 'count' | 'latest';
  period: 'today' | 'week' | 'month';
  format?: 'number' | 'currency' | 'percent';
}

// ─── Custom View Config ───
export interface CustomViewConfig {
  id: string;
  name: string;
  aspectId: string;
  layout: 'list' | 'table' | 'chart';
  columns: string[];
  icon?: string;
  aggregations?: Array<{
    field: string;
    type: 'sum' | 'avg' | 'count' | 'min' | 'max';
    label: string;
  }>;
  chartConfig?: {
    xField: string;
    yField: string;
    type: 'bar' | 'line';
  };
}

export interface AIChatResponse {
  response: string;
  actions: ActionResult[];
  cards: Card[];
  suggestions: string[];
}
