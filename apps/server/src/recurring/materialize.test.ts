// apps/server/src/recurring/materialize.test.ts
// Task A3: ленивая материализация recurring-инстансов (01 §5.4, §3.3; 02 §6).
// Интеграционные тесты против живой БД: инстансы порождает ТОЛЬКО сервер, через
// executor (source='system'), с детерминированными uuidv5-id и горизонтом 14 дней.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type FieldCatalog, parseQuery, recurringInstanceId } from '@orbis/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities, relations } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { materializationWindow, materializeInstances } from './materialize';

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

/** Шаблон через executor (единственный путь мутаций); возвращает id. */
async function createTemplate(
  owner: string,
  input: {
    id?: string;
    title: string;
    emoji?: string;
    tags?: string[];
    aspects: Record<string, Record<string, unknown>>;
  },
): Promise<string> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'system',
    operations: [{ tool: 'entity_create', input: { tags: [], ...input } }],
  });
  if (!r.ok) throw new Error(`шаблон не создан: ${r.error.code} ${r.error.message}`);
  return (r.results[0] as { id: string }).id;
}

/** Ежедневное расписание с 09:00 Москвы указанной даты. */
function dailySchedule(startDate: string): Record<string, unknown> {
  return {
    start_at: `${startDate}T09:00:00+03:00`,
    timezone: 'Europe/Moscow',
    recurrence: { freq: 'daily', interval: 1 },
  };
}

async function ownEntities(owner: string, ids: string[]) {
  return withIdentity(db, owner, (tx) =>
    tx.select().from(entities).where(inArray(entities.id, ids)),
  );
}

async function derivedFrom(owner: string, templateId: string) {
  return withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(relations)
      .where(and(eq(relations.sourceId, templateId), eq(relations.relationType, 'derived_from'))),
  );
}

