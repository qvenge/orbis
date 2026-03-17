# ORBIS

AI Integration — Technical Specification

| **Field**  | **Value**                                     |
|------------|-----------------------------------------------|
| Version    | 1.0                                            |
| Date       | March 2026                                     |
| Stack      | LLM-agnostic (Claude default) + Whisper STT    |
| Parent Doc | Orbis PRD v2.2, API Design v1.0                |

---

# 1. Overview

## 1.1 AI's Role in Orbis

AI is the operating system's command layer. Chat is the primary input method — always accessible, never removable. The AI:

- Creates, updates, and queries entities from natural language
- Attaches aspects, normalizes tags, extracts meta
- Manages progressive aspect activation (passive → active)
- Generates dynamic tools from active aspect definitions
- Provides proactive insights, nudges, and alerts
- Handles voice input via STT → text → chat pipeline

## 1.2 Architecture

```
User input (text or voice)
    │
    ▼
┌────────────────────────────────────┐
│         ai.chat procedure           │
│                                    │
│  1. Conversation history           │ ← Last N messages + summary
│  2. User context                   │ ← Settings, active view, selected entity
│  3. Aspect context                 │ ← Active aspects → tools + instructions
│  4. System prompt assembly         │ ← Core + aspect + view-specific
│  5. LLM call                       │ ← Claude API (or other provider)
│  6. Tool execution                 │ ← entity.create, relation.create, etc.
│  7. Response formatting            │ ← Text + cards + suggestions
└────────────────────────────────────┘
    │
    ▼
AIChatResponse { response, actions, cards, suggestions }
```

---

# 2. LLM Provider Abstraction

## 2.1 Interface

```typescript
// apps/server/src/services/llm/provider.ts

interface LLMProvider {
  chat(request: LLMRequest): Promise<LLMResponse>;
  estimateTokens(text: string): number;
}

interface LLMRequest {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  temperature: number;
}

interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;  // JSON Schema
}
```

## 2.2 Claude Provider (Default)

```typescript
// apps/server/src/services/llm/claude.provider.ts

import Anthropic from '@anthropic-ai/sdk';

class ClaudeProvider implements LLMProvider {
  private client: Anthropic;
  private model = 'claude-sonnet-4-20250514';

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      system: request.systemPrompt,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      tools: request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    });

    return {
      content: response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join(''),
      toolCalls: response.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, input: b.input })),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason,
    };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);  // Rough estimate
  }
}
```

## 2.3 Provider Swap

```typescript
// Environment-based provider selection
function createLLMProvider(): LLMProvider {
  switch (process.env.LLM_PROVIDER) {
    case 'claude': return new ClaudeProvider();
    case 'openai': return new OpenAIProvider();    // Future
    case 'local':  return new OllamaProvider();    // Future
    default:       return new ClaudeProvider();
  }
}
```

---

# 3. Context Management

## 3.1 Conversation History

Each user has a rolling conversation history stored in-memory on the server (with persistence to DB for long-term storage).

```typescript
interface ConversationContext {
  // Recent messages (last N turns)
  messages: ChatMessage[];

  // Compressed summary of older messages
  summary: string | null;

  // Entity IDs mentioned in conversation (for quick reference resolution)
  recentEntityIds: Set<string>;
}
```

### History Window Strategy

| Turn Count | Strategy |
|------------|----------|
| 1-20 | Full message history in context |
| 21-40 | Summary of turns 1-10, full turns 11-40 |
| 41+ | Summary of turns 1-30, full turns 31-current |

Summary generation: after every 20 turns, compress the oldest 10 into a 200-token summary using a lightweight LLM call: "Summarize this conversation history for context, focusing on entity names, decisions made, and user preferences."

### Message Format

```typescript
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  metadata?: {
    actions?: ActionResult[];    // What was created/modified
    activeView?: string;         // What view user was in
    selectedEntity?: string;     // What entity was open
    timestamp: string;
  };
}
```

