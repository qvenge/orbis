// `property_catalog` (§А9-3, приёмка §С8-2): живая БД под withIdentity — каталог читается
// из снимка реестра, `usage.entities` считается по графу владельца под RLS.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { bumpOwnerRegistryVersion } from '../registry/version';
import { type PropertyCatalogRow, runPropertyCatalog } from './property-catalog';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const stranger = freshUserId();

/** Свободное свойство владельца: носителя-аспекта нет, id и key РАЗНЫЕ (§А1-2). */
const FREE_ID = 'user/p-sleep';
const FREE_KEY = 'user/sleep-hours';
/** Предложенное свойство (§А2-7): в промпт не входит, видно ТОЛЬКО отсюда. */
const PROPOSED_ID = 'user/p-mood';
/**
 * Второе предложенное — ЗАЛЕЖАВШЕЕСЯ (заведено 40 дней назад). Нужно ровно ради того, чтобы
 * фильтр возраста было чем отличить от «отдаёт всё»: с одной строкой в фикстуре
 * `olderThanDays` зеленел бы и полностью сломанным (фикстура из одной строки прячет форму).
 */
const STALE_PROPOSED_ID = 'user/p-tempo';
const STALE_PROPOSED_AT = new Date(Date.now() - 40 * 86_400_000);

let reg: RegistrySnapshot;

async function seedProperty(spec: {
  id: string;
  key: string;
  label: string;
  description: string;
  status: 'active' | 'proposed' | 'deprecated';
  module?: string | null;
  /** Когда строку завели: фильтр возраста `olderThanDays` читает именно эту колонку. */
  createdAt?: Date;
}): Promise<void> {
  const admin = adminDb();
  try {
    await admin.db.execute(sql`
      INSERT INTO property_definitions
        (id, owner_id, key, label, description, type, status, storage, module, rank, flags,
         created_at)
      VALUES (${spec.id}, ${owner}, ${spec.key},
              ${JSON.stringify({ ru: spec.label })}::jsonb,
              ${JSON.stringify({ ru: spec.description })}::jsonb,
              ${JSON.stringify({ kind: 'number' })}::jsonb, ${spec.status}, 'props',
              ${spec.module ?? null}, 200, '{}'::jsonb,
              ${(spec.createdAt ?? new Date()).toISOString()}::timestamptz)
      ON CONFLICT (owner_id, id) WHERE owner_id IS NOT NULL DO NOTHING`);
    // Правка реестра двигает его версию тем же путём, что боевой писатель (§А10-1):
    // без этого кеш эффективных определений отдал бы снимок без нового свойства.
    await bumpOwnerRegistryVersion(admin.db, owner);
  } finally {
    await admin.client.end();
  }
}

beforeAll(async () => {
  await truncateAll();
  await seedProperty({
    id: FREE_ID,
    key: FREE_KEY,
    label: 'Часов сна',
    description: 'Сколько часов владелец спал',
    status: 'active',
  });
  await seedProperty({
    id: PROPOSED_ID,
    key: 'user/mood',
    label: 'Настроение',
    description: 'Как прошёл день по ощущениям',
    status: 'proposed',
  });
  await seedProperty({
    id: STALE_PROPOSED_ID,
    key: 'user/tempo',
    label: 'Темп',
    description: 'Насколько быстро шла работа',
    status: 'proposed',
    createdAt: STALE_PROPOSED_AT,
  });
  // Две сущности со значением свободного свойства и одна — чужая (её счётчик видеть нельзя).
  await withIdentity(db, owner, async (tx) => {
    for (const title of ['Ночь на понедельник', 'Ночь на вторник']) {
      await tx
        .insert(entities)
        .values({ id: newId(), ownerId: owner, title, props: { [FREE_ID]: 7 }, aspects: [] });
    }
  });
  await withIdentity(db, stranger, async (tx) => {
    await tx.insert(entities).values({
      id: newId(),
      ownerId: stranger,
      title: 'Чужая ночь',
      props: { [FREE_ID]: 9 },
      aspects: [],
    });
  });
  reg = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
});

afterAll(async () => {
  await truncateAll();
  await client.end();
});

/**
 * Часы вызова — инъекция, а не `new Date()`: фильтр `olderThanDays` мерит возраст строки от
 * ЭТОГО момента, и без сдвига часов проверить его можно было бы только подделкой `created_at`
 * в базе (то есть проверкой не того, что делает боевой путь).
 */
