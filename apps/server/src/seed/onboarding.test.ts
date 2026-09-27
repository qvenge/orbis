// apps/server/src/seed/onboarding.test.ts
// Заведение графа (срез 1б §8.6, РП-15, С1б-5) через createCallerFactory против живой БД: один раз, при
// отсутствии оболочки хоста — 12 категорий Финансов (механизм `seed`), десять записей поставки хоста
// (механизм `supply`), садовник и «Перенос остатков», маска Финансов, глобальный тред. На каждом
// следующем входе — ноль записей; граф старой формы — отказ `GRAPH_NEEDS_MIGRATION` без записи.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphId } from '@orbis/shared';
import {
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  BUILTIN_ASPECT_IDS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  CORE_PROPERTY_IDS,
  PAGE_ASPECT,
  ROLE_DEPENDENCY,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
} from '@orbis/shared';
import { OWNER_LOCALE, parseQueryAst, toParseRegistry } from '@orbis/shared/query';
import { AGENDA_QUERY_TEXTS } from '@orbis/shared/query/fixtures';
import {
  SUPPLY_ETALONS,
  SUPPLY_KEYS,
  type SupplyEtalon,
  supplyStatusOf,
} from '@orbis/shared/supply';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { seedLegacyWorld } from '../../test/legacy-world';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { assertEntityProps } from '../executor/aspects-validate';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { parseGraphId } from '../identity';
import { effectiveRegistry } from '../registry/cache';
import { validateEntityProps } from '../registry/validate-props';
import { appRouter } from '../router';
import { SEED_CATEGORIES } from '../seed/categories';
import { GARDENER_SLUG, seedRoutineId } from '../seed/gardener';
import { seedCategoryId, seedSmartListId } from '../seed/onboarding';
import { ensurePersonalGraph } from '../seed/personal-graph';
import { ROLLOVER_ROUTINE_SLUG } from '../seed/rollover-routine';
import { setupGraph } from '../seed/setup-graph';
import {
  ALL_TASKS_BODY,
  DAILY_PLANNING_BODY,
  HORIZON_LIFE_BODY,
  HORIZON_YEAR_BODY,
  ROUTINES_BATCH_QUERY,
  ROUTINES_LIST_BODY,
  SEED_HORIZON_LISTS,
  SEED_SMART_LISTS,
  type SeedSmartList,
  UPCOMING_BODY,
} from '../seed/smart-lists';
import { SEED_WORLD_SIZE, WORLD_SEED_MECHANISM } from '../seed/world';
import { listUpdates } from '../supply/mechanism';
import { supplyRecordId } from '../supply/records';
import { agentLoopHelpers } from '../test/agent-loop-helpers';
import { createCallerFactory } from '../trpc';

requireEnv();

/** Содержимое {{query:…}}-блоков body — тот же разбор, что у рендерера (web query.ts). */
function queryBlocksOf(body: string): string[] {
  return [...body.matchAll(/\{\{query:\s*([\s\S]*?)\}\}/g)].map((m) => {
    const block = m[1];
    if (block === undefined) throw new Error('query-блок без группы захвата');
    return block;
  });
}

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

function callerFor(user: GraphId) {
  return createCaller({ identity: personal(user), actorKind: 'owner', db, clientVersion: null });
}

/** Счётчики строк владельца через админ-DSN (обходит RLS) — независимая от роутеров сверка. */
async function counts(
  user: GraphId,
): Promise<{ entities: number; settings: number; threads: number }> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const e = await admin.execute(
      sql`SELECT count(*)::int AS n FROM entities WHERE graph_id = ${user}`,
    );
    const s = await admin.execute(
      sql`SELECT count(*)::int AS n FROM user_settings WHERE graph_id = ${user}`,
    );
    const t = await admin.execute(
      sql`SELECT count(*)::int AS n FROM chat_threads WHERE graph_id = ${user}`,
    );
    return { entities: Number(e[0]?.n), settings: Number(s[0]?.n), threads: Number(t[0]?.n) };
  } finally {
    await adminClient.end();
  }
}

/** Маска выключенных расширений графа (админ-DSN). */
async function disabledOf(user: GraphId): Promise<string[]> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = (await admin.execute(
      sql`SELECT disabled_modules FROM user_settings WHERE graph_id = ${user}::uuid`,
    )) as unknown as Array<{ disabled_modules: string[] }>;
    return rows[0]?.disabled_modules ?? [];
  } finally {
    await adminClient.end();
  }
}

interface RecordRow {
  title: string;
  emoji: string | null;
  body: string;
  tags: string[];
  aspects: string[];
  props: Record<string, unknown>;
  archived: boolean;
  updatedAt: string;
}

/** Строка записи владельца (админ-DSN) — в той форме, по которой `supplyStatusOf` судит «как в поставке». */
async function rowOf(user: GraphId, id: string): Promise<RecordRow> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = (await admin.execute(
      sql`SELECT title, emoji, body, tags, aspects, props, archived, updated_at
            FROM entities WHERE graph_id = ${user}::uuid AND id = ${id}::uuid`,
    )) as unknown as Array<
      Omit<RecordRow, 'updatedAt' | 'body'> & {
        body: string | null;
        updated_at: string | Date;
      }
    >;
    const r = rows[0];
    if (r === undefined) throw new Error(`записи ${id} нет`);
    return {
      title: r.title,
      emoji: r.emoji,
      body: r.body ?? '',
      tags: r.tags,
      aspects: r.aspects,
      props: r.props,
      archived: r.archived,
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  } finally {
    await adminClient.end();
  }
}

/**
 * ВСЁ, что вход мог бы записать в граф владельца, одним снимком (админ-DSN, мимо RLS): число и
 * отпечаток строк `entities` (id, отметка правки, архив, тело, свойства, аспекты, теги — любая правка
 * мимо исполнителя или через него его сдвигает), рёбра, сообщения тредов (в них живёт журнал
 * действий), треды, версии тел, происхождения и строка настроек целиком — вместе с `updated_at`.
 * Сравнение «до» и «после» входа — проверка С1б-5 «на каждом входе онбординг ничего не пишет».
 */
