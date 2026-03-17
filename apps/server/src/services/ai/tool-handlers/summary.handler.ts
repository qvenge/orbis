import type { Database } from '../../../db/client.ts';
import type { ActionResult } from '@orbis/shared';
import type { LLMToolCall } from '../../llm/types.ts';
import {
  buildBudgetSummary,
  buildFitnessSummary,
  buildNutritionSummary,
  buildHabitsSummary,
  buildDaySummary,
  buildWeekSummary,
} from '../summary-builder.ts';

export async function handleGenerateSummary(
  args: Record<string, unknown>,
  userId: string,
  db: Database,
  toolCall: LLMToolCall,
): Promise<ActionResult> {
  const summaryType = typeof args.summaryType === 'string' ? args.summaryType : '';
  const now = new Date();
  const year = typeof args.year === 'number' ? args.year : now.getFullYear();
  const month = typeof args.month === 'number' ? args.month : now.getMonth() + 1;
  const date = typeof args.date === 'string' ? args.date : now.toISOString().slice(0, 10);

  let summaryData: Record<string, unknown>;

  if (summaryType === 'budget') {
    summaryData = { summaryType, year, month, ...(await buildBudgetSummary(db, userId, year, month)) };
  } else if (summaryType === 'fitness') {
    summaryData = { summaryType, year, month, ...(await buildFitnessSummary(db, userId, year, month)) };
  } else if (summaryType === 'nutrition') {
    summaryData = { summaryType, year, month, ...(await buildNutritionSummary(db, userId, year, month)) };
  } else if (summaryType === 'habits') {
    summaryData = { summaryType, ...(await buildHabitsSummary(db, userId)) };
  } else if (summaryType === 'day') {
    summaryData = { summaryType, ...(await buildDaySummary(db, userId, date)) };
  } else if (summaryType === 'week') {
    const d = new Date(date + 'T00:00:00');
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    const weekStart = d.toISOString().slice(0, 10);
    summaryData = { summaryType, ...(await buildWeekSummary(db, userId, weekStart)) };
  } else {
    return { type: 'error', toolCallId: toolCall.id, message: `Unknown summary type: ${summaryType}` };
  }

  return {
    type: 'summary_generated',
    toolCallId: toolCall.id,
    data: summaryData,
    message: JSON.stringify(summaryData),
  };
}