function run(
  input: Parameters<typeof runPropertyCatalog>[2],
  now: Date = new Date(),
): Promise<PropertyCatalogRow[]> {
  return withIdentity(db, owner, async (tx) => {
    const r = await runPropertyCatalog(tx, reg, input, 'ru', { ownerId: owner, now });
    return r.properties;
  });
}

const keysOf = (rows: PropertyCatalogRow[]): string[] => rows.map((r) => r.key);

describe('property_catalog: фильтры (§А9-3)', () => {
  test('q ищет по подписи и по key, регистр не важен; находит orbis/finance_category', async () => {
    const rows = await run({ q: 'катег' });
    expect(keysOf(rows)).toContain('orbis/finance_category');
    // По key тоже: «finance_cat» в подписи «Категория» не встречается ни разу.
    expect(keysOf(await run({ q: 'FINANCE_CAT' }))).toEqual(['orbis/finance_category']);
    // Свободное свойство находится по своей русской подписи — иначе оно недостижимо вовсе.
    expect(keysOf(await run({ q: 'часов сна' }))).toEqual([FREE_KEY]);
  });

  test('usage: аспекты-носители и число сущностей со значением (под RLS)', async () => {
    const [category] = await run({ q: 'finance_cat' });
    // Слияние В1: категорию носят и финансы, и бюджет — по одному носителю это невидимо.
    expect(category?.usage.aspects).toEqual(['orbis/financial', 'orbis/budget']);
    expect(category?.usage.entities).toBe(0);

    const [free] = await run({ q: 'часов сна' });
    // Ровно ДВЕ свои сущности; третья, чужая, тоже несёт это свойство — и не видна (RLS).
    expect(free?.usage.entities).toBe(2);
    // Носителей нет: свободное свойство не объявляет ни один аспект (§А1-2).
    expect(free?.usage.aspects).toEqual([]);
  });

  test('status=proposed отдаёт ТОЛЬКО предложенные; по умолчанию видны все статусы', async () => {
    expect(keysOf(await run({ status: 'proposed' }))).toEqual(['user/mood', 'user/tempo']);
    // Приёмка брифа: `status=proposed` на встроенном каталоге пусто — все 77 строк active.
    expect(await run({ status: 'proposed', module: 'finance' })).toEqual([]);
    const all = await run({});
    expect(keysOf(all)).toContain('user/mood');
    expect(keysOf(all)).toContain('orbis/amount');
  });

  test('aspect сужает до свойств носителя; порядок — rank СЛОВАРЯ, а не порядок полей аспекта', async () => {
    const byKey = keysOf(await run({ aspect: 'orbis/budget' }));
    // `orbis/currency` объявлено в словаре раньше `orbis/finance_category`, а в аспекте
    // стоит после него: каталог сортирует по словарю (см. докблок `runPropertyCatalog`).
    expect(byKey).toEqual([
      'orbis/currency',
      'orbis/finance_category',
      'orbis/limit',
      'orbis/period_start',
      'orbis/period_end',
      'orbis/carryover',
    ]);
    // Свободное свойство не принадлежит ни одному аспекту — сюда не попадает.
    expect(byKey).not.toContain(FREE_KEY);
  });

  test('module сужает по колонке модуля; неизвестный модуль — пусто, а не всё', async () => {
    const finance = await run({ module: 'finance' });
    expect(finance.every((r) => r.module === 'finance')).toBe(true);
    expect(keysOf(finance)).toContain('orbis/limit');
    expect(keysOf(finance)).not.toContain('orbis/task_status');
    expect(await run({ module: 'выдуманный' })).toEqual([]);
  });

  test('contract в срезе А НИЧЕГО не сужает (§Б2 — часть Б), и это сказано в описании тула', async () => {
    // Инертен — значит выдача та же, а не пустая: пустой ответ модель прочитала бы как
    // «таких свойств нет», и это была бы ложь про несуществующий пока механизм.
    const withContract = await run({ contract: 'orbis/money-movement' });
    expect(keysOf(withContract)).toEqual(keysOf(await run({})));
  });

  test('orphans=true — свойство БЕЗ носителя И БЕЗ значений; обе половины проверяются порознь', async () => {
    // Фикстура держит все три различимых случая, иначе фильтр «И» неотличим от «ИЛИ»:
    //  - user/mood: носителей нет, значений нет            → сирота;
    //  - user/sleep-hours: носителей нет, но ДВА значения   → не сирота (по значениям);
    //  - orbis/finance_category: значений нет, но ДВА носителя → не сирота (по носителям).
    const orphans = keysOf(await run({ orphans: true }));
    expect(orphans).toContain('user/mood');
    expect(orphans).not.toContain(FREE_KEY);
    expect(orphans).not.toContain('orbis/finance_category');

    // Комбинируется с остальными: сироты среди предложенных — это уже отчёт садовника.
    expect(keysOf(await run({ orphans: true, status: 'proposed' }))).toEqual([
      'user/mood',
      'user/tempo',
    ]);
    // `orphans: false` — это НЕ «покажи неосиротевшие», а отсутствие фильтра.
    expect(keysOf(await run({ orphans: false }))).toEqual(keysOf(await run({})));
  });

  test('olderThanDays отбирает по created_at СТРОКИ: 14 дней ловит залежавшееся предложение и не ловит свежее', async () => {
    // Ровно то, что нужно садовнику (§А2-7): `proposed` старше двух недель.
    expect(keysOf(await run({ status: 'proposed', olderThanDays: 14 }))).toEqual(['user/tempo']);
    // Порог — граница, а не «отдай всё»: 41 день старше сорокадневной строки, и выдача пуста.
    expect(await run({ status: 'proposed', olderThanDays: 41 })).toEqual([]);
    // 0 дней = «заведено раньше, чем сейчас» — обе строки; ключ при этом не «выключен».
    expect(keysOf(await run({ status: 'proposed', olderThanDays: 0 }))).toEqual([
      'user/mood',
      'user/tempo',
    ]);
    // Возраст мерится от ЧАСОВ ВЫЗОВА: сдвинув «сейчас» на 20 дней вперёд, тот же порог
    // ловит и свежую строку — это пин на источник времени, а не на now() базы.
    expect(
      keysOf(
        await run(
          { status: 'proposed', olderThanDays: 14 },
          new Date(Date.now() + 20 * 86_400_000),
        ),
      ),
    ).toEqual(['user/mood', 'user/tempo']);
  });

  test('фильтры комбинируются: q + aspect (аспект действительно сужает выдачу слова)', async () => {
    // «категор» находит и поля самой категории (`orbis/icon`, `orbis/aliases`), и правило
    // памяти — совпадение по СМЫСЛУ, а не только по key: ровно ради этого `q` смотрит все
    // три поля строки.
    const wide = keysOf(await run({ q: 'категор' }));
    expect(wide).toEqual([
      'orbis/finance_category',
      'orbis/limit',
      'orbis/icon',
      'orbis/color',
      'orbis/aliases',
      'orbis/rule_target',
    ]);
    // Тот же запрос в пределах конверта — только его два свойства.
    expect(keysOf(await run({ q: 'категор', aspect: 'orbis/budget' }))).toEqual([
      'orbis/finance_category',
      'orbis/limit',
    ]);
  });
});

describe('property_catalog: форма строки (§А9-3)', () => {
  test('label/description разрешены в локаль, тип едет объектом словаря с вариантами', async () => {
    const [direction] = await run({ q: 'orbis/direction' });
    expect(direction).toEqual({
      id: 'orbis/direction',
      key: 'orbis/direction',
      label: 'Направление',
      description: 'Деньги приходят или уходят',
      type: {
        kind: 'select',
        options: [
          { key: 'income', label: { ru: 'Доход', en: 'Income' }, rank: 1 },
          { key: 'expense', label: { ru: 'Расход', en: 'Expense' }, rank: 2 },
        ],
      },
      status: 'active',
      module: 'finance',
      usage: { aspects: ['orbis/financial'], entities: 0 },
    });
  });

  test('порядок выдачи — rank словаря (§А2-1): у задачи он совпадает с порядком полей аспекта', async () => {
    const rows = await run({ aspect: 'orbis/task' });
    expect(keysOf(rows)).toEqual([
      'orbis/task_status',
      'orbis/priority',
      'orbis/due_date',
      'orbis/completed_at',
      'orbis/effort_min',
      'orbis/waiting_for',
    ]);
  });
});
