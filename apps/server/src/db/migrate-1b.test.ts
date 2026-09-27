// apps/server/src/db/migrate-1b.test.ts
// Разовый перевод данных среза 1б (спека §12, С1б-14, РП-16, Д-11) на фикстуре прод-формы
// (`seedLegacyWorld`, задача 12): `--report` не пишет ничего; `--apply` — одна пачка исполнителя на граф
// (записи поставки, навигация хоста из закреплённых без дублей, шесть списков → страницы поставки без
// тега, Финансы выключены) с подписью журнала В-4; повтор — «уже переведён» без записи; после перевода
// заведение графа (задача 12) признаёт граф заведённым.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  type GraphId,
  HOME_PROPERTY,
  PAGE_ASPECT,
  SUPPLY_ASPECT,
  SUPPLY_HASH,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '@orbis/shared';
import {
  etalonOf,
  LEGACY_ETALON_TEXTS,
  printPageRecord,
  SEED_SMART_LISTS,
  type SupplyKey,
  supplyStatusOf,
} from '@orbis/shared/supply';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  bumpRegistryVersion,
  freshGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { seedLegacyWorld } from '../../test/legacy-world';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { effectiveRegistry } from '../registry/cache';
import { seedOwner, seedOwnerGraph } from '../seed/onboarding';
import { seedCategoryId, seedSmartListId } from '../seed/world';
import { etalonHash } from '../supply/hash';
import { listUpdates } from '../supply/mechanism';
import { canonicalPageText, supplyRecordId } from '../supply/records';
import {
  applyMigrate1b,
  assertSlice1bRegistry,
  formatMigrate1bPlan,
  MIGRATE_1B_LABEL,
  type Migrate1bIo,
  planMigrate1b,
  reportMigrate1b,
  runMigrate1b,
  UNDO_WARNING,
} from './migrate-1b';
import { DEFINITION_TABLES } from './reset-world';
import { withIdentity } from './with-identity';

requireEnv();

const { db, client } = appDb();
const journal = makeChatJournalSink();

beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

const LIST_KEYS = SEED_SMART_LISTS.map((l) => l.slug);
/** Закреплённые фикстуры прод-формы — в их порядке (`seedLegacyWorld`). */
const PINNED_KEYS = [
  'daily-planning',
  'upcoming',
  'all-tasks',
  'horizon-year',
  'routines',
] as const;

/** Админ-DSN на время одного вызова: сверка мимо RLS, независимая от проверяемого кода. */
async function admin<T>(fn: (a: ReturnType<typeof adminDb>['db']) => Promise<T>): Promise<T> {
  const { db: a, client: c } = adminDb();
  try {
    return await fn(a);
  } finally {
    await c.end();
  }
}

/**
 * ВСЁ, что перевод мог бы записать в граф, одним снимком (как `worldSnapshot` сьюта онбординга): по
 * каждой таблице графа — число строк и отпечаток их полного содержимого. Сравнение «до» и «после» —
 * проверка «ничего не записано».
 */
async function worldSnapshot(user: GraphId): Promise<Record<string, unknown>> {
  return admin(async (a) => {
    const digest = async (table: string, where: ReturnType<typeof sql>): Promise<unknown> =>
      (
        (await a.execute(sql`
        SELECT count(*)::int AS n,
               md5(coalesce(string_agg(to_jsonb(x)::text, ';' ORDER BY to_jsonb(x)::text), '')) AS digest
          FROM ${sql.raw(table)} x WHERE ${where}`)) as unknown as unknown[]
      )[0];
    const ofGraph = sql`x.graph_id = ${user}::uuid`;
    const out: Record<string, unknown> = {
      entities: await digest('entities', ofGraph),
      relations: await digest(
        'relations',
        sql`x.source_id IN (SELECT id FROM entities WHERE graph_id = ${user}::uuid)`,
      ),
      threads: await digest('chat_threads', ofGraph),
      messages: await digest(
        'chat_messages',
        sql`x.thread_id IN (SELECT id FROM chat_threads WHERE graph_id = ${user}::uuid)`,
      ),
      versions: await digest('entity_versions', ofGraph),
      origins: await digest('entity_origins', ofGraph),
      settings: await digest('user_settings', ofGraph),
      deltas: await digest('registry_deltas', ofGraph),
    };
    for (const table of DEFINITION_TABLES) out[table] = await digest(table, ofGraph);
    return out;
  });
}

