// apps/server/src/seed/onboarding.test.ts
// Интеграционные тесты Task 13: онбординг-сидирование (02 §7) через createCallerFactory
// против живой БД. Сид пишет НАПРЯМУЮ в tx под withIdentity, МИМО executor/журнала
// (решение 6 плана): 12 категорий §7.1 + 3 smart lists §7.2 + настройки §7.3 + глобальный тред.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aspectJsonSchema,
  BUILTIN_ASPECT_IDS,
  buildFieldCatalog,
  categoryAspectSchema,
  parseQuery,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { appRouter } from '../router';
import { SEED_CATEGORIES } from '../seed/categories';
import { seedSmartListId } from '../seed/onboarding';
import { ALL_TASKS_BODY, DAILY_PLANNING_BODY, UPCOMING_BODY } from '../seed/smart-lists';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

function callerFor(user: string) {
  return createCaller({ actorUserId: user, db });
}

/** Счётчики строк владельца через админ-DSN (обходит RLS) — независимая от роутеров сверка. */
async function counts(
  user: string,
): Promise<{ entities: number; settings: number; threads: number }> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const e = await admin.execute(
      sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${user}`,
    );
    const s = await admin.execute(
      sql`SELECT count(*)::int AS n FROM user_settings WHERE owner_id = ${user}`,
    );
    const t = await admin.execute(
      sql`SELECT count(*)::int AS n FROM chat_threads WHERE owner_id = ${user}`,
    );
    return { entities: Number(e[0]?.n), settings: Number(s[0]?.n), threads: Number(t[0]?.n) };
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
  test('создаёт ровно 12+3 сущности, настройки и глобальный тред; повтор → {seeded:false}, count не растёт', async () => {
    const user = freshUserId();
    const caller = callerFor(user);

    const first = await caller.user.seedOnboarding();
    expect(first).toEqual({ seeded: true });
    expect(await counts(user)).toEqual({ entities: 15, settings: 1, threads: 1 });

    // Глобальный тред — с NULL entity_id (§4.5)
    const { db: admin, client: adminClient } = adminDb();
    try {
      const gt = await admin.execute(
        sql`SELECT entity_id FROM chat_threads WHERE owner_id = ${user}`,
      );
      expect(gt[0]?.entity_id).toBeNull();
    } finally {
      await adminClient.end();
    }

    // Одноразовость §7: повторный вызов ничего не добавляет
    const second = await caller.user.seedOnboarding();
    expect(second).toEqual({ seeded: false });
    expect(await counts(user)).toEqual({ entities: 15, settings: 1, threads: 1 });
  });

  test('конкурентные два seedOnboarding под разными коннекшнами → без дублей (детерминированные id + ON CONFLICT)', async () => {
    const user = freshUserId();
    const a = appDb();
    const b = appDb();
    try {
      const callerA = createCaller({ actorUserId: user, db: a.db });
      const callerB = createCaller({ actorUserId: user, db: b.db });
      await Promise.all([callerA.user.seedOnboarding(), callerB.user.seedOnboarding()]);
      expect(await counts(user)).toEqual({ entities: 15, settings: 1, threads: 1 });
    } finally {
      await a.client.end();
      await b.client.end();
    }
  });
});

describe('категории §7.1', () => {
  test('12 категорий; каждая из БД проходит categoryAspectSchema; spend_class отсутствует у доходных', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const rows = await caller.entity.query({ query: 'tags=category, sortBy=created_at:asc' });
    expect(rows.length).toBe(12);
    for (const r of rows) {
      const cat = r.aspects['orbis/category'];
      expect(() => categoryAspectSchema.parse(cat)).not.toThrow();
    }

    // Доходные (Зарплата/Фриланс): ключа spend_class нет (не null — иначе ajv упадёт)
    const salary = rows.find((r) => r.title === 'Зарплата');
    expect(salary).toBeDefined();
    expect('spend_class' in (salary?.aspects['orbis/category'] as object)).toBe(false);

    // Расходная «Еда»: точные aliases и spend_class
    const food = rows.find((r) => r.title === 'Еда');
    const foodAspect = food?.aspects['orbis/category'] as {
      spend_class?: string;
      aliases?: string[];
      icon?: string;
      color?: string;
    };
    expect(foodAspect.spend_class).toBe('discretionary');
    expect(foodAspect.icon).toBe('🍔');
    expect(foodAspect.color).toBe('#e0885a');
    expect(foodAspect.aliases).toEqual([
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
    const user = freshUserId();
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

describe('smart lists §7.2 / §3.3', () => {
  test('body всех трёх списков — байт-в-байт равен блокам 02 §3.3', () => {
    // Извлекаем ```markdown-блоки §3.3 из PRD и сверяем с константами сида
    const prdPath = join(import.meta.dir, '../../../../docs/prd/02-core-os.md');
    const prd = readFileSync(prdPath, 'utf8');
    const blocks = [...prd.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((m) => {
      const block = m[1];
      if (block === undefined) throw new Error('markdown-блок без группы захвата');
      return block;
    });
    // Первые три markdown-блока документа — Daily Planning, Upcoming, All Tasks (§3.3)
    expect(blocks[0]).toBe(DAILY_PLANNING_BODY);
    expect(blocks[1]).toBe(UPCOMING_BODY);
    expect(blocks[2]).toBe(ALL_TASKS_BODY);
  });

  test('все {{query:}}-блоки трёх списков парсятся собственным парсером (страховка от опечатки)', () => {
    const catalog = buildFieldCatalog(
      BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
    );
    const cases: Array<[string, number]> = [
      [DAILY_PLANNING_BODY, 3],
      [UPCOMING_BODY, 2],
      [ALL_TASKS_BODY, 1],
    ];
    for (const [body, expected] of cases) {
      const matches = [...body.matchAll(/\{\{query:\s*([\s\S]*?)\}\}/g)];
      expect(matches.length).toBe(expected);
      for (const m of matches) {
        const block = m[1];
        if (block === undefined) throw new Error('query-блок без группы захвата');
        expect(parseQuery(block, catalog).ok).toBe(true);
      }
    }
  });

  test('три сущности smart-list: tags, emoji, детерминированный id, порядок pinned', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const rows = await caller.entity.query({ query: 'tags=smart-list, sortBy=created_at:asc' });
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.tags).toEqual(['smart-list']);

    const byId = new Map(rows.map((r) => [r.id, r]));
    const daily = byId.get(seedSmartListId(user, 'daily-planning'));
    const upcoming = byId.get(seedSmartListId(user, 'upcoming'));
    const allTasks = byId.get(seedSmartListId(user, 'all-tasks'));
    expect(daily?.title).toBe('Daily Planning');
    expect(daily?.emoji).toBe('☀️');
    expect(daily?.body).toBe(DAILY_PLANNING_BODY);
    expect(upcoming?.title).toBe('Upcoming');
    expect(upcoming?.emoji).toBe('🗓️');
    expect(allTasks?.title).toBe('All Tasks');
    expect(allTasks?.emoji).toBe('📋');
  });
});

