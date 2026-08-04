// apps/server/src/ai/suggestions.test.ts
// Юнит-тесты парсера продолжений разговора (D19): маркер приходит последней строкой
// ответа модели, второго вызова LLM нет. БД не нужна — чистая функция над текстом.
// Главный инвариант: служебная строка НИКОГДА не должна доехать до ленты как проза,
// а разбор «почти маркера» не имеет права выдумывать продолжения.
import { describe, expect, test } from 'bun:test';
import { extractSuggestions, SUGGESTION_MAX_LEN, SUGGESTIONS_MAX } from './suggestions';

describe('extractSuggestions (D19)', () => {
  test('маркер вырезается из текста, продолжения разбираются', () => {
    const raw = 'Записал 340 ₽ в Еду.\n\n[[suggest: что по бюджету? | сколько осталось на еду?]]';
    expect(extractSuggestions(raw)).toEqual({
      text: 'Записал 340 ₽ в Еду.',
      suggestions: ['что по бюджету?', 'сколько осталось на еду?'],
    });
  });

  test('маркера нет — текст не тронут, продолжений нет', () => {
    expect(extractSuggestions('Готово.')).toEqual({ text: 'Готово.', suggestions: [] });
  });

  test('пустой ответ модели — пустой текст без продолжений', () => {
    expect(extractSuggestions('')).toEqual({ text: '', suggestions: [] });
  });

  test('битый маркер (пустое содержимое) продолжений не даёт и в текст не течёт', () => {
    expect(extractSuggestions('Готово.\n[[suggest:]]')).toEqual({
      text: 'Готово.',
      suggestions: [],
    });
  });

  test('маркер не в конце ответа не разбирается (строгая форма — последняя строка)', () => {
    const raw = 'Ок.\n[[suggest: раз | два]]\nЕщё пара слов.';
    const r = extractSuggestions(raw);
    expect(r.suggestions).toEqual([]);
    // Разбор строгий, вырезание — нет: продолжений нет, но и служебной строки в ленте нет.
    expect(r.text).not.toContain('[[suggest');
    expect(r.text).toBe('Ок.\n\nЕщё пара слов.');
  });

  test('завершающие переводы строк после маркера не мешают разбору', () => {
    const r = extractSuggestions('Ок.\n[[suggest: раз | два]]\n\n');
    expect(r).toEqual({ text: 'Ок.', suggestions: ['раз', 'два'] });
  });

  test(`больше ${SUGGESTIONS_MAX} продолжений усекается до ${SUGGESTIONS_MAX}`, () => {
    const r = extractSuggestions('Ок.\n[[suggest: a | b | c | d | e]]');
    expect(r.suggestions).toEqual(['a', 'b', 'c', 'd'].slice(0, SUGGESTIONS_MAX));
  });

  test('пустые части маркера отбрасываются, у остальных снимаются пробелы', () => {
    const r = extractSuggestions('Ок.\n[[suggest:  раз |  | два  |]]');
    expect(r.suggestions).toEqual(['раз', 'два']);
  });

  test(`элемент длиннее ${SUGGESTION_MAX_LEN} символов отбрасывается целиком, а не усекается`, () => {
    const long = 'я'.repeat(SUGGESTION_MAX_LEN + 1);
    const edge = 'э'.repeat(SUGGESTION_MAX_LEN);
    const r = extractSuggestions(`Ок.\n[[suggest: ${long} | ${edge} | коротко]]`);
    expect(r.suggestions).toEqual([edge, 'коротко']);
  });

  test('длина считается по символам, а не по UTF-16-юнитам (эмодзи не съедают лимит вдвое)', () => {
    const emoji = '🙂'.repeat(SUGGESTION_MAX_LEN); // 120 UTF-16-юнитов, 60 символов
    const r = extractSuggestions(`Ок.\n[[suggest: ${emoji}]]`);
    expect(r.suggestions).toEqual([emoji]);
  });

  test('ответ из одного маркера: текст пуст, продолжения разобраны (пустой пузырь лучше служебной строки)', () => {
    expect(extractSuggestions('[[suggest: что по бюджету? | отменить]]')).toEqual({
      text: '',
      suggestions: ['что по бюджету?', 'отменить'],
    });
  });

  test('все части отброшены — маркер всё равно вырезан, продолжений нет', () => {
    const long = 'я'.repeat(SUGGESTION_MAX_LEN + 1);
    const r = extractSuggestions(`Готово.\n\n[[suggest: ${long}]]`);
    expect(r).toEqual({ text: 'Готово.', suggestions: [] });
  });
});

// Промах формы — не редкость: инструкция про маркер лежит в промпте для КАЖДОГО ответа,
// то есть цена промаха платится на главном экране. Спека слайса 3 обещает смягчением ровно
// это: «при неполном совпадении чипы не показываются, а текст остаётся чистым». Разбор при
// этом остаётся строгим — терпимее только вырезание.
describe('extractSuggestions: промахи формы маркера не текут в ленту', () => {
  test('обрыв по max_tokens посреди маркера: хвост вырезан, продолжений нет', () => {
    const r = extractSuggestions('Записал 340 ₽ в Еду.\n\n[[suggest: что по бюдже');
    expect(r).toEqual({ text: 'Записал 340 ₽ в Еду.', suggestions: [] });
  });

  test('точка после маркера: вырезан и маркер, и пунктуационный хвост', () => {
    const r = extractSuggestions('Записал 340 ₽ в Еду.\n\n[[suggest: что по бюджету?]].');
    expect(r).toEqual({ text: 'Записал 340 ₽ в Еду.', suggestions: [] });
  });

  test('] внутри продолжения: строгая форма не совпала, но текст чист', () => {
    const r = extractSuggestions('Ок.\n[[suggest: показать [все] задачи]]');
    expect(r).toEqual({ text: 'Ок.', suggestions: [] });
  });

  test('маркер внутри код-фенса в текст не течёт', () => {
    const r = extractSuggestions('Пример:\n\n```\n[[suggest: раз | два]]\n```');
    expect(r.suggestions).toEqual([]);
    expect(r.text).not.toContain('[[suggest');
  });

  test('второй маркер выше по тексту тоже вырезается (разобран — только последний)', () => {
    const r = extractSuggestions('Ок.\n[[suggest: лишний]]\n[[suggest: раз | два]]');
    expect(r.suggestions).toEqual(['раз', 'два']);
    expect(r.text).not.toContain('[[suggest');
  });

  test('настоящий текст вокруг маркера не теряется ни одним символом', () => {
    // Предсказуемость правила: вырезается ровно служебная подстрока, а не «строка целиком
    // на всякий случай». Цена — двойной пробел на шве, а не съеденное предложение.
    const r = extractSuggestions('Я дописываю [[suggest: раз | два]] в конец ответа.');
    expect(r).toEqual({ text: 'Я дописываю  в конец ответа.', suggestions: [] });
  });
});