interface Row {
  id: string;
  title: string;
  emoji: string | null;
  body: string;
  bodyDoc: unknown;
  tags: string[];
  aspects: string[];
  props: Record<string, unknown>;
  archived: boolean;
  updatedAt: string;
}

async function rowOf(user: GraphId, id: string): Promise<Row> {
  const rows = await admin(
    (a) =>
      a.execute(sql`
      SELECT id::text AS id, title, emoji, body, body_doc, tags, aspects, props, archived, updated_at
        FROM entities WHERE graph_id = ${user}::uuid AND id = ${id}::uuid`) as unknown as Promise<
        Array<Record<string, unknown>>
      >,
  );
  const r = rows[0];
  if (r === undefined) throw new Error(`записи ${id} нет`);
  return {
    id: r.id as string,
    title: r.title as string,
    emoji: r.emoji as string | null,
    body: (r.body as string | null) ?? '',
    bodyDoc: r.body_doc,
    tags: r.tags as string[],
    aspects: r.aspects as string[],
    props: r.props as Record<string, unknown>,
    archived: r.archived as boolean,
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

/** `id → updated_at` всех записей графа, кроме перечисленных. */
async function stampsExcept(
  user: GraphId,
  except: readonly string[],
): Promise<Map<string, string>> {
  const rows = (await admin((a) =>
    a.execute(sql`SELECT id::text AS id, updated_at FROM entities WHERE graph_id = ${user}::uuid`),
  )) as unknown as Array<{ id: string; updated_at: string }>;
  return new Map(
    rows
      .filter((r) => !except.includes(r.id))
      .map((r) => [r.id, new Date(r.updated_at).toISOString()]),
  );
}

async function settingsOf(
  user: GraphId,
): Promise<{ pinned: unknown; installed: string[]; mask: string[] }> {
  const rows = (await admin((a) =>
    a.execute(sql`SELECT "pinnedEntities" AS pinned, "installedViews" AS installed,
                         disabled_modules AS mask
                    FROM user_settings WHERE graph_id = ${user}::uuid`),
  )) as unknown as Array<{ pinned: unknown; installed: string[]; mask: string[] }>;
  const r = rows[0];
  if (r === undefined) throw new Error('строки настроек нет');
  return r;
}

async function setPinned(user: GraphId, pinned: ReadonlyArray<{ id: string; order: number }>) {
  await admin((a) =>
    a.execute(sql`UPDATE user_settings SET "pinnedEntities" = ${JSON.stringify(pinned)}::jsonb
                   WHERE graph_id = ${user}::uuid`),
  );
}

/** Сообщения журнала графа (заголовок карточки — подпись действия). */
async function journalTitles(user: GraphId): Promise<string[]> {
  const rows = (await admin((a) =>
    a.execute(sql`
      SELECT m.metadata -> 'cards' -> 0 ->> 'title' AS title
        FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
       WHERE t.graph_id = ${user}::uuid AND m.metadata ? 'actions'
       ORDER BY m.created_at`),
  )) as unknown as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

/** Запись владельца обычным путём (исполнитель, механизм `user`, журнал). Возвращает id. */
async function ownerCreate(user: GraphId, input: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  const r = await execute(
    db,
    {
      identity: personal(user),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_create', input: { id, tags: [], ...input } }],
    },
    { sink: journal },
  );
  if (!r.ok) throw new Error(`создание: ${JSON.stringify(r.error)}`);
  return id;
}

async function ownerUpdate(user: GraphId, input: Record<string, unknown>): Promise<void> {
  const r = await execute(
    db,
    {
      identity: personal(user),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input }],
    },
    { sink: journal },
  );
  if (!r.ok) throw new Error(`правка: ${JSON.stringify(r.error)}`);
}

const listId = (user: GraphId, key: string): string => seedSmartListId(user, key);
const plan = (user: GraphId) => withIdentity(db, personal(user), (tx) => planMigrate1b(tx, user));

/** IO операции против локальной БД: пул админ-DSN, как `ops.ts` против прода; граф — один. */
function localIo(user: GraphId, lines: string[], opened: { n: number }): Migrate1bIo {
  return {
    readDsn: () => 'локальная база теста',
    openDb: () => {
      opened.n += 1;
      const { db: a, client: c } = adminDb();
      return { db: a, close: () => c.end() };
    },
    identities: async () => [personal(user)],
    log: (l) => lines.push(l),
    error: (l) => lines.push(`ОШИБКА ${l}`),
  };
}

describe('planMigrate1b — --report: план без единой записи', () => {
  test('(а) граф прод-формы: что создаётся, какие списки переводятся, навигация, маска, счётчики R-7; ничего не записано', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    const before = await worldSnapshot(user);

    const p = await plan(user);

    expect(p.state).toBe('legacy');
    expect(p.blocked).toBeNull();
    expect(p.create.map((c) => c.key)).toEqual(['host-template', 'home', 'records', 'host-shell']);
    expect(p.lists.map((l) => [l.key, l.id, l.etalon, l.status])).toEqual(
      LIST_KEYS.map((k) => [
        k,
        listId(user, k),
        k === 'horizon-year' || k === 'horizon-life' ? 'legacy' : 'current',
        'etalon',
      ]),
    );
    expect(p.missingLists).toEqual([]);
    expect(p.nav.map((n) => n.id)).toEqual([
      supplyRecordId(user, 'records'),
      ...PINNED_KEYS.map((k) => listId(user, k)),
    ]);
    expect(p.nav.map((n) => n.title)).toEqual([
      'Записи',
      'Daily Planning',
      'Upcoming',
      'All Tasks',
      'Год',
      'Рутины',
    ]);
    expect(p.navSkipped).toEqual([]);
    expect(p.shellStatus).toBe('etalon');
    expect(p.maskBefore).toEqual([]);
    expect(p.maskAfter).toEqual(['finance']);
    expect(p.counters).toEqual({
      agendaSubscriptions: 0,
      retiredSurfaceActions: 0,
      oldToolRoutines: 0,
      oldToolPending: 0,
    });
    // Одна пачка: шесть правок списков, четыре создания, выключение Финансов.
    expect(p.operations.map((o) => o.tool)).toEqual([
      ...LIST_KEYS.map(() => 'entity_update'),
      'entity_create',
      'entity_create',
      'entity_create',
      'entity_create',
      'module_set',
    ]);

    expect(await worldSnapshot(user)).toEqual(before);
  });

  test('(а) счётчики R-7 не ноль — план их считает, печать предупреждает владельца; реестр графа жив', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    await admin(async (a) => {
      // Своя подписка на прежней поверхности `planner/agenda` (до 1б — законная).
      await a.execute(sql`
        INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
        SELECT 'mine/old-agenda', ${user}::uuid, 'planner/agenda', definition, module, 900
          FROM subscription_definitions WHERE graph_id IS NULL AND id = 'orbis/agenda'`);
      // Своё действие на снятой голове — deprecated: его откат идёт через схему записи.
      await a.execute(sql`
        INSERT INTO action_definitions (id, graph_id, key, label, description, params, precondition,
                                        steps, sensitivity, offered_by, module, batch_cap, rank,
                                        status, over)
        SELECT 'mine/old-postpone', ${user}::uuid, 'mine/old_postpone', label, description, params,
               precondition, steps, sensitivity, '[{"surface":"planner/agenda"}]'::jsonb, module,
               batch_cap, 900, 'deprecated', over
          FROM action_definitions WHERE graph_id IS NULL AND id = 'planner/postpone_overdue'`);
      // Рутина со старым тулом в белом списке и отложенная операция с ним же.
      await a.execute(sql`
        INSERT INTO entities (id, graph_id, title, aspects, props, tags)
        VALUES (${crypto.randomUUID()}::uuid, ${user}::uuid, 'Старая рутина', '{}'::text[],
                ${JSON.stringify({ 'orbis/allowed_tools': ['action_planner_postpone_overdue'] })}::jsonb,
                '{}'::text[])`);
      await a.execute(sql`
        INSERT INTO chat_messages (id, thread_id, role, content, metadata)
        SELECT ${crypto.randomUUID()}::uuid, t.id, 'system', 'Требуется подтверждение',
               ${JSON.stringify({
                 pending: { id: 'p', tool: 'action_planner_postpone_overdue', input: {} },
               })}::jsonb
          FROM chat_threads t WHERE t.graph_id = ${user}::uuid AND t.entity_id IS NULL`);
    });
    const before = await worldSnapshot(user);

    const p = await plan(user);

    expect(p.counters).toEqual({
      agendaSubscriptions: 1,
      retiredSurfaceActions: 1,
      oldToolRoutines: 1,
      oldToolPending: 1,
    });
    const text = formatMigrate1bPlan(p).join('\n');
    expect(text).toContain('ВНИМАНИЕ: подписок графа на поверхности planner/agenda — 1');
    expect(text).toContain('ВНИМАНИЕ: действий графа на снятых поверхностях');
    expect(text).toContain('ВНИМАНИЕ: рутин со старым тулом action_planner_postpone_overdue — 1');
    expect(text).toContain(
      'ВНИМАНИЕ: отложенных операций со старым тулом action_planner_postpone_overdue — 1',
    );
    expect(await worldSnapshot(user)).toEqual(before);
  });

  test('заведённый граф — «уже переведён»; граф без мира — не заведён; операций нет', async () => {
    const seeded = await freshGraph();
    await seedOwnerGraph(db, personal(seeded));
    const bare = await freshGraph();

    const a = await plan(seeded);
    const b = await plan(bare);

    expect([a.state, a.operations]).toEqual(['migrated', []]);
    expect([b.state, b.operations]).toEqual(['unseeded', []]);
  });
});

