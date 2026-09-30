import { describe, expect, test } from 'bun:test';
import { formatTable, type LabSample, percentile, summarize } from './summary';

const s = (metric: string, durMs: number, extra: Partial<LabSample> = {}): LabSample => ({
  metric,
  durMs,
  repeat: 1,
  ...extra,
});

/** Разделители ячеек markdown — `|` без обратной косой перед ним. */
const cellBorders = (line: string) => line.match(/(?<!\\)\|/g)?.length ?? 0;

describe('лаборатория: сводка', () => {
  test('перцентиль — линейная интерполяция, как percentile_cont', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.75)).toBe(32.5);
    expect(percentile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5);
    expect(percentile([7], 0.95)).toBe(7);
  });
  test('группы — метрика, вид, кеш', () => {
    const sum = summarize([
      s('transition', 100, { kind: 'repeat', cached: true }),
      s('transition', 300, { kind: 'repeat', cached: true }),
      s('transition', 900, { kind: 'first', cached: false }),
    ]);
    expect(sum['transition|repeat|кеш']).toEqual({ n: 2, p50: 200, p75: 250, p95: 290 });
    expect(sum['transition|first|сеть']?.n).toBe(1);
  });
  test('нечисловые и отрицательные замеры отброшены и названы числом (JSON превращает NaN в null)', () => {
    const sum = summarize([
      s('action_confirmed', 40, { kind: 'checkbox' }),
      s('action_confirmed', Number.NaN, { kind: 'checkbox' }),
      s('action_confirmed', -12, { kind: 'checkbox' }),
      s('action_confirmed', null as unknown as number, { kind: 'checkbox' }),
    ]);
    expect(sum['action_confirmed|checkbox|-']).toEqual({
      n: 1,
      p50: 40,
      p75: 40,
      p95: 40,
      dropped: 3,
    });
    const onlyBad = summarize([s('lcp', Number.NaN, { kind: 'empty' })]);
    expect(onlyBad['lcp|empty|-']?.n).toBe(0);
    expect(onlyBad['lcp|empty|-']?.dropped).toBe(1);
    const t = formatTable(sum, null);
    expect(t).toContain('| action_confirmed\\|checkbox\\|- | 1 | 40 | 40 | 40 | 40 | 3 |');
  });
  test('таблица против целей §0.3: цель, база, сейчас, итог; нет данных — названо', () => {
    const base = summarize([s('transition', 400, { kind: 'repeat', cached: true })]);
    const after = summarize([s('transition', 80, { kind: 'repeat', cached: true })]);
    const t = formatTable(base, after);
    expect(t).toContain(
      '| Повторный переход на открывавшийся экран | transition\\|repeat\\|кеш | < 100 мс | 400 | 80 | да |',
    );
    expect(t).toContain('Правка агента видна на открытом экране'); // цель 3 — не лабораторная
    expect(t).toMatch(/action_visible\\\|checkbox\\\|- \| < 50 мс \| нет данных/);
    // цель 5 «не медленнее базы»: равенство — «да»
    const same = summarize([s('transition', 500, { kind: 'first', cached: false })]);
    expect(formatTable(same, same)).toContain(
      '| transition\\|first\\|сеть | ≤ базы | 500 | 500 | да |',
    );
  });
  test('таблица отрисовывается markdown: `|` в ячейках экранирован, у строки столько же границ, сколько у шапки', () => {
    const sum = summarize([
      s('transition', 80, { kind: 'repeat', cached: true }),
      s('action_visible', 30, { kind: 'subtask' }),
    ]);
    const tables = formatTable(sum, sum).split('\n\n');
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      const [head, ...rows] = table.split('\n');
      for (const row of rows) expect(cellBorders(row)).toBe(cellBorders(head ?? ''));
    }
  });
});
