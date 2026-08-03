// apps/server/src/llm/prompts/v2.test.ts
// Snapshot-тест системного промпта v2 (слайс 3, D19) — та же механика, что у v1:
// текст промпта версионированный артефакт, эталон — файл-фикстура v2.fixture.txt,
// фиксируемая ОСОЗНАННО. Отличие v2 от v1 ровно одно — блок «Продолжения разговора».
// Семантические гарды v1 перенесены целиком: новая версия не имеет права молча
// потерять нормативные куски слоя 1.
import { describe, expect, test } from 'bun:test';
import { extractSuggestions, SUGGESTION_MAX_LEN, SUGGESTIONS_MAX } from '../../ai/suggestions';
import { SYSTEM_PROMPT_V2, SYSTEM_PROMPT_VERSION, TOOL_RESULT_MARKER } from './v2';

describe('SYSTEM_PROMPT_V2 (§7.1 слой 1)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./v2.fixture.txt', import.meta.url)).text();
    expect(SYSTEM_PROMPT_V2).toBe(fixture);
  });

  test('версия промпта — v2', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('v2');
  });

  // --- Новое в v2 -----------------------------------------------------------

  // D19: чипы приходят маркером в конце ответа, второго вызова LLM нет — формат в
  // промпте и парсер (ai/suggestions.ts) обязаны описывать ОДИН И ТОТ ЖЕ протокол.
  test('блок продолжений разговора (D19): пример маркера разбирается парсером', () => {
    expect(SYSTEM_PROMPT_V2).toContain('Продолжения разговора:');
    const example = SYSTEM_PROMPT_V2.match(/\[\[suggest:[^\]\n]+\]\]/)?.[0];
    if (!example) throw new Error('в промпте нет примера маркера продолжений');
    const parsed = extractSuggestions(`Ответ модели.\n${example}`);
    expect(parsed.text).toBe('Ответ модели.'); // маркер вырезан целиком
    expect(parsed.suggestions).toHaveLength(3); // «первое | второе | третье»
  });

  test('блок продолжений: потолки промпта — те же числа, что в парсере', () => {
    expect(SYSTEM_PROMPT_V2).toContain(`2–${SUGGESTIONS_MAX} коротких продолжения`);
    expect(SYSTEM_PROMPT_V2).toContain(`до ${SUGGESTION_MAX_LEN} символов`);
  });

  test('блок продолжений: это реплики ПОЛЬЗОВАТЕЛЯ, а нечего предложить — строки нет', () => {
    expect(SYSTEM_PROMPT_V2).toContain('следующей реплики ПОЛЬЗОВАТЕЛЯ');
    expect(SYSTEM_PROMPT_V2).toMatch(/нечем — строку не добавляй/);
  });

  // --- Гарды, унаследованные от v1 -----------------------------------------

  test('соглашение meta-ключей §3.9 — дословно из PRD', () => {
    expect(SYSTEM_PROMPT_V2).toContain(
      '**имена ключей в `meta` обязаны совпадать с именами полей аспектов**',
    );
    expect(SYSTEM_PROMPT_V2).toContain('meta: {amount: "500.00", direction: "expense"}');
    expect(SYSTEM_PROMPT_V2).toContain('механической операцией, а не угадыванием');
  });

  test('правила поведения: тулы, decimal-деньги, category_ref, запрет выдумывать id', () => {
    expect(SYSTEM_PROMPT_V2).toContain('decimal-строк');
    expect(SYSTEM_PROMPT_V2).toContain('category_ref');
    expect(SYSTEM_PROMPT_V2).toContain('entity_query');
    expect(SYSTEM_PROMPT_V2).toMatch(/не выдумывай/i);
  });

  test('протокол tool-результатов MVP описан и согласован с маркером (Task 9)', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(SYSTEM_PROMPT_V2).toContain(TOOL_RESULT_MARKER);
  });

  test('блок Budget: budget_status для финансовых вопросов, запрет двойного вычета recurring (03-budget §4.3)', () => {
    expect(SYSTEM_PROMPT_V2).toContain('budget_status');
    expect(SYSTEM_PROMPT_V2).toContain('НЕ суммируй recurring отдельно');
    expect(SYSTEM_PROMPT_V2).toContain('двойной вычет');
    expect(SYSTEM_PROMPT_V2).toContain('spend_class');
  });

  test('future_outflows — только direction=expense, доходные инстансы не вычитаются (§4.3)', () => {
    expect(SYSTEM_PROMPT_V2).toContain('только direction=expense');
    expect(SYSTEM_PROMPT_V2).toMatch(/доходные инстансы[^.\n]*не вычитай/i);
  });

  test('одна сущность на намерение: аспекты на ТУ ЖЕ сущность, сумма — в orbis/financial (00-product §7)', () => {
    expect(SYSTEM_PROMPT_V2).toContain('Одна сущность на намерение');
    expect(SYSTEM_PROMPT_V2).toMatch(/не создавай втор|а НЕ втор/i);
    expect(SYSTEM_PROMPT_V2).toContain('attach_');
    expect(SYSTEM_PROMPT_V2).toContain('orbis/schedule');
    expect(SYSTEM_PROMPT_V2).toMatch(/сумма[^.\n]*orbis\/financial[^.\n]*не в `meta`/i);
  });

  test('шпаргалка грамматики §6 — модель видит синтаксис entity_query', () => {
    expect(SYSTEM_PROMPT_V2).toContain('status=!done&!cancelled'); // NOT-синтаксис
    expect(SYSTEM_PROMPT_V2).toContain('today | overdue | next_7d | after_7d'); // date-токены
    expect(SYSTEM_PROMPT_V2).toContain('children_of='); // дети сущности
    expect(SYSTEM_PROMPT_V2).toContain('sortBy='); // сортировка
    expect(SYSTEM_PROMPT_V2).toContain('status=planned|in_progress'); // OR внутри значения
  });
});