describe('applyMigrate1b — --apply: одна пачка исполнителя на граф', () => {
  test('(б) фикстура прод-формы: списки → страницы поставки, тела байт-в-байт, записи поставки, маска, ОДНА запись журнала В-4, прочее не тронуто', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    const task = await ownerCreate(user, { title: 'Задача фикстуры' });
    const lists = await Promise.all(LIST_KEYS.map((k) => rowOf(user, listId(user, k))));
    const settingsBefore = await settingsOf(user);
    const journalBefore = await journalTitles(user);
    const stampsBefore = await stampsExcept(
      user,
      LIST_KEYS.map((k) => listId(user, k)),
    );
    expect(stampsBefore.has(task)).toBe(true);
    expect(stampsBefore.has(seedCategoryId(user, 'food'))).toBe(true);

    const out = await applyMigrate1b(db, personal(user));
    expect(out.status).toBe('migrated');

    const reg = await withIdentity(db, personal(user), (tx) => effectiveRegistry(tx, user));
    for (const [i, k] of LIST_KEYS.entries()) {
      const was = lists[i] as Row;
      const now = await rowOf(user, listId(user, k));
      expect([k, now.aspects.includes(PAGE_ASPECT), now.aspects.includes(SUPPLY_ASPECT)]).toEqual([
        k,
        true,
        true,
      ]);
      expect([k, now.tags.includes('smart-list')]).toEqual([k, false]);
      expect([k, now.body, now.bodyDoc]).toEqual([k, was.body, was.bodyDoc]);
      expect([k, now.props[SUPPLY_KEY]]).toEqual([k, k]);
      expect([k, supplyStatusOf(now)]).toEqual([k, 'etalon']);
    }
    // «Год» и «Жизнь» совпали с ПРЕЖНИМ эталоном: в записи — его печать и отпечаток (РП-35, В-9).
    for (const k of ['horizon-year', 'horizon-life'] as const) {
      const e = etalonOf(k);
      if (e.kind === 'app') throw new Error('список — не приложение');
      const legacy = LEGACY_ETALON_TEXTS[k] as string;
      const now = await rowOf(user, listId(user, k));
      expect(now.props[SUPPLY_TEXT]).toBe(
        printPageRecord({
          title: e.title,
          emoji: e.emoji,
          body: canonicalPageText(legacy, reg),
        }),
      );
      expect(now.props[SUPPLY_HASH]).toBe(etalonHash({ ...e, text: legacy }));
    }
    // Новый эталон приходит предложением сразу — и только им.
    const updates = await listUpdates({ db, identity: personal(user) });
    expect(updates.map((u) => [u.key, u.kind, u.edited])).toEqual([
      ['horizon-year', 'update', false],
      ['horizon-life', 'update', false],
    ]);

    // Записи поставки созданы и «как в поставке»; оболочка — навигация из закреплённых.
    for (const k of ['host-template', 'home', 'records', 'host-shell'] as const) {
      const r = await rowOf(user, supplyRecordId(user, k));
      expect([k, r.props[SUPPLY_KEY], supplyStatusOf(r), r.archived]).toEqual([
        k,
        k,
        'etalon',
        false,
      ]);
    }
    const shell = await rowOf(user, supplyRecordId(user, 'host-shell'));
    expect(shell.props[APP_HOME]).toBe(supplyRecordId(user, 'home'));
    expect(shell.props[APP_NAV]).toEqual([
      supplyRecordId(user, 'records'),
      ...PINNED_KEYS.map((k) => listId(user, k)),
    ]);
    expect(shell.props[APP_NAV_FORM]).toBe('header-list');

    const settingsAfter = await settingsOf(user);
    expect(settingsAfter.mask).toEqual(['finance']);
    // Закреплённые и установленные виды не трогаются: колонки уходят позже (§8.6).
    expect([settingsAfter.pinned, settingsAfter.installed]).toEqual([
      settingsBefore.pinned,
      settingsBefore.installed,
    ]);
    // ОДНА запись журнала с подписью В-4.
    expect(await journalTitles(user)).toEqual([...journalBefore, MIGRATE_1B_LABEL]);
    expect(MIGRATE_1B_LABEL).toBe(
      'Перевод данных среза 1б: записи поставки, навигация из закреплённых, списки → страницы, Финансы выключены',
    );
    // Прочие записи графа не тронуты (категории, задача фикстуры).
    const stampsAfter = await stampsExcept(user, [
      ...LIST_KEYS.map((k) => listId(user, k)),
      ...(['host-template', 'home', 'records', 'host-shell'] as const).map((k) =>
        supplyRecordId(user, k),
      ),
    ]);
    expect(stampsAfter).toEqual(stampsBefore);
  });

  test('(б) тело «Года», правленое владельцем, — эталон нынешний, «изменено вами», предложения нет', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    const year = listId(user, 'horizon-year');
    const was = await rowOf(user, year);
    await ownerUpdate(user, {
      id: year,
      body: `${was.body}\n\nМоя приписка.`,
      expectedUpdatedAt: was.updatedAt,
    });
    const edited = await rowOf(user, year);

    const p = await plan(user);
    expect(p.lists.find((l) => l.key === 'horizon-year')).toMatchObject({
      etalon: 'current',
      status: 'edited',
    });
    await applyMigrate1b(db, personal(user));

    const now = await rowOf(user, year);
    expect(now.body).toBe(edited.body);
    expect(supplyStatusOf(now)).toBe('edited');
    expect(now.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('horizon-year')));
    const updates = await listUpdates({ db, identity: personal(user) });
    expect(updates.map((u) => u.key)).toEqual(['horizon-life']);
  });

  test('(в) закреплённые с дублем, своей страницей и архивной записью — навигация без дубля, своя в конце по order, архивная пропущена, «изменено вами»', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    const mine = await ownerCreate(user, { title: 'Моя страница' });
    const gone = await ownerCreate(user, { title: 'Ушедшая' });
    await ownerUpdate(user, { id: gone, archived: true });
    await setPinned(user, [
      { id: listId(user, 'upcoming'), order: 1 },
      { id: mine, order: 9 },
      { id: listId(user, 'daily-planning'), order: 0 },
      { id: listId(user, 'daily-planning'), order: 2 },
      { id: gone, order: 3 },
      { id: listId(user, 'all-tasks'), order: 4 },
      { id: listId(user, 'horizon-year'), order: 5 },
      { id: listId(user, 'routines'), order: 6 },
    ]);
    const mineBefore = await rowOf(user, mine);

    const p = await plan(user);
    expect(p.navSkipped.map((s) => [s.id, s.reason])).toEqual([
      [listId(user, 'daily-planning'), 'duplicate'],
      [gone, 'archived'],
    ]);
    expect(p.shellStatus).toBe('edited');

    const out = await applyMigrate1b(db, personal(user));
    expect(out.status).toBe('migrated');

    const shell = await rowOf(user, supplyRecordId(user, 'host-shell'));
    expect(shell.props[APP_NAV]).toEqual([
      supplyRecordId(user, 'records'),
      listId(user, 'daily-planning'),
      listId(user, 'upcoming'),
      listId(user, 'all-tasks'),
      listId(user, 'horizon-year'),
      listId(user, 'routines'),
      mine,
    ]);
    expect(supplyStatusOf(shell)).toBe('edited');
    // Оболочка хоста «Дом» не раздаёт (Н-1): своя страница не тронута.
    const mineAfter = await rowOf(user, mine);
    expect(mineAfter.updatedAt).toBe(mineBefore.updatedAt);
    expect(mineAfter.props[HOME_PROPERTY]).toBeUndefined();
  });

  test('(г) повторный перевод — «уже переведён», ноль записей', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    await applyMigrate1b(db, personal(user));
    const before = await worldSnapshot(user);

    const again = await applyMigrate1b(db, personal(user));

    expect(again.status).toBe('already');
    expect(await worldSnapshot(user)).toEqual(before);
  });

  test('(д) после перевода заведение графа признаёт его заведённым: {seeded:false}, ноль записей', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    await applyMigrate1b(db, personal(user));
    const before = await worldSnapshot(user);

    expect(await seedOwner(db, personal(user))).toEqual({ seeded: false });
    expect(await worldSnapshot(user)).toEqual(before);
  });

  test('id записи поставки занят чужой записью — план называет причину, перевод — INVARIANT без записи', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    await admin((a) =>
      a.execute(sql`
        INSERT INTO entities (id, graph_id, title, aspects, props, tags)
        VALUES (${supplyRecordId(user, 'home')}::uuid, ${user}::uuid, 'Чужая', '{}'::text[],
                '{}'::jsonb, '{}'::text[])`),
    );
    const before = await worldSnapshot(user);

    expect((await plan(user)).blocked).toContain('«home»');
    const err = await applyMigrate1b(db, personal(user)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).code).toBe('INVARIANT');
    expect(await worldSnapshot(user)).toEqual(before);
  });
});

