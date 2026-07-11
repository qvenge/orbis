// Интеграционные тесты реестра LLM/MCP-тулов (§9.2, §7.6): живая БД под withIdentity.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  attachAspectInput,
  BUILTIN_ASPECT_IDS,
  batchExecuteInput,
  budgetStatusInput,
  entityCreateInput,
  entityGetInput,
  entityQueryInput,
  entityUpdateInput,
  relationCreateInput,
  relationDeleteInput,
} from '@orbis/shared';
import { eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { aspectDefinitions } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { buildToolRegistry, type OrbisToolDef, threadPostInput, userQueryInput } from './registry';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const userB = freshUserId();

/** Кастомный аспект userA: id с '/' И '-' — проверка нормализации имени тула (решение 3). */
const CUSTOM_ASPECT_ID = 'user/sleep-log';
const CUSTOM_SCHEMA = {
  type: 'object',
  properties: { hours: { type: 'number' } },
  required: ['hours'],
  additionalProperties: false,
};

beforeAll(async () => {
  await truncateAll();
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.insert(aspectDefinitions).values({
      id: CUSTOM_ASPECT_ID,
      ownerId: userA,
      name: 'Sleep Log',
      namespace: 'user',
      description: 'Трекинг сна.',
      schema: CUSTOM_SCHEMA,
      aiInstructions: 'Пиши часы сна числом.',
      viewConfig: { keyFields: ['hours'] },
    });
  } finally {
    await adminClient.end();
  }
});

afterAll(async () => {
  await client.end();
});

function registryFor(userId: string): Promise<OrbisToolDef[]> {
  return withIdentity(db, userId, (tx) => buildToolRegistry(tx));
}

function defOf(defs: OrbisToolDef[], name: string): OrbisToolDef {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`тул «${name}» не найден в реестре`);
  return def;
}

const CORE_NAMES = [
  'entity_query',
  'entity_get',
  'entity_create',
  'entity_update',
  'relation_create',
  'relation_delete',
  'batch_execute',
  'user_query',
  'budget_status', // A6: read-агрегаты Budget (03-budget §4), доступен и MCP
] as const;

const BUILTIN_ATTACH_NAMES = BUILTIN_ASPECT_IDS.map(
  (id) => `attach_${id.replaceAll('/', '_').replaceAll('-', '_')}`,
);

