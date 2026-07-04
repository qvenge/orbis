// apps/server/src/export.test.ts
// Интеграционные тесты Task 13: экспорт графа (01 §9.4, D8) через createCallerFactory.
// Все чтения — одним withIdentity-tx, RLS ограничивает владельцем; встроенные аспекты
// НЕ экспортируются (только owner_id = актор).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entitySchema } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../test/helpers';
import { appRouter } from './router';
import { createCallerFactory } from './trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

function callerFor(user: string) {
  return createCaller({ actorUserId: user, db });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('user.exportData (§9.4)', () => {
  test('после сидирования: 15 сущностей, настройки, глобальный тред, 0 aspectDefinitions', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const exp = await caller.user.exportData();
    expect(exp.format).toBe('orbis-export');
    expect(exp.version).toBe(1);
    expect(typeof exp.exportedAt).toBe('string');
    expect(exp.exportedAt.endsWith('Z')).toBe(true);

    expect(exp.entities.length).toBe(15);
    for (const e of exp.entities) expect(() => entitySchema.parse(e)).not.toThrow();

    expect(exp.userSettings).not.toBeNull();
    expect(exp.userSettings?.timezone).toBe('Europe/Moscow');

    expect(exp.chatThreads.length).toBe(1);
    expect(exp.chatThreads[0]?.entityId).toBeNull(); // глобальный тред

    // Встроенные аспекты не экспортируются §9.4 (кастомных нет → 0)
    expect(exp.aspectDefinitions.length).toBe(0);
  });

  test('экспорт другого пользователя (без сидирования) — пуст (RLS скоупит владельцем)', async () => {
    const caller = callerFor(freshUserId());
    const exp = await caller.user.exportData();
    expect(exp.entities).toEqual([]);
    expect(exp.relations).toEqual([]);
    expect(exp.chatThreads).toEqual([]);
    expect(exp.chatMessages).toEqual([]);
    expect(exp.userSettings).toBeNull();
    expect(exp.aspectDefinitions).toEqual([]);
  });
});
