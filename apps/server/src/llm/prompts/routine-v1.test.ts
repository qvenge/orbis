// apps/server/src/llm/prompts/routine-v1.test.ts
// Снимок системного слоя раннера рутины (V1.5) — та же механика, что у v1–v4: текст
// промпта версионированный артефакт, эталон — routine-v1.fixture.txt, фиксируется
// ОСОЗНАННО. Сверх снимка — семантические гарды того, чем этот слой отличается от
// чат-ассистента: нет собеседника, нет чипов продолжений, терминальность
// orbis_propose, вопрос только чекпойнтом.
import { describe, expect, test } from 'bun:test';
import {
  ROUTINE_PROMPT_VERSION,
  ROUTINE_SYSTEM_PROMPT,
  routineModeSection,
  TOOL_RESULT_MARKER,
} from './routine-v1';
import { SYSTEM_PROMPT_V4 } from './v4';

describe('ROUTINE_SYSTEM_PROMPT (V1.5, системный слой раннера)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./routine-v1.fixture.txt', import.meta.url)).text();
    expect(ROUTINE_SYSTEM_PROMPT).toBe(fixture);
  });

  test('версия промпта — routine-v1', () => {
    expect(ROUTINE_PROMPT_VERSION).toBe('routine-v1');
  });

  // Главное отличие от чата: продолжений разговора у прогона нет — их некому нажимать,
  // а extractSuggestions раннер не зовёт, и маркер уехал бы в отчёт владельцу текстом.
  test('нет блока продолжений разговора: маркера [[suggest: в тексте нет', () => {
    expect(ROUTINE_SYSTEM_PROMPT).not.toContain('[[suggest:');
    expect(ROUTINE_SYSTEM_PROMPT).not.toContain('Продолжения разговора');
    // и в чат-промпте он ЕСТЬ — гард сравнивает две версии, а не проверяет опечатку
    expect(SYSTEM_PROMPT_V4).toContain('[[suggest:');
  });

  test('нет собеседника: сказано прямо, что текст по ходу работы никто не читает', () => {
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/Собеседника нет/);
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/Вопрос, написанный текстом, никто не прочитает/);
  });

  test('orbis_propose: терминален, обязателен в propose, форма операций сужена', () => {
    expect(ROUTINE_SYSTEM_PROMPT).toContain('orbis_propose');
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/orbis_propose ТЕРМИНАЛЕН/);
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/без предложения[^.\n]*провалившимся/);
    // предусловия снимает сервер (V1.7) — модель их не передаёт
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/[Пп]редусловия[^.\n]*не передавай/);
  });

  test('вопрос — только orbis_checkpoint с run_id; отчёт — финальным текстом', () => {
    expect(ROUTINE_SYSTEM_PROMPT).toContain('orbis_checkpoint');
    expect(ROUTINE_SYSTEM_PROMPT).toContain('run_id');
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/отчёт ФИНАЛЬНЫМ текстом/);
  });

  test('запрет по объекту назван словами (V1.10): рутины и назначения не трогаем', () => {
    expect(ROUTINE_SYSTEM_PROMPT).toContain('orbis/routine');
    expect(ROUTINE_SYSTEM_PROMPT).toContain('orbis/assignment');
  });

  test('протокол tool-результатов — тот же маркер, что сериализует toolResultMessage', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(ROUTINE_SYSTEM_PROMPT).toContain(TOOL_RESULT_MARKER);
  });
});

describe('routineModeSection (V1.10)', () => {
  test('propose: назван режим, run_id и бакет; сказано, что белый список не действует', () => {
    const s = routineModeSection({
      mode: 'propose',
      allowedTools: [],
      runId: '019e4466-aaaa-7e07-b5d4-64be9721da51',
      bucket: '2026-08-17T07:00',
    });
    expect(s).toContain('режим: propose');
    expect(s).toContain('019e4466-aaaa-7e07-b5d4-64be9721da51');
    expect(s).toContain('2026-08-17T07:00');
    expect(s).toContain('orbis_propose');
    expect(s).not.toContain('белый список правок:');
  });

  test('act: перечислен ровно белый список владельца', () => {
    const s = routineModeSection({
      mode: 'act',
      allowedTools: ['entity_update', 'relation_create'],
      runId: '019e4466-aaaa-7e07-b5d4-64be9721da51',
      bucket: 'manual:2026-08-17T12:00:00.000Z',
    });
    expect(s).toContain('режим: act');
    expect(s).toContain('entity_update, relation_create');
    expect(s).toContain('manual:2026-08-17T12:00:00.000Z');
  });

  test('act с пустым списком: сказано, что менять граф нечем (а не молчание)', () => {
    const s = routineModeSection({
      mode: 'act',
      allowedTools: [],
      runId: '019e4466-aaaa-7e07-b5d4-64be9721da51',
      bucket: '2026-08-17T07:00',
    });
    expect(s).toMatch(/белый список правок пуст/);
  });
});
