import { expect, test } from 'bun:test';
import { entitySchema } from '../schemas/entity';
import { queryFixtures } from './fixtures';

// Фикстура, не проходящая собственную схему, бесполезна для golden- и контрактных тестов.
test('каждая query-фикстура проходит entitySchema, id уникальны', () => {
  for (const fixture of queryFixtures) {
    const result = entitySchema.safeParse(fixture);
    if (!result.success) {
      throw new Error(
        `Фикстура "${fixture.title}" не проходит entitySchema: ${result.error.message}`,
      );
    }
  }
  const ids = queryFixtures.map((f) => f.id);
  expect(new Set(ids).size).toBe(queryFixtures.length);
  expect(queryFixtures.length).toBeGreaterThanOrEqual(10);
});
