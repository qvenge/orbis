// apps/server/src/routers/entity-backlinks.test.ts
// Task D5 (02-core-os §3.5.8, sign-off владельца K1): отдельной процедуры entity.backlinks
// НЕТ — расширен существующий include:['backlinks'] в entity-read.ts. Секция объединённая:
// явные связи роли `mention` обеих сторон (via 'relation') + упоминания по body_refs
// (via 'mention'), без архивных, потолок 100, подпись направления — из реестра ролей.
// Контракт readEntity общий с LLM/MCP-диспатчем (tools/dispatch), поэтому форма ответа
// пиннится здесь.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from '../executor/executor';
import { bumpOwnerRegistryVersion } from '../registry/version';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

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

/** id → пометка источника: порядок выдачи в утверждениях не фиксируем. */
function viaById(backlinks: { entity: { id: string }; via: string }[] | undefined) {
  return new Map((backlinks ?? []).map((b) => [b.entity.id, b.via]));
}

test('backlinks: связи роли mention обеих сторон + упоминания body_refs с пометкой источника', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Цель', tags: [] },
    source: 'fast_path',
  });
  const asSource = await caller.entity.create({
    input: { title: 'Связь от источника', tags: [] },
    source: 'fast_path',
  });
  const asTarget = await caller.entity.create({
    input: { title: 'Связь к цели', tags: [] },
    source: 'fast_path',
  });
  const mention = await caller.entity.create({
    input: { title: 'Упоминание', tags: [], body: `см. [[entity:${target.id}]]` },
    source: 'fast_path',
  });
  // связь «в цель» и связь «из цели» — обе стороны `mention` попадают в секцию
  await caller.relation.create({
    source_id: asSource.id,
    target_id: target.id,
    role: 'mention',
  });
  await caller.relation.create({
    source_id: target.id,
    target_id: asTarget.id,
    role: 'mention',
  });
  // связь `dependency` backlinks'ом НЕ является: она живёт в «Блокировках» (§3.5.7)
  const blocker = await caller.entity.create({
    input: { title: 'Блокер', tags: [] },
    source: 'fast_path',
  });
  await caller.relation.create({
    source_id: blocker.id,
    target_id: target.id,
    role: 'dependency',
  });

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  const via = viaById(got.backlinks);
  expect(via.get(asSource.id)).toBe('relation');
  expect(via.get(asTarget.id)).toBe('relation');
  expect(via.get(mention.id)).toBe('mention');
  expect(via.has(blocker.id)).toBe(false);
  expect(via.size).toBe(3);
  // Список поместился целиком — признака усечения нет (DF п.4)
  expect(got.backlinksTruncated).toBeUndefined();
});

test('backlinks: секция «Связанное» подписывает направление из реестра ролей', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Цель подписей', tags: [] },
    source: 'fast_path',
  });
  const mentions = await caller.entity.create({
    input: { title: 'Тот, кто сослался', tags: [] },
    source: 'fast_path',
  });
  const mentioned = await caller.entity.create({
    input: { title: 'Тот, на кого сослались', tags: [] },
    source: 'fast_path',
  });
  const inBody = await caller.entity.create({
    input: { title: 'Упомянувший телом', tags: [], body: `см. [[entity:${target.id}]]` },
    source: 'fast_path',
  });
  await caller.relation.create({ source_id: mentions.id, target_id: target.id, role: 'mention' });
  await caller.relation.create({ source_id: target.id, target_id: mentioned.id, role: 'mention' });

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  const labels = new Map((got.backlinks ?? []).map((b) => [b.entity.id, b.viaLabel]));
  // Подписи — ИЗ РЕЕСТРА (builtin-roles: source_label/target_label роли `mention`),
  // а не из словаря клиента: у web своего словаря направлений больше нет.
  expect(labels.get(mentions.id)).toBe('Упоминает');
  expect(labels.get(mentioned.id)).toBe('Упомянуто');
  // У ссылки из тела роли нет вовсе — её подпись общая
  expect(labels.get(inBody.id)).toBe('упоминание');

  // Своя строка реестра перекрывает встроенную — подпись едет из неё
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.execute(sql`
      INSERT INTO relation_role_definitions
        (id, owner_id, key, label, description, source_label, target_label,
         hierarchical, constraints, "symmetric", module, rank)
      SELECT id, ${user}::uuid, key, label, description,
             '{"ru":"Ссылается на нас"}'::jsonb, target_label,
             hierarchical, constraints, "symmetric", module, rank
        FROM relation_role_definitions WHERE id = 'mention' AND owner_id IS NULL`);
    await bumpOwnerRegistryVersion(admin, user); // мутация реестра двигает версию (§А10-1)
  } finally {
    await adminClient.end();
  }
  const after = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  expect(after.backlinks?.find((b) => b.entity.id === mentions.id)?.viaLabel).toBe(
    'Ссылается на нас',
  );
});

