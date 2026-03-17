import { db } from './client.ts';
import { aspectDefinitions } from './schema.ts';

const builtInAspects = [
  {
    id: 'orbis/schedule',
    name: 'Schedule',
    namespace: 'orbis',
    schema: {
      type: 'object',
      properties: {
        start_at: { type: 'string' },
        end_at: { type: 'string' },
        duration_min: { type: 'integer' },
        all_day: { type: 'boolean' },
        recurrence: { type: 'object' },
        location: { type: 'string' },
        timezone: { type: 'string' },
        color_override: { type: 'string' },
      },
    },
    aiInstructions:
      'Attach when user mentions a specific time, date, or scheduling. Recurrence (daily, weekly, monthly) is defined here — this is the single source of truth for "when does it repeat".',
    tagMappings: ['schedule', 'event', 'meeting', 'appointment', 'deadline'],
  },
  {
    id: 'orbis/task',
    name: 'Task',
    namespace: 'orbis',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['inbox', 'planned', 'in_progress', 'waiting', 'done', 'cancelled'],
        },
        priority: {
          type: 'string',
          enum: ['none', 'low', 'medium', 'high', 'urgent'],
        },
        due_date: { type: 'string' },
        completed_at: { type: 'string' },
        effort_min: { type: 'integer' },
        waiting_for: { type: 'string' },
        context: { type: 'string' },
      },
    },
    aiInstructions:
      'Attach when user describes an actionable item that can be completed. Note: recurrence is NOT in this aspect — it belongs in orbis/schedule.',
    tagMappings: ['task', 'todo', 'action', 'deadline', 'project', 'subtask'],
  },
  {
    id: 'orbis/financial',
    name: 'Financial',
    namespace: 'orbis',
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        currency: { type: 'string' },
        direction: { type: 'string', enum: ['income', 'expense', 'budget'] },
        category: { type: 'string' },
        recurring: { type: 'boolean' },
        payment_method: { type: 'string' },
        counterparty: { type: 'string' },
      },
    },
    aiInstructions:
      'Attach when user mentions money, prices, expenses, income, or budgets. Link transactions to budget envelopes via relations (type: parent), not via aspect fields.',
    tagMappings: ['expense', 'income', 'payment', 'budget', 'cost', 'price', 'salary'],
  },
  {
    id: 'orbis/fitness',
    name: 'Fitness',
    namespace: 'orbis',
    schema: {
      type: 'object',
      properties: {
        workout_type: { type: 'string' },
        exercises: { type: 'array' },
        program_ref: { type: 'string' },
        program_day: { type: 'string' },
        duration_actual_min: { type: 'integer' },
        total_volume_kg: { type: 'number' },
        perceived_effort: { type: 'integer' },
        body_metrics: { type: 'object' },
        notes: { type: 'string' },
      },
    },
    aiInstructions:
      'Attach when user describes a workout, exercise, or training session.',
    tagMappings: ['workout', 'fitness', 'gym', 'training', 'exercise', 'strength'],
  },
  {
    id: 'orbis/nutrition',
    name: 'Nutrition',
    namespace: 'orbis',
    schema: {
      type: 'object',
      properties: {
        meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
        items: { type: 'array' },
        total_calories: { type: 'integer' },
        total_protein: { type: 'number' },
        total_carbs: { type: 'number' },
        total_fat: { type: 'number' },
        recipe_ref: { type: 'string' },
        ai_estimated: { type: 'boolean' },
      },
    },
    aiInstructions:
      'Attach when user describes eating, meals, food, or nutrition.',
    tagMappings: ['food', 'meal', 'calories', 'protein', 'nutrition', 'breakfast', 'lunch', 'dinner', 'snack'],
  },
  {
    id: 'orbis/habit',
    name: 'Habit',
    namespace: 'orbis',
    schema: {
      type: 'object',
      properties: {
        frequency: { type: 'object' },
        habit_type: { type: 'string', enum: ['binary', 'quantitative'] },
        target_value: { type: 'number' },
        unit: { type: 'string' },
        check_ins: { type: 'array' },
        current_streak: { type: 'integer' },
        best_streak: { type: 'integer' },
        active: { type: 'boolean' },
        color: { type: 'string' },
        started_at: { type: 'string' },
      },
    },
    aiInstructions:
      'Attach when user describes a recurring behavioral pattern they want to track for consistency. Note: frequency here defines streak logic, not when to generate instances — that is orbis/schedule.recurrence.',
    tagMappings: ['habit', 'routine', 'streak', 'daily', 'weekly'],
  },
  {
    id: 'orbis/note',
    name: 'Note',
    namespace: 'orbis',
    schema: {
      type: 'object',
      properties: {
        content_type: { type: 'string', enum: ['markdown', 'plain', 'checklist'] },
        pinned: { type: 'boolean' },
      },
    },
    aiInstructions:
      'Attach when the primary purpose of the entity is textual content (notes, thoughts, journal entries).',
    tagMappings: ['note', 'thought', 'idea', 'journal', 'memo'],
  },
  {
    id: 'orbis/goal',
    name: 'Goal',
    namespace: 'orbis',
    schema: {
      type: 'object',
      properties: {
        target_value: { type: 'number' },
        current_value: { type: 'number' },
        unit: { type: 'string' },
        deadline: { type: 'string' },
        milestones: { type: 'array' },
      },
    },
    aiInstructions:
      'Attach when user sets a measurable target to achieve by a specific date.',
    tagMappings: ['goal', 'target', 'objective', 'milestone'],
  },
];

async function seed() {
  console.log('Seeding aspect definitions...');

  for (const aspect of builtInAspects) {
    await db
      .insert(aspectDefinitions)
      .values(aspect)
      .onConflictDoNothing({ target: aspectDefinitions.id });
  }

  console.log(`Seeded ${builtInAspects.length} built-in aspects.`);
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