async function worldSnapshot(user: GraphId): Promise<Record<string, unknown>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const one = async (q: ReturnType<typeof sql>): Promise<unknown> =>
      ((await admin.execute(q)) as unknown as unknown[])[0];
    return {
      entities: await one(sql`
        SELECT count(*)::int AS n,
               md5(coalesce(string_agg(
                 id::text || '|' || updated_at::text || '|' || archived::text || '|' ||
                 md5(coalesce(body, '')) || '|' || md5(props::text) || '|' ||
                 array_to_string(aspects, ',') || '|' || array_to_string(tags, ','),
                 ';' ORDER BY id), '')) AS digest
          FROM entities WHERE graph_id = ${user}::uuid`),
      relations: await one(sql`
        SELECT count(*)::int AS n FROM relations r
          JOIN entities e ON e.id = r.source_id WHERE e.graph_id = ${user}::uuid`),
      messages: await one(sql`
        SELECT count(*)::int AS n FROM chat_messages m
          JOIN chat_threads t ON t.id = m.thread_id WHERE t.graph_id = ${user}::uuid`),
      threads: await one(
        sql`SELECT count(*)::int AS n FROM chat_threads WHERE graph_id = ${user}::uuid`,
      ),
      versions: await one(
        sql`SELECT count(*)::int AS n FROM entity_versions WHERE graph_id = ${user}::uuid`,
      ),
      origins: await one(
        sql`SELECT count(*)::int AS n FROM entity_origins WHERE graph_id = ${user}::uuid`,
      ),
      settings: await one(
        sql`SELECT to_jsonb(s) AS row FROM user_settings s WHERE graph_id = ${user}::uuid`,
      ),
    };
  } finally {
    await adminClient.end();
  }
}

/**
 * Состав графа без привязки к id (они выводятся из id графа): число записей, категорий и рутин, рёбер,
 * тредов и строк настроек, маска и статус каждой записи поставки — сверка «итог как у целого заведения».
 */
async function composition(user: GraphId): Promise<Record<string, unknown>> {
  const { db: admin, client: adminClient } = adminDb();
  const n = async (q: ReturnType<typeof sql>): Promise<number> =>
    Number(((await admin.execute(q)) as unknown as Array<{ n: number }>)[0]?.n);
  try {
    return {
      entities: await n(
        sql`SELECT count(*)::int AS n FROM entities WHERE graph_id = ${user}::uuid`,
      ),
      categories: await n(sql`SELECT count(*)::int AS n FROM entities
        WHERE graph_id = ${user}::uuid AND aspects @> ARRAY['orbis/category']::text[]`),
      routines: await n(sql`SELECT count(*)::int AS n FROM entities
        WHERE graph_id = ${user}::uuid AND aspects @> ARRAY['orbis/routine']::text[]`),
      relations: await n(sql`SELECT count(*)::int AS n FROM relations r
        JOIN entities e ON e.id = r.source_id WHERE e.graph_id = ${user}::uuid`),
      threads: await n(
        sql`SELECT count(*)::int AS n FROM chat_threads WHERE graph_id = ${user}::uuid`,
      ),
      settings: await n(
        sql`SELECT count(*)::int AS n FROM user_settings WHERE graph_id = ${user}::uuid`,
      ),
      mask: await disabledOf(user),
      supply: await Promise.all(
        SUPPLY_KEYS.map(async (k) => [
          k,
          supplyStatusOf(await rowOf(user, supplyRecordId(user, k))),
        ]),
      ),
    };
  } finally {
    await adminClient.end();
  }
}

const journal = makeChatJournalSink();

/** Правка владельца обычным путём — исполнитель, механизм `user`, журнал. */
async function ownerEdit(user: GraphId, input: Record<string, unknown>): Promise<void> {
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
  if (!r.ok) throw new Error(`правка владельца: ${JSON.stringify(r.error)}`);
}

/** Строку записи — физически, админ-DSN: в продукте так нельзя, фикстуре — можно (§8.6, Р-29). */
async function deleteRow(user: GraphId, id: string): Promise<void> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.execute(
      sql`DELETE FROM entities WHERE graph_id = ${user}::uuid AND id = ${id}::uuid`,
    );
  } finally {
    await adminClient.end();
  }
}

/**
 * Личный граф аккаунта в цифрах: строка `graphs` с тождеством `id = owner_ref` и ровно один
 * действующий грант `owner`, выданный самим аккаунтом (спека §3.1–§3.2). Читается админ-DSN:
 * у графа без членства SELECT-политика молчит, и ноль строк означал бы не «нет графа», а «не видно».
 */
