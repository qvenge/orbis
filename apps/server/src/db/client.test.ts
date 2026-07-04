import { describe, expect, test } from 'bun:test';
import { makeDb } from './client';

describe('makeDb', () => {
  test('без DATABASE_URL бросает внятную ошибку, а не постгрес-таймаут', () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => makeDb()).toThrow(/DATABASE_URL/);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });
});
