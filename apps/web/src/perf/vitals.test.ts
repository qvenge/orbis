// «Сервер против сети» (спека скорости §3.1): запись Resource Timing запроса tRPC → замер `request`.
import { describe, expect, test } from 'vitest';
import { procedureListOf, requestSampleOf } from './vitals';

describe('perf/vitals: requestSampleOf', () => {
  test('пачка tRPC — процедуры без входа, длительность, время сервера и базы из Server-Timing', () => {
    expect(
      requestSampleOf({
        name: 'https://x/trpc/entity.get,entity.query?batch=1&input=%7B%220%22%3A%7B%22id%22%3A%22a%22%7D%7D',
        duration: 120,
        serverTiming: [
          { name: 'app', duration: 40 },
          { name: 'db', duration: 25 },
        ],
      }),
    ).toEqual({
      metric: 'request',
      procedure: 'entity.get,entity.query',
      durMs: 120,
      serverMs: 40,
      dbMs: 25,
    });
  });

  test('без Server-Timing — только длительность', () => {
    expect(requestSampleOf({ name: 'https://x/trpc/entity.get', duration: 12.345 })).toEqual({
      metric: 'request',
      procedure: 'entity.get',
      durMs: 12.3,
    });
  });

  test('крупная пачка не теряется (M-5): повторы имён убраны, длинный список обрезан по имени с запятой в конце', () => {
    const blocks = Array.from({ length: 40 }, () => 'entity.blocks').join(',');
    expect(
      requestSampleOf({
        name: `https://x/trpc/entity.get,${blocks},registry.effective`,
        duration: 300,
      }),
    ).toEqual({
      metric: 'request',
      procedure: 'entity.get,entity.blocks,registry.effective',
      durMs: 300,
    });
    const many = Array.from(
      { length: 30 },
      (_, i) => `module.procedure${String.fromCharCode(97 + (i % 26))}${i >= 26 ? 'x' : ''}`,
    );
    const out = procedureListOf(many);
    expect(out).not.toBeNull();
    expect(out?.length).toBeLessThanOrEqual(200);
    expect(out?.endsWith(',')).toBe(true);
    expect(out?.split(',').filter(Boolean)).toEqual(
      many.slice(0, out?.split(',').filter(Boolean).length),
    );
    expect(/^[a-zA-Z.,]{1,200}$/.test(out ?? '')).toBe(true);
  });

  test('имя вне маски схемы — не замер', () => {
    expect(procedureListOf(['entity.get', 'x1'])).toBeNull();
    expect(requestSampleOf({ name: 'https://x/trpc/entity%2Zget', duration: 5 })).toBeNull();
  });

  test('собственная отправка замеров и не-tRPC — не замер', () => {
    expect(requestSampleOf({ name: 'https://x/trpc/perf.report', duration: 5 })).toBeNull();
    expect(requestSampleOf({ name: 'https://x/assets/index.js', duration: 5 })).toBeNull();
  });
});
