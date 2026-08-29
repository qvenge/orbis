// apps/server/src/registry/cache.test.ts
// Процессный кеш эффективных определений (§А10-1) против ЖИВОЙ базы: инвалидация версией,
// независимость владельцев, вытеснение, обход кеша пишущей транзакцией — и наблюдаемость
// дельты СКВОЗЬ реестр: скрытое дельтой поле обязано исчезнуть из `attach_*`-тула и из
// ответа `registry.effective` (форма web строится по нему, §А9-2).
//
// Дельты пишутся здесь прямым INSERT'ом ВМЕСТЕ с инкрементом версии в ОДНОЙ транзакции —
// операций реестра ещё нет (Задача 15), а инвариант §А10-1 уже есть, и фикстура обязана
// ему подчиняться так же, как боевой писатель: кеш отличает «до» от «после» только версией.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attachToolName, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import type { Tx } from '../db/with-identity';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import { buildToolDefs } from '../tools/registry';
import { createCallerFactory } from '../trpc';
import { effectiveRegistry, REGISTRY_CACHE_LIMIT, registryCacheStats } from './cache';
import { bumpOwnerRegistryVersion, readRegistryVersions } from './version';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

/** Дельта + инкремент версии ОДНОЙ транзакцией — тот же путь, что у боевого писателя. */
async function writeDelta(
  ownerId: string,
  targetKind: 'aspect' | 'property',
  targetId: string,
  delta: unknown,
): Promise<void> {
  await withIdentity(db, ownerId, async (tx) => {
    await insertDelta(tx, ownerId, targetKind, targetId, delta);
    await bumpOwnerRegistryVersion(tx, ownerId);
  });
}

async function insertDelta(
  tx: Tx,
  ownerId: string,
  targetKind: string,
  targetId: string,
  delta: unknown,
): Promise<void> {
  const base = (await readRegistryVersions(tx, ownerId)).systemVersion;
  await tx.execute(sql`
    INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
    VALUES (${newId()}, ${ownerId}::uuid, ${targetKind}, ${targetId}, ${base},
            ${JSON.stringify(delta)}::jsonb)
    ON CONFLICT (owner_id, target_kind, target_id) DO UPDATE SET delta = EXCLUDED.delta`);
}

