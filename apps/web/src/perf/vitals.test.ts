// «Сервер против сети» (спека скорости §3.1): запись Resource Timing запроса tRPC → замер `request`.
import { describe, expect, test } from 'vitest';
import { requestSampleOf } from './vitals';

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

  test('собственная отправка замеров и не-tRPC — не замер', () => {
    expect(requestSampleOf({ name: 'https://x/trpc/perf.report', duration: 5 })).toBeNull();
    expect(requestSampleOf({ name: 'https://x/assets/index.js', duration: 5 })).toBeNull();
  });
});
