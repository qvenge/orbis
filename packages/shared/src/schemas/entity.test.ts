import { expect, test } from 'bun:test';
import { entitySchema } from './entity';

test('entitySchema принимает минимальную сущность и проставляет дефолты', () => {
  const e = entitySchema.parse({
    id: '018e4a2c-0000-7000-8000-000000000000',
    ownerId: '018e4a2c-0000-7000-8000-000000000001',
    title: 'Обед',
    createdAt: '2026-06-16T10:00:00Z',
    updatedAt: '2026-06-16T10:00:00Z',
  });
  expect(e.body).toBe('');
  expect(e.tags).toEqual([]);
  expect(e.archived).toBe(false);
});
