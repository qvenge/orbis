// apps/server/src/llm/openai.test.ts
// Сети здесь нет и быть не может (Global Constraints: CI гоняет только echo/scripted).
// Проверяется то, что проверяемо офлайн: имя модели по умолчанию, переопределение,
// наследование от общего слоя и ВЫБОР ТРАНСПОРТА (самое дорогое из офлайн-проверяемого).

import { describe, expect, test } from 'bun:test';
import { AiSdkProvider } from './ai-sdk';
import { DEFAULT_OPENAI_MODEL, OpenAIProvider } from './openai';
import type { LLMRequest } from './types';

/**
 * Достаёт модель SDK из приватного поля AiSdkProvider.
 *
 * Да, это залезание в инкапсуляцию, и честнее способа нет: модель намеренно приватна
 * (типы SDK не текут наружу — контракт ai-sdk.ts), публичного геттера у неё нет, а
 * добавлять его только ради теста значит расширять боевой API из-за теста.
 *
 * Цена незамеченной ошибки перевешивает чистоту. Боевой транспорт сегодня — Responses
 * API, то есть голый `(modelId)` (решение D29); обратная подмена на `.chat(modelId)`
 * не ловится ни компилятором (SdkModel принимает и голую строку, и любую
 * LanguageModelV4), ни линтером, ни остальными тестами. И — в отличие от прежней
 * конфигурации — она даже 400 в проде не даст: `strict: false` мы теперь шлём полем
 * самого тула, а Chat Completions с ним те же схемы принимает (проба 2026-08-06, §1.2
 * отчёта). Именно поэтому подмена и опасна: она молча уводит код с эндпоинта, который
 * выбран решением, и ничем себя не выдаёт — ни отказом, ни красным тестом. Сторож
 * ровно один: пин ниже, а он спрашивает имя транспорта у самой модели.
 *
 * `private` в TS — проверка компилятора, а не рантайма, так что поле доступно как есть.
 */
function sdkModelOf(p: AiSdkProvider): { provider: string; modelId: string } {
  return (p as unknown as { model: { provider: string; modelId: string } }).model;
}

/** Ответ /v1/responses, достаточный, чтобы SDK разобрал его без сети. */
const RESPONSES_STUB = JSON.stringify({
  id: 'resp_тест',
  created_at: 1,
  model: DEFAULT_OPENAI_MODEL,
  output: [
    {
      type: 'message',
      role: 'assistant',
      id: 'msg_1',
      // annotations обязательны по схеме ответа SDK — без них разбор падает
      content: [{ type: 'output_text', text: 'ок', annotations: [] }],
    },
  ],
  usage: { input_tokens: 11, output_tokens: 3 },
});

interface CapturedRequest {
  url: string;
  /** Тело запроса как его увидит OpenAI. */
  body: { store?: unknown; tools?: ReadonlyArray<Record<string, unknown>> };
  /** Ошибка вызова, если была: у транспортного пина она обязана отсутствовать. */
  error: unknown;
}

/**
 * Перехватывает HTTP-запрос провайдера, НЕ ПУСКАЯ его в сеть: globalThis.fetch на время
 * вызова подменяется записывающей заглушкой. Подмена работает потому, что SDK читает
 * globalThis.fetch в момент запроса, а не при загрузке модуля: значение по умолчанию
 * вычисляется в параметрах postToApi (@ai-sdk/provider-utils/dist/index.js:2860,
 * getOriginalFetch2 — :2809). Именно POST-путь: провайдер ходит постом.
 *
 * Так провайдеро-специфичные настройки проверяются там, где они имеют смысл, — в теле
 * запроса. Чтение приватных полей провайдера доказало бы лишь то, что мы их куда-то
 * положили, и промолчало бы, если бы SDK по дороге их выбросил или перебил дефолтом.
 */
