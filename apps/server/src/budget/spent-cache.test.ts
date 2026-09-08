// apps/server/src/budget/spent-cache.test.ts
// Кэш spent (§Б5-5, приёмка §С8-16): форма строки, обе половины версии, инкремент по хуку,
// три пути мимо хука и суточная граница. Реальная БД под withIdentity (RLS enforced).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  bumpRegistryVersion,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { touchesBudgetContour } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteOk, ExecuteRequest, ExecuteResult, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';
import { DEFAULT_TIMEZONE } from '../query/context';
import { effectiveRegistry } from '../registry/cache';
import { readRegistryVersions } from '../registry/version';
import { spentContributionOf } from '../subscriptions/budget';
import { budgetOverview } from './aggregates';
import { defaultCurrencyOf } from './binding';
import { decAdd, decCmp } from './decimal';
import { invalidateSpentCache, readSpentCache, spentCacheKey, writeSpentCache } from './spent-cache';

requireEnv();
const { db, client } = appDb();
/** Без журнала `undoAction` не найдёт action (образец `binding.test.ts`). */
const sink = makeChatJournalSink();
beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

function req(
  user: string,
  tool: string,
  input: unknown,
  over: Partial<ExecuteRequest> = {},
): ExecuteRequest {
  return {
    actorUserId: user,
    actorKind: 'owner',
    source: 'fast_path',
    operations: [{ tool, input }],
    ...over,
  };
}
function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}
async function createEntity(user: string, input: Record<string, unknown>): Promise<WireEntity> {
  return ok(await execute(db, req(user, 'entity_create', { tags: [], ...input })))
    .results[0] as WireEntity;
}
function budgetProps(
  cat: string,
  from = '2026-07-01',
  to = '2026-07-31',
): Record<string, unknown> {
  return {
    'orbis/finance_category': cat,
    'orbis/limit': '30000.00',
    'orbis/period_start': from,
    'orbis/period_end': to,
  };
}
function finProps(
  cat: string,
  on = '2026-07-05',
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    'orbis/amount': '340.00',
    'orbis/direction': 'expense',
    'orbis/finance_category': cat,
    'orbis/occurred_on': on,
    ...over,
  };
}
/** Строки кэша конверта — истина в БД (админ-DSN, обходит RLS). */
async function cacheRows(
  envelopeId: string,
): Promise<Array<{ as_of: string; spent: string; owner_version: number }>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(sql`
      SELECT as_of::text AS as_of, spent::text AS spent, owner_version FROM envelope_spent_cache
      WHERE envelope_id = ${envelopeId} ORDER BY as_of`);
    return [...rows] as Array<{ as_of: string; spent: string; owner_version: number }>;
  } finally {
    await adminClient.end();
  }
}

describe('таблица кэша: форма строки и обе половины версии (§Б5-5, §А10-1)', () => {
  const user = freshUserId();
  const cat = newId();

  test('запись и чтение по ключу (envelope_id, as_of); строка чужой версии невидима', async () => {
    const env = await createEntity(user, {
      title: 'Еда — июль',
      props: budgetProps(cat),
      aspects: ['orbis/budget'],
    });
    await withIdentity(db, user, async (tx) => {
      const v = await readRegistryVersions(tx, user);
      await writeSpentCache(
        tx,
        user,
        [{ envelopeId: env.id, asOf: '2026-07-05', spent: '340.00' }],
        v,
      );
      const hit = await readSpentCache(tx, user, [{ envelopeId: env.id, asOf: '2026-07-05' }], v);
      expect(hit.get(spentCacheKey({ envelopeId: env.id, asOf: '2026-07-05' }))).toBe('340.00');
      // Половина владельца сдвинулась — та же строка перестала отвечать (§С8-16).
      const stale = { ownerVersion: v.ownerVersion + 1, systemVersion: v.systemVersion };
      expect(
        (await readSpentCache(tx, user, [{ envelopeId: env.id, asOf: '2026-07-05' }], stale)).size,
      ).toBe(0);
      // Другой день — другой ключ: суточная граница закрыта ключом, а не пересчётом.
      expect(
        (await readSpentCache(tx, user, [{ envelopeId: env.id, asOf: '2026-07-06' }], v)).size,
      ).toBe(0);
      await invalidateSpentCache(tx, user, [env.id]);
      expect(
        (await readSpentCache(tx, user, [{ envelopeId: env.id, asOf: '2026-07-05' }], v)).size,
      ).toBe(0);
    });
    expect(await cacheRows(env.id)).toEqual([]);
  });
});

