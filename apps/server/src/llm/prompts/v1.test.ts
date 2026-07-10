// apps/server/src/llm/prompts/v1.test.ts
// Snapshot-тест системного промпта v1 (Task 8, carried-решение): текст промпта —
// версионированный артефакт. Эталон — файл-фикстура v1.fixture.txt (выбран вместо
// bun toMatchSnapshot: фикстура фиксируется ОСОЗНАННО руками/скриптом, а не
// автогенерацией первого прогона, и падение RED-фазы детерминировано).
// Изменение текста промпта = НОВЫЙ файл vN + новая фикстура — не правка v1.
import { describe, expect, test } from 'bun:test';
import { SYSTEM_PROMPT_V1, SYSTEM_PROMPT_VERSION, TOOL_RESULT_MARKER } from './v1';

describe('SYSTEM_PROMPT_V1 (§7.1 слой 1)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./v1.fixture.txt', import.meta.url)).text();
    expect(SYSTEM_PROMPT_V1).toBe(fixture);
  });

  test('версия промпта — v1', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('v1');
  });

  // Семантические гарды поверх точной фикстуры: даже «осознанное» обновление
  // фикстуры не имеет права потерять нормативные куски слоя 1.
  test('соглашение meta-ключей §3.9 — дословно из PRD', () => {
    expect(SYSTEM_PROMPT_V1).toContain(
      '**имена ключей в `meta` обязаны совпадать с именами полей аспектов**',
    );
    expect(SYSTEM_PROMPT_V1).toContain('meta: {amount: "500.00", direction: "expense"}');
    expect(SYSTEM_PROMPT_V1).toContain('механической операцией, а не угадыванием');
  });

  test('правила поведения: тулы, decimal-деньги, category_ref, запрет выдумывать id', () => {
    expect(SYSTEM_PROMPT_V1).toContain('decimal-строк');
    expect(SYSTEM_PROMPT_V1).toContain('category_ref');
    expect(SYSTEM_PROMPT_V1).toContain('entity_query');
    expect(SYSTEM_PROMPT_V1).toMatch(/не выдумывай/i);
  });

  test('протокол tool-результатов MVP описан и согласован с маркером (Task 9)', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(SYSTEM_PROMPT_V1).toContain(TOOL_RESULT_MARKER);
  });

  test('блок Budget (Task A6): budget_status для финансовых вопросов, запрет двойного вычета recurring (03-budget §4.3)', () => {
    expect(SYSTEM_PROMPT_V1).toContain('budget_status');
    expect(SYSTEM_PROMPT_V1).toContain('НЕ суммируй recurring отдельно');
    expect(SYSTEM_PROMPT_V1).toContain('двойной вычет');
    expect(SYSTEM_PROMPT_V1).toContain('spend_class');
  });

  test('шпаргалка грамматики §6 — модель видит синтаксис entity_query (fix round)', () => {
    expect(SYSTEM_PROMPT_V1).toContain('status=!done&!cancelled'); // NOT-синтаксис
    expect(SYSTEM_PROMPT_V1).toContain('today | overdue | next_7d | after_7d'); // date-токены
    expect(SYSTEM_PROMPT_V1).toContain('children_of='); // дети сущности
    expect(SYSTEM_PROMPT_V1).toContain('sortBy='); // сортировка
    expect(SYSTEM_PROMPT_V1).toContain('status=planned|in_progress'); // OR внутри значения
  });
});
