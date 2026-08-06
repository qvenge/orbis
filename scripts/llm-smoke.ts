// scripts/llm-smoke.ts
// Ручной смоук LLM-провайдера — НЕ тест и НЕ входит в CI (Global Constraints
// плана 1b: LLM-вызовы вне детерминированного CI). Один реальный вызов chat()
// с определением тула: проверяет и текстовый путь, и конвертацию tool defs.
//
// Провайдер выбирается той же фабрикой, что и в проде (llm/provider.ts), — иначе
// гейт «в прод только после живого смоука» закрывался бы не тем кодом, что поедет.
//
// Запуск: ORBIS_LLM_PROVIDER=openai    OPENAI_API_KEY=sk-...     bun scripts/llm-smoke.ts
//     или ORBIS_LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... bun scripts/llm-smoke.ts
// Модель: env ORBIS_LLM_MODEL, иначе дефолт выбранного провайдера
// (claude-sonnet-5 — DEFAULT_ANTHROPIC_MODEL, gpt-5.5 — DEFAULT_OPENAI_MODEL).

import { makeLLMProvider } from '../apps/server/src/llm/provider';

// Своей проверки ключей здесь нет намеренно: фабрика уже отвечает внятной ошибкой
// на все случаи (ключа нет, оба ключа без явного выбора, неизвестный провайдер),
// а вторая копия этих правил со временем разошлась бы с первой.
const provider = makeLLMProvider(process.env);

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
  // У gpt-5.x ровно та же арифметика: reasoning-токены тоже списываются из потолка
  // вывода, так что довод не устарел со вторым провайдером, а стал шире.
  maxTokens: 2048,
});

// Первой строкой — что именно проверено: без неё зелёный смоук не отличить
// от зелёного смоука другого провайдера или другой модели.
console.log('model     :', provider.modelId);
console.log('content   :', JSON.stringify(response.content));
console.log('toolCalls :', JSON.stringify(response.toolCalls, null, 2));
console.log('stopReason:', response.stopReason);
console.log('usage     :', response.usage);