## 3.2 Token Budget

Total context window: ~100K tokens (Claude). Budget allocation:

| Component | Budget | Notes |
|-----------|--------|-------|
| System prompt (core) | ~800 tokens | Fixed: identity, rules, user context |
| Active aspect instructions | ~200 tokens each | 2-3 active = ~500 tokens |
| Passive aspect summaries | ~30 tokens each | 5-6 passive = ~180 tokens |
| Tool definitions | ~150 tokens each | 8-12 tools = ~1500 tokens |
| Conversation history | ~4000 tokens | Rolling window + summary |
| User message | Variable | Current input |
| Entity context | ~500 tokens | Selected entity details if relevant |
| **Total input** | **~7500 tokens typical** | Well within limits |
| Response budget | 2000 tokens | max_tokens parameter |

### Tiered Aspect Loading

Not all aspects need full tool definitions in every request:

```typescript
function loadAspectContext(
  aspects: AspectDefinition[],
  statuses: Record<string, string>,
  recentlyUsed: Set<string>       // Aspects used in last 5 turns
): { tools: ToolDefinition[], instructions: string } {

  const tools: ToolDefinition[] = [];
  const instructions: string[] = [];

  for (const aspect of aspects) {
    const status = statuses[aspect.id];

    if (status === 'inactive') continue;  // Skip entirely

    if (status === 'active' && recentlyUsed.has(aspect.id)) {
      // Tier 1: Full tool + full instructions
      tools.push(generateToolForAspect(aspect));
      instructions.push(aspect.aiInstructions ?? '');
    } else if (status === 'active') {
      // Tier 2: Full tool, one-line instruction summary
      tools.push(generateToolForAspect(aspect));
      instructions.push(`${aspect.id}: ${aspect.name}. Active.`);
    } else if (status === 'passive') {
      // Tier 3: No tool, one-line reminder to save tags+meta
      instructions.push(`${aspect.id}: recognized but passive. Save tags+meta, ask before structuring.`);
    }
  }

  return { tools, instructions: instructions.join('\n') };
}
```

## 3.3 Entity Context Injection

When the user is viewing a specific entity, its data is injected into the context:

```typescript
function buildEntityContext(entity: Entity | null): string {
  if (!entity) return '';

  return `
## Currently Viewing Entity
- Title: ${entity.title}
- Tags: ${entity.tags.join(', ')}
- Aspects: ${Object.keys(entity.aspects).join(', ')}
- Body preview: ${entity.body.slice(0, 300)}
${entity.aspects['orbis/task'] ? `- Task status: ${entity.aspects['orbis/task'].status}` : ''}
${entity.aspects['orbis/financial'] ? `- Amount: ${entity.aspects['orbis/financial'].amount} ${entity.aspects['orbis/financial'].currency}` : ''}
`.trim();
}
```

---

# 4. Tool Definitions

## 4.1 Core Tools (Always Available)