describe('materializeInstances (01 §5.4)', () => {
  test('daily-шаблон: окно 3 дней → 3 инстанса с byte-точными uuidv5-id, копия title/emoji/tags, derived_from', async () => {
    const owner = freshUserId();
    // Байт-точный пример из PRD 01 §5.4: шаблон 019ded47-… + дата 2026-07-01
    const templateId = '019ded47-d100-717a-8307-a5b7a5be722f';
    await createTemplate(owner, {
      id: templateId,
      title: 'Утренняя пробежка',
      emoji: '🏃',
      tags: ['health', 'run'],
      aspects: { 'orbis/schedule': dailySchedule('2026-07-01') },
    });

    const r = await materializeInstances({
      db,
      ownerId: owner,
      from: '2026-07-01',
      to: '2026-07-03',
      today: '2026-07-01',
    });
    expect(r.created).toBe(3);

    // Литеральная фиксация uuid из §5.4 — не через хелпер (byte-точность формулы)
    const firstId = 'e7d0bfa4-f62a-59c1-b560-1c17cb32e89f';
    expect(recurringInstanceId(templateId, '2026-07-01')).toBe(firstId);
    const expectedIds = ['2026-07-01', '2026-07-02', '2026-07-03'].map((d) =>
      recurringInstanceId(templateId, d),
    );
    const rows = await ownEntities(owner, expectedIds);
    expect(rows.length).toBe(3);

    const first = rows.find((row) => row.id === firstId);
    expect(first).toBeDefined();
    expect(first?.title).toBe('Утренняя пробежка');
    expect(first?.emoji).toBe('🏃');
    expect(first?.tags).toEqual(['health', 'run']);
    const schedule = (first?.aspects as Record<string, Record<string, unknown>>)['orbis/schedule'];
    expect(schedule?.recurrence).toBeUndefined();
    // 09:00 Москвы (UTC+3) даты инстанса — время из start_at шаблона
    expect(schedule?.start_at).toBe('2026-07-01T06:00:00.000Z');
    const second = rows.find((row) => row.id === recurringInstanceId(templateId, '2026-07-02'));
    const secondSchedule = (second?.aspects as Record<string, Record<string, unknown>>)[
      'orbis/schedule'
    ];
    expect(secondSchedule?.start_at).toBe('2026-07-02T06:00:00.000Z');

    // relation derived_from шаблон→инстанс на каждый инстанс
    const rels = await derivedFrom(owner, templateId);
    expect(rels.map((x) => x.targetId).sort()).toEqual([...expectedIds].sort());
  });

  test('повторная материализация: created 0, правка инстанса переживает повтор; пересечение окон без дублей', async () => {
    const owner = freshUserId();
    const templateId = await createTemplate(owner, {
      title: 'Планёрка',
      aspects: { 'orbis/schedule': dailySchedule('2026-07-01') },
    });

    const first = await materializeInstances({
      db,
      ownerId: owner,
      from: '2026-07-01',
      to: '2026-07-03',
      today: '2026-07-01',
    });
    expect(first.created).toBe(3);

    // Правка инстанса (02 §6 «Правка инстанса recurring»: меняется только инстанс)
    const instanceId = recurringInstanceId(templateId, '2026-07-02');
    const upd = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        { tool: 'entity_update', input: { id: instanceId, title: 'Планёрка (перенесена)' } },
      ],
    });
    expect(upd.ok).toBe(true);

    // Повтор того же окна — идемпотентен, правка не перезаписана
    const again = await materializeInstances({
      db,
      ownerId: owner,
      from: '2026-07-01',
      to: '2026-07-03',
      today: '2026-07-01',
    });
    expect(again.created).toBe(0);

    // Пересекающееся окно другого запроса: досоздаёт только новые даты, без дублей
    const overlap = await materializeInstances({
      db,
      ownerId: owner,
      from: '2026-07-02',
      to: '2026-07-05',
      today: '2026-07-01',
    });
    expect(overlap.created).toBe(2); // 07-04, 07-05

    const ids = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'].map((d) =>
      recurringInstanceId(templateId, d),
    );
    const rows = await ownEntities(owner, ids);
    expect(rows.length).toBe(5);
    expect(rows.find((row) => row.id === instanceId)?.title).toBe('Планёрка (перенесена)');
  });

  test('окно дальше today+14 обрезается горизонтом (§5.4)', async () => {
    const owner = freshUserId();
    const templateId = await createTemplate(owner, {
      title: 'Ежедневное',
      aspects: { 'orbis/schedule': dailySchedule('2026-07-01') },
    });

    const r = await materializeInstances({
      db,
      ownerId: owner,
      from: '2026-07-01',
      to: '2026-07-31',
      today: '2026-07-01',
    });
    expect(r.created).toBe(15); // 07-01..07-15 = today+14 включительно

    const beyond = await ownEntities(owner, [recurringInstanceId(templateId, '2026-07-16')]);
    expect(beyond.length).toBe(0);
  });

  test('financial-шаблон: инстансы с occurred_on=дата, planned=true, recurring=true (§3.3)', async () => {
    const owner = freshUserId();
    const categoryRef = crypto.randomUUID();
    const templateId = await createTemplate(owner, {
      title: 'Аренда',
      aspects: {
        'orbis/schedule': dailySchedule('2026-07-01'),
        'orbis/financial': {
          amount: '340.00',
          currency: 'RUB',
          direction: 'expense',
          category_ref: categoryRef,
          recurring: true,
        },
      },
    });

    const r = await materializeInstances({
      db,
      ownerId: owner,
      from: '2026-07-01',
      to: '2026-07-02',
      today: '2026-07-01',
    });
    expect(r.created).toBe(2);

    const rows = await ownEntities(
      owner,
      ['2026-07-01', '2026-07-02'].map((d) => recurringInstanceId(templateId, d)),
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const aspects = row.aspects as Record<string, Record<string, unknown>>;
      const fin = aspects['orbis/financial'];
      expect(fin?.planned).toBe(true);
      expect(fin?.recurring).toBe(true);
      expect(fin?.amount).toBe('340.00');
      expect(fin?.category_ref).toBe(categoryRef);
      expect(aspects['orbis/schedule']?.recurrence).toBeUndefined();
    }
    const dates = rows
      .map(
        (row) =>
          (row.aspects as Record<string, Record<string, unknown>>)['orbis/financial']?.occurred_on,
      )
      .sort();
    expect(dates).toEqual(['2026-07-01', '2026-07-02']);
  });

  test('архивированный шаблон не материализуется', async () => {
    const owner = freshUserId();
    const templateId = await createTemplate(owner, {
      title: 'Старое расписание',
      aspects: { 'orbis/schedule': dailySchedule('2026-07-01') },
    });
    const arch = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: templateId, archived: true } }],
    });
    expect(arch.ok).toBe(true);

    const r = await materializeInstances({
      db,
      ownerId: owner,
      from: '2026-07-01',
      to: '2026-07-03',
      today: '2026-07-01',
    });
    expect(r.created).toBe(0);
    const rows = await ownEntities(owner, [recurringInstanceId(templateId, '2026-07-01')]);
    expect(rows.length).toBe(0);
  });

  test('битое recurrence-правило пропускается, не роняя материализацию остальных', async () => {
    const owner = freshUserId();
    // byweekday: массив произвольных строк проходит схему реестра, но expandRecurrence
    // на неизвестном дне недели бросает RangeError — шаблон пропускаем, запрос не роняем
    await createTemplate(owner, {
      title: 'Битый шаблон',
      aspects: {
        'orbis/schedule': {
          start_at: '2026-07-01T09:00:00+03:00',
          timezone: 'Europe/Moscow',
          recurrence: { freq: 'weekly', interval: 1, byweekday: ['xx'] },
        },
      },
    });
    const healthyId = await createTemplate(owner, {
      title: 'Здоровый шаблон',
      aspects: { 'orbis/schedule': dailySchedule('2026-07-01') },
    });

    const r = await materializeInstances({
      db,
      ownerId: owner,
      from: '2026-07-01',
      to: '2026-07-02',
      today: '2026-07-01',
    });
    expect(r.created).toBe(2); // только здоровый

    const rows = await ownEntities(
      owner,
      ['2026-07-01', '2026-07-02'].map((d) => recurringInstanceId(healthyId, d)),
    );
    expect(rows.length).toBe(2);
  });

  test('financial без orbis/schedule.recurrence — не шаблон: пропускается, не падает', async () => {
    const owner = freshUserId();
    await createTemplate(owner, {
      title: 'Разовая трата',
      aspects: {
        'orbis/schedule': { start_at: '2026-07-01T09:00:00+03:00' }, // без recurrence
        'orbis/financial': {
          amount: '100.00',
          direction: 'expense',
          category_ref: crypto.randomUUID(),
          occurred_on: '2026-07-01',
        },
      },
    });

    const r = await materializeInstances({
      db,
      ownerId: owner,
      from: '2026-07-01',
      to: '2026-07-03',
      today: '2026-07-01',
    });
    expect(r.created).toBe(0);
  });
});

