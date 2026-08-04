// apps/server/src/seed/onboarding.test.ts
// Интеграционные тесты Task 13: онбординг-сидирование (02 §7) через createCallerFactory
// против живой БД. Сид пишет НАПРЯМУЮ в tx под withIdentity, МИМО executor/журнала
// (решение 6 плана): 12 категорий §7.1 + 8 smart lists §7.2 (три исходных + пять горизонтов
// планирования, E4) + настройки §7.3 + глобальный тред.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addDays,
  aspectJsonSchema,
  BUILTIN_ASPECT_IDS,
  buildFieldCatalog,
  categoryAspectSchema,
  parseQuery,
} from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities } from '../db/schema';
import { appRouter } from '../router';
import { SEED_CATEGORIES } from '../seed/categories';
import { seedSmartListId } from '../seed/onboarding';
import {
  ALL_TASKS_BODY,
  DAILY_PLANNING_BODY,
  HORIZON_DAY_BODY,
  HORIZON_LIFE_BODY,
  HORIZON_MONTH_BODY,
  HORIZON_WEEK_BODY,
  HORIZON_YEAR_BODY,
  SEED_HORIZON_LISTS,
  SEED_SMART_LISTS,
  type SeedSmartList,
  UPCOMING_BODY,
} from '../seed/smart-lists';
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

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
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
  test('создаёт ровно 12+8 сущностей, настройки и глобальный тред; повтор → {seeded:false}, count не растёт', async () => {
    const user = freshUserId();
    const caller = callerFor(user);

    const first = await caller.user.seedOnboarding();
    expect(first).toEqual({ seeded: true });
    expect(await counts(user)).toEqual({ entities: 20, settings: 1, threads: 1 });

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
    expect(await counts(user)).toEqual({ entities: 20, settings: 1, threads: 1 });
  });

  test('конкурентные два seedOnboarding под разными коннекшнами → без дублей (детерминированные id + ON CONFLICT)', async () => {
    const user = freshUserId();
    const a = appDb();
    const b = appDb();
    try {
      const callerA = createCaller({
        actorUserId: user,
        actorKind: 'owner',
        db: a.db,
        clientVersion: null,
      });
      const callerB = createCaller({
        actorUserId: user,
        actorKind: 'owner',
        db: b.db,
        clientVersion: null,
      });
      await Promise.all([callerA.user.seedOnboarding(), callerB.user.seedOnboarding()]);
      expect(await counts(user)).toEqual({ entities: 20, settings: 1, threads: 1 });
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
  test('body всех восьми списков — байт-в-байт равен блокам 02 §3.3, в порядке документа', () => {
    // Извлекаем ```markdown-блоки §3.3 из PRD и сверяем с константами сида
    const prdPath = join(import.meta.dir, '../../../../docs/prd/02-core-os.md');
    const prd = readFileSync(prdPath, 'utf8');
    const blocks = [...prd.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((m) => {
      const block = m[1];
      if (block === undefined) throw new Error('markdown-блок без группы захвата');
      return block;
    });
    // Первые восемь markdown-блоков документа — §3.3, ровно в порядке SEED_SMART_LISTS:
    // три исходных списка, затем пять горизонтов планирования (E4).
    expect(blocks.slice(0, SEED_SMART_LISTS.length)).toEqual(SEED_SMART_LISTS.map((s) => s.body));
    // Поимённо — чтобы падение называло виновника, а не «массивы не равны»
    expect(blocks[0]).toBe(DAILY_PLANNING_BODY);
    expect(blocks[1]).toBe(UPCOMING_BODY);
    expect(blocks[2]).toBe(ALL_TASKS_BODY);
    expect(blocks[3]).toBe(HORIZON_DAY_BODY);
    expect(blocks[4]).toBe(HORIZON_WEEK_BODY);
    expect(blocks[5]).toBe(HORIZON_MONTH_BODY);
    expect(blocks[6]).toBe(HORIZON_YEAR_BODY);
    expect(blocks[7]).toBe(HORIZON_LIFE_BODY);
  });

  test('все {{query:}}-блоки восьми списков парсятся собственным парсером (страховка от опечатки)', () => {
    const catalog = buildFieldCatalog(
      BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
    );
    // Ожидаемое число блоков в каждом теле — потеря блока при правке body не пройдёт молча
    const expectedBlocks: Record<SeedSmartList['slug'], number> = {
      'daily-planning': 3,
      upcoming: 2,
      'all-tasks': 1,
      'horizon-day': 2,
      'horizon-week': 1,
      'horizon-month': 1,
      'horizon-year': 1,
      'horizon-life': 1,
    };
    expect(Object.keys(expectedBlocks).length).toBe(SEED_SMART_LISTS.length);
    for (const list of SEED_SMART_LISTS) {
      const blocks = queryBlocksOf(list.body);
      expect(blocks.length).toBe(expectedBlocks[list.slug]);
      for (const block of blocks) expect(parseQuery(block, catalog).ok).toBe(true);
    }
  });

  // E4, условие «никакие два списка не показывают одно и то же»: побайтовое совпадение
  // блоков означало бы два списка с одинаковой выдачей под разными заголовками.
  test('никакие два сидированных query-блока не совпадают побайтово', () => {
    const all = SEED_SMART_LISTS.flatMap((s) => queryBlocksOf(s.body));
    expect(new Set(all).size).toBe(all.length);
  });

  // Парсер — не компилятор: он проверяет форму, а SQL строит compile.ts со своим
  // исчерпывающим разбором токенов и типов полей. Блок, который парсится, но не
  // компилируется, приехал бы пользователю красной плашкой в готовом списке.
  test('каждый query-блок восьми списков выполняется entity.query против живой БД', async () => {
    const user = freshUserId();
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

  test('восемь сущностей smart-list: tags, emoji, детерминированный id, порядок pinned', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const rows = await caller.entity.query({ query: 'tags=smart-list, sortBy=created_at:asc' });
    expect(rows.length).toBe(8);
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

  // E4: пять горизонтов планирования — отдельные сущности со своими слагами.
  test('пять горизонтов: заголовки День/Неделя/Месяц/Год/Жизнь на детерминированных id', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const rows = await caller.entity.query({ query: 'tags=smart-list, sortBy=created_at:asc' });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const expected: Array<[string, string, string]> = [
      ['horizon-day', 'День', '🌅'],
      ['horizon-week', 'Неделя', '📆'],
      ['horizon-month', 'Месяц', '🌙'],
      ['horizon-year', 'Год', '🎯'],
      ['horizon-life', 'Жизнь', '🧭'],
    ];
    for (const [slug, title, emoji] of expected) {
      const row = byId.get(seedSmartListId(user, slug));
      expect(row?.title).toBe(title);
      expect(row?.emoji).toBe(emoji);
      expect(row?.tags).toEqual(['smart-list']);
    }
  });
});

describe('настройки §7.3 (getSettings / updateSettings)', () => {
  test('getSettings: дефолты §7.3; pinnedEntities в порядке daily/upcoming/allTasks/День', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const s = await caller.user.getSettings();
    expect(s.timezone).toBe('Europe/Moscow');
    expect(s.defaultCurrency).toBe('RUB');
    expect(s.weekStartDay).toBe('monday');
    expect(s.plan).toBe('dev');
    // E4: из пяти горизонтов закрепляется только «День» — остальные четыре живут в
    // Browser по тегу smart-list (цена закрепления — entity.count на каждую правку графа).
    expect(s.pinnedEntities).toEqual([
      { id: seedSmartListId(user, 'daily-planning'), order: 0 },
      { id: seedSmartListId(user, 'upcoming'), order: 1 },
      { id: seedSmartListId(user, 'all-tasks'), order: 2 },
      { id: seedSmartListId(user, 'horizon-day'), order: 3 },
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

// §9.3 (Task 3): ownerOnly-матрица против живой БД — агент (PAT) не управляет
// аккаунтом (FORBIDDEN), read-пути ему открыты, владельцу гейт не мешает.
describe('ownerOnly (§9.3): агент против владельца', () => {
  test('агент: мутации аккаунта → FORBIDDEN; getSettings доступен; владелец — ok', async () => {
    const user = freshUserId();
    const owner = createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
    const agent = createCaller({ actorUserId: user, actorKind: 'agent', db, clientVersion: null });

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

// Task A9 (слайс 2, §4.4): view `orbis-budget` в installedViews. Новые пользователи
// получают его при сидировании; засиденные ДО слайса 2 (пустой installedViews) —
// идемпотентный бэкфилл при повторном user.seedOnboarding, без дублей и без потери
// прочих значений/полей.
describe('installedViews: orbis-budget (§4.4, слайс 2)', () => {
  test('новый пользователь получает orbis-budget при первом сидировании', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const s = await caller.user.getSettings();
    expect(s.installedViews).toEqual(['orbis-budget']);
  });

  test('пользователь без orbis-budget получает его при повторном seedOnboarding; повтор не дублирует', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    // Симулируем засиденного ДО слайса 2: installedViews пуст
    await caller.user.updateSettings({ installedViews: [] });
    expect((await caller.user.getSettings()).installedViews).toEqual([]);

    // Повторный онбординг: guard → { seeded: false }, но бэкфилл дописывает view
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect((await caller.user.getSettings()).installedViews).toEqual(['orbis-budget']);

    // Ещё один повтор — без дубля
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect((await caller.user.getSettings()).installedViews).toEqual(['orbis-budget']);
  });

  test('кастомные значения installedViews не теряются при бэкфилле', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    await caller.user.updateSettings({ installedViews: ['some-custom-view'] });
    await caller.user.seedOnboarding();

    const iv = (await caller.user.getSettings()).installedViews;
    expect(iv).toContain('some-custom-view');
    expect(iv).toContain('orbis-budget');
    expect(iv.length).toBe(2);
  });

  test('бэкфилл не трогает остальные поля user_settings', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    await caller.user.updateSettings({
      timezone: 'Asia/Almaty',
      weekStartDay: 'sunday',
      installedViews: [],
    });
    await caller.user.seedOnboarding();

    const s = await caller.user.getSettings();
    expect(s.installedViews).toEqual(['orbis-budget']);
    expect(s.timezone).toBe('Asia/Almaty');
    expect(s.weekStartDay).toBe('sunday');
    expect(s.defaultCurrency).toBe('RUB');
    expect(s.pinnedEntities).toEqual([
      { id: seedSmartListId(user, 'daily-planning'), order: 0 },
      { id: seedSmartListId(user, 'upcoming'), order: 1 },
      { id: seedSmartListId(user, 'all-tasks'), order: 2 },
      { id: seedSmartListId(user, 'horizon-day'), order: 3 },
    ]);
  });
});

// E4, условие «заголовок не врёт»: горизонт обязан показывать то, что обещает его имя и
// первая строка тела. Проверяется смыслом — фикстурами относительно реального «сегодня»
// в дефолтной таймзоне Europe/Moscow (прецедент agenda-acceptance.test.ts, у «сегодня»
// шва нет), — а не сверкой строк запроса.
describe('горизонты показывают обещанное (§3.3, E4)', () => {
  const TZ = 'Europe/Moscow';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  /** id результатов N-го блока тела списка. */
  async function idsOfBlock(user: string, body: string, index: number): Promise<Set<string>> {
    const block = queryBlocksOf(body)[index];
    if (block === undefined) throw new Error(`в body нет query-блока №${index}`);
    const rows = await callerFor(user).entity.query({ query: block });
    return new Set(rows.map((r) => r.id));
  }

  test('день/неделя/месяц/год/жизнь отбирают ровно свои сущности', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const task = async (title: string, dueDate: string, status = 'planned') =>
      (
        await caller.entity.create({
          input: { title, tags: [], aspects: { 'orbis/task': { status, due_date: dueDate } } },
          source: 'ui',
        })
      ).id;

    const overdue = await task('Просроченная', addDays(today, -1));
    const dueToday = await task('Сегодняшняя', today);
    const waitingToday = await task('Ожидающая на сегодня', today, 'waiting');
    const dueIn3d = await task('Через три дня', addDays(today, 3));
    const dueIn20d = await task('Через двадцать дней', addDays(today, 20));
    const goal = (
      await caller.entity.create({
        input: {
          title: 'Пробежать 100 км',
          tags: [],
          aspects: {
            'orbis/goal': {
              progress_source: { query: 'aspect=orbis/task, status=done', aggregate: 'count' },
              target_value: '100',
            },
          },
        },
        source: 'ui',
      })
    ).id;
    const value = (
      await caller.entity.create({ input: { title: 'Здоровье', tags: ['life'] }, source: 'ui' })
    ).id;

    // «День», блок 1 «Срок сегодня»: только сегодняшняя, без ожидающей и без просрочки
    const dayToday = await idsOfBlock(user, HORIZON_DAY_BODY, 0);
    expect([...dayToday]).toEqual([dueToday]);
    expect(dayToday.has(waitingToday)).toBe(false);
    // «День», блок 2 «Просрочено»: только просроченная
    expect([...(await idsOfBlock(user, HORIZON_DAY_BODY, 1))]).toEqual([overdue]);

    // «Неделя»: окно next_7d включает сегодня (01-architecture §6.1) — пересечение с
    // «Днём» намеренное: горизонты — линзы, а не непересекающиеся корзины.
    const week = await idsOfBlock(user, HORIZON_WEEK_BODY, 0);
    expect(week.has(dueIn3d)).toBe(true);
    expect(week.has(dueToday)).toBe(true);
    expect(week.has(waitingToday)).toBe(true); // горизонт не фокус-список, waiting не прячет
    expect(week.has(overdue)).toBe(false);
    expect(week.has(dueIn20d)).toBe(false);

    // «Месяц»: всё, что дальше 7 дней, — и ничего из ближайшей недели
    const month = await idsOfBlock(user, HORIZON_MONTH_BODY, 0);
    expect([...month]).toEqual([dueIn20d]);

    // «Год»: цели, и только они
    expect([...(await idsOfBlock(user, HORIZON_YEAR_BODY, 0))]).toEqual([goal]);

    // «Жизнь»: сущности с тегом life; сам список-горизонт (тег smart-list) в выдачу не лезет
    expect([...(await idsOfBlock(user, HORIZON_LIFE_BODY, 0))]).toEqual([value]);
  });
});

// Task E4 (слайс 3, §7.2): пять горизонтов планирования. Новые пользователи получают их
// первым же сидированием; засиденные ДО E4 — идемпотентным бэкфиллом в guard-ветке
// (по образцу orbis-budget): досеваются ровно недостающие списки, «День» дописывается
// в конец pinnedEntities, повтор не создаёт дублей.
describe('горизонты планирования: бэкфилл (§7.2, E4)', () => {
  const HORIZONS = ['horizon-day', 'horizon-week', 'horizon-month', 'horizon-year', 'horizon-life'];

  /** Симуляция пользователя, засиденного ДО E4: часть горизонтов удалена админ-DSN (мимо RLS). */
  async function deleteHorizons(user: string, slugs: readonly string[]): Promise<void> {
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.delete(entities).where(
        and(
          eq(entities.ownerId, user),
          inArray(
            entities.id,
            slugs.map((s) => seedSmartListId(user, s)),
          ),
        ),
      );
    } finally {
      await adminClient.end();
    }
  }

  const basePins = (user: string) => [
    { id: seedSmartListId(user, 'daily-planning'), order: 0 },
    { id: seedSmartListId(user, 'upcoming'), order: 1 },
    { id: seedSmartListId(user, 'all-tasks'), order: 2 },
  ];

  test('новый пользователь получает все пять горизонтов и закрепление «Дня» за один проход', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: true });

    const lists = await caller.entity.query({ query: 'tags=smart-list' });
    expect(lists.length).toBe(8);
    const ids = new Set(lists.map((r) => r.id));
    for (const slug of HORIZONS) expect(ids.has(seedSmartListId(user, slug))).toBe(true);
    expect((await caller.user.getSettings()).pinnedEntities).toEqual([
      ...basePins(user),
      { id: seedSmartListId(user, 'horizon-day'), order: 3 },
    ]);
  });

  test('засиденный ДО E4: повторный seedOnboarding досевает пять горизонтов и пин; повтор не дублирует', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    // Откат к состоянию «до E4»: горизонтов нет, закреплены только три старых списка
    await deleteHorizons(user, HORIZONS);
    await caller.user.updateSettings({ pinnedEntities: basePins(user) });
    expect(await counts(user)).toEqual({ entities: 15, settings: 1, threads: 1 });

    // Guard возвращает { seeded: false }, но бэкфилл дописывает недостающее
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect(await counts(user)).toEqual({ entities: 20, settings: 1, threads: 1 });
    expect((await caller.entity.query({ query: 'tags=smart-list' })).length).toBe(8);
    expect((await caller.user.getSettings()).pinnedEntities).toEqual([
      ...basePins(user),
      { id: seedSmartListId(user, 'horizon-day'), order: 3 },
    ]);

    // Ещё два повтора — ни новых сущностей, ни второго закрепления «Дня»
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect(await counts(user)).toEqual({ entities: 20, settings: 1, threads: 1 });
    expect((await caller.user.getSettings()).pinnedEntities.length).toBe(4);
  });

  test('досевается РОВНО недостающее: удалены два горизонта — вставлены два, пин не тронут', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    await deleteHorizons(user, ['horizon-month', 'horizon-life']);
    expect(await counts(user)).toEqual({ entities: 18, settings: 1, threads: 1 });
    const settingsBefore = await caller.user.getSettings();

    expect(await caller.user.seedOnboarding()).toEqual({ seeded: false });
    expect(await counts(user)).toEqual({ entities: 20, settings: 1, threads: 1 });
    const settingsAfter = await caller.user.getSettings();
    expect(settingsAfter.pinnedEntities).toEqual(settingsBefore.pinnedEntities);
    // «День» уже закреплён — updated_at настроек бэкфилл не сдвигает
    expect(settingsAfter.updatedAt).toBe(settingsBefore.updatedAt);
  });

  test('кастомные закрепления не теряются: «День» дописывается в конец', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    await caller.user.seedOnboarding();

    const custom = crypto.randomUUID();
    await caller.user.updateSettings({ pinnedEntities: [{ id: custom, order: 0 }] });
    await caller.user.seedOnboarding();

    expect((await caller.user.getSettings()).pinnedEntities).toEqual([
      { id: custom, order: 0 },
      { id: seedSmartListId(user, 'horizon-day'), order: 1 },
    ]);
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
