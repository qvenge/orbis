// apps/server/src/executor/body-chain.test.ts
// Раскрутка цепочки «действие тела до» (спека скорости §8.6, К-18; план А задача 10): действующее действие текущего
// тела — колонка `body_action_id`, а пока она указывает на запись отмены — «действие тела до» у действия, которое
// та отменила. Цепочки собираются настоящими правками и отменами; журнал читается только API журнала и помощниками.
import { afterAll, describe, expect, test } from 'bun:test';
import { type GraphId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { journalOf, undoRecordOf } from '../../test/journal-helpers';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { bodyEntitiesOf, effectiveBodyAction, versionLabel } from './body-chain';
import { execute } from './executor';
import { makeJournalSink } from './journal';
import type { ExecuteResult } from './types';
import { undoAction } from './undo';

requireEnv();

const { db, client } = appDb();
const admin = adminDb();
const sink = makeJournalSink();
const createCaller = createCallerFactory(appRouter);
/** Грант агента — только атрибуция записи журнала (внешнего ключа у колонки нет). */
const GRANT = newId();

afterAll(async () => {
  await client.end();
  await admin.client.end();
});

function ok(r: ExecuteResult): Extract<ExecuteResult, { ok: true }> {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

/** Запись без журнала (сев с пустым синком): колонка тела пуста (К-34). */
async function seedNote(g: GraphId, body: string): Promise<string> {
  const id = newId();
  ok(
    await execute(db, {
      identity: personal(g),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_create', input: { id, title: 'Заметка', tags: [], body } }],
    }),
  );
  return id;
}

/** Колонки тела — сырым SELECT'ом под админом: их пишет триггер, проверять их надо мимо кода чтения. */
async function columns(id: string): Promise<{ rev: number; raw: string | null; body: string }> {
  const rows = (await admin.db.execute(sql`
    SELECT body, body_revision, body_action_id::text AS raw FROM entities WHERE id = ${id}::uuid`)) as unknown as Array<
    Record<string, unknown>
  >;
  const row = rows[0];
  if (row === undefined) throw new Error(`записи ${id} нет`);
  return {
    rev: row.body_revision as number,
    raw: (row.raw as string | null) ?? null,
    body: row.body as string,
  };
}

/** Правка тела одной записи: владелец в интерфейсе (`ui`) или агент (`mcp`). id записи журнала. */
async function edit(g: GraphId, id: string, body: string, by: 'owner' | 'agent'): Promise<string> {
  const r = ok(
    await execute(
      db,
      {
        identity: personal(g),
        ...(by === 'owner'
          ? { actorKind: 'owner' as const, source: 'ui' as const }
          : { actorKind: 'agent' as const, source: 'mcp' as const, actorGrantId: GRANT }),
        operations: [
          {
            tool: 'entity_update',
            input: { id, body, expectedBodyRevision: (await columns(id)).rev },
          },
        ],
      },
      { sink },
    ),
  );
  return r.actionId;
}

async function undo(g: GraphId, actionId: string): Promise<string> {
  const r = await undoAction(db, { identity: personal(g), actionId });
  if (!r.ok) throw new Error(`отмена ${actionId}: ${JSON.stringify(r.error)}`);
  return r.actionId;
}

/** Действующее действие текущего тела записи — по колонке, прочитанной сейчас. */
async function effective(g: GraphId, id: string): Promise<string | null> {
  const { raw } = await columns(id);
  return withIdentity(db, personal(g), (tx) => effectiveBodyAction(tx, g, id, raw));
}

describe('effectiveBodyAction (§8.6, К-18): раскрутка цепочки «действие тела до»', () => {
  test('колонка → действие: действующее — оно само', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'исходный');
    const x = await edit(g, id, 'агент', 'agent');
    expect((await columns(id)).raw).toBe(x);
    expect(await effective(g, id)).toBe(x);
  });

  test('колонка → запись отмены U(X): действующее — «действие тела до» X по этой записи (W)', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'исходный');
    const w = await edit(g, id, 'владелец', 'owner');
    const x = await edit(g, id, 'агент', 'agent');
    expect((await journalOf(g, x))?.bodyBefore).toEqual({ [id]: w });
    const u = await undo(g, x);
    expect((await columns(id)).raw).toBe(u);
    expect(await effective(g, id)).toBe(w);
  });

  test('двойная отмена: U(B2) → B2.bodyBefore = B1 → B1; затем U(B1) → «до» B1 — пусто (сев без журнала)', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'исходный');
    const b1 = await edit(g, id, 'один', 'owner');
    const b2 = await edit(g, id, 'два', 'owner');
    await undo(g, b2);
    expect(await effective(g, id)).toBe(b1);
    const u1 = await undo(g, b1);
    expect((await columns(id)).raw).toBe(u1);
    expect(await effective(g, id)).toBeNull();
  });

  test('колонка пуста (писатель без журнала) → пусто', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'исходный');
    expect((await columns(id)).raw).toBeNull();
    expect(await effective(g, id)).toBeNull();
  });

  test('отменённое действие без «действия тела до» (перенесённая запись) → пусто: цепочку не восстановить', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'исходный');
    await edit(g, id, 'владелец', 'owner');
    const x = await edit(g, id, 'агент', 'agent');
    // Запись журнала до плана А «действия тела до» не несёт (§8.6 «Записи до плана А») — так её и кладёт перенос
    await admin.db.execute(
      sql`UPDATE action_journal SET body_before = NULL WHERE graph_id = ${g}::uuid AND id = ${x}::uuid`,
    );
    await undo(g, x);
    expect(await effective(g, id)).toBeNull();
  });

  test('колонка → X, отменённое записью, которая текст не сменила (сеанс с нулевым итогом) → X.bodyBefore', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'исходный');
    const a = await edit(g, id, 'агент', 'agent');
    // Сеанс владельца: набрал и вернул текст к исходному «агент» — продолжение сеанса, колонка = S
    const caller = createCaller({
      identity: personal(g),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    const first = await caller.entity.update({
      id,
      body: 'набрано',
      expectedBodyRevision: (await columns(id)).rev,
      autosave: true,
    });
    await caller.entity.update({
      id,
      body: 'агент',
      expectedBodyRevision: first.bodyRevision,
      autosave: true,
    });
    const s = (await columns(id)).raw as string;
    expect((await journalOf(g, s))?.textSession).toBe(true);
    // Отмена сеанса возвращает тот же текст — триггер колонку не двигает, она остаётся S, а S отменён
    await undo(g, s);
    expect((await undoRecordOf(g, s))?.undoes).toBe(s);
    expect(await columns(id)).toMatchObject({ raw: s, body: 'агент' });
    expect(await effective(g, id)).toBe(a);
    // Чтение записи называет то же действующее действие: колонка указывает на ОТМЕНЁННЫЙ сеанс — не «живое» действие
    // пробы, раскрутка обязательна (К-37)
    expect((await caller.entity.get({ id })).bodyAction).toMatchObject({
      actionId: a,
      actorKind: 'agent',
      textSession: false,
    });
  });
});