// Обе стороны одной пары — это ОДНА строка секции, а не две: направления сворачиваются
// до объединения источников, иначе взаимное упоминание раздваивало бы запись в списке.
test('backlinks: взаимное упоминание — одна строка, подпись входящего направления', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Взаимная цель', tags: [] },
    source: 'fast_path',
  });
  const both = await caller.entity.create({
    input: { title: 'Взаимный сосед', tags: [] },
    source: 'fast_path',
  });
  await caller.relation.create({ source_id: both.id, target_id: target.id, role: 'mention' });
  await caller.relation.create({ source_id: target.id, target_id: both.id, role: 'mention' });

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  expect(got.backlinks?.map((b) => b.entity.id)).toEqual([both.id]);
  expect(got.backlinks?.[0]?.viaLabel).toBe('Упоминает');
});

test('backlinks: и связь, и упоминание одной сущностью → одна строка с пометкой «связь»', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Цель', tags: [] },
    source: 'fast_path',
  });
  const both = await caller.entity.create({
    input: { title: 'И связь, и упоминание', tags: [], body: `[[entity:${target.id}]]` },
    source: 'fast_path',
  });
  await caller.relation.create({
    source_id: both.id,
    target_id: target.id,
    role: 'mention',
  });

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  expect(got.backlinks?.map((b) => b.entity.id)).toEqual([both.id]);
  expect(got.backlinks?.[0]?.via).toBe('relation');
});

test('backlinks: архивные исключены (обе стороны — и связь, и упоминание)', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Цель', tags: [] },
    source: 'fast_path',
  });
  const relArchived = await caller.entity.create({
    input: { title: 'Архивная связь', tags: [] },
    source: 'fast_path',
  });
  const mentionArchived = await caller.entity.create({
    input: { title: 'Архивное упоминание', tags: [], body: `[[entity:${target.id}]]` },
    source: 'fast_path',
  });
  await caller.relation.create({
    source_id: relArchived.id,
    target_id: target.id,
    role: 'mention',
  });
  await caller.entity.update({ id: relArchived.id, archived: true });
  await caller.entity.update({ id: mentionArchived.id, archived: true });

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  expect(got.backlinks).toEqual([]);
});

test('backlinks: чужая сущность недостижима (RLS)', async () => {
  const owner = freshUserId();
  const stranger = freshUserId();
  const target = await callerFor(owner).entity.create({
    input: { title: 'Моя цель', tags: [] },
    source: 'fast_path',
  });
  // Чужой владелец ссылается на мою сущность в своём body — body_refs заполнены,
  // но строка entities под RLS невидима: в моей секции её быть не должно.
  await callerFor(stranger).entity.create({
    input: { title: 'Чужая ссылающаяся', tags: [], body: `[[entity:${target.id}]]` },
    source: 'fast_path',
  });

  const got = await callerFor(owner).entity.get({ id: target.id, include: ['backlinks'] });
  expect(got.backlinks).toEqual([]);
});