```typescript
const CORE_TOOLS: ToolDefinition[] = [
  {
    name: 'entity_create',
    description: 'Create a new entity. Always include relevant tags and meta. Attach active aspects when context matches.',
    inputSchema: {
      type: 'object',
      properties: {
        title:   { type: 'string', description: 'Entity title. Concise, clear.' },
        emoji:   { type: 'string', description: 'Single emoji for visual identification. Optional.' },
        body:    { type: 'string', description: 'Markdown body. Use [[entity:uuid|text]] for refs, {{query:...}} for dynamic lists. Optional.' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'Normalized lowercase English tags. Always include domain tags.' },
        meta:    { type: 'object', description: 'AI-extracted key-value data. Always extract structured data here even if aspect is passive.' },
        aspects: { type: 'object', description: 'Aspect data keyed by aspect ID. Only for active aspects.' },
      },
      required: ['title', 'tags'],
    },
  },
  {
    name: 'entity_update',
    description: 'Update an existing entity. Provide only fields that changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id:       { type: 'string', format: 'uuid', description: 'Entity ID to update.' },
        title:    { type: 'string' },
        emoji:    { type: 'string' },
        body:     { type: 'string' },
        tags:     { type: 'array', items: { type: 'string' } },
        meta:     { type: 'object' },
        aspects:  { type: 'object' },
        archived: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'entity_search',
    description: 'Search entities by text, tags, aspects, date. Returns matching entities.',
    inputSchema: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Full-text search on title and body.' },
        tags:     { type: 'array', items: { type: 'string' } },
        aspects:  { type: 'array', items: { type: 'string' }, description: 'Aspect IDs to filter by.' },
        dateFrom: { type: 'string', description: 'ISO date. Filter created_at >=.' },
        dateTo:   { type: 'string', description: 'ISO date. Filter created_at <=.' },
        limit:    { type: 'integer', default: 10 },
      },
    },
  },
  {
    name: 'relation_create',
    description: 'Create a relation between two entities.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId:     { type: 'string', format: 'uuid' },
        targetId:     { type: 'string', format: 'uuid' },
        relationType: { type: 'string', enum: ['parent', 'blocks', 'related_to', 'derived_from'] },
      },
      required: ['sourceId', 'targetId', 'relationType'],
    },
  },
  {
    name: 'relation_delete',
    description: 'Remove a relation between two entities.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId:     { type: 'string', format: 'uuid' },
        targetId:     { type: 'string', format: 'uuid' },
        relationType: { type: 'string', enum: ['parent', 'blocks', 'related_to', 'derived_from'] },
      },
      required: ['sourceId', 'targetId', 'relationType'],
    },
  },
  {
    name: 'user_query',
    description: 'Answer a question about the user\'s data. Computes aggregations, summaries, comparisons.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The user question, reformulated for clarity.' },
        scope:    { type: 'string', enum: ['today', 'this_week', 'this_month', 'all'], default: 'all' },
        aspects:  { type: 'array', items: { type: 'string' }, description: 'Which aspects to query.' },
      },
      required: ['question'],
    },
  },
];
```

## 4.2 Dynamic Aspect Tools

Generated from active aspect definitions. Each active aspect produces one tool.

```typescript
function generateToolForAspect(aspect: AspectDefinition): ToolDefinition {
  return {
    name: `attach_${aspect.id.replace('/', '_')}`,
    description: `Attach ${aspect.name} data to an entity. ${aspect.aiInstructions ?? ''}`,
    inputSchema: {
      type: 'object',
      properties: {
        entityId: {
          type: 'string',
          format: 'uuid',
          description: 'Target entity ID. Use with entity_create result or existing entity.',
        },
        data: aspect.schema,  // JSON Schema from aspect_definitions
      },
      required: ['entityId', 'data'],
    },
  };
}
```

### Example Generated Tools

**orbis/task active:**
```
Tool: attach_orbis_task
Description: Attach Task data to an entity. Attach when user describes an actionable item.
  Note: recurrence is NOT in this aspect — it belongs in orbis/schedule.
Input: {
  entityId: uuid,
  data: { status, priority, due_date, completed_at, effort_min, waiting_for, context }
}
```

**orbis/financial active:**
```
Tool: attach_orbis_financial
Description: Attach Financial data to an entity. Attach when user mentions money, prices, expenses.
  Link transactions to budget envelopes via relations (type: parent), not via aspect fields.
Input: {
  entityId: uuid,
  data: { amount, currency, direction, category, recurring, payment_method, counterparty }
}
```

**orbis/schedule active:**
```
Tool: attach_orbis_schedule
Description: Attach Schedule data to an entity. Attach when user mentions a specific time or date.
  Recurrence (daily, weekly, monthly) is defined here — single source of truth for "when does it repeat".
Input: {
  entityId: uuid,
  data: { start_at, end_at, duration_min, all_day, recurrence, location, timezone }
}
```

