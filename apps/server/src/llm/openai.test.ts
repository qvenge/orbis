// apps/server/src/llm/openai.test.ts
// Сети здесь нет и быть не может (Global Constraints: CI гоняет только echo/scripted).
// Проверяется то, что проверяемо офлайн: имя модели по умолчанию, переопределение,
// наследование от общего слоя и ВЫБОР ТРАНСПОРТА (самое дорогое из офлайн-проверяемого).

import { describe, expect, test } from 'bun:test';
import { AiSdkProvider } from './ai-sdk';
import { DEFAULT_OPENAI_MODEL, OpenAIProvider } from './openai';

/**
 * Достаёт модель SDK из приватного поля AiSdkProvider.
 *
 * Да, это залезание в инкапсуляцию, и честнее способа нет: модель намеренно приватна
 * (типы SDK не текут наружу — контракт ai-sdk.ts), публичного геттера у неё нет, а
 * добавлять его только ради теста значит расширять боевой API из-за теста. Цена
 * незамеченной ошибки перевешивает чистоту: подмена `.chat(modelId)` на `(modelId)`
 * не ловится ни компилятором (SdkModel принимает и голую строку, и любую
 * LanguageModelV4), ни линтером, ни остальными тестами — а в проде даёт 400 на
 * attach_orbis_financial и attach_orbis_goal, то есть на ВСЕХ финансах и ВСЕХ целях.
 * `private` в TS — проверка компилятора, а не рантайма, так что поле доступно как есть.
 */
function sdkModelOf(p: AiSdkProvider): { provider: string; modelId: string } {
  return (p as unknown as { model: { provider: string; modelId: string } }).model;
}

describe('OpenAIProvider', () => {
  test('дефолтная модель — полноразмерная, не mini/nano', () => {
    // Проба 2026-08-06: gpt-5.4-mini собирал orbis/financial без обязательного
    // category_ref и терял чипы продолжений. Дефолт обязан быть полноразмерным.
    expect(DEFAULT_OPENAI_MODEL).not.toMatch(/mini|nano/);
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

  // Транспорт — Chat Completions, и это НЕ вкусовщина: Responses API отвергает схемы
  // нашего реестра («regex lookaround is not supported») из-за негативного lookahead
  // в positiveDecimal — он стоит у orbis/financial.amount и orbis/goal.target_value.
  // Уехать голым createOpenAI(...)(modelId) вместо .chat(modelId) можно молча: типы
  // обоих транспортов одинаковы (LanguageModelV4), и такая правка оставляет зелёными
  // тесты, typecheck и lint, ломая в проде все финансы и все цели. Пин ниже — граница,
  // на которой эта подмена краснеет. Отличие видно офлайн, без сети: собранная модель
  // сама называет транспорт в поле provider (проверено на @ai-sdk/openai@4.0.31 —
  // 'openai.chat' у .chat(), 'openai.responses' у голого вызова и у .responses()).
  test('транспорт — Chat Completions, а не Responses API (иначе 400 на финансах и целях)', () => {
    const model = sdkModelOf(new OpenAIProvider({ apiKey: 'ключ-для-теста' }));
    expect(model.provider).toBe('openai.chat');
    // Явно называем то, чего быть не должно: при регрессе диагностика в выводе теста
    // указывает на транспорт, а не заставляет гадать, что значит несовпавшая строка.
    expect(model.provider).not.toBe('openai.responses');
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