describe('runMigrate1b — обвязка ops.ts (гейт подтверждения, печать)', () => {
  test('(е) без --i-understand, без режима, с лишним флагом — код 2, база не открыта, ни одной записи', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    const before = await worldSnapshot(user);

    for (const args of [
      ['--apply'],
      [],
      ['--report', '--apply', '--i-understand'],
      ['--apply', '--i-understand', '--force'],
      ['--i-understand'],
    ]) {
      const lines: string[] = [];
      const opened = { n: 0 };
      expect([args, await runMigrate1b(args, localIo(user, lines, opened))]).toEqual([args, 2]);
      expect([args, opened.n]).toEqual([args, 0]);
      expect(lines.join('\n')).toContain('migrate-1b');
    }
    expect(await worldSnapshot(user)).toEqual(before);
  });

  test('--report печатает план и ничего не пишет; --apply --i-understand переводит; повтор — «уже переведён»', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    const before = await worldSnapshot(user);

    const report: string[] = [];
    expect(await runMigrate1b(['--report'], localIo(user, report, { n: 0 }))).toBe(0);
    expect(await worldSnapshot(user)).toEqual(before);
    const text = report.join('\n');
    expect(text).toContain(user);
    expect(text).toContain(
      'навигация оболочки хоста: Записи, Daily Planning, Upcoming, All Tasks, Год, Рутины',
    );
    expect(text).toContain('оболочка хоста: как в поставке');
    expect(text).toContain('«Год» — как в поставке прежней версии');
    expect(text).toContain('маска выключенных расширений: [] → [finance]');
    expect(text).toContain('ничего не записано');

    const applied: string[] = [];
    expect(
      await runMigrate1b(['--apply', '--i-understand'], localIo(user, applied, { n: 0 })),
    ).toBe(0);
    expect(applied.join('\n')).toContain('переведён одной пачкой');
    expect((await plan(user)).state).toBe('migrated');

    const after = await worldSnapshot(user);
    const again: string[] = [];
    expect(await runMigrate1b(['--apply', '--i-understand'], localIo(user, again, { n: 0 }))).toBe(
      0,
    );
    expect(again.join('\n')).toContain('уже переведён');
    expect(await worldSnapshot(user)).toEqual(after);
  });
});