describe('чтение spent идёт через кэш (§Б5-5): промах считает и пишет, попадание не считает', () => {
  const user = freshUserId();
  const cat = newId();

  test('первый overview кладёт строку конверта; второй берёт её; смена версии реестра — снова промах', async () => {
    const env = await createEntity(user, {
      title: 'Такси — июль',
      props: budgetProps(cat),
      aspects: ['orbis/budget'],
    });
    await createEntity(user, {
      title: 'Такси 1',
      props: finProps(cat, '2026-07-05'),
      aspects: ['orbis/financial'],
    });
    const clock = () => new Date('2026-07-10T09:00:00.000Z');

    expect(await cacheRows(env.id)).toEqual([]);
    const first = await budgetOverview(db, user, '2026-07', clock);
    expect(first.envelopes.map((e) => e.spent)).toEqual(['340.00']);
    // Промах записал строку ровно за «сегодня» владельца и с текущей парой версий.
    const versions = await withIdentity(db, user, (tx) => readRegistryVersions(tx, user));
    expect(await cacheRows(env.id)).toEqual([
      { as_of: '2026-07-10', spent: '340.00', owner_version: versions.ownerVersion },
    ]);

    // Подмена строки кэша заведомо неверным числом: если бы читатель считал по графу, он
    // вернул бы 340.00 и тест не отличил бы кэш от его отсутствия.
    await withIdentity(db, user, async (tx) => {
      await writeSpentCache(
        tx,
        user,
        [{ envelopeId: env.id, asOf: '2026-07-10', spent: '999.00' }],
        versions,
      );
    });
    expect((await budgetOverview(db, user, '2026-07', clock)).envelopes.map((e) => e.spent)).toEqual(
      ['999.00'],
    );

    // §С8-16: смена registry_version инвалидирует — строка чужой версии не отвечает.
    await bumpRegistryVersion(user);
    expect((await budgetOverview(db, user, '2026-07', clock)).envelopes.map((e) => e.spent)).toEqual(
      ['340.00'],
    );
  });

  test('конверт без трат кэшируется НУЛЁМ: иначе он промахивался бы вечно', async () => {
    const other = newId();
    const env = await createEntity(user, {
      title: 'Пустой',
      props: budgetProps(other),
      aspects: ['orbis/budget'],
    });
    await budgetOverview(db, user, '2026-07', () => new Date('2026-07-11T09:00:00.000Z'));
    expect((await cacheRows(env.id)).map((r) => r.as_of)).toEqual(['2026-07-11']);
  });
});