async function graphRows(
  user: GraphId,
): Promise<{ graphs: number; ownerRefOk: number; members: number; issuedByOk: number }> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const g = await admin.execute(
      sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE owner_ref = ${user}::uuid AND owner_kind = 'person')::int AS ok
          FROM graphs WHERE id = ${user}::uuid`,
    );
    const m = await admin.execute(
      sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE issued_by = ${user}::uuid)::int AS ok
          FROM graph_members
          WHERE graph_id = ${user}::uuid AND grant_kind = 'owner' AND revoked_at IS NULL`,
    );
    return {
      graphs: Number(g[0]?.n),
      ownerRefOk: Number(g[0]?.ok),
      members: Number(m[0]?.n),
      issuedByOk: Number(m[0]?.ok),
    };
  } finally {
    await adminClient.end();
  }
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('user.seedOnboarding (02 §7): состав и одноразовость', () => {
  test('сигнатура сева личного графа: один id вместо пары не компилируется (D44, Ш-2)', async () => {
    // Смысл пина: до фикс-раунда лист принимал `accountId: string`, и вызов с `who.graph`
    // клал ГРАФ в колонки аккаунта (`owner_ref`, `account_id`, `issued_by`) молча — компилятор
    // этого не видел (гейт-ревью Г-3, Important-1). Теперь единственный вход — ПАРА.
    const who = personal(await freshGraph());
    await withIdentity(db, who, async (tx) => {
      // @ts-expect-error — GraphId вместо Identity: один id сюда больше не передать
      void (() => ensurePersonalGraph(tx, who.graph));
      // @ts-expect-error — AccountId вместо Identity: и аккаунт в одиночку тоже
      void (() => ensurePersonalGraph(tx, who.actor));
      // Разведение колонок ВНУТРИ листа (`owner_ref`/`account_id`/`issued_by` — аккаунт,
      // `id`/`graph_id` — граф) держат брендированные параметры `personalGraphRow`/
      // `ownerMemberRow`: подстановка одного бренда на место другого — ошибка компиляции,
      // а не красный тест (колонки drizzle — голый `uuid`, Р-КГ-5). Проверено мутацией.
      await ensurePersonalGraph(tx, who); // идемпотентно: граф уже заведён `freshGraph()`
    });
    expect(await graphRows(who.graph)).toEqual({
      graphs: 1,
      ownerRefOk: 1,
      members: 1,
      issuedByOk: 1,
    });
  });

  test('создаёт личный граф, 12 категорий + 10 записей поставки + две рутины, настройки и глобальный тред; повтор → {seeded:false} и ни одной записи', async () => {
    // Аккаунт БЕЗ графа — обычной фикстурой `freshGraph()` строка `graphs` уже была бы заведена,
    // и сев графа первым шагом `setupGraph` (D44) проверять было бы нечем.
    const user = parseGraphId(crypto.randomUUID());
    const caller = callerFor(user);

    const first = await caller.user.seedOnboarding();
    expect(first).toEqual({ seeded: true });
    expect(await counts(user)).toEqual({ entities: 24, settings: 1, threads: 1 });
    expect(await graphRows(user)).toEqual({ graphs: 1, ownerRefOk: 1, members: 1, issuedByOk: 1 });
    // …и число 24 — не литерал из воздуха: мир владельца (`seed/world.ts`, 12 категорий + десять
    // записей поставки хоста: шаблон, оболочка, «Домой», «Записи», шесть списков) плюс ДВЕ рутины —
    // садовник и «Перенос остатков». Сложи кто-нибудь в поставку одиннадцатую запись — литерал
    // выше покраснеет, и вот эта строка скажет, почему.
    expect(SEED_WORLD_SIZE).toBe(SEED_CATEGORIES.length + SUPPLY_ETALONS.length);
    expect(SEED_WORLD_SIZE + 2).toBe(24);

    // Глобальный тред — с NULL entity_id (§4.5)
    const { db: admin, client: adminClient } = adminDb();
    try {
      const gt = await admin.execute(
        sql`SELECT entity_id FROM chat_threads WHERE graph_id = ${user}`,
      );
      expect(gt[0]?.entity_id).toBeNull();
    } finally {
      await adminClient.end();
    }

    // Повторный вход (С1б-5, §8.6): граф заведён — вход не пишет НИЧЕГО, включая личный граф.
    const before = await worldSnapshot(user);
    const second = await caller.user.seedOnboarding();
    expect(second).toEqual({ seeded: false });
    expect(await worldSnapshot(user)).toEqual(before);
    expect(await graphRows(user)).toEqual({ graphs: 1, ownerRefOk: 1, members: 1, issuedByOk: 1 });
  });

  test('гонка двух первых входов под разными коннекшнами: один заводит граф, второй — {seeded:false} без ошибки, дублей нет', async () => {
    // Аккаунт БЕЗ графа — как у соседнего кейса выше и по той же причине: с `freshGraph()` строка
    // `graphs` и грант owner заведены ОБВЯЗКОЙ до первого вызова, обе гонящиеся транзакции проходят
    // `ensurePersonalGraph` (D44, ПЕРВЫЙ шаг заведения) по идемпотентной ветке, и гонка не задевает
    // ровно то, ради чего кейс писался.
    const user = parseGraphId(crypto.randomUUID());
    const a = appDb();
    const b = appDb();
    try {
      const callerA = createCaller({
        identity: personal(user),
        actorKind: 'owner',
        db: a.db,
        clientVersion: null,
      });
      const callerB = createCaller({
        identity: personal(user),
        actorKind: 'owner',
        db: b.db,
        clientVersion: null,
      });
      const results = await Promise.all([
        callerA.user.seedOnboarding(),
        callerB.user.seedOnboarding(),
      ]);
      expect(results.map((r) => r.seeded).sort()).toEqual([false, true]);
      expect(await counts(user)).toEqual({ entities: 24, settings: 1, threads: 1 });
      // Маска — ровно Финансы: проигравший не оставил её снятой (он снимал её до своего сева).
      expect(await disabledOf(user)).toEqual(['finance']);
    } finally {
      await a.client.end();
      await b.client.end();
    }
  });
});

describe('категории §7.1', () => {
  test('12 категорий; каждая из БД проходит валидатор реестра; spend_class отсутствует у доходных', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const rows = await caller.entity.query({ query: 'tags=category, sortBy=orbis/created_at:asc' });
    expect(rows.length).toBe(12);
    // Проверка формы — ТЕМ ЖЕ валидатором, которым её проверяет запись (стадия 2
    // исполнителя, `assertEntityProps` по эффективному снимку реестра). Прежде здесь стояла
    // zod-схема аспекта старой формы: она была ВТОРЫМ описанием тех же полей и могла
    // разойтись с реестром — с «Пересевом мира» второго описания больше нет.
    const reg = await withIdentity(db, personal(user), (tx) => effectiveRegistry(tx, user));
    for (const r of rows) {
      expect(() =>
        assertEntityProps(reg, { props: r.props, aspects: [...r.aspects] }),
      ).not.toThrow();
      expect(r.aspects).toEqual(['orbis/category']);
    }

    // Доходные (Зарплата/Фриланс): ключа spend_class нет (не null — иначе ajv упадёт)
    const salary = rows.find((r) => r.title === 'Зарплата');
    expect(salary).toBeDefined();
    expect(salary?.props['orbis/spend_class']).toBeUndefined();

    // Расходная «Еда»: точные aliases и spend_class
    const food = rows.find((r) => r.title === 'Еда');
    const foodProps = food?.props ?? {};
    expect(foodProps['orbis/spend_class']).toBe('discretionary');
    expect(foodProps['orbis/icon']).toBe('🍔');
    expect(foodProps['orbis/color']).toBe('#e0885a');
    expect(foodProps['orbis/aliases']).toEqual([
      'еда',
      'food',
      'продукты',
      'groceries',
      'обед',
      'lunch',
      'ужин',
      'завтрак',
      'кофе',
    ]);
  });

  test('категория «Еда» находится entity.query(tags=category, search=Еда)', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const rows = await caller.entity.query({ query: 'tags=category, search=Еда' });
    expect(rows.map((r) => r.title)).toContain('Еда');
    expect(rows.every((r) => r.tags.includes('category'))).toBe(true);
  });

  test('SEED_CATEGORIES: ровно 12, слаги уникальны', () => {
    expect(SEED_CATEGORIES.length).toBe(12);
    const slugs = new Set(SEED_CATEGORIES.map((c) => c.slug));
    expect(slugs.size).toBe(12);
  });
});

/**
 * ПУТЬ СИДА ПРОТИВ ЗАПРЕТА CORE-ПРОЕКЦИЙ (единица 15-бис, §А1-3).
 *
 * Запрет «core-свойству нет места в `props`» (`CORE_IN_PROPS`, `registry/validate-props.ts`)
 * стоит на общей стадии 2 конвейера, а сид пишет строки НАПРЯМУЮ, мимо executor'а — то есть
 * стадию 2 он не проходит вовсе, и запрет его сломать не может ПО ПОСТРОЕНИЮ. Но именно
 * поэтому нужна проба: неисполнимость правила на этом пути значит, что нарушить его сид мог
 * бы МОЛЧА, и двадцать посеянных строк оказались бы единственными в системе носителями
 * второй правды. Здесь посеянное прогоняется через тот же валидатор, что и запись владельца.
 *
 * Core-значения сид пишет ЗАКОННО и пишет их в КОЛОНКИ (`title`, `created_at`, `updated_at`
 * у каждой из 24 строк) — проба это и показывает: колонки заполнены, а `props` о них молчит.
 */