// Ключи фикстуры сверены с эталонами: список, которого нет в поставке, тест бы не заметил.
test('ключи шести списков — ключи эталонов поставки', () => {
  for (const k of LIST_KEYS) expect(etalonOf(k as SupplyKey).kind).toBe('page');
});

describe('фикс-раунд 1 гейта (R-21, M-1…M-5)', () => {
  test('M-1: --report — транзакция READ ONLY: план, попытавшийся записать, падает, граф цел', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    const before = await worldSnapshot(user);

    const writing = reportMigrate1b(db, personal(user), async (tx, graph) => {
      const p = await planMigrate1b(tx, graph);
      await tx.execute(
        sql`UPDATE user_settings SET disabled_modules = ARRAY['finance'] WHERE graph_id = ${graph}::uuid`,
      );
      return p;
    });
    const err = await writing.then(
      () => null,
      (e: unknown) => e,
    );
    // Драйвер оборачивает ошибку PG: причина — `read_only_sql_transaction` (25006), не права и не RLS.
    const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
    expect([cause?.code, cause?.message]).toEqual([
      '25006',
      'cannot execute UPDATE in a read-only transaction',
    ]);
    expect((await reportMigrate1b(db, personal(user))).state).toBe('legacy');
    expect(await worldSnapshot(user)).toEqual(before);
  });

  test('M-2: --report — сбой одного графа печатается, остальные отчитываются, код 1', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    // Второй граф прод-формы с битой строкой своего реестра (действие без шагов, положено админом мимо
    // схемы записи): чтение реестра графа падает законно — ровно «сбой одного графа на проде».
    const broken = await freshGraph();
    await seedLegacyWorld(broken);
    await admin((a) =>
      a.execute(sql`
        INSERT INTO action_definitions (id, graph_id, key, label, description, params, precondition,
                                        steps, sensitivity, offered_by, module, batch_cap, rank,
                                        status, over)
        SELECT 'mine/broken', ${broken}::uuid, 'mine/broken', label, description, params,
               precondition, '[]'::jsonb, sensitivity, offered_by, module, batch_cap, 900, status, over
          FROM action_definitions WHERE graph_id IS NULL AND id = 'planner/postpone_overdue'`),
    );
    // Мимо реестровых операций версия реестра графа не сдвинулась бы, и кеш отдал бы прежний снимок.
    await bumpRegistryVersion(broken);
    expect(
      await plan(broken).then(
        () => null,
        (e: unknown) => e,
      ),
    ).toBeInstanceOf(Error);
    const lines: string[] = [];
    const io = localIo(user, lines, { n: 0 });
    const code = await runMigrate1b(['--report'], {
      ...io,
      identities: async () => [personal(broken), personal(user)],
    });
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain(`ОШИБКА граф ${broken}: отчёт не собран`);
    expect(text).toContain(`граф ${user}:`);
    expect(text).toContain('навигация оболочки хоста: Записи');
  });

  test('M-3: реестр не среза 1б — отказ с текстом о пересеве', async () => {
    const user = await freshGraph();
    const reg = await withIdentity(db, personal(user), (tx) => effectiveRegistry(tx, user));
    expect(() => assertSlice1bRegistry(reg)).not.toThrow();
    const aspects = new Map(reg.aspects);
    aspects.delete(SUPPLY_ASPECT);
    let err: unknown = null;
    try {
      assertSlice1bRegistry({ ...reg, aspects });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).code).toBe('VALIDATION');
    expect((err as ExecError).message).toContain('сначала пересев реестров среза 1б');
    expect((err as ExecError).message).toContain(SUPPLY_ASPECT);
  });

  test('M-4: битый элемент закреплённых — «(без id)», а не «undefined»', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    await admin((a) =>
      a.execute(sql`UPDATE user_settings
                       SET "pinnedEntities" = "pinnedEntities" || '[{"order": 1}, null]'::jsonb
                     WHERE graph_id = ${user}::uuid`),
    );
    const p = await plan(user);
    expect(p.navSkipped).toEqual([
      { id: null, title: null, reason: 'missing' },
      { id: null, title: null, reason: 'missing' },
    ]);
    const text = formatMigrate1bPlan(p).join('\n');
    expect(text).toContain(
      'пропущено из закреплённых: битый элемент закреплённых (без id) — записи нет',
    );
    expect(text).not.toContain('undefined');
  });

  test('M-5: отчёт называет рутины хоста — на фикстуре их нет, в графе, заведённом 1б, есть', async () => {
    const legacy = await freshGraph();
    await seedLegacyWorld(legacy);
    const seeded = await freshGraph();
    await seedOwner(db, personal(seeded));

    const a = await plan(legacy);
    const b = await plan(seeded);

    expect(a.hostRoutines).toEqual({ gardener: 'absent', rollover: 'absent' });
    expect(b.hostRoutines).toEqual({ gardener: 'present', rollover: 'present' });
    expect(formatMigrate1bPlan(a).join('\n')).toContain(
      'рутины хоста: садовник — нет, «Перенос остатков» — нет (после перевода недостающую никто не посеет',
    );
    expect(formatMigrate1bPlan(b).join('\n')).toContain(
      'рутины хоста: садовник — есть, «Перенос остатков» — есть',
    );
  });

  test('R-21: печать --apply предупреждает, что Undo — не откат', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    const lines: string[] = [];
    expect(await runMigrate1b(['--apply', '--i-understand'], localIo(user, lines, { n: 0 }))).toBe(
      0,
    );
    expect(lines).toContain(UNDO_WARNING);
    expect(UNDO_WARNING).toContain('Undo этого перевода — НЕ откат');
    expect(UNDO_WARNING).toContain('восстановление дампа');
  });
});
