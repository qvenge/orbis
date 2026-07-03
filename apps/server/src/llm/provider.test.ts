import { expect, test } from 'bun:test';
import { EchoProvider } from './provider';

test('EchoProvider возвращает наши типы без tool-call', async () => {
  const p = new EchoProvider();
  const r = await p.chat({
    system: '',
    messages: [{ role: 'user', content: 'привет' }],
    tools: [],
    maxTokens: 100,
  });
  expect(r.content).toContain('привет');
  expect(r.toolCalls).toEqual([]);
  expect(r.stopReason).toBe('end_turn');
});