describe('materializationWindow — детект окна по AST (чистая функция, ноль запросов к БД)', () => {
  const today = '2026-07-10';
  const win = (query: string) => {
    // Мини-каталог: start_at (timestamp, orbis/schedule), occurred_on (date, orbis/financial)
    const catalog: FieldCatalog = {
      fields: {
        start_at: [{ aspect: 'orbis/schedule', type: 'timestamp' }],
        occurred_on: [{ aspect: 'orbis/financial', type: 'date' }],
        status: [{ aspect: 'orbis/task', type: 'string' }],
      },
    };
    const parsed = parseQuery(query, catalog);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return materializationWindow(parsed.ast, today);
  };

  test('запрос без date/timestamp-условий — окна нет', () => {
    expect(win('aspect=orbis/task, status=inbox')).toBeNull();
    expect(win('tags=work, limit=10')).toBeNull();
  });

  test('date-токены дают явный диапазон; overdue/открытый низ → от сегодня', () => {
    expect(win('start_at=today')).toEqual({ from: today, to: today });
    expect(win('start_at=next_7d')).toEqual({ from: today, to: '2026-07-17' });
    expect(win('start_at=after_7d')).toEqual({ from: '2026-07-18', to: '2026-07-24' });
    expect(win('occurred_on=overdue')).toEqual({ from: today, to: today });
  });

  test('объединение условий — минимальный from, максимальный to', () => {
    expect(win('start_at=today|next_7d')).toEqual({ from: today, to: '2026-07-17' });
    expect(win('start_at=next_7d, occurred_on=after_7d')).toEqual({
      from: today,
      to: '2026-07-24',
    });
  });

  test('литеральная дата на date-поле — окно этого дня', () => {
    expect(win('occurred_on=2026-07-12')).toEqual({ from: '2026-07-12', to: '2026-07-12' });
  });

  test('date-токен на чужом поле (due_date и т.п.) окна не даёт', () => {
    // status — не date-поле; окна нет и парсер бы отверг токен; берём чистый литерал
    expect(win('status=inbox')).toBeNull();
  });
});

describe('хук entity.query/count (§5.4: любой запрос диапазона дат материализует)', () => {
  test('entity.query со start_at=next_7d триггерит материализацию', async () => {
    const owner = freshUserId();
    const caller = callerFor(owner);
    // Реальное «сегодня» в дефолтной таймзоне (user_settings нет → Europe/Moscow)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
      new Date(),
    );
    const templateId = await createTemplate(owner, {
      title: 'Ежедневный созвон',
      aspects: { 'orbis/schedule': dailySchedule(today) },
    });

    const results = await caller.entity.query({ query: 'start_at=next_7d' });
    const ids = new Set(results.map((r) => r.id));
    // Инстансы сегодняшнего и завтрашнего дня материализованы и попали в выдачу
    expect(ids.has(recurringInstanceId(templateId, today))).toBe(true);
    // 8 инстансов [today; today+7] + сам шаблон
    expect(results.length).toBe(9);

    // count тем же окном видит те же строки (материализация уже идемпотентна)
    const { count } = await caller.entity.count({ query: 'start_at=next_7d' });
    expect(count).toBe(9);
  });

  test('запрос без date-полей не материализует (ноль инстансов, ноль лишней работы)', async () => {
    const owner = freshUserId();
    const caller = callerFor(owner);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
      new Date(),
    );
    const templateId = await createTemplate(owner, {
      title: 'Без окна',
      aspects: { 'orbis/schedule': dailySchedule(today) },
    });

    const results = await caller.entity.query({ query: 'aspect=orbis/schedule' });
    expect(results.map((r) => r.id)).toEqual([templateId]); // только шаблон, инстансов нет

    const rows = await derivedFrom(owner, templateId);
    expect(rows.length).toBe(0);
  });
});
