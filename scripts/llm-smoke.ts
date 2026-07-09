// scripts/llm-smoke.ts
// Ручной смоук AnthropicProvider — НЕ тест и НЕ входит в CI (Global Constraints
// плана 1b: LLM-вызовы вне детерминированного CI). Один реальный вызов chat()
// с определением тула: проверяет и текстовый путь, и конвертацию tool defs.
//
// Запуск: ANTHROPIC_API_KEY=sk-... bun scripts/llm-smoke.ts
// Модель: env ORBIS_LLM_MODEL (default claude-sonnet-5 — DEFAULT_ANTHROPIC_MODEL).

import { AnthropicProvider } from '../apps/server/src/llm/anthropic';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('llm-smoke: ANTHROPIC_API_KEY не задан — смоук требует реальный ключ.');
  process.exit(1);
}

const provider = new AnthropicProvider({
  apiKey,
  model: process.env.ORBIS_LLM_MODEL || undefined,
});

const response = await provider.chat({
  system:
    'Ты — ассистент Orbis. Если вопрос касается сущностей пользователя, вызывай тул entity_query.',
  messages: [{ role: 'user', content: 'Сколько у меня незакрытых задач?' }],
  tools: [
    {
      name: 'entity_query',
      description: 'Поиск сущностей по грамматике запросов Orbis (§6).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
  // 2048, не 256: на claude-sonnet-5 adaptive thinking включён по умолчанию и
  // считается в output-бюджет — слишком узкий потолок дал бы ложный обрыв max_tokens.
  maxTokens: 2048,
});

console.log('content   :', JSON.stringify(response.content));
console.log('toolCalls :', JSON.stringify(response.toolCalls, null, 2));
console.log('stopReason:', response.stopReason);
console.log('usage     :', response.usage);