describe('врезка в бюджет-хук: инкремент нового движения, снос — всё остальное (§Б5-5, Р-К-16)', () => {
  const user = freshUserId();
  const cat = newId();
  const clock = () => new Date('2026-07-10T09:00:00.000Z');

  test('новое движение ИНКРЕМЕНТИРУЕТ прогретую строку конверта — без пересчёта по графу', async () => {
    const env = await createEntity(user, {
      title: 'Еда — июль',
      props: budgetProps(cat),
      aspects: ['orbis/budget'],
    });
    await budgetOverview(db, user, '2026-07', clock); // прогрев: строка за 2026-07-10 = 0
    expect((await cacheRows(env.id)).map((r) => [r.as_of, r.spent])).toEqual([
      ['2026-07-10', '0.00'],
    ]);

    await createEntity(user, {
      title: 'Продукты',
      props: finProps(cat, '2026-07-05'),
      aspects: ['orbis/financial'],
    });
    // Инкремент прошёл В ТОЙ ЖЕ tx, что запись движения: строка уже верна ДО всякого чтения.
    expect((await cacheRows(env.id))[0]?.spent).toBe('340.00');
    expect((await budgetOverview(db, user, '2026-07', clock)).envelopes[0]?.spent).toBe('340.00');
  });

  test('движение будущего дня строку СЕГОДНЯ не трогает (as_of >= occurred_on)', async () => {
    await createEntity(user, {
      title: 'Аванс за август',
      props: finProps(cat, '2026-07-20'),
      aspects: ['orbis/financial'],
    });
    const env = (await budgetOverview(db, user, '2026-07', clock)).envelopes[0];
    expect(env?.spent).toBe('340.00');
  });

  test('правка суммы привязку не меняет (descs пуст), но строку конверта СНОСИТ', async () => {
    const txn = await createEntity(user, {
      title: 'Кафе',
      props: finProps(cat, '2026-07-06', { 'orbis/amount': '100.00' }),
      aspects: ['orbis/financial'],
    });
    const envId = ((await budgetOverview(db, user, '2026-07', clock)).envelopes[0]
      ?.envelope as WireEntity).id;
    expect((await cacheRows(envId))[0]?.spent).toBe('440.00');
    ok(await execute(db, req(user, 'entity_update', { id: txn.id, props: { 'orbis/amount': '250.00' } })));
    expect(await cacheRows(envId)).toEqual([]); // ленивый пересчёт
    expect((await budgetOverview(db, user, '2026-07', clock)).envelopes[0]?.spent).toBe('590.00');
  });

  test('доход и план не инкрементируют вовсе (предикат тот же, что у ведомости)', async () => {
    const envId = ((await budgetOverview(db, user, '2026-07', clock)).envelopes[0]
      ?.envelope as WireEntity).id;
    const before = (await cacheRows(envId))[0]?.spent;
    // Прогретая строка ОБЯЗАНА быть: без неё «не изменилась» было бы сравнением двух
    // `undefined`, то есть тавтологией.
    expect(typeof before).toBe('string');
    await createEntity(user, {
      title: 'Зарплата',
      props: finProps(cat, '2026-07-07', { 'orbis/direction': 'income' }),
      aspects: ['orbis/financial'],
    });
    expect((await cacheRows(envId))[0]?.spent).toBe(before as string);
  });

  test('ребро envelope-binding, поставленное/снятое не хуком, сносит строку конверта', async () => {
    const otherCat = newId();
    const env = await createEntity(user, {
      title: 'Ручной конверт',
      props: budgetProps(otherCat),
      aspects: ['orbis/budget'],
    });
    const txn = await createEntity(user, {
      title: 'Ручная трата',
      props: finProps(otherCat, '2026-07-08'),
      aspects: ['orbis/financial'],
    });
    await budgetOverview(db, user, '2026-07', clock);
    expect((await cacheRows(env.id))[0]?.spent).toBe('340.00');
    // Механизм seed — фикстура играет роль системы (§А4-4): гейт created_by пропускает.
    ok(
      await execute(
        db,
        req(
          user,
          'relation_delete',
          { source_id: env.id, target_id: txn.id, role: 'envelope-binding' },
          { mechanism: 'seed' },
        ),
      ),
    );
    expect(await cacheRows(env.id)).toEqual([]);
    await budgetOverview(db, user, '2026-07', clock);
    expect((await cacheRows(env.id))[0]?.spent).toBe('0.00');
    ok(
      await execute(
        db,
        req(
          user,
          'relation_create',
          { source_id: env.id, target_id: txn.id, role: 'envelope-binding' },
          { mechanism: 'seed' },
        ),
      ),
    );
    expect(await cacheRows(env.id)).toEqual([]);
  });
});

describe('вклад одного движения — из декларации подписки (§Б5-4, §Б5-5)', () => {
  const user = freshUserId();
  const cat = newId();

  /** Тот же вход, что у врезки в исполнителе: снимок владельца + его «сегодня». */
  async function contribution(entityId: string, envelopeId: string) {
    return withIdentity(db, user, async (tx) => {
      const reg = await effectiveRegistry(tx, user);
      const cctx = {
        ownerId: user,
        today: '2026-07-10',
        timeZone: DEFAULT_TIMEZONE,
        reg,
        thisEntityId: null,
      };
      return spentContributionOf(tx, user, cctx, {
        entityId,
        envelopeId,
        defaultCurrency: await defaultCurrencyOf(tx, user),
      });
    });
  }

  test('расход своей валюты даёт сумму и день; доход, план и чужая валюта — null', async () => {
    const env = await createEntity(user, {
      title: 'Вклад',
      props: budgetProps(cat),
      aspects: ['orbis/budget'],
    });
    const spend = await createEntity(user, {
      title: 'Расход',
      props: finProps(cat, '2026-07-05'),
      aspects: ['orbis/financial'],
    });
    // `asOf` — значение слота `date`, а НЕ «сегодня»: строка более раннего дня этого
    // движения не видела, и инкремент обязан знать, с какого дня оно считается.
    expect(await contribution(spend.id, env.id)).toEqual({ amount: '340.00', asOf: '2026-07-05' });

    const income = await createEntity(user, {
      title: 'Доход',
      props: finProps(cat, '2026-07-05', { 'orbis/direction': 'income' }),
      aspects: ['orbis/financial'],
    });
    expect(await contribution(income.id, env.id)).toBeNull(); // класс inflow вне `where`
    const planned = await createEntity(user, {
      title: 'План',
      props: finProps(cat, '2026-07-05', { 'orbis/planned': true }),
      aspects: ['orbis/financial'],
    });
    expect(await contribution(planned.id, env.id)).toBeNull(); // набор `facts`
    const usd = await createEntity(user, {
      title: 'Валюта',
      props: finProps(cat, '2026-07-05', { 'orbis/currency': 'USD' }),
      aspects: ['orbis/financial'],
    });
    expect(await contribution(usd.id, env.id)).toBeNull(); // currency: same_as_envelope
  });

  test('вклады и ведомость считают ОДНО множество: сумма вкладов = spent конверта', async () => {
    // Ровно эта сверка отличает инкремент от второй правды о деньгах: разъедься предикат
    // вклада с предикатом ведомости — числа разойдутся здесь, а не на экране владельца.
    const cat2 = newId();
    const env = await createEntity(user, {
      title: 'Сверка',
      props: budgetProps(cat2),
      aspects: ['orbis/budget'],
    });
    const ids: string[] = [];
    for (const [day, amount] of [
      ['2026-07-02', '100.00'],
      ['2026-07-03', '250.50'],
      ['2026-07-04', '1.25'],
    ] as const) {
      ids.push(
        (
          await createEntity(user, {
            title: `Т ${day}`,
            props: finProps(cat2, day, { 'orbis/amount': amount }),
            aspects: ['orbis/financial'],
          })
        ).id,
      );
    }
    let sum = '0';
    for (const id of ids) {
      const c = await contribution(id, env.id);
      sum = decAdd(sum, c?.amount ?? '0');
    }
    const overview = await budgetOverview(
      db,
      user,
      '2026-07',
      () => new Date('2026-07-10T09:00:00.000Z'),
    );
    expect(
      decCmp(sum, overview.envelopes.find((e) => e.envelope.id === env.id)?.spent ?? '0'),
    ).toBe(0);
  });
});