---

# 5. System Prompt

## 5.1 Core System Prompt

```
You are Orbis AI — the intelligent core of a life operating system.

## Identity
- You are the primary interface to Orbis. Users talk to you to manage their entire life.
- Be concise. Action-oriented. Don't repeat what the user said.
- When creating entities, always include tags and meta even if no aspect is active.
- Confirm actions with a brief summary, not a detailed explanation.

## Data Model
- Everything is an entity: tasks, expenses, workouts, meals, notes, habits, goals.
- Entities have: title, emoji, body (markdown), tags, meta (AI-extracted), aspects (structured).
- Relations link entities: parent, blocks, related_to, derived_from.
- Body supports: [[entity:uuid|Display Text]] for references, {{query:...}} for dynamic lists.

## Tag Normalization Rules
- Always normalize to canonical English lowercase.
- Semantic dedup: "cost"/"expense"/"spending" → always "expense".
- Consistent category names: "food"/"groceries"/"eating out" → always "food".
- User language doesn't matter — tags are always English. Content stays in user's language.

## Meta Extraction Rules
- ALWAYS extract structured data into meta, even if the matching aspect is passive.
- meta.amount for any monetary value.
- meta.start_at for any time/date reference.
- meta.category for any categorizable item.
- Key names MUST match aspect field names (meta.amount → orbis/financial.amount).
- This ensures seamless migration when the user activates the aspect.
```

## 5.2 User Context Block

Appended to system prompt per request:

```
## User Context
- Timezone: {timezone}
- Currency: {defaultCurrency}
- Week starts: {weekStartDay}
- Active view: {activeView or 'none'}
- Current date/time: {now}
```

## 5.3 Aspect Instructions Block

```
## Active Aspects (you can freely attach these)
- orbis/schedule: Attach when user mentions a specific time, date, or scheduling.
  Recurrence defined here — single source of truth.
- orbis/task: Attach when user describes an actionable item.
  Note: recurrence NOT here, belongs in orbis/schedule.
- orbis/financial: Attach when user mentions money. Link to envelopes via
  parent relation (envelope is parent of transaction), not via aspect fields.

## Passive Aspects (save tags+meta, ask before attaching)
- orbis/fitness: Recognized but not active. Save tags (workout, exercise, gym)
  and meta (workout_type, exercises). Ask: "Want me to start tracking your workouts?"
- orbis/nutrition: Recognized but not active. Save tags (food, meal, calories)
  and meta (meal_type, total_calories). Ask: "Want me to start tracking nutrition?"
- orbis/habit: Recognized but not active.
- orbis/note: Recognized but not active.
- orbis/goal: Recognized but not active.
```

## 5.4 View-Specific Instructions

When the user is in a specific view, additional context is appended:

### Budget View Active
```
## Budget View Context
User is viewing their budget. Financial entities should default to expense.
When user says an amount without direction, assume expense.
After creating a transaction, create parent relation to matching envelope. Report updated status.
Available categories from user's history: {categories}.
(Source: categories from entity query; no view-specific settings needed)
```

### Fitness View Active
```
## Fitness View Context
User is viewing fitness. Active program: {programName or 'none'}.
Today's planned workout: {workout or 'rest day'}.
When logging exercises, look up the exercise library for canonical names.
Report PRs when detected. Suggest progressive overload based on history.
(Source: activeProgram from user_settings.viewPreferences["orbis/fitness"])
```

### Nutrition View Active
```
## Nutrition View Context
User is viewing nutrition. Daily targets: {calorieTarget} kcal, {proteinTarget}g protein.
Today's intake so far: {currentCalories} kcal, {currentProtein}g protein.
When logging food, estimate macros from knowledge. Set ai_estimated: true.
If the user references a saved recipe, use recipe_ref and exact macros.
Is training day: {isTrainingDay}. If yes, boost targets by {boosts}.
(Source: targets from user_settings.viewPreferences["orbis/nutrition"];
 intake computed from today's entities with orbis/nutrition aspect)
```

