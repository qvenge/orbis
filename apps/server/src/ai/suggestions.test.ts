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

  test('битый маркер (пустое содержимое) остаётся частью текста, но продолжений не даёт', () => {
    const r = extractSuggestions('Готово.\n[[suggest:]]');
    expect(r.suggestions).toEqual([]);
    expect(r.text).toContain('Готово.');
  });

  test('маркер не в конце ответа не разбирается (строгая форма — последняя строка)', () => {
    const raw = 'Ок.\n[[suggest: раз | два]]\nЕщё пара слов.';
    expect(extractSuggestions(raw)).toEqual({ text: raw, suggestions: [] });
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
