import { eq, or, isNull } from 'drizzle-orm';
import { getLLMProvider } from '../llm/index.ts';
import type { LLMMessage } from '../llm/types.ts';
import { generateTools } from './tools.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { executeToolCall } from './executor.ts';
import { getConversationHistory, appendMessage } from './context.ts';
import { buildCards } from './card-builder.ts';
import { generateSuggestions } from './suggestion-generator.ts';
import { aspectDefinitions, userSettings } from '../../db/schema.ts';
import { DEFAULT_ASPECT_STATUSES } from '@orbis/shared';
import type { AIChatResponse, ActionResult, AIChatInput } from '@orbis/shared';
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

    const assistantWithTools: LLMMessage = {
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    };
    appendMessage(userId, assistantWithTools);

    const toolResultMessage: LLMMessage = {
      role: 'user',
      content: '',
      toolResults,
    };
    appendMessage(userId, toolResultMessage);

    const followUpMessages = [...history, userMessage, assistantWithTools, toolResultMessage];
    response = await llm.chat({ messages: followUpMessages, tools, systemPrompt });
  }

  // 9. Save final assistant message
  appendMessage(userId, { role: 'assistant', content: response.content });

  // 10. Build cards and suggestions
  const cards = buildCards(allActions, settings.defaultCurrency ?? 'RUB');
  const suggestions = generateSuggestions(allActions, input.context?.activeView);

  return {
    response: response.content,
    actions: allActions,
    cards,
    suggestions,
  };
}