### Habits View Active
```
## Habits View Context
User is viewing habits. Active habits: {habitNames}.
Unchecked today: {uncheckedHabits}.
When user says "done" or "checked", apply to the most relevant unchecked habit.
```

---

# 6. Response Pipeline

## 6.1 Single-Turn Flow

```
User: "lunch 340₽"
  │
  ├─ 1. Build context: user settings + conversation history + active view
  ├─ 2. Assemble tools: core tools + active aspect tools (orbis/financial, orbis/task, orbis/schedule)
  ├─ 3. Build system prompt: core + user context + aspect instructions
  ├─ 4. Call LLM
  │
  │  LLM returns:
  │  - tool_use: entity_create({ title: "Lunch", tags: ["expense", "food"], meta: { amount: 340, currency: "RUB" }, aspects: { "orbis/financial": { amount: 340, direction: "expense", category: "food", currency: "RUB" }, "orbis/schedule": { start_at: "2026-03-16T13:00:00" } } })
  │  - tool_use: relation_create({ source: <food_envelope_id>, target: <new_entity_id>, type: "parent" })
  │  - text: "Recorded: 340₽ on food. Budget remaining: 4,660₽ (77%)."
  │
  ├─ 5. Execute tool calls → ActionResult[]
  ├─ 6. Format response → AIChatResponse
  │
  └─ Return: { response, actions: [entity_created, relation_created], cards: [entity_card], suggestions: ["Undo", "Change category"] }
```

## 6.2 Multi-Turn Flow

```
User: "bench 3x8 80kg"
  AI: entity_create(workout entity with orbis/fitness)
  AI: "Logged: Bench Press 3×8 @ 80kg. New PR! 🎉 Previous best: 3×8 @ 77.5kg."

User: "then OHP 3x10 40kg"
  AI: entity_update(same workout entity, add OHP to exercises array)
  AI: "Added: OHP 3×10 @ 40kg. 2 exercises logged. Continue or finish workout?"

User: "done"
  AI: entity_update(mark workout complete, compute total volume)
  AI: "Workout finished. Total volume: 2,880kg. Duration: 45 min."
```

The AI maintains conversation context to know "then OHP" refers to the same workout entity from the previous turn.

## 6.3 Progressive Activation Flow

```
User: "spent 500₽ on lunch"
  │
  ├─ orbis/financial status: passive
  │
  ├─ AI creates entity:
  │    title: "Lunch"
  │    tags: ["expense", "food"]
  │    meta: { amount: 500, currency: "RUB", category: "food", direction: "expense" }
  │    aspects: {}  ← NO financial aspect (passive)
  │
  ├─ AI responds:
  │    "Recorded: lunch 500₽, tagged #expense #food."
  │    "I notice you're tracking expenses. Want me to start structured financial tracking?
  │     I'll categorize spending, track budgets, and show trends."
  │
  ├─ User: "yes"
  │
  ├─ AI calls: aspect.activate("orbis/financial")
  │    → Server: sets aspectStatuses["orbis/financial"] = "active"
  │    → Server: runs retroactive migration (find all entities with tags expense/income/payment)
  │    → Server: for each: map meta → aspects.orbis/financial
  │    → Returns: { migrated: 12 }
  │
  └─ AI: "Done! I've structured 12 past expenses. You can install the Budget view
          for envelope budgeting and spending charts. Want me to set it up?"
```

## 6.4 Tool Execution Pipeline

