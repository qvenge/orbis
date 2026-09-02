// scripts/llm-smoke.ts
// Ручной смоук LLM-провайдера — НЕ тест и НЕ входит в CI (Global Constraints
// плана 1b: LLM-вызовы вне детерминированного CI). Один реальный вызов chat()
// с НАСТОЯЩИМ набором тулов реестра: проверяет и текстовый путь, и конвертацию
// tool defs, и — главное — что провайдер вообще ПРИНЯЛ наши схемы.
//
// Провайдер выбирается той же фабрикой, что и в проде (llm/provider.ts), — иначе
// гейт «в прод только после живого смоука» закрывался бы не тем кодом, что поедет.
//
// БАЗА НУЖНА. Прежняя шапка обещала «запускается где угодно и без DATABASE_URL» — обещание
// держалось на том, что набор тулов собирался из литералов старой формы
// (`BUILTIN_ASPECT_META` + `legacyAspectJsonSchema`). Обе умерли вместе со старой формой, а
// `buildToolDefs` с Задачи 12 принимает СНИМОК РЕЕСТРА — тот самый, по которому валидируется
// запись. Собирать снимок «из кода» значило бы завести второй путь сборки ради обещания
// шапки, и гейт проверял бы набор, которого в проде нет. Живой смоук и так требует ключа
// провайдера и прод-подобного контура — база к этому списку добавляется честно (Р-23-5а).
//
// Запуск: DATABASE_URL=postgres://… ORBIS_SMOKE_OWNER_ID=<uuid владельца>
//         ORBIS_LLM_PROVIDER=openai OPENAI_API_KEY=sk-... bun scripts/llm-smoke.ts
//     или ORBIS_LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... …
// Модель: env ORBIS_LLM_MODEL, иначе дефолт выбранного провайдера
// (claude-sonnet-5 — DEFAULT_ANTHROPIC_MODEL, gpt-5.5 — DEFAULT_OPENAI_MODEL).

import { makeDb } from '../apps/server/src/db/client';
import { withIdentity } from '../apps/server/src/db/with-identity';
import { makeLLMProvider } from '../apps/server/src/llm/provider';
import type { LLMToolDef } from '../apps/server/src/llm/types';
import { effectiveRegistry } from '../apps/server/src/registry/cache';
import { buildToolDefs } from '../apps/server/src/tools/registry';

// Правила ВЫБОРА провайдера скрипт не дублирует: неизвестное значение
// ORBIS_LLM_PROVIDER, отсутствие ключа выбранного провайдера, оба ключа сразу без
// явного выбора — на всё это фабрика уже отвечает внятной ошибкой, и вторая копия
// этих правил со временем разошлась бы с первой.
const provider = makeLLMProvider(process.env);

// А вот СОБСТВЕННОЕ предусловие гейта проверить обязан он сам. Без ключей и вне
// production фабрика ошибку не бросает — она отдаёт EchoProvider (fail-safe для dev,
// llm/provider.ts). Для сервера это правильно, для гейта губительно: оператор, забывший
// экспортировать ключ, увидел бы «echo: Сколько у меня…», stopReason end_turn и exit 0 —
// то есть смоук закрылся бы, ни разу не сходив в сеть, и в прод уехал бы непроверенный
// провайдер. Гейт по определению требует настоящего провайдера, поэтому здесь — отказ.
if (provider.modelId === 'echo') {
  console.error(
    'llm-smoke: выбран EchoProvider — гейт требует настоящего провайдера, заглушка ничего не доказывает.',
  );
  console.error(
    'Задайте ключ (OPENAI_API_KEY либо ANTHROPIC_API_KEY) и ORBIS_LLM_PROVIDER — см. шапку файла.',
  );
  process.exit(1);
}

/**
 * НАСТОЯЩИЙ набор тулов реестра, а не рукописный образец.
 *
 * Рукописный тул с плоской схемой проходит у кого угодно, и гейт на нём молчал бы
 * ровно о том, ради чего он существует: примет ли провайдер СХЕМЫ АСПЕКТОВ. Отказ
 * задокументирован ровно на одной конструкции — негативный lookahead в positiveDecimal
 * (orbis/financial.amount, orbis/goal.target_value): его не берёт строгий режим, а строгий
 * дефолт стоит как раз на Responses-транспорте OpenAI (см. разбор strict в openai.ts).
 * Про союз anyOf у orbis/goal.progress_source доказано лишь то, что он ПРИНЯТ, — причиной
 * отказа он не был ни разу; в наборе он важен как единственный в реестре, а не как риск.
 *
 * Источник — ЭФФЕКТИВНЫЙ СНИМОК РЕЕСТРА владельца, то есть ровно то, из чего собирает свой
 * набор бой (`ai/send-message.ts`): системные строки плюс собственные аспекты и свойства
 * владельца. Набор с кастомными аспектами и есть интересный случай гейта — рукописный
 * набор его не воспроизводит.
 */
const ownerId = process.env.ORBIS_SMOKE_OWNER_ID;
if (!ownerId) {
  console.error('llm-smoke: задайте ORBIS_SMOKE_OWNER_ID — от него зависит эффективный реестр.');
  process.exit(1);
}
const { db, client } = makeDb({ max: 1 });
const registry = await withIdentity(db, ownerId, (tx) => effectiveRegistry(tx, ownerId));
await client.end();
// Та же конвертация OrbisToolDef → LLMToolDef, что в бою (ai/send-message.ts):
// расхождение здесь означало бы, что гейт проверяет не ту форму запроса.
const defs = buildToolDefs(registry);
const tools: LLMToolDef[] = defs.map((d) => ({
  name: d.name,
  description: d.description,
  inputSchema: d.inputJsonSchema,
}));

const response = await provider.chat({
  system:
    'Ты — ассистент Orbis. Если вопрос касается сущностей пользователя, вызывай тул entity_query.',
  messages: [{ role: 'user', content: 'Сколько у меня незакрытых задач?' }],
  tools,
  // 2048, не 256: на claude-sonnet-5 adaptive thinking включён по умолчанию и
  // считается в output-бюджет — слишком узкий потолок дал бы ложный обрыв max_tokens.
  // У gpt-5.x ровно та же арифметика: reasoning-токены тоже списываются из потолка
  // вывода, так что довод не устарел со вторым провайдером, а стал шире.
  maxTokens: 2048,
});

// Первыми строками — что именно проверено: без них зелёный смоук не отличить
// от зелёного смоука другого провайдера, другой модели или урезанного набора тулов.
console.log('model     :', provider.modelId);
console.log(
  'tools     :',
  tools.length,
  `(из них attach_*: ${defs.filter((d) => d.name.startsWith('attach_')).length})`,
);
console.log('content   :', JSON.stringify(response.content));
console.log('toolCalls :', JSON.stringify(response.toolCalls, null, 2));
console.log('stopReason:', response.stopReason);
console.log('usage     :', response.usage);
