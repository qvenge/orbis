// apps/server/src/budget/currency-normalize.test.ts
// Task B2 / бэклог A7 (TOCTOU NULL-currency-преемника): нормализация currency
// конверта NULL→user_settings.defaultCurrency на СЕРВЕРЕ — при create/update/attach
// orbis/budget, ДО проверки уникальности §2.1 и записи. Все пути (UI, rollover,
// будущий импорт) дают каноничную комбинацию с явной валютой, поэтому конверт
// «без currency» и конверт с явной defaultCurrency больше не считаются разными
// комбинациями. Реальная БД под withIdentity (RLS), без моков.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteErr, ExecuteOk, ExecuteRequest, ExecuteResult } from '../executor/types';

requireEnv();

const { db, client } = appDb();
const sink = makeChatJournalSink();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function req(user: string, tool: string, input: unknown): ExecuteRequest {
  return { actorUserId: user, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] };
}

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function err(r: ExecuteResult): ExecuteErr {
  if (r.ok) throw new Error('ожидался структурированный отказ, получен успех');
  return r;
}

function invariantOf(r: ExecuteErr): unknown {
  return (r.error.details as { invariant?: unknown } | undefined)?.invariant;
}

/** Конверт СВОЙСТВАМИ — она же форма `data` у `attach_*` (§А9-1). */
function budgetProps(
  categoryRef: string,
  start: string,
  end: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    'orbis/finance_category': categoryRef,
    'orbis/limit': '10000.00',
    'orbis/period_start': start,
    'orbis/period_end': end,
    ...over,
  };
}

/** Сохранённые свойства сущности — истина в БД (админ-DSN, обходит RLS). */
async function storedProps(id: string): Promise<Record<string, unknown>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = [...(await admin.execute(sql`SELECT props FROM entities WHERE id = ${id}`))];
    return (rows[0]?.props ?? {}) as Record<string, unknown>;
  } finally {
    await adminClient.end();
  }
}

async function setDefaultCurrency(user: string, currency: string): Promise<void> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.execute(
      sql`INSERT INTO user_settings (owner_id, "defaultCurrency") VALUES (${user}, ${currency})
          ON CONFLICT (owner_id) DO UPDATE SET "defaultCurrency" = ${currency}`,
    );
  } finally {
    await adminClient.end();
  }
}

describe('нормализация currency конверта NULL→defaultCurrency (бэклог A7, §2.1)', () => {
  test('create без currency: сохраняется явная defaultCurrency (фолбэк RUB)', async () => {
    const user = freshUserId();
    const r = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Конверт без валюты',
          tags: [],
          props: budgetProps(newId(), '2026-07-01', '2026-07-31'),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    const id = (r.results[0] as { id: string }).id;
    expect((await storedProps(id))['orbis/currency']).toBe('RUB');
  });

  test('create без currency при user_settings.defaultCurrency=EUR → сохраняется EUR', async () => {
    const user = freshUserId();
    await setDefaultCurrency(user, 'EUR');
    const r = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Конверт EUR-пользователя',
          tags: [],
          props: budgetProps(newId(), '2026-07-01', '2026-07-31'),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    const id = (r.results[0] as { id: string }).id;
    expect((await storedProps(id))['orbis/currency']).toBe('EUR');
  });

  test('ГЛАВНЫЙ A7-кейс: конверт без currency + конверт с явной defaultCurrency на ту же (категория, период) → duplicate_envelope', async () => {
    const user = freshUserId();
    const cat = newId();
    ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Без currency (нормализуется в RUB)',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31'),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    const r = err(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Явная RUB — та же комбинация',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31', { 'orbis/currency': 'RUB' }),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('duplicate_envelope');
  });

  test('зеркальный порядок: явная RUB создана первой, второй без currency → duplicate_envelope', async () => {
    const user = freshUserId();
    const cat = newId();
    ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Явная RUB',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31', { 'orbis/currency': 'RUB' }),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    const r = err(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Без currency',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31'),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    expect(invariantOf(r)).toBe('duplicate_envelope');
  });

  test('иная явная валюта — по-прежнему другая комбинация (EUR при дефолте RUB)', async () => {
    const user = freshUserId();
    const cat = newId();
    ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Без currency → RUB',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31'),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'EUR-вариант',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31', { 'orbis/currency': 'EUR' }),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
  });

  test('attach-путь: attach без currency нормализуется и ловит дубль явной defaultCurrency', async () => {
    const user = freshUserId();
    const cat = newId();
    ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Существующий RUB-конверт',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31', { 'orbis/currency': 'RUB' }),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    const host = ok(
      await execute(db, req(user, 'entity_create', { title: 'Кандидат', tags: [] }), { sink }),
    );
    const hostId = (host.results[0] as { id: string }).id;
    const r = err(
      await execute(
        db,
        req(user, 'attach_orbis_budget', {
          entity_id: hostId,
          data: budgetProps(cat, '2026-07-01', '2026-07-31'),
        }),
        { sink },
      ),
    );
    expect(invariantOf(r)).toBe('duplicate_envelope');

    // attach на свободную комбинацию — сохраняется с явной валютой
    const free = ok(
      await execute(
        db,
        req(user, 'attach_orbis_budget', {
          entity_id: hostId,
          data: budgetProps(cat, '2026-08-01', '2026-08-31'),
        }),
        { sink },
      ),
    );
    expect(free.ok).toBe(true);
    expect((await storedProps(hostId))['orbis/currency']).toBe('RUB');
  });

  test('update-путь: patch {currency: null} не оставляет NULL — нормализуется в defaultCurrency', async () => {
    const user = freshUserId();
    const cat = newId();
    const created = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Конверт с явной валютой',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31', { 'orbis/currency': 'RUB' }),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    const id = (created.results[0] as { id: string }).id;
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id,
          unset: ['orbis/currency'],
          aspects: { attach: ['orbis/budget'] },
        }),
        { sink },
      ),
    );
    expect((await storedProps(id))['orbis/currency']).toBe('RUB');
  });

  test('update-путь: перевод периода в комбинацию, занятую NULL-нормализованным конвертом → duplicate_envelope', async () => {
    const user = freshUserId();
    const cat = newId();
    ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Июль без currency → RUB',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31'),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    const aug = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Август, явная RUB',
          tags: [],
          props: budgetProps(cat, '2026-08-01', '2026-08-31', { 'orbis/currency': 'RUB' }),
          aspects: ['orbis/budget'],
        }),
        { sink },
      ),
    );
    const augId = (aug.results[0] as { id: string }).id;
    const r = err(
      await execute(
        db,
        req(user, 'entity_update', {
          id: augId,
          props: { 'orbis/period_start': '2026-07-01', 'orbis/period_end': '2026-07-31' },
          aspects: { attach: ['orbis/budget'] },
        }),
        { sink },
      ),
    );
    expect(invariantOf(r)).toBe('duplicate_envelope');
  });
});