describe('сид против запрета core-проекций в props (§А1-3, единица 15-бис)', () => {
  test('все 24 посеянные строки проходят валидатор реестра: core-значения — в колонках, в props их нет', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const rows = await withIdentity(db, personal(user), async (tx) => {
      const reg = await effectiveRegistry(tx, user);
      const seeded = await tx
        .select({
          id: entities.id,
          title: entities.title,
          props: entities.props,
          aspects: entities.aspects,
          createdAt: entities.createdAt,
        })
        .from(entities);
      return seeded.map((row) => ({
        title: row.title,
        createdAt: row.createdAt,
        propKeys: Object.keys(row.props as Record<string, unknown>),
        violations: validateEntityProps(reg, {
          props: row.props as Record<string, unknown>,
          aspects: row.aspects,
        }),
      }));
    });

    expect(rows.length).toBe(24);
    for (const row of rows) {
      expect([row.title, row.violations]).toEqual([row.title, []]);
      // Прямая половина того же утверждения: значение колонки есть, а адреса в props нет.
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.createdAt).toBeInstanceOf(Date);
      for (const id of CORE_PROPERTY_IDS) {
        expect([row.title, id, row.propKeys.includes(id)]).toEqual([row.title, id, false]);
      }
    }
  });
});

describe('smart lists §7.2 / §3.3', () => {
  test('проза шести списков — байт-в-байт равна блокам 02 §3.3, в порядке документа', () => {
    // ПИН БАЙТОВЫЙ — сравниваются ЦЕЛЫЕ тела, вместе с записью запросов внутри
    // `{{query:…}}`. Маска `{{query:#N}}`, стоявшая здесь на время реформы, снята: она была
    // законна ровно тот интервал, пока тела сидов уже переехали в key-форму канона (§А5-3),
    // а §3.3 PRD ещё держал прежнюю запись, — а этот коммит везёт тела и документ ВМЕСТЕ
    // (§А12-7), и разъехаться им больше не на чем.
    //
    // Почему пин байтовый, а не «по смыслу»: §3.3 — это ОБЕЩАНИЕ пользователю про то, что
    // он увидит в смарт-листе, и единственный способ поймать расхождение обещания с кодом —
    // сравнить символы. Семантического сравнения двух форм запроса в дереве больше нет
    // вовсе: мост старой грамматики снесён вместе со старой формой.
    const prdPath = join(import.meta.dir, '../../../../docs/prd/02-core-os.md');
    const prd = readFileSync(prdPath, 'utf8');
    const blocks = [...prd.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((m) => {
      const block = m[1];
      if (block === undefined) throw new Error('markdown-блок без группы захвата');
      return block;
    });
    // Первые шесть markdown-блоков документа — §3.3, ровно в порядке SEED_SMART_LISTS:
    // три исходных списка, два верхних горизонта планирования (E4), «Рутины» (V1.9).
    expect(blocks.slice(0, SEED_SMART_LISTS.length)).toEqual(SEED_SMART_LISTS.map((s) => s.body));
    // Поимённо — чтобы падение называло виновника, а не «массивы не равны»
    expect(blocks[0]).toBe(DAILY_PLANNING_BODY);
    expect(blocks[1]).toBe(UPCOMING_BODY);
    expect(blocks[2]).toBe(ALL_TASKS_BODY);
    expect(blocks[3]).toBe(HORIZON_YEAR_BODY);
    expect(blocks[4]).toBe(HORIZON_LIFE_BODY);
    expect(blocks[5]).toBe(ROUTINES_LIST_BODY);
    // Контроль осмысленности: блоков в §3.3 ровно шесть, и запись запросов внутрь сравнения
    // ВХОДИТ. Без этих двух строк пин зеленел бы и на документе, где §3.3 обрезали до трёх
    // списков, и на теле, где запрос подменили целиком.
    expect(blocks).toHaveLength(SEED_SMART_LISTS.length);
    expect(ROUTINES_LIST_BODY).toContain(`{{query:${ROUTINES_BATCH_QUERY}}}`);
  });

  test('все {{query:}}-блоки шести списков разбираются СТРОГИМ каноном против ЖИВОГО реестра', async () => {
    // Реестр — из ручки, а не из фикстуры: страховка от опечатки в сиде стоит ровно
    // столько, сколько стоит её словарь, а сидированный блок увидит именно тот реестр,
    // который отдаёт сервер.
    const caller = callerFor(await freshGraph());
    const { properties, roles, aspects, contracts } = await caller.registry.effective();
    const reg = toParseRegistry(
      {
        properties: new Map(properties.map((p) => [p.id, p])),
        aspects: new Map(aspects.map((a) => [a.id, a])),
        roles: new Map(roles.map((r) => [r.id, r])),
        contracts: new Map(contracts.map((c) => [c.id, c])),
      },
      OWNER_LOCALE,
    );
    // Ожидаемое число блоков в каждом теле — потеря блока при правке body не пройдёт молча
    const expectedBlocks: Record<SeedSmartList['slug'], number> = {
      'daily-planning': 3,
      upcoming: 2,
      'all-tasks': 1,
      'horizon-year': 1,
      'horizon-life': 1,
      routines: 3,
    };
    expect(Object.keys(expectedBlocks).length).toBe(SEED_SMART_LISTS.length);
    for (const list of SEED_SMART_LISTS) {
      const blocks = queryBlocksOf(list.body);
      expect(blocks.length).toBe(expectedBlocks[list.slug]);
      for (const block of blocks) {
        const parsed = parseQueryAst(block, reg);
        expect([list.slug, block, parsed.ok]).toEqual([list.slug, block, true]);
      }
    }
  });

  // E4, условие «никакие два списка не показывают одно и то же»: побайтовое совпадение
  // блоков означало бы два списка с одинаковой выдачей под разными заголовками.
  test('никакие два сидированных query-блока не совпадают побайтово', () => {
    const all = SEED_SMART_LISTS.flatMap((s) => queryBlocksOf(s.body));
    expect(new Set(all).size).toBe(all.length);
  });

  // Парсер — не компилятор: он проверяет форму, а SQL строит `query/compile-ast.ts` со своим
  // исчерпывающим разбором токенов и типов полей. Блок, который парсится, но не
  // компилируется, приехал бы пользователю красной плашкой в готовом списке.
  test('каждый query-блок шести списков выполняется entity.query против живой БД', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    for (const list of SEED_SMART_LISTS) {
      for (const block of queryBlocksOf(list.body)) {
        const rows = await caller.entity.query({ query: block });
        expect(Array.isArray(rows)).toBe(true);
      }
    }
  });

  // E4, R21: горизонты выражены ТОЛЬКО относительными токенами грамматики. Абсолютная
  // дата в сиде протухла бы через неделю после деплоя, и список молча опустел бы.
  test('в телах горизонтов нет абсолютных дат — только относительные date-токены', () => {
    for (const list of SEED_HORIZON_LISTS) {
      for (const block of queryBlocksOf(list.body)) {
        expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      }
    }
  });

  // §9.4: шесть списков — записи поставки. Страница, эталон, ключ, прежний детерминированный id сева
  // (ссылки владельца на них переживают 1б), тег `smart-list` ушёл — его никто не читает.
  test('шесть списков — страницы поставки: аспекты, ключ, «как в поставке», прежние id, тега smart-list нет', async () => {
    const user = await freshGraph();
    await callerFor(user).user.seedOnboarding();

    const expected: Array<[SeedSmartList['slug'], string, string]> = [
      ['daily-planning', 'Daily Planning', '☀️'],
      ['upcoming', 'Upcoming', '🗓️'],
      ['all-tasks', 'All Tasks', '📋'],
      ['horizon-year', 'Год', '🎯'],
      ['horizon-life', 'Жизнь', '🧭'],
      ['routines', 'Рутины', '⏰'],
    ];
    expect(expected.map(([slug]) => slug)).toEqual(SEED_SMART_LISTS.map((l) => l.slug));
    for (const [slug, title, emoji] of expected) {
      const row = await rowOf(user, seedSmartListId(user, slug));
      expect([slug, row.title, row.emoji]).toEqual([slug, title, emoji]);
      expect(row.aspects).toEqual(expect.arrayContaining([PAGE_ASPECT, SUPPLY_ASPECT]));
      expect(row.props[SUPPLY_KEY]).toBe(slug);
      expect([slug, supplyStatusOf(row)]).toEqual([slug, 'etalon']);
      expect(row.tags).not.toContain('smart-list');
    }
    expect((await rowOf(user, seedSmartListId(user, 'daily-planning'))).body).toBe(
      DAILY_PLANNING_BODY,
    );
    // Тега `smart-list` нет ни на одной записи графа — поиск по нему пуст.
    expect(await callerFor(user).entity.query({ query: 'tags=smart-list' })).toEqual([]);
  });
});