describe('bodyEntitiesOf (§8.6 «Кого касается»)', () => {
  test('ключи «действия тела до»; у перенесённой записи — записи с телом из данных отмены', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'исходный');
    const x = await edit(g, id, 'агент', 'agent');
    const entry = await journalOf(g, x);
    if (entry === undefined) throw new Error('записи журнала нет');
    expect(bodyEntitiesOf(entry)).toEqual([id]);
    const other = newId();
    const holder = newId();
    expect(
      bodyEntitiesOf({
        ...entry,
        bodyBefore: null,
        inverse: [
          { op: 'entity_update', payload: { id: id.toUpperCase(), body: 'до' } },
          { op: 'entity_update', payload: { id: other, title: 'без тела' } },
          { op: 'property_merge_undo', payload: { bodies: [{ entityId: holder, body: '' }] } },
        ],
      }),
    ).toEqual([id, holder]);
    // Отмена создания (архив) тела не пишет — правилу не подлежит
    expect(
      bodyEntitiesOf({
        ...entry,
        bodyBefore: null,
        inverse: [{ op: 'entity_update', payload: { id, archived: true } }],
      }),
    ).toEqual([]);
  });
});

test('подпись версии — в потолке 200, срез по кодовым точкам, пробелы по краям сняты', () => {
  expect(versionLabel('  перед отменой: Заметка  ')).toBe('перед отменой: Заметка');
  const long = versionLabel(`перед отменой: ${'а'.repeat(183)}😀😀`);
  expect(long.length).toBeLessThanOrEqual(200);
  expect(long.endsWith('…')).toBe(true);
  expect(/[\uD800-\uDBFF]…$/.test(long)).toBe(false);
});