```typescript
// apps/server/src/services/ai.service.ts

async function executeToolCalls(
  toolCalls: ToolCall[],
  ctx: AuthContext
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const call of toolCalls) {
    try {
      switch (call.name) {
        case 'entity_create': {
          // Extract body_refs from body if present
          const bodyRefs = call.input.body
            ? extractBodyRefs(call.input.body)
            : [];
          const entity = await createEntity({
            ...call.input,
            bodyRefs,
            userId: ctx.userId,
          });
          results.push({ type: 'entity_created', entity, toolCallId: call.id });
          break;
        }

        case 'entity_update': {
          const entity = await updateEntity(call.input.id, call.input, ctx.userId);
          results.push({ type: 'entity_updated', entity, toolCallId: call.id });
          break;
        }

        case 'entity_search': {
          const entities = await searchEntities(call.input, ctx.userId);
          results.push({ type: 'entity_list', entities, toolCallId: call.id });
          break;
        }

        case 'relation_create': {
          const relation = await createRelation(call.input, ctx.userId);
          results.push({ type: 'relation_created', relation, toolCallId: call.id });
          break;
        }

        case 'relation_delete': {
          await deleteRelation(call.input, ctx.userId);
          results.push({ type: 'relation_deleted', toolCallId: call.id });
          break;
        }

        case 'user_query': {
          const answer = await computeUserQuery(call.input, ctx.userId);
          results.push({ type: 'query_result', data: answer, toolCallId: call.id });
          break;
        }

        default: {
          // Dynamic aspect tool: attach_orbis_financial, attach_orbis_fitness, etc.
          if (call.name.startsWith('attach_')) {
            const aspectId = call.name.replace('attach_', '').replace('_', '/');
            await attachAspect(call.input.entityId, aspectId, call.input.data, ctx.userId);
            results.push({ type: 'aspect_attached', aspectId, entityId: call.input.entityId, toolCallId: call.id });
          }
        }
      }
    } catch (error) {
      results.push({
        type: 'error',
        toolCallId: call.id,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}
```

---

# 7. Response Format

## 7.1 AIChatResponse

```typescript
interface AIChatResponse {
  // AI's text response to display in chat
  response: string;

  // Actions executed (entity created, updated, relation added, etc.)
  actions: ActionResult[];

  // UI cards to render inline in chat
  cards: Card[];

  // Suggested follow-up actions (chips below message)
  suggestions: string[];
}
```

## 7.2 Card Types

```typescript
type Card =
  | { type: 'entity';         entity: Entity }
  | { type: 'entity_list';    entities: Entity[]; title: string }
  | { type: 'budget_summary'; envelope: string; spent: number; limit: number; remaining: number }
  | { type: 'macro_summary';  calories: number; protein: number; carbs: number; fat: number; targets: MacroTargets }
  | { type: 'workout_log';    exercises: Exercise[]; totalVolume: number; prs: string[] }
  | { type: 'habit_checkin';  habits: { name: string; checked: boolean; streak: number }[] }
  | { type: 'progress_chart'; data: ChartData; title: string }
  | { type: 'day_summary';    tasks: number; completed: number; events: Event[]; meals: number; workout: boolean };
```

Cards are rendered by the client in the chat message stream. Each card type has a dedicated React component in `widgets/chat-overlay/AICard.tsx`.

## 7.3 Suggestion Chips

After each AI response, display 2-4 contextual follow-up actions:

```
[Created expense entity]
Suggestions: ["Undo", "Change category", "Add receipt"]

[Logged workout]
Suggestions: ["Add another exercise", "Finish workout", "See PR history"]

[Morning greeting]
Suggestions: ["What's my plan today?", "Log breakfast", "Start workout"]
```

Generated by the AI as part of the response. The client renders them as tappable chips that send the text to chat.

---

# 8. Proactive AI

## 8.1 Trigger Points

Proactive messages are initiated by the system, not by user input:

