import type { LLMToolDefinition } from '../llm/types.ts';
import type { AspectDefinition } from '@orbis/shared';

const CORE_TOOLS: LLMToolDefinition[] = [
  {
    name: 'entity_create',
    description:
      'Create a new entity. Use tags for categorization (English, lowercase). Use meta for extracted data. Use aspects for structured data when the aspect is active.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Entity title' },
        emoji: { type: 'string', description: 'Single emoji for the entity' },
        body: { type: 'string', description: 'Markdown body content' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization (English, lowercase)',
        },
        meta: {
          type: 'object',
          description:
            'Extracted metadata. ALWAYS store here even if aspect is passive. Key names MUST match aspect field names.',
        },
        aspects: {
          type: 'object',
          description:
            'Structured aspect data. Only attach aspects that are active for this user.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'entity_update',
    description: 'Update an existing entity. Only include fields that need to change.',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'UUID of entity to update' },
        title: { type: 'string' },
        emoji: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object' },
        aspects: { type: 'object' },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'entity_search',
    description: 'Search for entities by text, tags, or aspects.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full-text search query' },
        tags: { type: 'array', items: { type: 'string' } },
        aspects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by aspect IDs (e.g. orbis/task)',
        },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'relation_create',
    description: 'Create a relation between two entities.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Source entity UUID' },
        targetId: { type: 'string', description: 'Target entity UUID' },
        relationType: {
          type: 'string',
          enum: ['parent', 'blocks', 'related_to', 'derived_from'],
        },
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
        sourceId: { type: 'string' },
        targetId: { type: 'string' },
        relationType: {
          type: 'string',
          enum: ['parent', 'blocks', 'related_to', 'derived_from'],
        },
      },
      required: ['sourceId', 'targetId', 'relationType'],
    },
  },
  {
    name: 'user_query',
    description:
      'Answer questions about user data. Search entities, compute aggregations (count, sum, avg).',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to answer' },
        filters: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { type: 'string' } },
            aspects: { type: 'array', items: { type: 'string' } },
            dateFrom: { type: 'string' },
            dateTo: { type: 'string' },
          },
        },
        aggregation: {
          type: 'string',
          enum: ['count', 'sum', 'avg', 'list'],
          description: 'Type of aggregation to compute',
        },
        aggregationField: {
          type: 'string',
          description: 'Field path for sum/avg (e.g. aspects.orbis/financial.amount)',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'generate_summary',
    description:
      'Generate a rich summary card with data for the user. Use when user asks about their budget status, fitness progress, nutrition stats, habit streaks, day overview, or week plan.',
    inputSchema: {
      type: 'object',
      properties: {
        summaryType: {
          type: 'string',
          enum: ['budget', 'fitness', 'nutrition', 'habits', 'day', 'week'],
          description: 'Type of summary to generate',
        },
        year: { type: 'number', description: 'Year (defaults to current)' },
        month: { type: 'number', description: 'Month 1-12 (defaults to current)' },
        date: { type: 'string', description: 'YYYY-MM-DD for day summary (defaults to today)' },
      },
      required: ['summaryType'],
    },
  },
  {
    name: 'create_custom_aspect',
    description:
      'Create a custom aspect/tracker for the user. Use when user wants to track something new that does not fit existing aspects (e.g. books, movies, recipes).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable name (e.g. "Reading")' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean'] },
              description: { type: 'string' },
            },
            required: ['name', 'type'],
          },
          description: 'Fields for this aspect',
        },
        aiInstructions: { type: 'string', description: 'Instructions for when to use this aspect' },
        tagMappings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags that trigger this aspect',
        },
      },
      required: ['name', 'fields'],
    },
  },
];

function generateAspectTool(aspectDef: AspectDefinition): LLMToolDefinition {
  const toolName = `attach_${aspectDef.id.replace('/', '_')}`;
  const schema = aspectDef.schema as { properties?: Record<string, unknown> };
  const properties: Record<string, unknown> = {
    entityId: { type: 'string', description: 'UUID of entity to attach aspect to' },
  };

  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      properties[key] = value;
    }
  }

  return {
    name: toolName,
    description: `Attach ${aspectDef.name} aspect to an entity. ${aspectDef.aiInstructions ?? ''}`,
    inputSchema: {
      type: 'object',
      properties,
      required: ['entityId'],
    },
  };
}

export function generateTools(
  aspectDefs: AspectDefinition[],
  aspectStatuses: Record<string, string>,
): LLMToolDefinition[] {
  const tools = [...CORE_TOOLS];

  for (const def of aspectDefs) {
    const status = aspectStatuses[def.id];
    if (status === 'active') {
      tools.push(generateAspectTool(def));
    }
  }

  return tools;
}