async function captureRequest(p: AiSdkProvider): Promise<CapturedRequest> {
  const req: LLMRequest = {
    system: 'системный промпт',
    messages: [{ role: 'user', content: 'привет' }],
    // Схема с негативным lookahead — та самая, из-за которой нужен strict: false
    // (positiveDecimal у orbis/financial.amount и orbis/goal.target_value).
    tools: [
      {
        name: 'attach_orbis_financial',
        description: 'финансовый аспект',
        inputSchema: {
          type: 'object',
          properties: { amount: { type: 'string', pattern: '^(?!0+(\\.0+)?$)\\d+$' } },
          required: ['amount'],
          additionalProperties: false,
        },
      },
      {
        name: 'entity_get',
        description: 'взять сущность',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    maxTokens: 64,
  };

  const captured: { url: string; body: CapturedRequest['body'] }[] = [];
  const realFetch = globalThis.fetch;
  let error: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(RESPONSES_STUB, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await p.chat(req);
  } catch (e) {
    // Предмет тестов ниже — ЗАПРОС. Разбор ответа-заглушки законно падает, если
    // транспорт увезли на другой эндпоинт, и этот случай ловит отдельный пин
    // транспорта: незачем ронять им заодно пины strict и store.
    error = e;
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(captured).toHaveLength(1);
  const only = captured[0];
  if (only === undefined) throw new Error('запрос не перехвачен');
  return { ...only, error };
}

describe('OpenAIProvider', () => {
  test('в имени дефолтной модели нет mini/nano/lite — дефолт не съехал на урезанную', () => {
    // Проба 2026-08-06: gpt-5.4-mini собирал orbis/financial без обязательного
    // category_ref и терял чипы продолжений, поэтому дефолт обязан быть полноразмерным.
    // Но проверяется здесь ИМЯ, а не способности: «полноразмерность» офлайн недоказуема
    // (для неё нужен живой вызов), доказуемо лишь то, что дефолт не подменили урезанным
    // вариантом той же линейки. Список суффиксов чёрный, и в этом его граница — новый
    // суффикс придётся дописать руками; 'lite' добавлен именно поэтому: пара mini|nano
    // пропустила бы «gpt-5.5-lite».
    expect(DEFAULT_OPENAI_MODEL).not.toMatch(/mini|nano|lite/);
  });

  test('modelId по умолчанию — DEFAULT_OPENAI_MODEL', () => {
    const p = new OpenAIProvider({ apiKey: 'ключ-для-теста' });
    expect(p.modelId).toBe(DEFAULT_OPENAI_MODEL);
  });

  test('modelId переопределяется опцией model', () => {
    const p = new OpenAIProvider({ apiKey: 'ключ-для-теста', model: 'иная-модель' });
    expect(p.modelId).toBe('иная-модель');
  });

  test('провайдер построен на общем слое AI SDK, а не на своей копии', () => {
    expect(new OpenAIProvider({ apiKey: 'ключ-для-теста' })).toBeInstanceOf(AiSdkProvider);
  });

  // Транспорт — Responses API: он рекомендован OpenAI для нового кода, и наши схемы
  // он принимает (проба 2026-08-08, см. openai.ts). Съехать на .chat(modelId) можно
  // молча — типы обоих транспортов одинаковы (LanguageModelV4), typecheck и lint
  // разницы не видят. Пин ниже — граница, на которой такая подмена краснеет; отличие
  // видно офлайн: собранная модель сама называет транспорт в поле provider
  // ('openai.responses' у голого вызова и .responses(), 'openai.chat' у .chat()),
  // а перехваченный запрос — свой эндпоинт.
  test('транспорт — Responses API, а не Chat Completions', async () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test-key' });
    expect(sdkModelOf(p).provider).toBe('openai.responses');
    const { url, error } = await captureRequest(p);
    expect(url).toContain('/responses');
    expect(url).not.toContain('/chat/completions');
    // Полный круг «запрос → ответ» на этом транспорте проходит без ошибки: значит
    // пины strict и store ниже смотрят на живой запрос, а не на попытку его собрать.
    expect(error).toBeUndefined();
  });

  test('на тулах запроса strict: false — иначе Responses отвергает наши схемы', async () => {
    // Дефолт эндпоинта /v1/responses — строгий, а строгий режим не берёт regex
    // lookaround: «Invalid JSON schema: regex lookaround is not supported» на
    // positiveDecimal (orbis/financial.amount, orbis/goal.target_value) — два тула
    // из девятнадцати, то есть все финансы и все цели.
    const { body } = await captureRequest(new OpenAIProvider({ apiKey: 'sk-test-key' }));
    const tools = body.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      // Форма тула у транспортов разная (Responses — плоско, Chat Completions —
      // внутри .function), а проверяем мы одно поле: разворачиваем, чтобы пин
      // краснел ровно на пропаже strict, а не на смене транспорта — у неё свой тест.
      const fn = (t.function as Record<string, unknown> | undefined) ?? t;
      expect(fn.strict).toBe(false);
    }
  });

  test('store: false — переписка не остаётся на стороне OpenAI', async () => {
    // На Responses SDK по умолчанию ставит store: true (@ai-sdk/openai/dist/index.js:6533),
    // и тогда OpenAI хранит запрос с ответом у себя. Через чат Orbis идут банковские
    // выписки, суммы и личные заметки — хранить их на чужой стороне мы не согласились
    // (решение владельца 2026-08-08). Пин смотрит в тело запроса именно потому, что
    // тут важно перебить чужой дефолт, а не просто где-то у себя записать false.
    const { body } = await captureRequest(new OpenAIProvider({ apiKey: 'sk-test-key' }));
    expect(body.store).toBe(false);
  });

  test('в транспорт уходит именно запрошенная модель (в т.ч. переопределённая)', () => {
    // Заодно доказывает, что sdkModelOf достал ровно ту модель, которую собрал
    // конструктор, а не случайный объект: modelId совпадает с запрошенным.
    expect(sdkModelOf(new OpenAIProvider({ apiKey: 'к' })).modelId).toBe(DEFAULT_OPENAI_MODEL);
    expect(sdkModelOf(new OpenAIProvider({ apiKey: 'к', model: 'gpt-иная' })).modelId).toBe(
      'gpt-иная',
    );
  });
});
