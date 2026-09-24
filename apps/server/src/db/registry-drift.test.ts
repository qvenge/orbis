// apps/server/src/db/registry-drift.test.ts
// Серверная половина стартовой проверки реестров (E1, §А12-1 п.4): чтение ШЕСТИ таблиц под
// ролью приложения. Именно она ловит то, чего не видят unit'ы shared, — права роли: без
// SET LOCAL ROLE authenticated запрос падает «permission denied» на каждом старте (роль
// приложения NOINHERIT, гранты висят на authenticated), а забытый GRANT новой таблице даёт
// 42501 ещё до всякой политики.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  canonicalJson,
  type GraphId,
  hasRegistryDrift,
  newId,
  ruleDefinitionSchema,
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
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { undoAction } from '../executor/undo';
import { approvePending } from '../policy/pending';
import { effectiveRegistry } from '../registry/cache';
import {
  type RegistryConflict,
  type RegistryDeltaRow,
  threeWayMerge,
  UNKNOWN_PREV_SYSTEM,
} from '../registry/deltas';
import {
  createDriftConflictUnits,
  DRIFT_MERGE_EFFECT,
  RULE_MERGE_EFFECT,
} from '../registry/merge-conflict';
import { setAspectDelta, setRuleDelta } from '../registry/ops';
import {
  checkRegistryDrift,
  REGISTRY_DELTAS_QUERY,
  reportRegistryDriftOnStartup,
} from './registry-drift';
import { DEFINITION_TABLES } from './reset-world';
import { codeSystemDefinitions } from './seed-registries';

requireEnv();

const { db, client } = appDb();
const admin = adminDb();

/**
 * Сеть безопасности файла: тесты ниже намеренно ПОРТЯТ общие реестры, а по ним валидирует
 * исполнитель во ВСЕХ остальных серверных сьютах прогона — упавший на середине тест не
 * имеет права оставить локальную БД в состоянии «фича мертва», иначе следом посыплется
 * весь прогон.
 *
 * Снимок ТАБЛИЦ ЦЕЛИКОМ (`to_jsonb` → `jsonb_populate_recordset`), а не повтор upsert'а из
 * сидера: список колонок не дублируется, и следующая миграция реестров не забудет про этот
 * файл.
 */
const snapshots = new Map<string, string>();

async function saveRegistries(): Promise<void> {
  for (const table of DEFINITION_TABLES) {
    const rows = (await admin.db.execute(
      sql`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows
          FROM ${sql.raw(table)} t WHERE graph_id IS NULL`,
    )) as unknown as { rows: unknown }[];
    snapshots.set(table, JSON.stringify(rows[0]?.rows ?? []));
  }
}