describe('настройки §7.3 (getSettings / updateSettings)', () => {
  test('getSettings: дефолты §7.3; pinnedEntities в порядке daily/upcoming/allTasks', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const s = await caller.user.getSettings();
    expect(s.timezone).toBe('Europe/Moscow');
    expect(s.defaultCurrency).toBe('RUB');
    expect(s.weekStartDay).toBe('monday');
    expect(s.plan).toBe('dev');
    expect(s.pinnedEntities).toEqual([
      { id: seedSmartListId(user, 'daily-planning'), order: 0 },
      { id: seedSmartListId(user, 'upcoming'), order: 1 },
      { id: seedSmartListId(user, 'all-tasks'), order: 2 },
    ]);
  });

  test('updateSettings: частичная правка меняет заданные поля, остальные не трогает', async () => {
    const user = freshUserId();
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

describe('aspect.list (§9.1): реестр builtin + свои', () => {
  test('возвращает встроенный реестр, отсортирован по id, builtin — ownerId null', async () => {
    const caller = callerFor(freshUserId());
    const list = await caller.aspect.list();
    const ids = list.map((a) => a.id);
    expect(ids).toEqual([...ids].sort()); // сортировка по id
    for (const id of BUILTIN_ASPECT_IDS) expect(ids).toContain(id);
    const builtins = list.filter((a) => (BUILTIN_ASPECT_IDS as readonly string[]).includes(a.id));
    expect(builtins.every((a) => a.ownerId === null)).toBe(true);
  });
});