describe('пути мимо хука: undo и property_merge (§Б5-5)', () => {
  const user = freshUserId();
  const cat = newId();
  const clock = () => new Date('2026-07-10T09:00:00.000Z');

  test('undo действия сносит кэш владельца: откат правит props, а хук в нём не зовётся вовсе', async () => {
    const env = await createEntity(user, {
      title: 'Кино — июль',
      props: budgetProps(cat),
      aspects: ['orbis/budget'],
    });
    const created = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Билеты',
          tags: [],
          props: finProps(cat, '2026-07-04'),
          aspects: ['orbis/financial'],
        }),
        { sink },
      ),
    );
    await budgetOverview(db, user, '2026-07', clock);
    expect((await cacheRows(env.id))[0]?.spent).toBe('340.00');

    const undone = await undoAction(db, { actorUserId: user, actionId: created.actionId });
    expect(undone.ok ? 'ok' : undone.error.code).toBe('ok');
    expect(await cacheRows(env.id)).toEqual([]);
    expect((await budgetOverview(db, user, '2026-07', clock)).envelopes[0]?.spent).toBe('0.00');
  });

  test('property_merge сносит кэш владельца ЦЕЛИКОМ и виден предикату замка контура', async () => {
    // Свойства здесь ПОЛЬЗОВАТЕЛЬСКИЕ и к финансам отношения не имеют: инвалидация не
    // условная. Так и надо — слияние переписывает `props` неизвестного заранее множества
    // носителей одним UPDATE в CTE, и «а задело ли оно деньги» вопрос без дешёвого ответа.
    const mk = (key: string) =>
      execute(
        db,
        req(user, 'property_create', {
          key,
          label: { ru: key },
          description: { ru: 'Проба слияния' },
          type: { kind: 'text' },
          status: 'active',
        }),
      );
    ok(await mk('user/merge-probe-1'));
    ok(await mk('user/merge-probe-2'));
    const env = (await budgetOverview(db, user, '2026-07', clock)).envelopes[0]
      ?.envelope as WireEntity;
    expect((await cacheRows(env.id)).length).toBe(1);

    ok(
      await execute(
        db,
        req(user, 'property_merge', {
          source: 'user/merge-probe-1',
          into: 'user/merge-probe-2',
        }),
      ),
    );
    expect(await cacheRows(env.id)).toEqual([]);

    // Предикат замка обязан ВИДЕТЬ слияние: иначе конкурентный бюджет-хук считал бы привязку
    // по props, которые слияние переписывает мимо всякой per-entity операции.
    const reg = await withIdentity(db, user, (tx) => effectiveRegistry(tx, user));
    expect(
      touchesBudgetContour(reg, { tool: 'property_merge', input: { source: 'a', into: 'b' } }),
    ).toBe(true);
    expect(touchesBudgetContour(reg, { tool: 'property_merge_undo', input: {} })).toBe(true);
  });
});
