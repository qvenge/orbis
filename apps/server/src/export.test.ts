// apps/server/src/export.test.ts
// Интеграционные тесты Task 13: экспорт графа (01 §9.4, §С5, D8) через createCallerFactory.
// Все чтения — одним withIdentity-tx, RLS ограничивает владельцем; встроенные строки
// реестров НЕ экспортируются (только owner_id = актор).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  aspectDefinitionSchema,
  entitySchema,
  propertyDefinitionSchema,
  relationRoleDefinitionSchema,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../test/helpers';
import { appRouter } from './router';
import { createCallerFactory } from './trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('user.exportData (§9.4)', () => {
  test('после сидирования: 18 сущностей, настройки, глобальный тред, 0 aspectDefinitions', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const exp = await caller.user.exportData();
    expect(exp.format).toBe('orbis-export');
    // Версия 2 — не косметика: сущности едут НОВОЙ формой (§А1-1), и читатель обязан уметь
    // отличить её от дампа v1, где та же запись описана несовместимо (карта аспектов).
    expect(exp.version).toBe(2);
    expect(typeof exp.exportedAt).toBe('string');
    expect(exp.exportedAt.endsWith('Z')).toBe(true);

    expect(exp.entities.length).toBe(18);
    for (const e of exp.entities) {
      expect(() => entitySchema.parse(e)).not.toThrow();
      // Форма — новая и ТОЛЬКО новая: старой карты и мешка `meta` в дампе нет вовсе.
      expect('aspectsMap' in e).toBe(false);
      expect('meta' in e).toBe(false);
    }
    // Значения адресованы id свойства, а не парой «аспект + поле»: сидированная категория
    // «Еда» несёт `orbis/icon` — на старой форме этого ключа в дампе не было бы.
    const food = exp.entities.find((e) => e.title === 'Еда');
    expect(food?.props['orbis/icon']).toBe('🍔');
    expect(food?.aspects).toContain('orbis/category');

    expect(exp.userSettings).not.toBeNull();
    expect(exp.userSettings?.timezone).toBe('Europe/Moscow');

    expect(exp.chatThreads.length).toBe(1);
    expect(exp.chatThreads[0]?.entityId).toBeNull(); // глобальный тред

    // Встроенные строки реестров не экспортируются §С5 (своих у владельца нет → 0).
    // Все три реестра, а не один: молчаливо потерять свой словарь так же дорого, как граф.
    expect(exp.propertyDefinitions).toEqual([]);
    expect(exp.aspectDefinitions).toEqual([]);
    expect(exp.relationRoleDefinitions).toEqual([]);
  });

  /**
   * ROUND-TRIP дампа v2: то, что выгрузилось, разбирается ОБРАТНО каноническими схемами —
   * теми же, которыми реестр и граф читает сервер.
   *
   * Проверяется именно ОБРАТНЫЙ разбор, а не «поля на месте»: схемы `z.object` срезают всё,
   * чего в них нет, и сверка «разобранное === выгруженное» ловит две беды разом — лишний
   * ключ, который переживёт выгрузку и потеряется на чтении, и недостающий, без которого
   * запись не соберётся. Первое и есть то, чем была старая карта в дампе v1.
   *
   * Фикстура несёт СВОЮ строку реестра владельца: без неё все три списка пусты, и
   * round-trip был бы истинным на пустом месте.
   */
  test('дамп v2 читается обратно: сущности и строки реестров владельца разбираются каноном', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    // Свои строки владельца — прямым INSERT'ом от админа: операций реестра в срезе А ещё
    // нет (они — Задача 15), а дамп обязан уметь выгрузить строки, которые уже бывают.
    // По одной в КАЖДЫЙ из трёх реестров: на пустом списке цикл сверки ниже был бы истинным
    // ни о чём, и потерянный реестр прошёл бы незамеченным (гейт-ревью 13c, Minor-4).
    const propertyId = crypto.randomUUID();
    const aspectId = crypto.randomUUID();
    const roleId = crypto.randomUUID();
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.execute(sql`
        INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
        VALUES (${propertyId}, ${user}::uuid, 'user/sleep-hours',
                ${JSON.stringify({ ru: 'Часов сна', en: 'Sleep hours' })}::jsonb,
                ${JSON.stringify({ ru: 'Сколько спал', en: 'How long the sleep was' })}::jsonb,
                ${JSON.stringify({ kind: 'number' })}::jsonb, 1000)`);
      await admin.execute(sql`
        INSERT INTO aspect_definitions
          (id, owner_id, key, label, description, properties, tag_mappings, view_config, rank)
        VALUES (${aspectId}, ${user}::uuid, 'user/sleep-log',
                ${JSON.stringify({ ru: 'Сон', en: 'Sleep' })}::jsonb,
                ${JSON.stringify({ ru: 'Запись о сне', en: 'A sleep record' })}::jsonb,
                ${JSON.stringify([{ propertyId, required: false, rank: 10 }])}::jsonb,
                '{}'::text[], ${JSON.stringify({ keyFields: [propertyId] })}::jsonb, 1000)`);
      await admin.execute(sql`
        INSERT INTO relation_role_definitions
          (id, owner_id, key, label, description, source_label, target_label, rank)
        VALUES (${roleId}, ${user}::uuid, 'sleeps-after',
                ${JSON.stringify({ ru: 'Сон после', en: 'Sleeps after' })}::jsonb,
                ${JSON.stringify({ ru: 'Своя роль владельца', en: "The owner's own role" })}::jsonb,
                ${JSON.stringify({ ru: 'Событие', en: 'Event' })}::jsonb,
                ${JSON.stringify({ ru: 'Сон', en: 'Sleep' })}::jsonb, 1000)`);
    } finally {
      await adminClient.end();
    }

    const exp = await caller.user.exportData();
    // Ровно по одной строке в каждом реестре: встроенные (их под сотню) в дамп не попали.
    expect(exp.propertyDefinitions.map((r) => r.key)).toEqual(['user/sleep-hours']);
    expect(exp.aspectDefinitions.map((r) => r.key)).toEqual(['user/sleep-log']);
    expect(exp.relationRoleDefinitions.map((r) => r.key)).toEqual(['sleeps-after']);
    for (const row of [
      ...exp.propertyDefinitions,
      ...exp.aspectDefinitions,
      ...exp.relationRoleDefinitions,
    ]) {
      expect(row.ownerId).toBe(user);
    }

    for (const row of exp.propertyDefinitions) {
      expect(propertyDefinitionSchema.parse(row)).toEqual(row);
    }
    for (const row of exp.aspectDefinitions) {
      expect(aspectDefinitionSchema.parse(row)).toEqual(row);
    }
    for (const row of exp.relationRoleDefinitions) {
      expect(relationRoleDefinitionSchema.parse(row)).toEqual(row);
    }
    for (const e of exp.entities) {
      expect(entitySchema.parse(e)).toEqual(e);
    }
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
