// apps/server/src/registry/load.test.ts
// Снимок эффективных реестров владельца против живой БД: система ⊕ свои, перекрытие по id,
// обе версии. Дельты — Задача 14.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_IDS, BUILTIN_PROPERTY_META, RELATION_ROLE_IDS } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  freshUserId,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { bumpOwnerRegistryVersion } from '../registry/version';
import { effectiveRegistry } from './cache';

requireEnv();

/**
 * Имя constraint'а, на котором отказала вставка. Drizzle заворачивает ошибку драйвера в
 * свою («Failed query: …»), и текст обёртки имени НЕ содержит — совпадение по нему было бы
 * ложно-зелёным на любом отказе. Точное имя лежит в `cause` от postgres.js, и проверять
 * надо именно его: тест обязан доказать, что сработал ТОТ индекс, а не какой-нибудь.
 */
async function failedConstraint(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    const cause = (e as { cause?: { constraint_name?: string } }).cause;
    return cause?.constraint_name ?? `без имени constraint: ${String(e)}`;
  }
  throw new Error('ожидался отказ уникальности, но вставка прошла');
}

const { db, client } = appDb();
const owner = freshUserId();
const stranger = freshUserId();

beforeAll(async () => {
  await truncateAll();
  await seedCustomAspect(owner, {
    key: 'user/sleep-log',
    label: { ru: 'Сон', en: 'Sleep' },
    aiInstructions: 'Часы сна числом.',
    properties: [{ key: 'hours', type: { kind: 'number' }, required: true }],
  });
  await seedCustomAspect(stranger, {
    key: 'user/mood',
    label: { ru: 'Настроение', en: 'Mood' },
    properties: [{ key: 'level', type: { kind: 'number' } }],
  });
});

afterAll(async () => {
  await truncateAll();
  await client.end();
});

test('снимок несёт систему целиком: 77 свойств, 13 аспектов, 11 ролей', async () => {
  const snap = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
  for (const p of BUILTIN_PROPERTY_META) expect(snap.properties.has(p.id)).toBe(true);
  for (const id of BUILTIN_ASPECT_IDS) expect(snap.aspects.has(id)).toBe(true);
  for (const id of RELATION_ROLE_IDS) expect(snap.roles.has(id)).toBe(true);
  // Строки разобраны строгими схемами shared, а не просто прочитаны: тип свойства обязан
  // быть объектом словаря §А2-2, иначе `parse` бросил бы ещё в загрузчике.
  expect(snap.properties.get('orbis/amount')?.type).toEqual({ kind: 'decimal', exclusiveMin: '0' });
  expect(snap.roles.get('subitem')?.hierarchical).toBe(true);
  expect(snap.aspects.get('orbis/agent-run')?.service).toBe(true);
});

test('система ⊕ СВОИ: свой аспект и его свойства видны, чужие — нет (RLS)', async () => {
  const snap = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
  expect(snap.aspects.get('user/sleep-log')?.ownerId).toBe(owner);
  expect(snap.properties.get('user/hours')?.ownerId).toBe(owner);
  // Чужой аспект того же namespace невидим — его отсекает не фильтр запроса, а политика.
  expect(snap.aspects.has('user/mood')).toBe(false);
  expect(snap.properties.has('user/level')).toBe(false);
});

/**
 * Своя строка с ТЕМ ЖЕ id, что у встроенной, законна и перекрывает её — на этом стоит
 * сегодняшнее переопределение аспекта (`registry.test.ts`) и будущая дельта. Частичные
 * уникальности разведены по `owner_id IS NULL` / `IS NOT NULL` ровно ради этого.
 */
test('своё определение с id встроенного ПЕРЕКРЫВАЕТ его (ORDER BY owner_id NULLS FIRST)', async () => {
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.execute(sql`
      INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
      VALUES ('orbis/priority', ${owner}::uuid, 'orbis/priority', '{"ru":"Важность"}'::jsonb,
              '{"ru":"Своя важность"}'::jsonb, '{"kind":"text"}'::jsonb, 1)`);
    await bumpOwnerRegistryVersion(admin, owner); // мутация реестра двигает версию (§А10-1)
    const snap = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
    const overridden = snap.properties.get('orbis/priority');
    expect(overridden?.ownerId).toBe(owner);
    expect(overridden?.label.ru).toBe('Важность');
    // Ровно одна запись под этим id — снимок не задваивает.
    expect([...snap.properties.keys()].filter((k) => k === 'orbis/priority').length).toBe(1);

    // ВТОРАЯ своя строка с тем же id — вот это отказ уникальности (`*_custom_uniq`).
    expect(
      await failedConstraint(async () => {
        await admin.execute(sql`
          INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
          VALUES ('orbis/priority', ${owner}::uuid, 'orbis/priority-2', '{"ru":"Дубль"}'::jsonb,
                  '{"ru":"Дубль"}'::jsonb, '{"kind":"text"}'::jsonb, 2)`);
      }),
    ).toBe('property_definitions_custom_uniq');
  } finally {
    await admin.execute(
      sql`DELETE FROM property_definitions WHERE id = 'orbis/priority' AND owner_id IS NOT NULL`,
    );
    await adminClient.end();
  }
});

test('key уникален среди СВОИХ: два свойства владельца с одним key — отказ', async () => {
  const { db: admin, client: adminClient } = adminDb();
  try {
    expect(
      await failedConstraint(async () => {
        await admin.execute(sql`
          INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
          VALUES ('user/dup-a', ${owner}::uuid, 'user/dup', '{"ru":"А"}'::jsonb,
                  '{"ru":"А"}'::jsonb, '{"kind":"text"}'::jsonb, 1),
                 ('user/dup-b', ${owner}::uuid, 'user/dup', '{"ru":"Б"}'::jsonb,
                  '{"ru":"Б"}'::jsonb, '{"kind":"text"}'::jsonb, 2)`);
      }),
    ).toBe('property_definitions_custom_key');
  } finally {
    await admin.execute(sql`DELETE FROM property_definitions WHERE owner_id = ${owner}::uuid
                            AND key = 'user/dup'`);
    await adminClient.end();
  }
});

test('версии: системная — из registry_system, владельца — из user_settings (0 без строки)', async () => {
  // СВОЙ владелец, а не общий `owner` файла: у того строку настроек уже завёл инкремент
  // версии, которым сопровождается всякая мутация реестра (§А10-1), — а проверяется здесь
  // ровно случай «строки настроек нет вовсе».
  const virgin = freshUserId();
  const noSettings = await withIdentity(db, virgin, (tx) => effectiveRegistry(tx, virgin));
  expect(noSettings.systemVersion).toBeGreaterThan(0); // сид db:prepare уже был
  expect(noSettings.ownerVersion).toBe(0); // строки настроек у владельца нет

  await withIdentity(db, virgin, (tx) =>
    tx.execute(sql`INSERT INTO user_settings (owner_id, registry_version)
                   VALUES (${virgin}::uuid, 7)`),
  );
  const withSettings = await withIdentity(db, virgin, (tx) => effectiveRegistry(tx, virgin));
  expect(withSettings.ownerVersion).toBe(7);
  expect(withSettings.systemVersion).toBe(noSettings.systemVersion);
});