describe('настройки §7.3 (getSettings / updateSettings)', () => {
  test('getSettings: дефолты §7.3; закреплённых и установленных видов нет', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const s = await caller.user.getSettings();
    expect(s.timezone).toBe('Europe/Moscow');
    expect(s.defaultCurrency).toBe('RUB');
    expect(s.weekStartDay).toBe('monday');
    expect(s.plan).toBe('dev');
    // Закреплённые стали навигацией оболочки хоста (§9.3): `pinnedEntities` и `installedViews`
    // заведение графа не пишет (РП-15), колонки остаются пустыми до их удаления.
    expect(s.pinnedEntities).toEqual([]);
    expect(s.installedViews).toEqual([]);
  });

  test('updateSettings: частичная правка меняет заданные поля, остальные не трогает', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const upd = await caller.user.updateSettings({
      timezone: 'Asia/Almaty',
      weekStartDay: 'sunday',
    });
    expect(upd.timezone).toBe('Asia/Almaty');
    expect(upd.weekStartDay).toBe('sunday');
    expect(upd.defaultCurrency).toBe('RUB'); // не тронуто

    // персистентно
    const again = await caller.user.getSettings();
    expect(again.timezone).toBe('Asia/Almaty');
  });
});

// §9.3 (Task 3): ownerOnly-матрица против живой БД — агент (PAT) не управляет
// аккаунтом (FORBIDDEN), read-пути ему открыты, владельцу гейт не мешает.
describe('ownerOnly (§9.3): агент против владельца', () => {
  test('агент: мутации аккаунта → FORBIDDEN; getSettings доступен; владелец — ok', async () => {
    const user = await freshGraph();
    const owner = createCaller({
      identity: personal(user),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    const agent = createCaller({
      identity: personal(user),
      actorKind: 'agent',
      db,
      clientVersion: null,
    });

    // owner → ok: сид проходит под ownerOnlyProcedure
    expect((await owner.user.seedOnboarding()).seeded).toBe(true);

    // agent → FORBIDDEN на всех трёх закрытых процедурах; состояние не меняется
    const calls: Array<() => Promise<unknown>> = [
      () => agent.user.seedOnboarding(),
      () => agent.user.updateSettings({ timezone: 'Europe/Berlin' }),
      () => agent.user.exportData(),
    ];
    for (const call of calls) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe('FORBIDDEN');
    }

    // read-путь открыт агенту: настройки читаются, правка агента не применилась
    const viaAgent = await agent.user.getSettings();
    expect(viaAgent.timezone).toBe('Europe/Moscow');

    // владельцу гейт не мешает: правка проходит
    const upd = await owner.user.updateSettings({ timezone: 'Asia/Almaty' });
    expect(upd.timezone).toBe('Asia/Almaty');
  });
});

// E4, условие «заголовок не врёт»: горизонт обязан показывать то, что обещает его имя и
// первая строка тела. Проверяется смыслом, а не сверкой строк запроса. Ни один блок «Года»
// и «Жизни» не опирается на даты, поэтому и фикстуры от «сегодня» не зависят — теста,
// который на полуночи увидел бы разные сутки у себя и у сервера, здесь нет по построению.
describe('горизонты показывают обещанное (§3.3, E4)', () => {
  /** id результатов N-го блока тела списка. */
  async function idsOfBlock(user: GraphId, body: string, index: number): Promise<Set<string>> {
    const block = queryBlocksOf(body)[index];
    if (block === undefined) throw new Error(`в body нет query-блока №${index}`);
    const rows = await callerFor(user).entity.query({ query: block });
    return new Set(rows.map((r) => r.id));
  }

  test('«Год» отбирает цели, «Жизнь» — сущности с тегом life, и ничего сверх', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    // Задача с датой — контрольная: ни в один из двух горизонтов она попасть не должна
    await caller.entity.create({
      input: {
        title: 'Обычная задача',
        tags: [],
        props: {
          'orbis/task_status': 'planned',
          'orbis/due_date': '2026-12-31',
        },
        aspects: ['orbis/task'],
      },
      source: 'ui',
    });
    const goal = (
      await caller.entity.create({
        input: {
          title: 'Пробежать 100 км',
          tags: [],
          props: {
            // Новая форма значения (§А5-2): запрос — ДЕРЕВО, а неразобранный текст едет
            // обёрткой `{text}`. Старый вход исполнителя оборачивал строку сам
            // (`translateLegacyValue`); прямая запись `props` через него не идёт, и строкой
            // здесь значение не прошло бы схему свойства.
            'orbis/progress_source': {
              query: { text: 'aspect=orbis/task, orbis/task_status=done' },
              aggregate: 'count',
            },
            'orbis/target_value': '100',
          },
          aspects: ['orbis/goal'],
        },
        source: 'ui',
      })
    ).id;
    const value = (
      await caller.entity.create({ input: { title: 'Здоровье', tags: ['life'] }, source: 'ui' })
    ).id;

    // «Год»: цели, и только они
    expect([...(await idsOfBlock(user, HORIZON_YEAR_BODY, 0))]).toEqual([goal]);

    // «Жизнь»: сущности с тегом life; сами списки-горизонты (тег smart-list) в выдачу не лезут
    expect([...(await idsOfBlock(user, HORIZON_LIFE_BODY, 0))]).toEqual([value]);
  });

  // Лестница объявлена словами в теле «Года» (Р29) — если исходные списки переименуют,
  // текст начнёт врать. Здесь это ловится, а не всплывает у пользователя.
  test('лестница в теле «Года» называет существующие списки их настоящими заголовками', () => {
    const ladder = HORIZON_YEAR_BODY.split('\n').find((l) => l.startsWith('Лестница горизонтов'));
    expect(ladder).toBeDefined();
    for (const slug of ['daily-planning', 'upcoming'] as const) {
      const title = SEED_SMART_LISTS.find((l) => l.slug === slug)?.title;
      expect(title).toBeDefined();
      expect(ladder).toContain(`«${title as string}»`);
    }
    expect(ladder).toContain('«Жизнь»');
  });
});