async function deltaCount(ownerId: string): Promise<number> {
  const rows = (await withIdentity(db, ownerId, (tx) =>
    tx.execute(
      sql`SELECT count(*)::int AS n FROM registry_deltas WHERE owner_id = ${ownerId}::uuid`,
    ),
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function ownerVersion(ownerId: string): Promise<number> {
  return (await withIdentity(db, ownerId, (tx) => readRegistryVersions(tx, ownerId))).ownerVersion;
}

describe('версия реестра — в той же транзакции, что мутация (§А10-1)', () => {
  test('дельта и инкремент видны ВМЕСТЕ: внутри своей tx обе правки уже на месте', async () => {
    const owner = freshUserId();
    const before = await ownerVersion(owner);
    const inside = await withIdentity(db, owner, async (tx) => {
      await insertDelta(tx, owner, 'aspect', 'orbis/task', { label: { ru: 'Дело' } });
      const version = await bumpOwnerRegistryVersion(tx, owner);
      const reg = await effectiveRegistry(tx, owner);
      return { version, label: reg.aspects.get('orbis/task')?.label.ru };
    });
    expect(inside.version).toBe(before + 1);
    expect(inside.label).toBe('Дело');
    expect(await ownerVersion(owner)).toBe(before + 1);
  });

  test('откат уносит ОБЕ правки: ни дельты, ни сдвинутой версии не остаётся', async () => {
    const owner = freshUserId();
    const before = await ownerVersion(owner);
    await expect(
      withIdentity(db, owner, async (tx) => {
        await insertDelta(tx, owner, 'aspect', 'orbis/task', { label: { ru: 'Дело' } });
        await bumpOwnerRegistryVersion(tx, owner);
        throw new Error('падение после мутации реестра');
      }),
    ).rejects.toThrow('падение после мутации реестра');
    expect(await ownerVersion(owner)).toBe(before);
    expect(await deltaCount(owner)).toBe(0);
  });

  test('инкремент заводит строку настроек, если её не было: UPDATE не тронул бы ни одной', async () => {
    const owner = freshUserId();
    expect(await ownerVersion(owner)).toBe(0); // строки user_settings ещё нет
    await withIdentity(db, owner, (tx) => bumpOwnerRegistryVersion(tx, owner));
    expect(await ownerVersion(owner)).toBe(1);
  });
});

describe('кеш эффективных определений (§А10-1)', () => {
  test('второе чтение той же версии — попадание, чтение после мутации — промах и НОВЫЙ снимок', async () => {
    const owner = freshUserId();
    const first = registryCacheStats();
    const a = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
    const afterFirst = registryCacheStats();
    expect(afterFirst.misses).toBe(first.misses + 1);

    const b = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
    expect(registryCacheStats().hits).toBe(afterFirst.hits + 1);
    // Тот же ОБЪЕКТ, а не равный: снимок отдаётся из кеша, а не пересобирается.
    expect(b).toBe(a);

    await writeDelta(owner, 'aspect', 'orbis/task', { label: { ru: 'Дело' } });
    const c = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
    expect(c).not.toBe(a);
    expect(a.aspects.get('orbis/task')?.label.ru).toBe('Задача');
    expect(c.aspects.get('orbis/task')?.label.ru).toBe('Дело');
  });

  test('два владельца независимы: дельта одного не видна другому и не вытесняет его снимок', async () => {
    const mine = freshUserId();
    const neighbour = freshUserId();
    await writeDelta(mine, 'aspect', 'orbis/task', { label: { ru: 'Дело' } });
    const a = await withIdentity(db, mine, (tx) => effectiveRegistry(tx, mine));
    const b = await withIdentity(db, neighbour, (tx) => effectiveRegistry(tx, neighbour));
    expect(a.aspects.get('orbis/task')?.label.ru).toBe('Дело');
    expect(b.aspects.get('orbis/task')?.label.ru).toBe('Задача');
    // Соседский снимок читается из кеша и после чтения первого — ключи разные.
    const hits = registryCacheStats().hits;
    await withIdentity(db, mine, (tx) => effectiveRegistry(tx, mine));
    await withIdentity(db, neighbour, (tx) => effectiveRegistry(tx, neighbour));
    expect(registryCacheStats().hits).toBe(hits + 2);
  });

  test('размер кеша не растёт выше предела, а вытесненный владелец читается заново', async () => {
    const first = freshUserId();
    await withIdentity(db, first, (tx) => effectiveRegistry(tx, first));
    // Ещё REGISTRY_CACHE_LIMIT владельцев: первый обязан быть вытеснен как самый старый.
    for (let i = 0; i < REGISTRY_CACHE_LIMIT; i += 1) {
      const other = freshUserId();
      await withIdentity(db, other, (tx) => effectiveRegistry(tx, other));
    }
    expect(registryCacheStats().size).toBe(REGISTRY_CACHE_LIMIT);
    const misses = registryCacheStats().misses;
    await withIdentity(db, first, (tx) => effectiveRegistry(tx, first));
    expect(registryCacheStats().misses).toBe(misses + 1);
  }, 60_000);

  test('транзакция, которая уже писала, кеш ОБХОДИТ — и не читает его, и не наполняет', async () => {
    const owner = freshUserId();
    // Строка настроек нужна, чтобы запись ниже была именно UPDATE'ом, не меняющим версию.
    await withIdentity(db, owner, (tx) => bumpOwnerRegistryVersion(tx, owner));
    // Прогрев: снимок этой версии в кеше есть.
    await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
    const before = registryCacheStats();
    const size = before.size;

    await withIdentity(db, owner, async (tx) => {
      // Запись, не трогающая реестр: транзакции выдаётся xid, версия остаётся прежней.
      await tx.execute(sql`UPDATE user_settings SET timezone = timezone
                           WHERE owner_id = ${owner}::uuid`);
      await effectiveRegistry(tx, owner);
      await effectiveRegistry(tx, owner);
    });

    const after = registryCacheStats();
    expect(after.bypassed).toBe(before.bypassed + 2);
    expect(after.hits).toBe(before.hits); // из кеша не читали
    expect(after.size).toBe(size); // и в кеш не клали
  });
});

describe('дельта видна сквозь реестр: тул и форма (§А3-2, §А9-2)', () => {
  test('скрытое дельтой поле исчезает из attach_task и из registry.effective, добавленное — появляется', async () => {
    const owner = freshUserId();
    const caller = createCaller({
      actorUserId: owner,
      actorKind: 'owner',
      db,
      clientVersion: null,
    });

    const beforeTool = attachTaskProperties(
      await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner)),
    );
    expect(beforeTool).toContain('orbis/effort_min');
    expect(beforeTool).not.toContain('orbis/aliases');

    await writeDelta(owner, 'aspect', 'orbis/task', {
      properties: {
        hide: ['orbis/effort_min'],
        add: [{ propertyId: 'orbis/aliases', required: false, rank: 50 }],
      },
    });

    const afterTool = attachTaskProperties(
      await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner)),
    );
    expect(afterTool).not.toContain('orbis/effort_min');
    expect(afterTool).toContain('orbis/aliases');

    // Форма web строится по `registry.effective` — состав аспекта в ответе тот же самый.
    const wire = await caller.registry.effective();
    const ids = wire.aspects
      .find((a) => a.id === 'orbis/task')
      ?.properties.map((r) => r.propertyId);
    expect(ids).not.toContain('orbis/effort_min');
    expect(ids).toContain('orbis/aliases');
    // Версия ответа сдвинулась вместе с дельтой — клиент получил повод перечитать снимок.
    const versions = await withIdentity(db, owner, (tx) => readRegistryVersions(tx, owner));
    expect(wire.version).toBe(`${versions.systemVersion}.${versions.ownerVersion}`);
  });

  test('дельта подписи свойства доезжает до описания параметра attach_*-тула', async () => {
    const owner = freshUserId();
    await writeDelta(owner, 'property', 'orbis/priority', {
      label: { ru: 'Важность' },
      description: { ru: 'Насколько это срочно для меня' },
    });
    const defs = buildToolDefs(await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner)));
    const data = attachTaskData(defs);
    const field = (data.properties as Record<string, { description?: string }>)['orbis/priority'];
    expect(field?.description).toContain('Насколько это срочно для меня');
  });
});

/** Имена полей `data` тула attach_task — то, что модель реально увидит (§А9-1). */
function attachTaskProperties(reg: Awaited<ReturnType<typeof effectiveRegistry>>): string[] {
  return Object.keys(attachTaskData(buildToolDefs(reg)).properties as Record<string, unknown>);
}

function attachTaskData(
  defs: ReturnType<typeof buildToolDefs>,
): { properties: unknown } & Record<string, unknown> {
  const def = defs.find((d) => d.name === attachToolName('orbis/task'));
  if (def === undefined) throw new Error('в реестре тулов нет attach_task');
  const schema = def.inputJsonSchema as { properties: { data: Record<string, unknown> } };
  return schema.properties.data as { properties: unknown } & Record<string, unknown>;
}