| Trigger | Action | Example |
|---------|--------|---------|
| Morning (configurable time) | Day briefing | "Good morning! 5 tasks today, 2 urgent. First event: standup at 10:00." |
| Evening (configurable time) | Day review | "You completed 4/5 tasks. 2 habits unchecked. Log dinner?" |
| Budget threshold (>80%) | Overspend alert | "Food budget at 85%. 3,200₽ remaining for 8 days (400₽/day pace)." |
| Habit missed | Nudge | "Haven't logged meditation today. Quick check-in?" |
| Task overdue | Reminder | "Design API was due yesterday. Reschedule or complete?" |
| Workout scheduled | Pre-workout | "Push Day A scheduled for today. Ready to start?" |
| PR detected | Celebration | "New bench PR: 3×8 @ 80kg! Previous: 77.5kg. +2.5kg in 2 weeks." |
| Pattern detected | Suggestion | "You've logged water 8 days in a row. Track as a habit?" |
| View suggestion | Install prompt | "You've tracked 15 expenses this week. Install Budget view for charts and envelope tracking?" |

## 8.2 Implementation

```typescript
// apps/server/src/services/proactive.service.ts

// Runs on schedule (cron) or triggered by entity changes

async function checkProactiveTriggers(userId: string): Promise<ProactiveMessage[]> {
  const messages: ProactiveMessage[] = [];
  const settings = await getUserSettings(userId);
  const now = new Date();

  // Morning briefing
  if (isMorningWindow(now, settings.timezone)) {
    const tasks = await getTasksForToday(userId);
    const events = await getEventsForToday(userId);
    const habits = await getUncheckedHabits(userId);
    messages.push({
      type: 'morning_briefing',
      data: { tasks, events, habits },
    });
  }

  // Budget alerts
  if (settings.aspectStatuses['orbis/financial'] === 'active') {
    const envelopes = await getOverspendingEnvelopes(userId, 0.8);
    for (const env of envelopes) {
      messages.push({ type: 'budget_alert', data: env });
    }
  }

  // Overdue tasks
  const overdue = await getOverdueTasks(userId);
  for (const task of overdue) {
    messages.push({ type: 'task_overdue', data: task });
  }

  return messages;
}
```

---

# 9. Voice Pipeline

## 9.1 Flow

```
User taps mic → Record audio → Send base64 to server
    → Whisper API → transcript text
    → Forward to ai.chat pipeline (same as text input)
    → Return response + transcript

Client: plays audio feedback, shows transcript, then AI response.
```

## 9.2 Implementation

```typescript
// apps/server/src/routers/ai.ts

voice: protectedProcedure
  .input(z.object({ audio: z.string() }))  // Base64 WAV/WebM
  .mutation(async ({ input, ctx }) => {
    // 1. Transcribe
    const transcript = await whisperTranscribe(input.audio);

    // 2. Forward to chat pipeline
    const chatResult = await aiChat({
      message: transcript,
      context: { /* same as text chat */ },
    }, ctx);

    return {
      ...chatResult,
      transcript,
    };
  }),
```

## 9.3 Whisper Configuration

```typescript
async function whisperTranscribe(audioBase64: string): Promise<string> {
  const buffer = Buffer.from(audioBase64, 'base64');
  const response = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file: new File([buffer], 'audio.webm', { type: 'audio/webm' }),
    language: 'ru',           // User language auto-detected or from settings
    prompt: 'Orbis, задачи, тренировка, калории, бюджет',  // Domain hints
  });
  return response.text;
}
```

## 9.4 Voice UX

- Mic button in chat input bar (hold-to-record or tap-to-toggle)
- Visual feedback: waveform animation during recording
- Transcript shown instantly after STT completes
- AI response follows (same as text flow)
- Voice-to-action latency target: < 4 seconds (STT ~1s + LLM ~3s)

---

# 10. Tag Normalization

## 10.1 Rules

AI normalizes all tags to a consistent canonical form:

```
Language normalization:
  "расход" → "expense"
  "тренировка" → "workout"
  "еда" → "food"

Semantic dedup:
  "cost" / "expense" / "spending" / "purchase" → "expense"
  "workout" / "training" / "gym session" → "workout"
  "food" / "meal" / "eating" / "dining" → "food"
  "todo" / "task" / "action item" → "task"

Case normalization:
  "Work" / "WORK" / "work" → "work"

Compound tag splitting:
  "work meeting" → "work", "meeting"
  "grocery shopping" → "food", "shopping"
```

## 10.2 System Prompt Instruction

```
## Tag Normalization
- All tags MUST be lowercase English.
- Use canonical forms: expense (not cost/spending), workout (not training/gym), food (not meal/eating).
- Split compound concepts into separate tags: "work meeting" → ["work", "meeting"].
- Category tags (food, transport, housing, subscriptions) must be consistent across all entities.
- If user provides Russian input, translate tags to English. Content stays in user's language.
```

## 10.3 Category Consistency

Financial categories are particularly important for budget grouping:

```
food        — groceries, restaurants, coffee, snacks
transport   — taxi, fuel, public transit, car maintenance
housing     — rent, utilities, repairs, furniture
health      — medicine, gym membership, doctors
subscriptions — Netflix, Spotify, SaaS, insurance
entertainment — movies, games, bars, events
clothing    — clothes, shoes, accessories
education   — courses, books, workshops
salary      — main job income
freelance   — side job income
```

AI enforces these categories across all financial entities. If user says "обед в кафе" → category: "food" (not "restaurant" or "dining").

---

# 11. Error Handling

## 11.1 LLM Errors

| Error | Response |
|-------|----------|
| Rate limit (429) | Retry with exponential backoff (1s, 2s, 4s). Show: "Thinking..." |
| Context too long | Truncate conversation history, retry. Summarize aggressively. |
| Malformed tool call | Log error, respond with text-only (no actions). |
| Tool execution failed | Report to user: "I tried to create the entity but hit an error. Please try again." |
| Provider down | Show: "AI is temporarily unavailable. You can still use all features manually." |
| Timeout (>10s) | Cancel, show: "That took too long. Want me to try again?" |

## 11.2 Graceful Degradation

When AI is unavailable, the entire app still works:
- Entity Browser, Calendar, all Views function normally
- Manual entity creation, editing, aspect attachment available
- Only Chat and voice input are affected
- Proactive messages queued and delivered when AI recovers

---

# 12. Cost Management

## 12.1 Token Tracking

```typescript
// Track per-user daily token usage
interface TokenUsage {
  userId: string;
  date: string;        // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}
```

## 12.2 Cost Optimization Strategies

| Strategy | Impact | Implementation |
|----------|--------|----------------|
| Tiered aspect loading | -30% input tokens | Load full context only for recently-used aspects |
| Conversation summary | -40% history tokens | Compress old messages into summaries |
| Response caching | -20% for repeat queries | Cache aggregation queries (budget remaining, daily macros) for 5 min |
| Smaller model for simple tasks | -60% cost per request | Use Haiku for tag normalization, entity search. Sonnet for creation/complex queries. |
| Batched proactive checks | -50% proactive cost | Combine morning briefing + habit check + budget alert into single LLM call |

## 12.3 Rate Limits

| Operation | Limit | Rationale |
|-----------|-------|-----------|
| ai.chat | 30/min | Standard chat usage |
| ai.voice | 10/min | Whisper API cost |
| Proactive messages | 5/hour | Don't overwhelm user |

---

# 13. Future

- **Multi-model routing**: simple queries → Haiku, complex → Sonnet, analysis → Opus
- **Streaming responses**: token-by-token display for faster perceived response
- **Image input**: photo of receipt → extract items + amounts (vision API)
- **Embeddings**: semantic search across entities using vector embeddings
- **Fine-tuning**: custom model trained on user's data patterns (long-term)
- **Agent mode**: multi-step planning ("Plan my week" → AI creates multiple entities, sets dependencies, schedules)
- **Offline AI**: small local model for basic entity creation when offline