async function restoreRegistries(): Promise<void> {
  for (const table of DEFINITION_TABLES) {
    await admin.db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE graph_id IS NULL`);
    await admin.db.execute(
      sql`INSERT INTO ${sql.raw(table)}
          SELECT * FROM jsonb_populate_recordset(NULL::${sql.raw(table)},
            ${snapshots.get(table) ?? '[]'}::jsonb)`,
    );
  }
}

beforeAll(async () => {
  await truncateAll();
  await saveRegistries();
});

afterAll(async () => {
  await restoreRegistries();
  await admin.client.end();
  await client.end();
});

test('засеянные реестры: расхождений нет и запросы проходят под ролью приложения', async () => {
  const drift = await checkRegistryDrift(db);
  expect(hasRegistryDrift(drift)).toBe(false);
  const empty = { missing: [], drifted: [], extra: [] };
  expect(drift).toEqual({
    properties: empty,
    aspects: empty,
    roles: empty,
    contracts: empty,
    subscriptions: empty,
    actions: empty,
  });
});

/**
 * Пин обещания докблока `checkRegistryDrift`. Без него «шесть запросов видят один снапшот»
 * остаётся словами: транзакция по умолчанию READ COMMITTED, и каждый SELECT в ней берёт
 * СВОЙ снапшот (замерено пробоем) — то есть ровно то, что докблок обещал и чего не делал.
 *
 * Проверка ПОВЕДЕНЧЕСКАЯ, а не «в вызов передан объект конфига»: прокси-`Db` пробрасывает
 * вызов настоящему и внутри ТОЙ ЖЕ транзакции спрашивает у PostgreSQL, в каком режиме она
 * фактически открыта. Аргумент можно передать и мимо драйвера, режим соврать не может.
 */
test('чтение идёт в REPEATABLE READ и READ ONLY (снапшот один на шесть запросов)', async () => {
  let mode: { iso: string; ro: string } | undefined;
  const spy = {
    transaction: (fn: unknown, config: unknown) =>
      (db as unknown as { transaction: (f: unknown, c: unknown) => Promise<unknown> }).transaction(
        async (tx: { execute: (q: unknown) => Promise<unknown> }) => {
          const r = (await tx.execute(sql`SELECT current_setting('transaction_isolation') AS iso,
                                                 current_setting('transaction_read_only') AS ro`)) as unknown as {
            iso: string;
            ro: string;
          }[];
          mode = r[0];
          return (fn as (t: unknown) => Promise<unknown>)(tx);
        },
        config,
      ),
  } as unknown as typeof db;

  const drift = await checkRegistryDrift(spy);
  expect(mode).toEqual({ iso: 'repeatable read', ro: 'on' });
  // И сама сверка при этом работает — режим не сломал ни SET LOCAL ROLE, ни запросы.
  expect(hasRegistryDrift(drift)).toBe(false);
});

test('label свойства в БД разошёлся с кодом — drifted с именем столбца', async () => {
  try {
    await admin.db.execute(
      sql`UPDATE property_definitions SET label = '{"ru":"Не тот"}'::jsonb
          WHERE id = 'orbis/amount' AND graph_id IS NULL`,
    );
    const drift = await checkRegistryDrift(db);
    expect(drift.properties.drifted).toEqual([{ id: 'orbis/amount', what: ['label'] }]);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

test('набор properties аспекта устарел — drifted (релиз добавил свойство без пересева)', async () => {
  // Колонки `schema` у аспекта больше нет (0017): JSON Schema — производная реестра свойств
  // (§А3-1). Ту же роль главной ловушки релиза играет теперь сам набор ссылок на свойства:
  // разъехавшись с кодом, он молча оставит новое свойство невалидируемым и невидимым туду.
  try {
    await admin.db.execute(
      sql`UPDATE aspect_definitions SET properties = '[]'::jsonb
          WHERE id = 'orbis/financial' AND graph_id IS NULL`,
    );
    const drift = await checkRegistryDrift(db);
    expect(drift.aspects.drifted).toEqual([{ id: 'orbis/financial', what: ['properties'] }]);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

test('роли нет в реестре — missing (релиз добавил роль без пересева)', async () => {
  try {
    await admin.db.execute(
      sql`DELETE FROM relation_role_definitions WHERE id = 'mention' AND graph_id IS NULL`,
    );
    expect((await checkRegistryDrift(db)).roles.missing).toEqual(['mention']);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

// Р-23: до реформы лишняя встроенная строка дрейфом НЕ считалась — свойство, удалённое из
// кода, продолжало валидировать данные в проде молча.
test('лишняя system-строка свойства — extra, а не тишина (Р-23)', async () => {
  try {
    await admin.db.execute(
      sql`INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
          VALUES ('orbis/zzz', NULL, 'orbis/zzz', '{"ru":"Ж"}'::jsonb, '{"ru":"Ж"}'::jsonb,
                  '{"kind":"text"}'::jsonb, 999)`,
    );
    const drift = await checkRegistryDrift(db);
    expect(drift.properties.extra).toEqual(['orbis/zzz']);
    expect(hasRegistryDrift(drift)).toBe(true);
  } finally {
    await restoreRegistries();
  }
});

// §Б1-1: контракты сеются с Б-1 и сверяются по колонкам. Действия сеются с Б-2 (§Б6-5): незнакомая
// system-строка рядом с посеянными — extra.
test('контракты: незнакомая system-строка — extra, испорченная — drifted; лишнее действие — extra', async () => {
  try {
    await admin.db.execute(
      sql`INSERT INTO contract_definitions (id, graph_id, key, label, description, kind, rank)
          VALUES ('orbis/zzz', NULL, 'orbis/zzz', '{"ru":"З"}'::jsonb, '{"ru":"З"}'::jsonb, 'slots', 900)`,
    );
    await admin.db.execute(
      sql`UPDATE contract_definitions SET module = 'взлом' WHERE id = 'orbis/when'`,
    );
    // `steps` нужен не дрейфу, а СНИМКУ: с Б-2 `loadRegistryRows` разбирает `action_definitions`
    // строгой схемой (`steps.min(1)`), и system-строка с `steps: NULL`, живущая внутри `try`, уронила
    // бы любой `effectiveRegistry`, случившийся в том же окне. Колонка nullable, поэтому прежний
    // INSERT проходил — и тем громче упал бы снимок.
    await admin.db.execute(
      sql`INSERT INTO action_definitions (id, graph_id, key, label, description, steps)
          VALUES ('orbis/close', NULL, 'orbis/close', '{"ru":"З"}'::jsonb, '{"ru":"З"}'::jsonb,
                  '[{"tool":"entity_update","input":{}}]'::jsonb)`,
    );
    const drift = await checkRegistryDrift(db);
    expect(drift.contracts.extra).toEqual(['orbis/zzz']);
    expect(drift.contracts.drifted).toEqual([{ id: 'orbis/when', what: ['module'] }]);
    expect(drift.actions.extra).toEqual(['orbis/close']);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

// Ловушка релиза на ЖИВОЙ базе: колонки действий читаются под ролью приложения (забытый
// GRANT дал бы 42501 ещё до всякой политики), а испорченный `steps` обязан быть назван
// столбцом, а не «строка не та».
test('действия: посеянные — без дрейфа; правка steps в БД — drifted по столбцу steps', async () => {
  try {
    await admin.db.execute(
      sql`UPDATE action_definitions SET steps = '[]'::jsonb WHERE id = 'finance/plan-to-fact'`,
    );
    const drift = await checkRegistryDrift(db);
    expect(drift.actions.drifted).toEqual([{ id: 'finance/plan-to-fact', what: ['steps'] }]);
    expect(drift.actions.missing).toEqual([]);
    expect(drift.actions.extra).toEqual([]);
    expect(hasRegistryDrift(drift)).toBe(true);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

test('правило, дописанное в system-строку руками, — drifted по столбцу rules у каждого из трёх носителей', async () => {
  // По строке в КАЖДОЙ таблице-носителе: у каждой свой запрос (`REGISTRY_DRIFT_QUERIES`) и своё ожидание,
  // и половина пары, потерянная у одного реестра, сделала бы немой порчу именно его правил.
  const rule = `[{"id":"взлом","template":"requires_when","enabled":true,"undo":"check",
                  "params":{"property":"orbis/occurred_on"}}]`;
  try {
    await admin.db.execute(sql`UPDATE property_definitions SET rules = ${rule}::jsonb
      WHERE id = 'orbis/occurred_on' AND graph_id IS NULL`);
    await admin.db.execute(sql`UPDATE aspect_definitions SET rules = ${rule}::jsonb
      WHERE id = 'orbis/financial' AND graph_id IS NULL`);
    await admin.db.execute(sql`UPDATE relation_role_definitions SET rules = ${rule}::jsonb
      WHERE id = 'ref' AND graph_id IS NULL`);
    const drift = await checkRegistryDrift(db);
    expect([drift.properties.drifted, drift.aspects.drifted, drift.roles.drifted]).toEqual([
      [{ id: 'orbis/occurred_on', what: ['rules'] }],
      [{ id: 'orbis/financial', what: ['rules'] }],
      [{ id: 'ref', what: ['rules'] }],
    ]);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

test('exclusive_classes, поднятый в system-строке руками, — drifted по столбцу (Р-К-92)', async () => {
  try {
    await admin.db.execute(
      sql`UPDATE contract_definitions SET exclusive_classes = true WHERE id = 'orbis/completable'`,
    );
    expect((await checkRegistryDrift(db)).contracts.drifted).toEqual([
      { id: 'orbis/completable', what: ['exclusive_classes'] },
    ]);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

// Кастомные строки эталона в коде не имеют — дрейфом они не бывают ни в какую сторону.
test('кастомные строки владельца сверку не трогают', async () => {
  const owner = await freshGraph();
  try {
    await admin.db.execute(
      sql`INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
          VALUES ('user/mood', ${owner}::uuid, 'user/mood', '{"ru":"Настроение"}'::jsonb,
                  '{"ru":"Настроение"}'::jsonb, '{"kind":"text"}'::jsonb, 1)`,
    );
    expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
  } finally {
    await admin.db.execute(sql`DELETE FROM property_definitions WHERE graph_id IS NOT NULL`);
  }
});

/**
 * ДЕЛЬТЫ ПОД РОЛЬЮ ПРИЛОЖЕНИЯ НЕ ВИДНЫ — и это причина, по которой предпросмотр конфликтов
 * слияния (§А3-3) живёт в `ops.ts check`, а не в /health.
 *
 * Утверждение проверяемое, а не пояснительное: политика `current_graph_select` (0021) скоупит
 * `registry_deltas` текущим графом И грантом актора в нём, а у стартовой проверки нет ни того,
 * ни другого — обе половины предиката ложны, и «конфликтов
 * ноль» в /health означало бы не «их нет», а «их некому увидеть». Проба ниже кладёт живую
 * дельту и показывает обе стороны: админская роль её видит, роль приложения — нет.
 */
test('registry_deltas: админ видит строку, роль приложения — ни одной (RLS без актора)', async () => {
  const owner = await freshGraph();
  try {
    await admin.db.execute(
      sql`INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
          VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/task', 1,
                  '{"label":{"ru":"Дело"}}'::jsonb)`,
    );
    const byAdmin = (await admin.db.execute(
      sql.raw(REGISTRY_DELTAS_QUERY),
    )) as unknown as unknown[];
    expect(byAdmin.length).toBeGreaterThan(0);

    const byApp = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE authenticated`);
      return (await tx.execute(sql.raw(REGISTRY_DELTAS_QUERY))) as unknown as unknown[];
    });
    expect(byApp.length).toBe(0);
  } finally {
    await admin.db.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${owner}::uuid`);
  }
});

// Три состояния вместо двух: «проверка не выполнилась» обязано отличаться от «расхождений
// нет». Раньше одна неудачная попытка навсегда снимала ловушку, а /health отвечал ровно как
// на здоровом реестре — то есть штатная операторская проверка (runbook §1) давала
// ложноотрицательный ответ.
describe('reportRegistryDriftOnStartup: провал ≠ «дрейфа нет»', () => {
  /** Заглушка Db, чья транзакция падает n раз, а дальше зовёт настоящую. */
  function flakyDb(failures: number) {
    let left = failures;
    return {
      transaction: (fn: unknown) => {
        if (left > 0) {
          left -= 1;
          return Promise.reject(new Error('connection refused'));
        }
        return (db as unknown as { transaction: (f: unknown) => Promise<unknown> }).transaction(fn);
      },
    } as unknown as typeof db;
  }

  test('здоровые реестры → status ok', async () => {
    expect(await reportRegistryDriftOnStartup(db, { delays: [] })).toEqual({ status: 'ok' });
  });

  test('БД недоступна на первой попытке → повтор, и проверка всё же выполняется', async () => {
    const waits: number[] = [];
    const r = await reportRegistryDriftOnStartup(flakyDb(2), {
      delays: [1, 2, 3],
      wait: async (ms: number) => {
        waits.push(ms);
      },
    });
    expect(r).toEqual({ status: 'ok' });
    expect(waits).toEqual([1, 2]); // ровно две паузы на два отказа
  });

  test('попытки исчерпаны → status unknown, а НЕ «расхождений нет»', async () => {
    const r = await reportRegistryDriftOnStartup(flakyDb(99), {
      delays: [1, 1],
      wait: async () => {},
    });
    expect(r).toEqual({ status: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// §А3-3: конфликты трёхстороннего слияния → единицы пачки (Задача 15)
// ---------------------------------------------------------------------------

describe('конфликты пересева становятся единицами пачки (§А3-3)', () => {
  const owner = mintGraph();

  test('«вариант рядом с похожим» → единица пачки с aspect_delta_set; approve применяет дельту', async () => {
    // ФИКСТУРА, БЕЗ КОТОРОЙ КАРТА КЛАССОВ В ДЕЛЬТЕ НЕЗАКОННА (Ф-Б1-49). `orbis/content_type` —
    // обычный select заметки, слотом-статусом он становится только у того, кто его туда поставил:
    // здесь это свой аспект владельца. Без него `checkClassMap` отвергнет карту на approve
    // (`UNKNOWN_SLOT`/`not_bound`), и это правильно — карта, которая никуда не ведёт, отвергается.
    // `value_map` привязки пуст: классы добавленным вариантам назначает именно дельта.
    await seedCustomAspect(owner, {
      key: 'user/content-status',
      label: { ru: 'Вид текста как статус' },
      properties: [{ key: 'note', type: { kind: 'number' } }],
      // Аспект НЕСЁТ биндуемое свойство (Ф-Б1-54а): носимость — общая истина `checkImplements`
      // и `statusSlotsOf`, и привязка к не носимому слотом-статусом не считается.
      carries: ['orbis/content_type'],
      implements: [
        {
          contract: 'orbis/completable',
          bind: { status: 'orbis/content_type' },
          value_map: [],
          fixed: {},
        },
      ],
    });
    // Владелец добавил в `orbis/content_type` два своих варианта. У первого подпись
    // совпадает с системным «Markdown», ключ — другой: это ровно тот ряд §А3-3, где
    // молчаливого правильного ответа нет («слить их может только владелец»). Второй
    // ни на что не похож и обязан пережить разбор — иначе «слить» стоило бы владельцу
    // настройки, о которой его не спрашивали.
    const row: RegistryDeltaRow = {
      id: newId(),
      graphId: owner,
      targetKind: 'aspect',
      targetId: 'orbis/note',
      baseVersion: 0,
      delta: {
        selectOptions: {
          'orbis/content_type': {
            add: [
              { key: 'md', label: { ru: 'Markdown' }, rank: 10 },
              { key: 'table', label: { ru: 'Таблица' }, rank: 11 },
            ],
          },
        },
        classMap: {
          'orbis/content_type': [
            { contract: 'orbis/completable', slot: 'status', variant: 'md', class: 'active' },
            { contract: 'orbis/completable', slot: 'status', variant: 'table', class: 'active' },
          ],
        },
      },
    };
    const { merged, conflicts } = threeWayMerge(UNKNOWN_PREV_SYSTEM, codeSystemDefinitions(), row);
    // Пересев пишет слитую дельту ТОЙ ЖЕ транзакцией, что и единицу, — единица рассчитана на эту строку
    // (`expected_delta`, гейт 16 m-8).
    await putDelta(owner, 'aspect', 'orbis/note', merged);
    expect(conflicts.map((c) => c.kind)).toEqual(['variant-merge']);
    // Ключи пары — СТРУКТУРНО: единица собирается по ним, а не разбором человеческого текста.
    expect(conflicts[0]?.option).toEqual({ mine: 'md', theirs: 'markdown' });

    const ids = await withIdentity(db, personal(owner), (tx) =>
      createDriftConflictUnits(tx, {
        graphId: owner,
        systemVersion: 7,
        deltaRowId: row.id,
        merged,
        conflicts,
      }),
    );
    expect(ids).toHaveLength(1);
    const pendingId = ids[0] as string;

    const rows = (await withIdentity(db, personal(owner), (tx) =>
      tx.execute(sql`SELECT content, metadata FROM chat_messages WHERE id = ${pendingId}::uuid`),
    )) as unknown as Array<{ content: string; metadata: Record<string, unknown> }>;
    const pending = (rows[0]?.metadata as { pending: Record<string, unknown> }).pending;
    // Единица — ОТ СИСТЕМЫ: у деплойного слияния актора нет вовсе (находка 46).
    expect(pending).toMatchObject({ actor_kind: 'system', source: 'system', kind: 'action' });
    expect(pending.tool).toBe('aspect_delta_set');
    // ТЕКСТ КАРТОЧКИ ЗАПИННЕН, и не косметики ради: он уже был неправдой один раз
    // («записи будут указывать на общий ключ» — approve значений не трогает). Сверка идёт
    // с ТОЙ ЖЕ константой, которую подставляет писатель, поэтому разъехаться обещанию и
    // поведению нечем: за поведение отвечает ассерция ниже.
    expect(String(rows[0]?.content)).toContain(DRIFT_MERGE_EFFECT);
    // «Слить» = принять: в нагрузке ПОХОЖЕГО варианта уже нет, а непохожий остался.
    const input = pending.input as { aspect: string; delta: Record<string, unknown> };
    expect(input.aspect).toBe('orbis/note');
    const added = (input.delta.selectOptions as Record<string, { add: Array<{ key: string }> }>)[
      'orbis/content_type'
    ]?.add;
    expect(added?.map((o) => o.key)).toEqual(['table']);
    // Нагрузка единицы — дельта МИНУС спорный вариант, и карта вычищена вместе с ним:
    // незачищенная оставила бы висячее отнесение, и «Принять» упало бы на применении.
    const map = (input.delta.classMap as Record<string, Array<{ variant: string }>>)[
      'orbis/content_type'
    ];
    expect(map?.map((e) => e.variant)).toEqual(['table']);

    // Повторный прогон пересева той же версии второй карточки не кладёт.
    const again = await withIdentity(db, personal(owner), (tx) =>
      createDriftConflictUnits(tx, {
        graphId: owner,
        systemVersion: 7,
        deltaRowId: row.id,
        merged,
        conflicts,
      }),
    );
    expect(again).toEqual([pendingId]);
    const count = (await withIdentity(db, personal(owner), (tx) =>
      tx.execute(sql`SELECT id FROM chat_messages
                     WHERE metadata @> '{"pending":{"tool":"aspect_delta_set"}}'::jsonb`),
    )) as unknown as unknown[];
    expect(count).toHaveLength(1);

    // Запись, у которой уже стоит спорный вариант, — та самая, о судьбе которой карточка и
    // говорит. Кладётся прямым INSERT'ом: валидатор до применения дельты варианта «md» не
    // знает, а вопрос теста — что с ЗАПИСЬЮ станет после approve, а не как она появилась.
    const withOldVariant = newId();
    await withIdentity(db, personal(owner), (tx) =>
      tx.execute(sql`
        INSERT INTO entities (id, graph_id, title, props, aspects, tags)
        VALUES (${withOldVariant}::uuid, ${owner}::uuid, 'Заметка со старым вариантом',
                '{"orbis/content_type":"md"}'::jsonb, ARRAY['orbis/note'], ARRAY[]::text[])`),
    );

    // approve ПРИМЕНЯЕТ дельту обычным конвейером — своего пути записи у конфликта нет.
    const approved = await approvePending(db, { identity: personal(owner), pendingId });
    expect(approved.ok).toBe(true);
    const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
    const options = reg.properties.get('orbis/content_type')?.type;
    const keys =
      options?.kind === 'select' ? options.options.map((o: { key: string }) => o.key) : [];
    expect(keys).toContain('table');
    expect(keys).not.toContain('md');
    expect(keys).toContain('markdown');
    // ВТОРАЯ ПОЛОВИНА ОБЕЩАНИЯ: карточка говорит, что записи со старым вариантом останутся
    // с ним, — и они остаются. Если однажды «слить» научится переносить значения, падёт
    // именно эта ассерция, и текст придётся переписать вместе с ней.
    const stillOld = (await withIdentity(db, personal(owner), (tx) =>
      tx.execute(sql`SELECT props FROM entities WHERE id = ${withOldVariant}::uuid`),
    )) as unknown as Array<{ props: Record<string, unknown> }>;
    expect(stillOld[0]?.props).toMatchObject({ 'orbis/content_type': 'md' });
  });

  /** Своё правило, которое пересев выключил: пишет то же, что системное `task_completed_at`. */
  const MY_RULE = {
    id: 'my_completed_at',
    template: 'on_enter_class' as const,
    params: {
      enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
      set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
    },
  };

  /** Строка дельты владельца «как её оставил пересев» — единица рассчитана на неё (`expected_delta`). */
  async function putDelta(graph: GraphId, targetKind: string, targetId: string, delta: unknown) {
    await admin.db.execute(sql`
      INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
      VALUES (gen_random_uuid(), ${graph}::uuid, ${targetKind}, ${targetId}, 0, ${JSON.stringify(delta)}::jsonb)`);
  }
  const unitOf = async (graph: GraphId, id: string) => {
    const rows = (await withIdentity(db, personal(graph), (tx) =>
      tx.execute(sql`SELECT content, metadata FROM chat_messages WHERE id = ${id}::uuid`),
    )) as unknown as Array<{ content: string; metadata: Record<string, unknown> }>;
    return {
      content: String(rows[0]?.content),
      pending: (rows[0]?.metadata as { pending: Record<string, unknown> }).pending,
    };
  };
  const RULE_CONFLICT: RegistryConflict = {
    kind: 'rule-conflict',
    targetKind: 'aspect',
    targetId: 'orbis/task',
    rule: { mine: 'my_completed_at', theirs: 'task_completed_at' },
    detail: 'обновление завело правило',
  };
  const MERGED = { rules: [MY_RULE], rulesDisabled: ['my_completed_at'] };

  test('rule-conflict → единица пачки: «Принять» отключает СИСТЕМНОЕ правило и возвращает своё', async () => {
    const graph = await freshGraph();
    await putDelta(graph, 'aspect', 'orbis/task', MERGED);
    const ids = await withIdentity(db, personal(graph), (tx) =>
      createDriftConflictUnits(tx, {
        graphId: graph,
        systemVersion: 7,
        deltaRowId: newId(),
        merged: MERGED as never,
        conflicts: [RULE_CONFLICT],
      }),
    );
    expect(ids).toHaveLength(1);
    const { content, pending } = await unitOf(graph, ids[0] as string);
    // Пачка двух тулов правил (конкурент бывает на другом носителе — Ф-Б2-28): сперва отключение, затем
    // включение своего.
    expect(pending.tool).toBe('batch_execute');
    expect((pending.input as { operations: unknown[] }).operations).toEqual([
      {
        tool: 'rule_remove',
        input: { target: { aspect: 'orbis/task' }, rule: 'task_completed_at' },
      },
      { tool: 'rule_set', input: { target: { aspect: 'orbis/task' }, rule: MY_RULE } },
    ]);
    expect(pending.expected_delta).toEqual({
      target_kind: 'aspect',
      target_id: 'orbis/task',
      delta: MERGED,
    });
    expect(content).toContain(RULE_MERGE_EFFECT);

    // «Принять» — обычный конвейер (`approvePending` → `execute`): своего пути записи у конфликта нет.
    const approved = await approvePending(db, {
      identity: personal(graph),
      pendingId: ids[0] as string,
    });
    expect(approved.ok).toBe(true);
    const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
    const live = reg.aspects.get('orbis/task')?.rules.map((r) => r.id) ?? [];
    expect(live).toContain('my_completed_at');
    expect(live).not.toContain('task_completed_at');
  });

  test('Fable I-3: владелец правил правила после заметки → «Принять» гасит единицу «Устарело», правка цела', async () => {
    const graph = await freshGraph();
    await putDelta(graph, 'aspect', 'orbis/task', MERGED);
    const ids = await withIdentity(db, personal(graph), (tx) =>
      createDriftConflictUnits(tx, {
        graphId: graph,
        systemVersion: 7,
        deltaRowId: newId(),
        merged: MERGED as never,
        conflicts: [RULE_CONFLICT],
      }),
    );
    // Заметка зовёт владельца править правила — он заводит ещё одно правило на той же строке.
    await withIdentity(db, personal(graph), (tx) =>
      setRuleDelta(
        tx,
        graph,
        { kind: 'aspect', id: 'orbis/task' },
        {
          id: 'after_note',
          template: 'requires_when',
          params: { property: 'orbis/due_date' },
        },
      ),
    );
    const refused = await approvePending(db, {
      identity: personal(graph),
      pendingId: ids[0] as string,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('ожидалось «Устарело»');
    expect(refused.error.details).toMatchObject({ reason: 'REGISTRY_UNIT_STALE' });
    const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
    const live = reg.aspects.get('orbis/task')?.rules.map((r) => r.id) ?? [];
    expect(live).toContain('after_note');
    expect(live).toContain('task_completed_at'); // обмена не случилось
    const again = await approvePending(db, {
      identity: personal(graph),
      pendingId: ids[0] as string,
    });
    // Единица погашена — повтор упирается в отказ, а не в исполнение.
    expect(again.ok).toBe(false);
  });

  test('rule-conflict на ВСТРОЕННОМ СВОЙСТВЕ — тоже единица: пачка тулов правил не зависит от рода строки', async () => {
    const graph = await freshGraph();
    const mine = {
      id: 'x',
      template: 'default' as const,
      params: { property: 'orbis/due_date', value: { const: '2026-12-31' } },
    };
    const ids = await withIdentity(db, personal(graph), (tx) =>
      createDriftConflictUnits(tx, {
        graphId: graph,
        systemVersion: 7,
        deltaRowId: newId(),
        merged: { rules: [mine], rulesDisabled: ['x'] } as never,
        conflicts: [
          {
            kind: 'rule-conflict',
            targetKind: 'property',
            targetId: 'orbis/due_date',
            rule: { mine: 'x', theirs: 'y', theirsAt: { kind: 'aspect', id: 'orbis/task' } },
            detail: '',
          },
        ],
      }),
    );
    expect(ids).toHaveLength(1);
    const { pending } = await unitOf(graph, ids[0] as string);
    expect((pending.input as { operations: unknown[] }).operations).toEqual([
      { tool: 'rule_remove', input: { target: { aspect: 'orbis/task' }, rule: 'y' } },
      { tool: 'rule_set', input: { target: { property: 'orbis/due_date' }, rule: mine } },
    ]);
  });

  test('N-1: «Принять» единицы правил → «отмени последнее» → дельты владельца как до «Принять»', async () => {
    const graph = await freshGraph();
    const mine = ruleDefinitionSchema.parse({
      id: 'note_completed_at',
      template: 'on_enter_class',
      params: {
        enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
        set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
      },
    });
    const D0 = { rules: [mine], rulesDisabled: ['note_completed_at'] };
    await putDelta(graph, 'aspect', 'orbis/note', D0);
    const ids = await withIdentity(db, personal(graph), (tx) =>
      createDriftConflictUnits(tx, {
        graphId: graph,
        systemVersion: 7,
        deltaRowId: newId(),
        merged: D0 as never,
        conflicts: [
          {
            kind: 'rule-conflict',
            targetKind: 'aspect',
            targetId: 'orbis/note',
            rule: {
              mine: 'note_completed_at',
              theirs: 'task_completed_at',
              theirsAt: { kind: 'aspect', id: 'orbis/task' },
            },
            detail: '',
          },
        ],
      }),
    );
    const approved = await approvePending(db, {
      identity: personal(graph),
      pendingId: ids[0] as string,
    });
    if (!approved.ok) throw new Error(`«Принять» не прошло: ${approved.error.message}`);
    const deltasOf = async () =>
      (await admin.db.execute(
        sql`SELECT target_kind, target_id, delta FROM registry_deltas WHERE graph_id = ${graph}::uuid
             ORDER BY target_kind, target_id`,
      )) as unknown as Array<{ target_kind: string; target_id: string; delta: unknown }>;
    expect((await deltasOf()).map((r) => r.target_id)).toEqual(['orbis/note', 'orbis/task']);
    const undone = await undoAction(db, { identity: personal(graph), actionId: approved.actionId });
    expect(undone.ok).toBe(true);
    // Прежде откат по эффективному списку снимал декларацию своего правила целиком (проба PR1).
    const rows = await deltasOf();
    expect(rows.map((r) => [r.target_kind, r.target_id])).toEqual([['aspect', 'orbis/note']]);
    expect(canonicalJson(rows[0]?.delta)).toBe(canonicalJson(D0));
    const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
    expect(reg.aspects.get('orbis/task')?.rules.map((r) => r.id)).toContain('task_completed_at');
    expect(reg.aspects.get('orbis/note')?.rules.map((r) => r.id)).toEqual([]);
  });

  test('m-B: свежесть единицы ВАРИАНТА — правка настройки после пересева гасит её «Устарело»', async () => {
    const graph = await freshGraph();
    const merged = {
      selectOptions: {
        'orbis/priority': {
          add: [
            { key: 'urgent2', label: { ru: 'Срочно' }, rank: 9 },
            { key: 'other2', label: { ru: 'Другое' }, rank: 10 },
          ],
        },
      },
    };
    await putDelta(graph, 'aspect', 'orbis/task', merged);
    const ids = await withIdentity(db, personal(graph), (tx) =>
      createDriftConflictUnits(tx, {
        graphId: graph,
        systemVersion: 7,
        deltaRowId: newId(),
        merged: merged as never,
        conflicts: [
          {
            kind: 'variant-merge',
            targetKind: 'aspect',
            targetId: 'orbis/task',
            propertyId: 'orbis/priority',
            option: { mine: 'urgent2', theirs: 'high' },
            detail: '',
          },
        ],
      }),
    );
    await withIdentity(db, personal(graph), (tx) =>
      setAspectDelta(tx, graph, 'orbis/task', { ...merged, icon: '📌' }),
    );
    const refused = await approvePending(db, {
      identity: personal(graph),
      pendingId: ids[0] as string,
    });
    if (refused.ok) throw new Error('ожидалось «Устарело»');
    expect(refused.error.details).toMatchObject({ reason: 'REGISTRY_UNIT_STALE' });
    const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
    expect(reg.aspects.get('orbis/task')?.viewConfig.icon).toBe('📌');
  });
});