// Задача 14 (V1.9, V1.14) и D42: шестой сидируемый список — «Рутины». ТРИ блока, и
// порядок в нём — не косметика: бейдж закреплённой сущности считает ПЕРВЫЙ query-блок body
// (§3.2), поэтому первым стоит «Ждут ответа» — то, что требует действия владельца и
// убывает от каждого ответа. Третий, «Пачка решений» (D42), стоит В КОНЦЕ: место первого
// занято бейджем, а вставка в середину сдвинула бы индексы `idsOfBlock` ниже.
//
// Все три блока называют аспект ЯВНО, и на то две причины. `orbis/agent-run` — служебный
// (§3.9): без `aspect=` компилятор вырезал бы прогоны из выдачи, и блок молча показывал бы
// пусто. `stage=` — неоднозначен (orbis/project и orbis/routine), и запрос без `aspect=`
// не скомпилировался бы вовсе.
//
// Досевов у «Рутин» больше нет (спека 1б §8.6): список — запись поставки, заводится один раз при
// заведении графа, а новый эталон его тела приходит только предложением (§9.1).
describe('смарт-лист «Рутины» (§3.3, §7.2, V1.9, D42)', () => {
  const helpers = agentLoopHelpers(db);

  /** id результатов N-го блока тела «Рутин» — тем же путём, каким его увидит виджет. */
  async function idsOfBlock(user: GraphId, index: number): Promise<Set<string>> {
    const block = queryBlocksOf(ROUTINES_LIST_BODY)[index];
    if (block === undefined) throw new Error(`в теле «Рутин» нет query-блока №${index}`);
    const rows = await callerFor(user).entity.query({ query: block });
    return new Set(rows.map((r) => r.id));
  }

  test('новый владелец: «Рутины» — страница поставки с тремя блоками, последний раздел навигации хоста', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: true });

    const routines = await rowOf(user, seedSmartListId(user, 'routines'));
    expect(routines.title).toBe('Рутины');
    expect(routines.emoji).toBe('⏰');
    expect(routines.tags).toEqual([]);
    expect(routines.body).toBe(ROUTINES_LIST_BODY);
    expect(queryBlocksOf(routines.body).length).toBe(3);

    const shell = await rowOf(user, supplyRecordId(user, 'host-shell'));
    const nav = shell.props[APP_NAV] as string[];
    expect(nav[nav.length - 1]).toBe(seedSmartListId(user, 'routines'));
  });

  test('«Ждут ответа» находит прогон с исходом checkpoint и не находит отвеченный', async () => {
    const user = await freshGraph();
    await callerFor(user).user.seedOnboarding();

    const routineId = await helpers.seedRoutine(user, { title: 'Утренний обзор' });
    const waiting = await helpers.seedRoutineRun(user, {
      routineId,
      bucket: '2026-08-18T07:00',
      run: {
        'orbis/run_outcome': 'checkpoint',
        'orbis/run_checkpoint': {
          question: 'Списать 340 на «Еду»?',
          asked_at: '2026-08-18T07:00:10.000Z',
        },
      },
    });
    const answered = await helpers.seedRoutineRun(user, {
      routineId,
      bucket: '2026-08-17T07:00',
      run: {
        'orbis/run_outcome': 'answered',
        'orbis/run_checkpoint': {
          question: 'Уже спрашивал',
          asked_at: '2026-08-17T07:00:10.000Z',
        },
        'orbis/run_reply': { text: 'да', at: '2026-08-17T08:00:00.000Z' },
      },
    });

    const ids = await idsOfBlock(user, 0);
    expect(ids.has(waiting.runId)).toBe(true);
    expect(ids.has(answered.runId)).toBe(false);
    // Рутина — не прогон: во второй блок она попадёт, в первый нет
    expect(ids.has(routineId)).toBe(false);
  });

  test('«Активные рутины» находит active и не находит paused', async () => {
    const user = await freshGraph();
    await callerFor(user).user.seedOnboarding();

    const active = await helpers.seedRoutine(user, { title: 'Активная' });
    const paused = await helpers.seedRoutine(user, {
      title: 'На паузе',
      routine: { 'orbis/routine_stage': 'paused' },
    });

    const ids = await idsOfBlock(user, 1);
    expect(ids.has(active)).toBe(true);
    expect(ids.has(paused)).toBe(false);
  });

  // D42 (приёмка 11): третий блок — «Пачка решений». Имя своё: «ждёт ответа» занято
  // терминальным вопросом (первый блок), «ждёт решения» — предложением рутины, и слить
  // три вида ожидания в один заголовок значило бы обещать одну кнопку на все три.
  test('«Пачка решений» находит прогон с undecided=true и не находит ни разобранный, ни checkpoint-прогон без флажка; первый блок пачку не показывает', async () => {
    const user = await freshGraph();
    await callerFor(user).user.seedOnboarding();

    const routineId = await helpers.seedRoutine(user, { title: 'Ночная сводка' });
    const undecided = await helpers.seedRoutineRun(user, {
      routineId,
      bucket: '2026-08-18T07:00',
      run: { 'orbis/run_outcome': 'finished', 'orbis/undecided': true },
    });
    // Разобранная пачка несёт `undecided:false`: снятие флажка — ЗАПИСЬ, а не удаление
    // ключа (предиката «поля нет» у грамматики §6.1 не существует)
    const settled = await helpers.seedRoutineRun(user, {
      routineId,
      bucket: '2026-08-17T07:00',
      run: { 'orbis/run_outcome': 'finished', 'orbis/undecided': false },
    });
    const checkpoint = await helpers.seedRoutineRun(user, {
      routineId,
      bucket: '2026-08-16T07:00',
      run: {
        'orbis/run_outcome': 'checkpoint',
        'orbis/run_checkpoint': {
          question: 'Списать 340 на «Еду»?',
          asked_at: '2026-08-16T07:00:10.000Z',
        },
      },
    });

    const batch = await idsOfBlock(user, 2);
    expect(batch.has(undecided.runId)).toBe(true);
    expect(batch.has(settled.runId)).toBe(false);
    expect(batch.has(checkpoint.runId)).toBe(false);

    // И обратно: терминальный вопрос — не пачка, пачка — не терминальный вопрос
    const waiting = await idsOfBlock(user, 0);
    expect(waiting.has(checkpoint.runId)).toBe(true);
    expect(waiting.has(undecided.runId)).toBe(false);
  });
});

