import { z } from 'zod';
import { RELATION_TYPES, ASPECT_STATES } from './constants.ts';

// ─── Entity CRUD ───

export const createEntityInput = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  emoji: z.string().optional(),
  body: z.string().default(''),
  tags: z.array(z.string()).default([]),
  meta: z.record(z.unknown()).default({}),
  aspects: z.record(z.unknown()).default({}),
});

export type CreateEntityInput = z.infer<typeof createEntityInput>;

export const updateEntityInput = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).optional(),
  emoji: z.string().nullable().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  meta: z.record(z.unknown()).optional(),
  aspects: z.record(z.unknown()).optional(),
  archived: z.boolean().optional(),
});

export type UpdateEntityInput = z.infer<typeof updateEntityInput>;

export const entityQueryInput = z.object({
  tags: z.array(z.string()).optional(),
  aspects: z.array(z.string()).optional(),
  search: z.string().optional(),
  parentId: z.string().uuid().optional(),
  archived: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  sortBy: z.enum(['created_at', 'updated_at', 'title']).default('updated_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  dateRange: z
    .object({
      from: z.string(),
      to: z.string(),
      aspectField: z.string().default('orbis/schedule'),
    })
    .optional(),
});

export type EntityQueryInput = z.infer<typeof entityQueryInput>;

// ─── Relation CRUD ───

export const createRelationInput = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  relationType: z.enum(RELATION_TYPES),
  meta: z.record(z.unknown()).default({}),
});

export type CreateRelationInput = z.infer<typeof createRelationInput>;

export const deleteRelationInput = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  relationType: z.enum(RELATION_TYPES),
});

export type DeleteRelationInput = z.infer<typeof deleteRelationInput>;

// ─── Aspect CRUD ───

export const createAspectInput = z.object({
  id: z.string().regex(/^[a-z0-9]+\/[a-z0-9-]+$/),
  name: z.string().min(1),
  schema: z.record(z.unknown()),
  aiInstructions: z.string().optional(),
  tagMappings: z.array(z.string()).default([]),
  viewConfig: z.record(z.unknown()).default({}),
});

export type CreateAspectInput = z.infer<typeof createAspectInput>;

// ─── User Settings ───

export const updateSettingsInput = z.object({
  displayName: z.string().optional(),
  timezone: z.string().optional(),
  defaultCurrency: z.string().optional(),
  weekStartDay: z.string().optional(),
  tagColors: z.record(z.string()).optional(),
  installedViews: z.array(z.string()).optional(),
  pinnedEntities: z
    .array(z.object({ id: z.string().uuid(), order: z.number() }))
    .optional(),
  statusStripMetrics: z.array(z.unknown()).optional(),
  aspectStatuses: z.record(z.enum(ASPECT_STATES)).optional(),
  viewPreferences: z.record(z.unknown()).optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;

// ─── AI Chat ───

export const aiChatInput = z.object({
  message: z.string().min(1),
  context: z
    .object({
      activeView: z.string().optional(),
      selectedEntity: z.string().uuid().optional(),
      recentEntityIds: z.array(z.string().uuid()).max(10).optional(),
    })
    .optional(),
});

export type AIChatInput = z.infer<typeof aiChatInput>;

// ─── Financial ───

export const financialSummaryInput = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
});

export type FinancialSummaryInput = z.infer<typeof financialSummaryInput>;

export const financialTransactionsInput = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  category: z.string().optional(),
  direction: z.enum(['income', 'expense']).optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export type FinancialTransactionsInput = z.infer<typeof financialTransactionsInput>;

// ─── Fitness ───

export const fitnessSummaryInput = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
});

export type FitnessSummaryInput = z.infer<typeof fitnessSummaryInput>;

export const fitnessWorkoutsInput = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  workoutType: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export type FitnessWorkoutsInput = z.infer<typeof fitnessWorkoutsInput>;

// ─── Nutrition ───

export const nutritionSummaryInput = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
});

export type NutritionSummaryInput = z.infer<typeof nutritionSummaryInput>;

export const nutritionMealsInput = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  date: z.string().optional(),
  mealType: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export type NutritionMealsInput = z.infer<typeof nutritionMealsInput>;

// ─── Habits ───

export const habitCheckInInput = z.object({
  entityId: z.string().uuid(),
  date: z.string(),
  value: z.number().optional(),
  completed: z.boolean().default(true),
});

export type HabitCheckInInput = z.infer<typeof habitCheckInInput>;

export const habitsHistoryInput = z.object({
  days: z.number().int().min(1).max(90).default(30),
});

export type HabitsHistoryInput = z.infer<typeof habitsHistoryInput>;

// ─── Sync ───

export const syncPushInput = z.object({
  deviceId: z.string(),
  lastSyncAt: z.string().datetime().nullable(),
  changes: z.object({
    entities: z.array(z.unknown()).default([]),
    relations: z.array(z.unknown()).default([]),
  }),
});

export type SyncPushInput = z.infer<typeof syncPushInput>;
