// apps/server/src/registry/load.test.ts
// Снимок эффективных реестров владельца против живой БД: система ⊕ свои, перекрытие по id,
// обе версии. Дельты — Задача 14.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  BUILTIN_ACTION_DEFS,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_ASPECT_IDS,
  BUILTIN_PROPERTY_META,
  BUILTIN_SUBSCRIPTION_DEFS,
  CONTRACT_IDS,
  RELATION_ROLE_IDS,
  type RuleDefinition,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  freshGraph,
  mintGraph,
  personal,
  requireEnv,
  seedCustomAspect,
  seedCustomRole,
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
const owner = mintGraph();
const stranger = mintGraph();

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
  const snap = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
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
  const snap = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  expect(snap.aspects.get('user/sleep-log')?.graphId).toBe(owner);
  expect(snap.properties.get('user/hours')?.graphId).toBe(owner);
  // Чужой аспект того же namespace невидим — его отсекает не фильтр запроса, а политика.
  expect(snap.aspects.has('user/mood')).toBe(false);
  expect(snap.properties.has('user/level')).toBe(false);
});

/**
 * Своя строка с ТЕМ ЖЕ id, что у встроенной, законна и перекрывает её — на этом стоит
 * сегодняшнее переопределение аспекта (`registry.test.ts`) и будущая дельта. Частичные
 * уникальности разведены по `graph_id IS NULL` / `IS NOT NULL` ровно ради этого.
 */
