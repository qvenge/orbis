// Сравнение реестра аспектов в БД с кодом — чистая половина стартовой проверки дрейфа
// (ловушка релиза, бэклоги фаз C и D). Серверная половина (чтение таблицы под ролью
// приложения) живёт в apps/server/src/db/aspect-drift.test.ts.
import { expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_META,
  canonicalJson,
  diffBuiltinAspects,
  hasAspectDrift,
} from './aspect-registry';
import { aspectJsonSchema } from './schemas/aspects';

/** Реестр «как после свежего пересева» — эталон, от которого отходим в каждом тесте. */
const seeded = () =>
  BUILTIN_ASPECT_META.map((m) => ({
    id: m.id as string,
    schema: aspectJsonSchema(m.id),
    aiInstructions: m.aiInstructions,
  }));

test('canonicalJson: порядок КЛЮЧЕЙ не значим (jsonb его не хранит)', () => {
  expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
  );
});

test('canonicalJson: порядок МАССИВА значим (enum/required в JSON Schema)', () => {
  expect(canonicalJson({ required: ['a', 'b'] })).not.toBe(canonicalJson({ required: ['b', 'a'] }));
});

test('свежий пересев — расхождений нет', () => {
  const drift = diffBuiltinAspects(seeded());
  expect(drift).toEqual({ missing: [], drifted: [] });
  expect(hasAspectDrift(drift)).toBe(false);
});

test('строка прошла через jsonb (ключи переставлены) — это НЕ дрейф', () => {
  // Ровно то, что делает PostgreSQL с jsonb: ключи возвращаются в своём порядке.
  const shuffled = seeded().map((r) => ({
    ...r,
    schema: Object.fromEntries(
      Object.entries(r.schema as Record<string, unknown>).reverse(),
    ) as unknown,
  }));
  expect(hasAspectDrift(diffBuiltinAspects(shuffled))).toBe(false);
});

test('аспекта нет в реестре — missing (релиз добавил аспект без пересева)', () => {
  const rows = seeded().filter((r) => r.id !== 'orbis/memory');
  expect(diffBuiltinAspects(rows)).toEqual({ missing: ['orbis/memory'], drifted: [] });
});

test('в схеме БД нет нового поля — drifted:[schema] (самый частый случай ловушки)', () => {
  const rows = seeded().map((r) =>
    r.id === 'orbis/financial'
      ? { ...r, schema: { ...(r.schema as Record<string, unknown>), properties: {} } }
      : r,
  );
  expect(diffBuiltinAspects(rows)).toEqual({
    missing: [],
    drifted: [{ id: 'orbis/financial', what: ['schema'] }],
  });
});

test('устарели ai_instructions — дрейф тоже (они уезжают в описания attach_*-тулов)', () => {
  const rows = seeded().map((r) =>
    r.id === 'orbis/task' ? { ...r, aiInstructions: 'старый текст' } : r,
  );
  expect(diffBuiltinAspects(rows)).toEqual({
    missing: [],
    drifted: [{ id: 'orbis/task', what: ['ai_instructions'] }],
  });
});

test('разошлись оба поля — оба и названы', () => {
  const rows = seeded().map((r) =>
    r.id === 'orbis/budget' ? { ...r, schema: {}, aiInstructions: 'старый текст' } : r,
  );
  expect(diffBuiltinAspects(rows)).toEqual({
    missing: [],
    drifted: [{ id: 'orbis/budget', what: ['schema', 'ai_instructions'] }],
  });
});

test('лишние КАСТОМНЫЕ строки реестра дрейфом не считаются', () => {
  const rows = [...seeded(), { id: 'user/fitness', schema: {}, aiInstructions: '' }];
  expect(hasAspectDrift(diffBuiltinAspects(rows))).toBe(false);
});
