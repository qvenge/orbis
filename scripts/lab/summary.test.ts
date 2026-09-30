import { describe, expect, test } from 'bun:test';
import { formatTable, type LabSample, percentile, summarize } from './summary';

const s = (metric: string, durMs: number, extra: Partial<LabSample> = {}): LabSample => ({
  metric,
  durMs,
  repeat: 1,
  ...extra,
});

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
  test('таблица против целей §0.3: цель, база, сейчас, итог; нет данных — названо', () => {
    const base = summarize([s('transition', 400, { kind: 'repeat', cached: true })]);
    const after = summarize([s('transition', 80, { kind: 'repeat', cached: true })]);
    const t = formatTable(base, after);
    expect(t).toContain(
      '| Повторный переход на открывавшийся экран | transition|repeat|кеш | < 100 мс | 400 | 80 | да |',
    );
    expect(t).toContain('Правка агента видна на открытом экране'); // цель 3 — не лабораторная
    expect(t).toMatch(/action_visible\|checkbox\|- \| < 50 мс \| нет данных/);
    // цель 5 «не медленнее базы»: равенство — «да»
    const same = summarize([s('transition', 500, { kind: 'first', cached: false })]);
    expect(formatTable(same, same)).toContain(
      '| transition|first|сеть | ≤ базы | 500 | 500 | да |',
    );
  });
});