// DF п.4: порядок был ВОЗРАСТАЮЩИМ по created_at, то есть при переполнении отбрасывалась
// ровно та связь, которую пользователь только что создал, и признака обрезания наружу не
// было вовсе (урок C6: молчаливого усечения быть не должно).
test('backlinks: потолок 100 строк — свежие первыми, с признаком усечения', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Популярная', tags: [] },
    source: 'fast_path',
  });
  // 105 упоминаний — сырым админ-соединением: 105 вызовов роутера тест не оправдывают.
  // created_at задаём явно: одним INSERT'ом now() у всех строк одинаков, и порядок
  // выдачи решал бы случайный uuid — «свежесть» была бы непроверяема.
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.execute(sql`
      INSERT INTO entities (id, owner_id, title, body, body_refs, created_at)
      SELECT gen_random_uuid(), ${user}::uuid, 'Ссылка ' || g, '', ARRAY[${target.id}]::text[],
             now() - make_interval(mins => g)
      FROM generate_series(1, 105) AS g
    `);
  } finally {
    await adminClient.end();
  }

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  expect(got.backlinks?.length).toBe(100);
  expect(got.backlinksTruncated).toBe(true);
  // «Ссылка 1» — самая свежая (минута назад), «Ссылка 105» — самая старая
  const titles = got.backlinks?.map((b) => b.entity.title) ?? [];
  expect(titles[0]).toBe('Ссылка 1');
  expect(titles).toContain('Ссылка 100');
  // усечены именно САМЫЕ СТАРЫЕ — пять последних
  expect(titles).not.toContain('Ссылка 101');
  expect(titles).not.toContain('Ссылка 105');
});

// §А6-2/§А8 «backlinks видят правила» (находка 9 ревью плана): до зеркала-ребра открытая
// категория не показывала ни своих транзакций, ни правил памяти, которые её назначают, —
// ссылка жила значением в `props`, а секция ходила только по рёбрам.
//
// Источники создаются через `execute` с НОВОЙ формой (`props` по id): tRPC-вход
// `entityCreateInput` — это ещё тул-контракт старой карты (перевод — Задача 12), и
// `orbis/rule_target` в неё не выражается вовсе.
test('backlinks категории: транзакции и правила памяти по ref, подпись — label свойства', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const category = await caller.entity.create({
    input: { title: 'Еда', tags: [], aspects: ['orbis/category'] },
    source: 'fast_path',
  });
  const created = async (input: Record<string, unknown>): Promise<string> => {
    const r = await execute(db, {
      actorUserId: user,
      actorKind: 'owner',
      source: 'fast_path',
      operations: [{ tool: 'entity_create', input }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.results[0] as { id: string }).id;
  };
  const txn = await created({
    title: 'Обед',
    tags: [],
    aspects: ['orbis/financial'],
    props: {
      'orbis/amount': '340.00',
      'orbis/direction': 'expense',
      'orbis/occurred_on': '2026-08-20',
      'orbis/finance_category': category.id,
    },
  });
  const rule = await created({
    title: 'пятёрочка → Еда',
    tags: [],
    aspects: ['orbis/memory'],
    props: {
      'orbis/memory_kind': 'rule',
      'orbis/rule_pattern': 'пятёрочка',
      'orbis/rule_target': category.id,
    },
  });

  const got = await caller.entity.get({ id: category.id, include: ['backlinks'] });
  const via = viaById(got.backlinks);
  expect(via.get(txn)).toBe('ref');
  expect(via.get(rule)).toBe('ref');
  expect(via.size).toBe(2);
  // Подпись — label СВОЙСТВА из meta.property, а не подпись роли `ref` («Откуда ссылка»):
  // владельцу важно, ЧЕМ на категорию сослались, и у двух источников это разные свойства.
  const labels = new Map((got.backlinks ?? []).map((b) => [b.entity.id, b.viaLabel]));
  expect(labels.get(txn)).toBe('Категория');
  expect(labels.get(rule)).toBe('Назначаемая категория');
});