describe('buildToolRegistry: состав (§9.2 + §7.6)', () => {
  test('builtin-реестр (userB без кастомных): 9 core + thread_post + 7 attach_* = 17', async () => {
    const defs = await registryFor(userB);
    const names = defs.map((d) => d.name);
    for (const name of CORE_NAMES) expect(names).toContain(name);
    expect(names).toContain('thread_post');
    for (const name of BUILTIN_ATTACH_NAMES) expect(names).toContain(name);
    expect(defs.length).toBe(17);
    // дублей имён нет
    expect(new Set(names).size).toBe(names.length);
  });

  test('имена тулов без «/» (и вообще только [a-z0-9_])', async () => {
    const defs = await registryFor(userA);
    for (const def of defs) {
      expect(def.name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  test('kind: entity_query/entity_get/user_query/budget_status — read, остальные — mutate', async () => {
    const defs = await registryFor(userB);
    for (const def of defs) {
      const expected = ['entity_query', 'entity_get', 'user_query', 'budget_status'].includes(
        def.name,
      )
        ? 'read'
        : 'mutate';
      expect(def.kind).toBe(expected);
    }
  });

  test('internalOnly: true только у user_query (§9.2: в публичный реестр не входит)', async () => {
    const defs = await registryFor(userB);
    for (const def of defs) {
      if (def.name === 'user_query') expect(def.internalOnly).toBe(true);
      else expect(def.internalOnly).not.toBe(true);
    }
  });

  test('entity_query: description содержит примеры грамматики §6 (fix round Task 8)', async () => {
    // Модель не видит спецификацию §6 — без примеров в description холодный резолв
    // category_ref (инструкция промпта v1) гарантированно бился бы о парсер
    const def = defOf(await registryFor(userB), 'entity_query');
    expect(def.description).toContain('aspect=orbis/category, search=Еда');
    expect(def.description).toContain(
      'aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, limit=20',
    );
  });
});

describe('buildToolRegistry: attach_* из реестра аспектов (§7.6)', () => {
  test('attach_orbis_task: description = ai_instructions из БД', async () => {
    const defs = await registryFor(userB);
    const rows = await withIdentity(db, userB, (tx) =>
      tx
        .select({ ai: aspectDefinitions.aiInstructions })
        .from(aspectDefinitions)
        .where(
          sql`${aspectDefinitions.id} = 'orbis/task' AND ${isNull(aspectDefinitions.ownerId)}`,
        ),
    );
    const expected = rows[0]?.ai;
    expect(expected).toBeTruthy();
    expect(defOf(defs, 'attach_orbis_task').description).toBe(expected as string);
  });

  test('attach_orbis_task: inputJsonSchema = envelope {entity_id, data: <схема аспекта из БД>}', async () => {
    const defs = await registryFor(userB);
    const rows = await withIdentity(db, userB, (tx) =>
      tx
        .select({ schema: aspectDefinitions.schema })
        .from(aspectDefinitions)
        .where(
          sql`${aspectDefinitions.id} = 'orbis/task' AND ${isNull(aspectDefinitions.ownerId)}`,
        ),
    );
    expect(defOf(defs, 'attach_orbis_task').inputJsonSchema).toEqual({
      type: 'object',
      properties: {
        entity_id: { type: 'string', format: 'uuid' },
        data: rows[0]?.schema as Record<string, unknown>,
      },
      required: ['entity_id', 'data'],
      additionalProperties: false,
    });
  });

  test('кастомный аспект userA: attach_user_sleep_log («/» и «-» → «_»), схема из БД; userB его не видит (RLS)', async () => {
    const defsA = await registryFor(userA);
    const def = defOf(defsA, 'attach_user_sleep_log');
    expect(def.kind).toBe('mutate');
    expect(def.description).toBe('Пиши часы сна числом.');
    expect((def.inputJsonSchema.properties as Record<string, unknown>).data).toEqual(CUSTOM_SCHEMA);
    expect(defsA.length).toBe(18);

    const defsB = await registryFor(userB);
    expect(defsB.some((d) => d.name === 'attach_user_sleep_log')).toBe(false);
  });
});

describe('парность zod-envelope ↔ рукописная JSON Schema (§9.2)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: доступ к .shape любого ZodObject
  const ZOD_BY_TOOL: Record<string, z.ZodObject<any>> = {
    entity_query: entityQueryInput,
    entity_get: entityGetInput,
    entity_create: entityCreateInput,
    entity_update: entityUpdateInput,
    relation_create: relationCreateInput,
    relation_delete: relationDeleteInput,
    batch_execute: batchExecuteInput,
    user_query: userQueryInput,
    budget_status: budgetStatusInput,
    thread_post: threadPostInput,
  };

  test('каждый ключ zod-схемы есть в JSON Schema и наоборот; required = не-optional ключи zod', async () => {
    const defs = await registryFor(userB);
    for (const [tool, zodSchema] of Object.entries(ZOD_BY_TOOL)) {
      const jsonSchema = defOf(defs, tool).inputJsonSchema;
      const props = Object.keys(jsonSchema.properties as Record<string, unknown>).sort();
      const zodKeys = Object.keys(zodSchema.shape).sort();
      expect({ tool, keys: props }).toEqual({ tool, keys: zodKeys });

      const required = [...((jsonSchema.required as string[] | undefined) ?? [])].sort();
      const zodRequired = zodKeys.filter((k) => !zodSchema.shape[k].isOptional()).sort();
      expect({ tool, required }).toEqual({ tool, required: zodRequired });
      // strict-режим zod ↔ additionalProperties: false
      expect({ tool, ap: jsonSchema.additionalProperties }).toEqual({ tool, ap: false });
    }
  });

  test('attach_*: top-level ключи JSON Schema = ключи attachAspectInput (envelope §9.2)', async () => {
    const defs = await registryFor(userB);
    const zodKeys = Object.keys(attachAspectInput.shape).sort();
    for (const def of defs.filter((d) => d.name.startsWith('attach_'))) {
      const props = Object.keys(def.inputJsonSchema.properties as Record<string, unknown>).sort();
      expect({ tool: def.name, keys: props }).toEqual({ tool: def.name, keys: zodKeys });
    }
  });

  test('собственное определение перекрывает builtin при коллизии id (ORDER BY owner_id NULLS FIRST)', async () => {
    // Кастомный orbis/note userA поверх builtin: attach_orbis_note берёт описание кастомного
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.insert(aspectDefinitions).values({
        id: 'orbis/note',
        ownerId: userA,
        name: 'Note (custom)',
        namespace: 'orbis',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        aiInstructions: 'Кастомная инструкция заметки.',
      });
      const defs = await registryFor(userA);
      expect(defOf(defs, 'attach_orbis_note').description).toBe('Кастомная инструкция заметки.');
      // имя не задублировано
      expect(defs.filter((d) => d.name === 'attach_orbis_note').length).toBe(1);
    } finally {
      await admin
        .delete(aspectDefinitions)
        .where(
          sql`${aspectDefinitions.id} = 'orbis/note' AND ${eq(aspectDefinitions.ownerId, userA)}`,
        );
      await adminClient.end();
    }
  });
});
