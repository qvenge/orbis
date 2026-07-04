import { describe, expect, test } from 'bun:test';
import { ASPECT_SCHEMAS, aspectJsonSchema } from './aspects';

describe('схемы аспектов (01 §3.1–§3.7)', () => {
  test('orbis/task: полный и минимальный валидны; статус вне enum — нет', () => {
    const s = ASPECT_SCHEMAS['orbis/task'];
    expect(s.safeParse({ status: 'inbox' }).success).toBe(true);
    expect(
      s.safeParse({
        status: 'done',
        priority: 'high',
        due_date: '2026-07-10',
        completed_at: '2026-07-03T10:00:00Z',
        effort_min: 30,
        waiting_for: 'ответ',
      }).success,
    ).toBe(true);
    expect(s.safeParse({ status: 'todo' }).success).toBe(false);
    expect(s.safeParse({}).success).toBe(false); // status обязателен
  });
  test('orbis/financial: amount — положительная decimal-строка, number запрещён', () => {
    const s = ASPECT_SCHEMAS['orbis/financial'];
    const base = {
      direction: 'expense',
      category_ref: crypto.randomUUID(),
      occurred_on: '2026-07-03',
    };
    expect(s.safeParse({ ...base, amount: '340.00' }).success).toBe(true);
    expect(s.safeParse({ ...base, amount: 340 }).success).toBe(false);
    expect(s.safeParse({ ...base, amount: '-1.00' }).success).toBe(false);
    expect(s.safeParse({ ...base, amount: '0' }).success).toBe(false);
    expect(s.safeParse({ ...base, amount: '3.4e2' }).success).toBe(false);
  });
  test('orbis/schedule: start_at обязателен; recurrence — структурный объект', () => {
    const s = ASPECT_SCHEMAS['orbis/schedule'];
    expect(s.safeParse({ start_at: '2026-07-05T09:00:00+03:00' }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(
      s.safeParse({
        start_at: '2026-07-05T09:00:00+03:00',
        recurrence: { freq: 'weekly', interval: 1, byweekday: ['mo'] },
      }).success,
    ).toBe(true);
    expect(
      s.safeParse({
        start_at: '2026-07-05T09:00:00+03:00',
        recurrence: { freq: 'yearly', interval: 1 },
      }).success,
    ).toBe(false);
  });
  test('orbis/budget: carryover может быть отрицательным, limit — нет', () => {
    const s = ASPECT_SCHEMAS['orbis/budget'];
    const base = {
      category_ref: crypto.randomUUID(),
      limit: '30000.00',
      period_start: '2026-06-01',
      period_end: '2026-06-30',
    };
    expect(s.safeParse({ ...base, carryover: '-1200.00' }).success).toBe(true);
    expect(s.safeParse({ ...base, limit: '-1.00' }).success).toBe(false);
  });
  test('orbis/memory: kind обязателен', () => {
    expect(
      ASPECT_SCHEMAS['orbis/memory'].safeParse({ kind: 'rule', scope: 'orbis/financial' }).success,
    ).toBe(true);
    expect(ASPECT_SCHEMAS['orbis/memory'].safeParse({}).success).toBe(false);
  });
  test('orbis/note и orbis/category: пустой объект валиден (все поля опциональны)', () => {
    expect(ASPECT_SCHEMAS['orbis/note'].safeParse({}).success).toBe(true);
    expect(ASPECT_SCHEMAS['orbis/category'].safeParse({}).success).toBe(true);
  });
  test('неизвестные ключи отклоняются (strict) — защита от опечаток в meta→aspects', () => {
    expect(
      ASPECT_SCHEMAS['orbis/task'].safeParse({ status: 'inbox', prioritty: 'high' }).success,
    ).toBe(false);
  });
  test('JSON Schema: enum-порядок сохранён (сортировка §6.1)', () => {
    const js = aspectJsonSchema('orbis/task') as {
      properties: { status: { enum: string[] }; priority: { enum: string[] } };
      required: string[];
    };
    expect(js.properties.status.enum).toEqual([
      'inbox',
      'planned',
      'in_progress',
      'waiting',
      'done',
      'cancelled',
    ]);
    expect(js.properties.priority.enum).toEqual(['low', 'medium', 'high']);
    expect(js.required).toContain('status');
  });
});