test('своё определение с id встроенного ПЕРЕКРЫВАЕТ его (ORDER BY graph_id NULLS FIRST)', async () => {
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.execute(sql`
      INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
      VALUES ('orbis/priority', ${owner}::uuid, 'orbis/priority', '{"ru":"Важность"}'::jsonb,
              '{"ru":"Своя важность"}'::jsonb, '{"kind":"text"}'::jsonb, 1)`);
    await bumpOwnerRegistryVersion(admin, owner); // мутация реестра двигает версию (§А10-1)
    const snap = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
    const overridden = snap.properties.get('orbis/priority');
    expect(overridden?.graphId).toBe(owner);
    expect(overridden?.label.ru).toBe('Важность');
    // Ровно одна запись под этим id — снимок не задваивает.
    expect([...snap.properties.keys()].filter((k) => k === 'orbis/priority').length).toBe(1);

    // ВТОРАЯ своя строка с тем же id — вот это отказ уникальности (`*_custom_uniq`).
    expect(
      await failedConstraint(async () => {
        await admin.execute(sql`
          INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
          VALUES ('orbis/priority', ${owner}::uuid, 'orbis/priority-2', '{"ru":"Дубль"}'::jsonb,
                  '{"ru":"Дубль"}'::jsonb, '{"kind":"text"}'::jsonb, 2)`);
      }),
    ).toBe('property_definitions_custom_uniq');
  } finally {
    await admin.execute(
      sql`DELETE FROM property_definitions WHERE id = 'orbis/priority' AND graph_id IS NOT NULL`,
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
          INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
          VALUES ('user/dup-a', ${owner}::uuid, 'user/dup', '{"ru":"А"}'::jsonb,
                  '{"ru":"А"}'::jsonb, '{"kind":"text"}'::jsonb, 1),
                 ('user/dup-b', ${owner}::uuid, 'user/dup', '{"ru":"Б"}'::jsonb,
                  '{"ru":"Б"}'::jsonb, '{"kind":"text"}'::jsonb, 2)`);
      }),
    ).toBe('property_definitions_custom_key');
  } finally {
    await admin.execute(sql`DELETE FROM property_definitions WHERE graph_id = ${owner}::uuid
                            AND key = 'user/dup'`);
    await adminClient.end();
  }
});

test('версии: системная — из registry_system, владельца — из user_settings (0 без строки)', async () => {
  // СВОЙ владелец, а не общий `owner` файла: у того строку настроек уже завёл инкремент
  // версии, которым сопровождается всякая мутация реестра (§А10-1), — а проверяется здесь
  // ровно случай «строки настроек нет вовсе».
  const virgin = await freshGraph();
  const noSettings = await withIdentity(db, personal(virgin), (tx) =>
    effectiveRegistry(tx, virgin),
  );
  expect(noSettings.systemVersion).toBeGreaterThan(0); // сид db:prepare уже был
  expect(noSettings.ownerVersion).toBe(0); // строки настроек у владельца нет

  await withIdentity(db, personal(virgin), (tx) =>
    tx.execute(sql`INSERT INTO user_settings (graph_id, registry_version)
                   VALUES (${virgin}::uuid, 7)`),
  );
  const withSettings = await withIdentity(db, personal(virgin), (tx) =>
    effectiveRegistry(tx, virgin),
  );
  expect(withSettings.ownerVersion).toBe(7);
  expect(withSettings.systemVersion).toBe(noSettings.systemVersion);
});

test('снимок несёт словарь контрактов: шесть встроенных, форма разобрана схемой', async () => {
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  expect([...reg.contracts.keys()].sort()).toEqual([...CONTRACT_IDS].sort());
  expect(reg.contracts.get('orbis/completable')?.sets).toEqual({
    closed: ['done', 'cancelled'],
    open: ['active'],
  });
  // Форма `{kind:"facts"}` доезжает разобранной, а не «как лежит в jsonb».
  expect(reg.contracts.get('orbis/sensitivity')?.facts?.length).toBe(5);
});

test('словарь подписок несёт обе засеянные: строки разобраны схемой, поверхности на месте', async () => {
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  // Состав — по СИДУ, а не литералом: задача, дописавшая третью подписку, не обязана искать этот
  // тест. Порядок словаря — это `ORDER BY graph_id NULLS FIRST, id` (`load.ts`), а НЕ `rank`:
  // совпадение с рангом сегодня держится на АЛФАВИТЕ (`orbis/agenda` < `orbis/budget-overview`),
  // и третья встроенная подписка с меньшим рангом покрасила бы этот пин при исправном коде.
  // Поэтому ожидание сортируется тем же ключом, каким сортирует читатель.
  expect([...reg.subscriptions.keys()]).toEqual(BUILTIN_SUBSCRIPTION_DEFS.map((s) => s.id).sort());
  expect([...reg.subscriptions.keys()]).toEqual(['orbis/agenda', 'orbis/budget-overview']);
  const row = reg.subscriptions.get('orbis/agenda');
  // `definition` доезжает РАЗОБРАННОЙ (а не «как лежит в jsonb»): движок читает поля, а не JSON.
  expect(row?.definition.engine).toBe('agenda');
  expect([row?.surface, row?.module, row?.graphId]).toEqual(['planner/agenda', 'planner', null]);
  const budget = reg.subscriptions.get('orbis/budget-overview');
  expect(budget?.definition.engine).toBe('budget');
  expect([budget?.surface, budget?.module, budget?.graphId]).toEqual([
    'finance/budget-overview',
    'finance',
    null,
  ]);
});

// §Б6-1: шестой род реестра. Состав — по СИДУ, порядок — ключом читателя (`ORDER BY graph_id NULLS
// FIRST, id`), тот же довод, что у подписок выше. `batch_cap` и `over` — колонки 0022: без них в
// SELECT пакетное действие доезжало бы одиночным, и кап Р-К-14 молча пропадал.
test('снимок несёт шестой словарь: действия по id, форма разобрана схемой', async () => {
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  expect([...reg.actions.keys()].sort()).toEqual(BUILTIN_ACTION_DEFS.map((a) => a.id).sort());
  expect(reg.actions.get('planner/postpone_overdue')?.batch_cap).toBe(100);
  expect(reg.actions.get('planner/postpone_overdue')?.over).not.toBeNull();
});

// Колонки 0014 `params`/`sensitivity`/`offered_by` nullable БЕЗ default, у схемы же умолчание `[]`:
// строка с NULL в них (прежний писатель, ручная правка) обязана доехать до снимка умолчаниями, а не
// уронить разбор реестра владельца целиком (довод `aggregations` аспекта, `load.ts`).
test('своё действие с NULL в params/sensitivity/offered_by доезжает умолчаниями схемы', async () => {
  const { db: admin, client } = adminDb();
  try {
    await admin.execute(sql`
      INSERT INTO action_definitions (id, graph_id, key, label, description, steps, rank)
      VALUES ('user/bare', ${owner}::uuid, 'user/bare', '{"ru":"Голое"}'::jsonb,
              '{"ru":"Голое"}'::jsonb, '[{"tool":"entity_update","input":{}}]'::jsonb, 900)`);
    await bumpOwnerRegistryVersion(admin, owner);
    const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
    const bare = reg.actions.get('user/bare');
    expect([bare?.params, bare?.sensitivity, bare?.offered_by]).toEqual([[], [], []]);
    expect([bare?.graphId, bare?.over, bare?.batch_cap, bare?.status]).toEqual([
      owner,
      null,
      null,
      'active',
    ]);
    // Своё действие чужого графа в снимок не попадает (RLS и условие по графу в SELECT).
    const other = await withIdentity(db, personal(stranger), (tx) =>
      effectiveRegistry(tx, stranger),
    );
    expect(other.actions.has('user/bare')).toBe(false);
  } finally {
    await admin.execute(sql`DELETE FROM action_definitions WHERE graph_id = ${owner}::uuid`);
    await bumpOwnerRegistryVersion(admin, owner);
    await client.end();
  }
});

test('снимок несёт rules строк-носителей: своё правило доезжает разобранным, чужое не видно', async () => {
  const rule: RuleDefinition = {
    id: 'own_probe',
    template: 'requires_when',
    enabled: true,
    undo: 'check',
    params: { property: 'orbis/occurred_on' },
  };
  const { db: admin, client } = adminDb();
  try {
    await admin.execute(sql`UPDATE aspect_definitions SET rules = ${JSON.stringify([rule])}::jsonb
                             WHERE graph_id = ${owner}::uuid AND id = 'user/sleep-log'`);
    await bumpOwnerRegistryVersion(admin, owner);
  } finally {
    await client.end();
  }
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  expect(reg.aspects.get('user/sleep-log')?.rules).toEqual([rule]);
  // Аспект чужого графа (`beforeAll`) в снимок владельца не попадает вместе со своими правилами.
  expect(reg.aspects.has('user/mood')).toBe(false);
  // Встроенные строки несут системные правила задачи 4 — ровно в той форме, в какой их собирает код
  // (`BUILTIN_ASPECT_DEFS`: вход `BUILTIN_RULES_BY_CARRIER`, доведённый умолчаниями схемы): сид пишет
  // колонку, снимок её разбирает, и круг «код → БД → снимок» ничего не теряет и не добавляет.
  const finDef = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/financial');
  if (finDef === undefined) throw new Error('встроенного orbis/financial в коде нет');
  expect(reg.aspects.get('orbis/financial')?.rules).toEqual(finDef.rules);
  expect(reg.aspects.get('orbis/financial')?.rules.map((r) => r.id)).toEqual([
    'financial_requires_occurred_on',
    'financial_recurring_requires_recurrence',
  ]);
  expect(reg.properties.get('orbis/occurred_on')?.rules).toEqual([]);
  expect(reg.roles.get('ref')?.rules).toEqual([]);
  // Тем же DDL — флаг контракта (Р-К-92 п.2): в снимке он ЕСТЬ уже здесь, `true` появится с
  // `orbis/delegable` задачи 14а. Без колонки в SELECT флаг терялся бы на пересеве молча.
  expect(reg.contracts.get('orbis/completable')?.exclusive_classes).toBe(false);
});

/**
 * Пин КАЖДОГО из четырёх SELECT, а не одного: тест выше держит `rules` аспекта непустым значением, но
 * у свойств, ролей и контрактов в снимке сегодня только умолчания схемы (`[]` и `false`) — снятая из
 * SELECT или маппера колонка дала бы ровно их же, и дорога рвалась бы молча. Поэтому здесь у каждого
 * носителя значение, которого умолчание НЕ даёт: правило у своего свойства и своей роли владельца и
 * `exclusive_classes: true` у своей строки контракта, перекрывающей встроенную (ORDER BY graph_id).
 */
test('поле доезжает из КАЖДОГО SELECT: rules свойства и роли, exclusive_classes контракта владельца', async () => {
  const propertyRule: RuleDefinition = {
    id: 'own_property_probe',
    template: 'requires_when',
    enabled: true,
    undo: 'check',
    params: { property: 'user/hours' },
  };
  const roleRule: RuleDefinition = {
    id: 'own_role_probe',
    template: 'acyclic',
    enabled: true,
    undo: 'check',
    params: {},
  };
  await seedCustomRole(owner, {
    key: 'user/probe-role',
    label: { ru: 'Проба' },
    sourceLabel: { ru: 'Откуда' },
    targetLabel: { ru: 'Куда' },
    rules: [roleRule],
  });
  const { db: admin, client } = adminDb();
  try {
    await admin.execute(sql`UPDATE property_definitions
      SET rules = ${JSON.stringify([propertyRule])}::jsonb
      WHERE graph_id = ${owner}::uuid AND id = 'user/hours'`);
    await admin.execute(sql`
      INSERT INTO contract_definitions
        (id, graph_id, key, label, description, kind, slots, classes, sets, facts, module, rank,
         exclusive_classes)
      SELECT id, ${owner}::uuid, key, label, description, kind, slots, classes, sets, facts, module,
             rank, true
      FROM contract_definitions WHERE graph_id IS NULL AND id = 'orbis/completable'`);
    await bumpOwnerRegistryVersion(admin, owner);
    const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
    expect(reg.properties.get('user/hours')?.rules).toEqual([propertyRule]);
    expect(reg.roles.get('user/probe-role')?.rules).toEqual([roleRule]);
    expect(reg.contracts.get('orbis/completable')?.graphId).toBe(owner);
    expect(reg.contracts.get('orbis/completable')?.exclusive_classes).toBe(true);
  } finally {
    await admin.execute(sql`DELETE FROM contract_definitions WHERE graph_id = ${owner}::uuid`);
    await admin.execute(sql`DELETE FROM relation_role_definitions WHERE graph_id = ${owner}::uuid`);
    await admin.execute(sql`UPDATE property_definitions SET rules = '[]'::jsonb
                            WHERE graph_id = ${owner}::uuid AND id = 'user/hours'`);
    await bumpOwnerRegistryVersion(admin, owner);
    await client.end();
  }
});