// С1б-5, РП-15, Р-29: заведение графа — ОДНА запись онбординга. Признак «граф заведён» — запись поставки
// «оболочка хоста», в том числе архивная; вход, где она есть, не пишет ничего (§0.2 п. 2).
describe('заведение графа (§8.6, РП-15, С1б-5)', () => {
  test('(а) новый граф: 12 категорий, десять записей поставки, рутины, маска Финансов, пустые закреплённые, глобальный тред', async () => {
    const user = await freshGraph();
    expect(await callerFor(user).user.seedOnboarding()).toEqual({ seeded: true });

    const { db: admin, client: adminClient } = adminDb();
    try {
      const cats = await admin.execute(
        sql`SELECT count(*)::int AS n FROM entities
             WHERE graph_id = ${user}::uuid AND aspects @> ARRAY['orbis/category']::text[]`,
      );
      expect(Number(cats[0]?.n)).toBe(12);
      const threads = await admin.execute(
        sql`SELECT count(*)::int AS n FROM chat_threads
             WHERE graph_id = ${user}::uuid AND entity_id IS NULL`,
      );
      expect(Number(threads[0]?.n)).toBe(1);
    } finally {
      await adminClient.end();
    }

    // Десять записей поставки: каждая — «как в поставке», со своим ключом и детерминированным id.
    for (const key of SUPPLY_KEYS) {
      const row = await rowOf(user, supplyRecordId(user, key));
      expect([key, row.aspects.includes(SUPPLY_ASPECT)]).toEqual([key, true]);
      expect([key, row.props[SUPPLY_KEY]]).toEqual([key, key]);
      expect([key, supplyStatusOf(row)]).toEqual([key, 'etalon']);
      expect([key, row.archived]).toEqual([key, false]);
    }
    expect((await rowOf(user, supplyRecordId(user, 'host-template'))).aspects).toContain(
      PAGE_ASPECT,
    );
    expect((await rowOf(user, supplyRecordId(user, 'home'))).title).toBe('Домой');
    expect((await rowOf(user, supplyRecordId(user, 'records'))).title).toBe('Записи');

    // Оболочка хоста (§6.5): домашняя — «Домой», навигация — «Записи» и пять списков, форма —
    // «список из заголовка».
    const shell = await rowOf(user, supplyRecordId(user, 'host-shell'));
    expect(shell.props[APP_HOME]).toBe(supplyRecordId(user, 'home'));
    expect(shell.props[APP_NAV]).toEqual(
      ['records', 'daily-planning', 'upcoming', 'all-tasks', 'horizon-year', 'routines'].map((k) =>
        supplyRecordId(user, k as (typeof SUPPLY_KEYS)[number]),
      ),
    );
    expect(shell.props[APP_NAV_FORM]).toBe('header-list');

    // Рутины — только при заведении графа; «Перенос остатков» на паузе.
    expect((await rowOf(user, seedRoutineId(user, GARDENER_SLUG))).aspects).toEqual([
      'orbis/routine',
    ]);
    const rollover = await rowOf(user, seedRoutineId(user, ROLLOVER_ROUTINE_SLUG));
    expect(rollover.props['orbis/routine_stage']).toBe('paused');

    // Маска с выключенными Финансами (§8.6), закреплённых и установленных видов нет (РП-15).
    expect(await disabledOf(user)).toEqual(['finance']);
    const s = await callerFor(user).user.getSettings();
    expect(s.installedViews).toEqual([]);
    expect(s.pinnedEntities).toEqual([]);
  });

  test('(б) повторные входы на заведённом графе — {seeded:false} и НОЛЬ записей', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();
    const before = await worldSnapshot(user);
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect(await worldSnapshot(user)).toEqual(before);
  });

  test('(в) граф с правками владельца: блок пачки удалён из «Рутин», «Домой» в архиве, навигация изменена — вход не пишет ничего', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const routinesId = seedSmartListId(user, 'routines');
    const batchBlock = `\n\n{{query:${ROUTINES_BATCH_QUERY}}}`;
    expect(ROUTINES_LIST_BODY).toContain(batchBlock);
    const withoutBatch = ROUTINES_LIST_BODY.replace(batchBlock, '');
    await ownerEdit(user, {
      id: routinesId,
      body: withoutBatch,
      expectedUpdatedAt: (await rowOf(user, routinesId)).updatedAt,
    });
    await ownerEdit(user, { id: supplyRecordId(user, 'home'), archived: true });
    await ownerEdit(user, {
      id: supplyRecordId(user, 'host-shell'),
      props: {
        [APP_NAV]: [supplyRecordId(user, 'records'), seedSmartListId(user, 'daily-planning')],
      },
    });

    const before = await worldSnapshot(user);
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect(await worldSnapshot(user)).toEqual(before);
    // Блок пачки не возвращён (Фокус ревью п. 4): правка владельца — его решение.
    expect((await rowOf(user, routinesId)).body).not.toContain(ROUTINES_BATCH_QUERY);
    expect((await rowOf(user, supplyRecordId(user, 'home'))).archived).toBe(true);
  });

  test('(г) оболочка хоста в архиве — граф заведён, вход ничего не пишет (Р-29)', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();
    await ownerEdit(user, { id: supplyRecordId(user, 'host-shell'), archived: true });

    const before = await worldSnapshot(user);
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect(await worldSnapshot(user)).toEqual(before);
    expect((await rowOf(user, supplyRecordId(user, 'host-shell'))).archived).toBe(true);
  });

  test('(д) мир старой формы без оболочки хоста — отказ GRAPH_NEEDS_MIGRATION, ни одной записи', async () => {
    const user = await freshGraph();
    await seedLegacyWorld(user);
    const before = await worldSnapshot(user);

    const err = await callerFor(user)
      .user.seedOnboarding()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(TRPCError);
    // CONFLICT, а не PRECONDITION_FAILED: тот на проводе значит «клиент устарел» (R-19).
    expect((err as TRPCError).code).toBe('CONFLICT');
    expect(((err as TRPCError).cause as { code?: string } | undefined)?.code).toBe(
      'GRAPH_NEEDS_MIGRATION',
    );
    expect(await worldSnapshot(user)).toEqual(before);
  });

  // R-20: признак «граф заведён» (оболочка хоста) пишется ПОСЛЕДНИМ, и каждый шаг до него повторяем —
  // вход после падения посреди заведения доводит граф до того же вида, что у целого заведения.
  test('(к) падение после каждого шага заведения — следующий вход завершает, итог как у целого заведения', async () => {
    const whole = await freshGraph();
    await callerFor(whole).user.seedOnboarding();
    const reference = await composition(whole);

    for (const step of ['world', 'supply', 'routines', 'mask'] as const) {
      const user = await freshGraph();
      const crashed = await setupGraph(db, personal(user), {
        afterStep: (s) => {
          if (s === step) throw new Error(`падение после шага «${s}»`);
        },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect([step, (crashed as Error | null)?.message]).toEqual([
        step,
        `падение после шага «${step}»`,
      ]);
      // Признака нет — граф не заведён, и вход доводит его до конца.
      expect([step, await callerFor(user).user.seedOnboarding()]).toEqual([step, { seeded: true }]);
      expect([step, await composition(user)]).toEqual([step, reference]);
    }
  });

  test('(и) новый эталон и новая запись поставки на заведённом графе — только предложения, вход пишет ноль', async () => {
    const user = await freshGraph();
    await callerFor(user).user.seedOnboarding();
    // Записи «Записи» и одной категории нет (удалены физически фикстурой: в продукте так нельзя) —
    // «никогда не было» и «удалил» вход не различает и не досевает ни то, ни другое.
    await deleteRow(user, supplyRecordId(user, 'records'));
    await deleteRow(user, seedCategoryId(user, 'food'));
    // «Новый релиз»: эталон «Upcoming» другой (инъекция списка эталонов).
    const next: SupplyEtalon[] = SUPPLY_ETALONS.map((e) =>
      e.kind !== 'app' && e.key === 'upcoming'
        ? { ...e, text: `${e.text}\n\nНовая строка релиза.` }
        : e,
    );

    const before = await worldSnapshot(user);
    expect(await setupGraph(db, personal(user), { etalons: next })).toEqual({ seeded: false });
    expect(await callerFor(user).user.seedOnboarding()).toEqual({ seeded: false });
    expect(await worldSnapshot(user)).toEqual(before);

    const updates = await listUpdates({ db, identity: personal(user) }, next);
    expect(updates.map((u) => [u.key, u.kind])).toEqual(
      expect.arrayContaining([
        ['records', 'new'],
        ['upcoming', 'update'],
      ]),
    );
  });
});

