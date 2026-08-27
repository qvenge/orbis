// scripts/probe-openai-schema.ts
// Живая проба схемы Q-AST на OpenAI (приёмка §С8-4, Р-10) — НЕ тест и НЕ часть CI: она
// ходит в сеть и стоит денег. Запуск: `bun scripts/probe-openai-schema.ts`.
//
// ЧТО ИМЕННО ПРОВЕРЯЕТСЯ, и почему без живого прогона это непроверяемо. `queryAstJsonSchema`
// (§А5-4) — рекурсивная схема с `$ref: '#/$defs/node'` и союзом `anyOf` из полутора десятков
// ветвей (точное число печатает сам скрипт — писать его сюда значило бы завести вторую правду). Ровно на таких мелочах уже спотыкался чужой валидатор: решение D29 («strict:false
// на Responses API») родилось из одной конструкции — негативного просмотра в паттерне
// суммы, — и обнаружилось это НЕ разбором схемы, а отказом провайдера на живом вызове.
// Реформа снимает ту конкретную причину (границы стали конфигом типа), но заводит новую
// форму — рекурсию через `$defs`, — и утверждать без прогона, что её примут, было бы
// повторением той же ошибки.
//
// Проверяются ТРИ вещи, и они разные:
//   1. схему ПРИНЯЛИ — вызов не отвергнут с «Invalid JSON schema»;
//   2. модель СМОГЛА ею воспользоваться — вернула tool-call с полем `ast`;
//   3. возвращённое дерево ВАЛИДНО и по zod-канону, и по самой JSON Schema (два разных
//      валидатора: расхождение между ними означало бы, что мы отдаём наружу схему, которая
//      описывает не тот язык, что принимает сервер).
//
// Тексты — три БОЕВЫХ запроса Agenda (`AGENDA_QUERY_TEXTS`, §А5-5): проба на выдуманном
// «status=done» доказывала бы только то, что провайдер принимает плоскую схему.
//
// Провайдер берётся ЯВНО openai-шный, а не фабрикой `makeLLMProvider`: приёмка называет
// OpenAI поимённо (у владельца он прод-провайдер), и прогон, случайно ушедший в Anthropic
// из-за `ORBIS_LLM_PROVIDER`, закрыл бы гейт, не проверив ничего.
import { queryAstJsonSchema, queryAstSchema } from '@orbis/shared/query';
import { AGENDA_QUERY_TEXTS } from '@orbis/shared/query/fixtures';
import Ajv from 'ajv';
import { OpenAIProvider } from '../apps/server/src/llm/openai';
import type { LLMToolDef } from '../apps/server/src/llm/types';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error(
    'probe-openai-schema: нет OPENAI_API_KEY — проба §С8-4 требует ЖИВОГО прогона, ' +
      'заглушка ничего не доказывает. Задайте ключ и повторите.',
  );
  process.exit(2);
}

/**
 * Схема входа тула. `$defs` ПОДНЯТЫ на корень, а сама схема Q-AST вложена без них.
 *
 * Это не косметика: указатель `#/$defs/node` резолвится от КОРНЯ документа, которым для
 * провайдера является схема тула, а не наша схема запроса. Оставь мы `$defs` внутри —
 * ссылка указывала бы в никуда, и отказ пришёл бы не про язык запросов, а про битый $ref.
 */
const {
  $schema: _schema,
  $defs,
  ...astSchema
} = queryAstJsonSchema as Record<string, unknown> & {
  $defs: unknown;
};

const inputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    ast: astSchema,
    title: { type: 'string', description: 'Заголовок списка, если он нужен' },
  },
  required: ['ast'],
  additionalProperties: false,
  $defs,
};

const tools: LLMToolDef[] = [
  {
    name: 'entity_query',
    description:
      'Отобрать записи владельца разобранным запросом Orbis (Q-AST). ' +
      'Поле `ast` — дерево фильтра и параметры проекции; имена свойств, аспектов и ролей — ' +
      'namespaced-ключи вида orbis/task_status.',
    inputSchema,
  },
];

const SYSTEM = [
  'Ты — ассистент Orbis. На любой запрос о записях владельца вызывай тул entity_query.',
  'Отвечай ТОЛЬКО вызовом тула, без текста.',
  'Свойства адресуются namespaced-ключами: orbis/task_status, orbis/due_date, orbis/start_at.',
  'Относительное время записывается как {"token":"today"|"overdue"|"next_7d"|"after_7d"}.',
].join(' ');

const provider = new OpenAIProvider({ apiKey });
// `allErrors: false` — намеренно: у союза из четырнадцати ветвей полный список ошибок
// разворачивается в сотню строк, среди которых настоящая причина не видна. Нужен первый
// отказ, а дерево целиком и так печатается строкой выше.
const ajv = new Ajv({ strict: false, allErrors: false });
const validate = ajv.compile(queryAstJsonSchema);

console.log('probe-openai-schema: модель', provider.modelId);
console.log('probe-openai-schema: транспорт Responses API, strict:false (D29)');
console.log(
  `probe-openai-schema: ветвей в $defs.node.anyOf — ${
    (($defs as { node?: { anyOf?: unknown[] } })?.node?.anyOf ?? []).length
  }`,
);

let accepted = false;
let ok = 0;
const texts = Object.entries(AGENDA_QUERY_TEXTS);

for (const [name, text] of texts) {
  console.log(`\n— ${name}: ${text}`);
  let response: Awaited<ReturnType<typeof provider.chat>>;
  try {
    response = await provider.chat({
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Собери запрос по этому описанию и вызови entity_query: ${text}`,
        },
      ],
      tools,
      // 2048 — как в llm-smoke: reasoning-токены gpt-5.x списываются из потолка вывода,
      // и узкий потолок дал бы ложный обрыв max_tokens вместо ответа.
      maxTokens: 2048,
    });
  } catch (e) {
    // Отказ провайдера по схеме — это ГЛАВНЫЙ отрицательный исход пробы, и он обязан быть
    // виден целиком: именно в тексте такой ошибки жила причина D29.
    console.error('  ОТКАЗ ПРОВАЙДЕРА:', e instanceof Error ? e.message : String(e));
    console.error('  → схема НЕ принята; приёмка §С8-4 не пройдена');
    process.exit(1);
  }
  accepted = true;
  const call = response.toolCalls.find((c) => c.name === 'entity_query');
  if (!call) {
    console.log(`  тул не вызван (stopReason=${response.stopReason}); текст:`, response.content);
    continue;
  }
  const ast = (call.input as { ast?: unknown }).ast;
  console.log('  ast:', JSON.stringify(ast));
  const byZod = queryAstSchema.safeParse(ast);
  const bySchema = validate(ast);
  console.log(
    `  валидность: zod-канон ${byZod.success ? 'ок' : `ОТКАЗ (${byZod.error.issues[0]?.message})`}` +
      `; JSON Schema ${bySchema ? 'ок' : `ОТКАЗ (${ajv.errorsText(validate.errors)})`}`,
  );
  if (byZod.success !== bySchema) {
    console.error(
      '  РАСХОЖДЕНИЕ ВАЛИДАТОРОВ: наружу отдана схема другого языка, чем принимает сервер',
    );
    process.exit(1);
  }
  if (byZod.success) ok++;
}

console.log(
  `\nprobe-openai-schema: схема ${accepted ? 'ПРИНЯТА' : 'НЕ принята'}; ` +
    `разбираемый AST получен на ${ok} из ${texts.length} текстов`,
);
if (!accepted || ok === 0) {
  console.error('probe-openai-schema: приёмка §С8-4 НЕ пройдена');
  process.exit(1);
}
