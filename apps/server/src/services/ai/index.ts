import { eq, or, isNull } from 'drizzle-orm';
import { getLLMProvider } from '../llm/index.ts';
import type { LLMMessage } from '../llm/types.ts';
import { generateTools } from './tools.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { executeToolCall } from './executor.ts';
import { getConversationHistory, appendMessage } from './context.ts';
import { aspectDefinitions, userSettings } from '../../db/schema.ts';
import { DEFAULT_ASPECT_STATUSES } from '@orbis/shared';
import type { AIChatResponse, ActionResult, Card, AIChatInput } from '@orbis/shared';
import type { Database } from '../../db/client.ts';

export async function handleChat(
  input: AIChatInput,
  userId: string,
  db: Database,
): Promise<AIChatResponse> {
  const llm = getLLMProvider();

  // 1. Load user settings
  let [settings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId));

  if (!settings) {
    [settings] = await db
      .insert(userSettings)
      .values({
        userId,
        aspectStatuses: DEFAULT_ASPECT_STATUSES,
        updatedAt: new Date(),
      })
      .returning();
  }

  // 2. Load aspect definitions
  const aspectDefs = await db
    .select()
    .from(aspectDefinitions)
    .where(or(isNull(aspectDefinitions.userId), eq(aspectDefinitions.userId, userId)));

  const aspectStatuses = (settings.aspectStatuses as Record<string, string>) ?? {};

  // 3. Get conversation history
  const history = getConversationHistory(userId);

  // 4. Generate tools
  const tools = generateTools(aspectDefs as any, aspectStatuses);

  // 5. Build system prompt
  const systemPrompt = buildSystemPrompt(
    {
      timezone: settings.timezone ?? 'Europe/Moscow',
      defaultCurrency: settings.defaultCurrency ?? 'RUB',
      weekStartDay: settings.weekStartDay ?? 'monday',
    },
    aspectDefs as any,
    aspectStatuses,
    input.context
      ? { activeView: input.context.activeView }
      : undefined,
  );

  // 6. Add user message to history
  const userMessage: LLMMessage = { role: 'user', content: input.message };
  appendMessage(userId, userMessage);

  // 7. Call LLM
  const messages = [...history, userMessage];
  let response = await llm.chat({ messages, tools, systemPrompt });

  // 8. Execute tool calls if any
  const allActions: ActionResult[] = [];

  if (response.toolCalls.length > 0) {
    const toolResults: { toolCallId: string; content: string }[] = [];

    for (const toolCall of response.toolCalls) {
      const result = await executeToolCall(toolCall, userId, db);
      allActions.push(result);
      toolResults.push({
        toolCallId: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    // Save assistant message with tool calls
    const assistantWithTools: LLMMessage = {
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    };
    appendMessage(userId, assistantWithTools);

    // Send tool results back
    const toolResultMessage: LLMMessage = {
      role: 'user',
      content: '',
      toolResults,
    };
    appendMessage(userId, toolResultMessage);

    // Follow-up call for final response
    const followUpMessages = [...history, userMessage, assistantWithTools, toolResultMessage];
    response = await llm.chat({ messages: followUpMessages, tools, systemPrompt });
  }

  // 10. Save final assistant message
  appendMessage(userId, { role: 'assistant', content: response.content });

  // 11. Build cards from actions
  const cards: Card[] = [];
  for (const action of allActions) {
    if (action.type === 'entity_created' && action.entity) {
      cards.push({ type: 'entity', entity: action.entity });
    } else if (action.type === 'entity_updated' && action.entity) {
      cards.push({ type: 'entity', entity: action.entity });
    } else if (action.type === 'entity_list' && action.entities) {
      cards.push({ type: 'entity_list', entities: action.entities, title: 'Search Results' });
    } else if (action.type === 'summary_generated' && action.data) {
      const d = action.data as Record<string, unknown>;
      const sType = d.summaryType as string;
      if (sType === 'budget') {
        cards.push({
          type: 'budget_summary',
          totalIncome: d.totalIncome as number,
          totalExpenses: d.totalExpenses as number,
          balance: d.balance as number,
          currency: settings.defaultCurrency ?? 'RUB',
        } as Card);
      } else if (sType === 'fitness') {
        cards.push({
          type: 'fitness_progress',
          period: `${d.year}/${d.month}`,
          workouts: d.workouts as number,
          totalVolume: d.totalVolume as number,
          totalDuration: d.totalDuration as number,
          avgEffort: d.avgEffort as number,
        } as Card);
      } else if (sType === 'nutrition') {
        cards.push({
          type: 'nutrition_summary',
          period: `${d.year}/${d.month}`,
          dailyAvgCalories: d.dailyAvgCalories as number,
          dailyAvgProtein: d.dailyAvgProtein as number,
          dailyAvgCarbs: d.dailyAvgCarbs as number,
          dailyAvgFat: d.dailyAvgFat as number,
          totalMeals: d.totalMeals as number,
        } as Card);
      } else if (sType === 'habits') {
        cards.push({
          type: 'habit_streaks',
          habits: d.habits as Array<{ name: string; emoji: string | null; streak: number; checkedInToday: boolean }>,
        } as Card);
      } else if (sType === 'day') {
        cards.push({
          type: 'day_summary',
          date: d.date as string,
          tasks: d.tasks as number,
          completed: d.completed as number,
          events: d.events as number,
        } as Card);
      } else if (sType === 'week') {
        cards.push({
          type: 'week_plan',
          days: d.days as Array<{ date: string; weekday: string; tasks: number; events: number }>,
        } as Card);
      }
    }
  }

  // 12. Generate suggestions
  const suggestions = generateSuggestions(allActions, input.context?.activeView);

  return {
    response: response.content,
    actions: allActions,
    cards,
    suggestions,
  };
}

function generateSuggestions(actions: ActionResult[], activeView?: string): string[] {
  const suggestions: string[] = [];

  // Action-based suggestions
  for (const action of actions) {
    if (action.type === 'entity_created') {
      suggestions.push('Undo');
      const aspects = action.entity?.aspects as Record<string, unknown> | undefined;
      if (aspects?.['orbis/task']) {
        suggestions.push('Set priority');
        suggestions.push('Set due date');
      }
      if (aspects?.['orbis/financial']) {
        suggestions.push('Budget status');
      }
      if (aspects?.['orbis/fitness']) {
        suggestions.push('Fitness progress');
      }
      if (aspects?.['orbis/nutrition']) {
        suggestions.push('Nutrition this month');
      }
    }
    if (action.type === 'summary_generated') {
      suggestions.push('Show details');
    }
  }

  // View-based suggestions (when no action context)
  if (suggestions.length === 0 && activeView) {
    if (activeView === 'budget') {
      suggestions.push('Budget status', 'Recent expenses');
    } else if (activeView === 'fitness') {
      suggestions.push('Fitness progress', 'Log a workout');
    } else if (activeView === 'nutrition') {
      suggestions.push('Nutrition this month', 'Log a meal');
    } else if (activeView === 'habits') {
      suggestions.push('Show my habits', 'Check in on habits');
    } else if (activeView === 'calendar') {
      suggestions.push("What's on today?", 'Plan my week');
    }
  }

  // Time-of-day defaults
  if (suggestions.length === 0) {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 12) {
      suggestions.push('Plan my day', "What's on today?");
    } else if (hour >= 18 || hour < 6) {
      suggestions.push('How was my day?', 'Budget status');
    } else {
      suggestions.push("What's today?", 'Show my tasks');
    }
    suggestions.push('Show my habits');
  }

  return suggestions.slice(0, 4);
}