describe('registry.effective (§А9-2): эффективный реестр владельца одним ответом', () => {
  test('отдаёт встроенные свойства, аспекты и роли в порядке rank, graphId у встроенных — null', async () => {
    const caller = callerFor(await freshGraph());
    const { properties, roles, aspects } = await caller.registry.effective();

    // Словари ЦЕЛИКОМ: каталог полей web строится по ним, и недостача любого свойства
    // означает поле, по которому запрос собрать нельзя (§А5-3а).
    expect(properties.length).toBe(BUILTIN_PROPERTY_META.length);
    expect(roles.length).toBe(BUILTIN_RELATION_ROLE_META.length);
    expect(aspects.length).toBe(BUILTIN_ASPECT_IDS.length);
    for (const id of ['orbis/task_status', 'orbis/title', 'orbis/created_at']) {
      expect(properties.map((p) => p.id)).toContain(id);
    }
    expect(roles.map((r) => r.id)).toContain(ROLE_DEPENDENCY);

    // Порядок наблюдаем: по нему конструктор рисует строки полей и список сортировки.
    const ranks = properties.map((p) => p.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(properties.every((p) => p.graphId === null)).toBe(true);

    // Тип едет ЦЕЛИКОМ, а не обеднённым словарём старого каталога: по нему web решает,
    // какие операторы предлагать (`time` упорядочен, `json` не фильтруется вовсе).
    const at = properties.find((p) => p.id === 'orbis/routine_at');
    expect(at?.type.kind).toBe('time');
  });

  test('снимок разбора из ОДНОЙ выдачи резолвит имена канона §А5-3', async () => {
    const caller = callerFor(await freshGraph());
    // Ровно та сборка, которую делает web (`buildQueryRegistry`): выдачи ОДНОЙ ручки
    // достаточно, чтобы разобрать боевой текст без единого обращения к БД. До Задачи 13a
    // ручек было две (`aspect.list` + `aspect.properties`), и аспект приходилось собирать
    // обратно в декларацию разбором wire-строки — здесь он уже декларация.
    const { properties, roles, aspects, contracts } = await caller.registry.effective();
    const reg = toParseRegistry(
      {
        properties: new Map(properties.map((p) => [p.id, p])),
        aspects: new Map(aspects.map((a) => [a.id, a])),
        roles: new Map(roles.map((r) => [r.id, r])),
        contracts: new Map(contracts.map((c) => [c.id, c])),
      },
      OWNER_LOCALE,
    );
    const parsed = parseQueryAst(AGENDA_QUERY_TEXTS.overdueDue, reg);
    expect(parsed.ok).toBe(true);
  });
});

describe('механизм сева мира (§А2-5)', () => {
  // ПОЧЕМУ ПИН ПОВЕДЕНЧЕСКИЙ, А НЕ «сев записал mechanism». Механизм нигде не хранится:
  // журнала у сева нет (синк не передаётся), а ни одно из четырёх сеемых свойств категории
  // не помечено `system_writable` — значит подмена механизма в самом вызове сегодня не
  // наблюдаема ничем. Пиннится ПРАВИЛО, на которое сев опирается: механизм сева вправе
  // писать системное свойство, а механизм по умолчанию — нет. Первое же системное свойство
  // в `SEED_CATEGORIES` упрётся в `writeDenial` ровно там, где никто не смотрит.
  const CARRYOVER = 'orbis/carryover';

  test('механизм сева ВПРАВЕ писать system_writable-свойство', async () => {
    const user = await freshGraph();
    const r = await execute(db, {
      identity: personal(user),
      actorKind: 'owner',
      source: 'system',
      mechanism: WORLD_SEED_MECHANISM,
      operations: [
        {
          tool: 'entity_create',
          input: { title: 'Проба сева', tags: [], props: { [CARRYOVER]: '10.00' } },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  test('тот же вызов БЕЗ механизма сева — отказ по системному свойству (§А2-5)', async () => {
    const user = await freshGraph();
    const r = await execute(db, {
      identity: personal(user),
      actorKind: 'owner',
      source: 'system',
      operations: [
        {
          tool: 'entity_create',
          input: { title: 'Проба сева', tags: [], props: { [CARRYOVER]: '10.00' } },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error.details as { reason?: string }).reason).toBe('system_writable');
  });
});
