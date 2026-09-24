// Тест чистой части замера размера промпта (`scripts/prompt-size.ts`).
//
// Сам замер — на локальной БД (канал владельца после сида) и, для токенов, живым вызовом
// провайдера; тестом он не покрывается. Покрываются два правила, по которым читают цифры
// таблицы бюджетов `docs/prd/01-architecture.md`:
//   - байты — это БАЙТЫ UTF-8, а не длина строки JS: канал на кириллице, и `.length` занизил
//     бы его почти вдвое (буква — два байта, а UTF-16-единица — одна);
//   - `--tokens` без провайдера — код 2 («не замерено»), а не 1 и не выдуманный ноль.
import { describe, expect, test } from 'bun:test';
import { main, measureBytes } from './prompt-size.ts';

describe('measureBytes: байты UTF-8 канала и JSON схем тулов', () => {
  test('кириллица — два байта на букву, а не одна единица .length', () => {
    const system = 'Ж'.repeat(10);
    expect(system.length).toBe(10);
    expect(measureBytes(system, []).layer1Bytes).toBe(20);
  });

  test('слой 5 — байты JSON-сериализации определений тулов, какими их получает провайдер', () => {
    const tools = [
      { name: 'entity_query', description: 'Поиск', inputSchema: { type: 'object' } },
      { name: 'budget_status', description: 'Бюджет', inputSchema: { type: 'object' } },
    ];
    const m = measureBytes('', tools);
    expect(m.layer5Bytes).toBe(Buffer.byteLength(JSON.stringify(tools), 'utf8'));
    expect(m.layer5Bytes).toBeGreaterThan(JSON.stringify(tools).length);
    expect(m.toolCount).toBe(2);
  });
});

describe('--tokens без провайдера — EXIT 2', () => {
  test('явный провайдер без ключа — «токены не замерены», до всякой БД', async () => {
    expect(await main(['--tokens'], { ORBIS_LLM_PROVIDER: 'openai' })).toBe(2);
  });

  test('echo — тоже 2: он не считает токены (inputTokens = 0), и ноль в таблице был бы ложью', async () => {
    expect(await main(['--tokens'], { ORBIS_LLM_PROVIDER: 'echo' })).toBe(2);
  });
});
