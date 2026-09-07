// apps/server/test/gate-c8-18.test.ts
// Гейт части Б (§С8-18, ревизия 3): два пользовательских аспекта, заведённых ТОЛЬКО декларацией,
// участвуют в четырёх потребителях без строки кода под них. Четыре утверждения помечены
// `test.failing`: сегодня они ложны, и каждое переводит в `test` та задача вехи I, которая его
// зеленит (4 — excludeBlocked, 6 — Agenda, 7 — строка M14, 9 — spent; Р-К-9). Задача 10 проверяет,
// что `test.failing` в файле не осталось, и снимает греп-доказательство.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { withIdentity } from '../src/db/with-identity';
import { effectiveRegistry } from '../src/registry/cache';
import { appRouter } from '../src/router';
import { createCallerFactory } from '../src/trpc';
import {
  GATE_ASPECT_KEYS,
  GATE_FIN_ASPECT,
  GATE_PLAIN_ASPECT,
  GATE_PROPS,
  type GateWorld,
  seedGateWorld,
} from './fixtures/gate-aspects';
import { adminDb, appDb, freshUserId, requireEnv, seedCustomAspect, truncateAll } from './helpers';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

describe('фикстура гейта: хелпер пишет привязки', () => {
  test('seedCustomAspect кладёт implements и module — и ПЕРЕЗАПИСЫВАЕТ их при повторном севе', async () => {
    // ДВА утверждения, и оба обязательны (Р-К-53).
    // ПЕРВОЕ — после первого сева: сегодня хелпер `spec.implements`/`spec.module` не читает ВОВСЕ,
    // в INSERT стоят литералы `'[]'::jsonb` и `NULL`. Красным шаг делает именно оно.
    // ВТОРОЕ — после повторного, ловушка Р12: `ON CONFLICT … DO UPDATE SET` колонок
    // `implements`/`module` не перечисляет, и фикстура гейта, севшая дважды в одном прогоне,
    // вернула бы первую версию привязок. Одного второго мало: до правки оно ЗЕЛЁНОЕ — в базе и так
    // `[]` и NULL, но не потому, что хелпер их записал, а потому, что он записал литералы.
    const user = freshUserId();
    const spec = {
      key: 'user/impl-probe',
      label: { ru: 'Проба' },
      properties: [{ key: 'probe_flag', type: { kind: 'boolean' } as const }],
      module: 'finance' as string | null,
      implements: [
        { contract: 'orbis/completable', bind: { status: 'user/probe_flag' } },
      ] as unknown[],
    };
    const { db: adb, client: ac } = adminDb();
    // Чтение СЫРОЕ (jsonb как лежит), без zod: умолчания формы привязки подставляет схема задачи 2,
    // а здесь проверяется ровно то, что хелпер записал.
    const read = async (): Promise<{ implements: unknown[]; module: string | null } | undefined> =>
      (
        (await adb.execute(sql`SELECT implements, module FROM aspect_definitions
        WHERE owner_id = ${user} AND id = 'user/impl-probe'`)) as unknown as Array<{
          implements: unknown[];
          module: string | null;
        }>
      )[0];
    try {
      await seedCustomAspect(user, spec);
      const first = await read();
      expect(first?.implements).toEqual([
        { contract: 'orbis/completable', bind: { status: 'user/probe_flag' } },
      ]);
      expect(first?.module).toBe('finance');

      await seedCustomAspect(user, { ...spec, implements: [] as unknown[], module: null });
      const second = await read();
      expect(second?.implements).toEqual([]);
      expect(second?.module).toBeNull();
    } finally {
      await ac.end();
    }
  });
});

describe('фикстура гейта: два аспекта заведены только декларацией', () => {
  test('оба аспекта и восемь их свойств видны в снимке реестра владельца', async () => {
    const user = freshUserId();
    await seedCustomAspect(user, GATE_FIN_ASPECT);
    await seedCustomAspect(user, GATE_PLAIN_ASPECT);
    const reg = await withIdentity(db, user, (tx) => effectiveRegistry(tx, user));
    expect(GATE_ASPECT_KEYS.every((k) => reg.aspects.has(k))).toBe(true);
    for (const id of Object.values(GATE_PROPS)) expect(reg.properties.has(id)).toBe(true);
    // Привязки доехали до снимка как данные: на вехе 0 их никто не читает, и это ровно то,
    // что гейт обязан изменить — читателем станет реестр контрактов (задачи 1–2).
    expect((reg.aspects.get(GATE_ASPECT_KEYS[0])?.implements ?? []).length).toBe(3);
    expect((reg.aspects.get(GATE_ASPECT_KEYS[1])?.implements ?? []).length).toBe(2);
  });
});

const owner = freshUserId();
let world: GateWorld;
const createCaller = createCallerFactory(appRouter);
const callerFor = (user: string) =>
  createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });

beforeAll(async () => {
  await truncateAll();
  await seedCustomAspect(owner, GATE_FIN_ASPECT);
  await seedCustomAspect(owner, GATE_PLAIN_ASPECT);
  world = await seedGateWorld(owner);
});

describe('гейт §С8-18: аспект только декларацией', () => {
  test('обстановка гейта на месте: конверт, трата, два дела, блокеры и сущность §С8-21', async () => {
    const ids = new Set(
      (await callerFor(owner).entity.query({ query: 'sortBy=orbis/title:asc, limit=50' })).map(
        (e) => e.id,
      ),
    );
    for (const id of [
      world.envelopeId,
      world.finId,
      world.windowId,
      world.overdueId,
      world.blockedId,
      world.blockerClosedId,
      world.blockedOpenId,
      world.blockerOpenId,
      world.ambiguousId,
    ])
      expect(ids.has(id)).toBe(true);
  });
});
