// apps/server/src/executor/body-stamp.test.ts
// Колонки тела (спека скорости §8.1, план А задача 7): ревизию, «действие текущего тела» и время изменения тела ставит
// триггер `entities_body_stamp` (0026) у ЛЮБОГО писателя; executor объявляет действие один раз на транзакцию
// (`orbis.body_action`, РП-16), сев без журнала оставляет колонку пустой (К-34), пачка повторяет приращение в
// виртуальной строке (РП-17), запись журнала — и запись отмены — хранит «действие тела до» для записей, чьё тело
// сменила (§8.6 «Цепочка»; у слияния — у каждого держателя). Журнал читается только помощниками
// `test/journal-helpers.ts`; колонки записи — сырым SELECT'ом под админом (их писатель — триггер, а не API).
import { afterAll, describe, expect, test } from 'bun:test';
import { type GraphId, newId } from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { journalOf, undoRecordOf } from '../../test/journal-helpers';
import type { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { readEntity } from '../entity-read';
import { setupGraph } from '../seed/setup-graph';
import { bodyChanges, stampVirtualBody } from './body-stamp';
import { execute } from './executor';
import { makeJournalSink } from './journal';
import type { ExecuteOk, ExecuteRequest, ExecuteResult, WireEntity } from './types';
import { undoAction } from './undo';

requireEnv();

const { db, client } = appDb();
const admin = adminDb();
const sink = makeJournalSink();

afterAll(async () => {
  await client.end();
  await admin.client.end();
});

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function req(
  g: GraphId,
  operations: Array<{ tool: string; input: unknown }>,
  over: Partial<ExecuteRequest> = {},
): ExecuteRequest {
  return { identity: personal(g), actorKind: 'owner', source: 'ui', operations, ...over };
}

function run(g: GraphId, tool: string, input: unknown): Promise<ExecuteResult> {
  return execute(db, req(g, [{ tool, input }]), { sink });
}

async function createNote(
  g: GraphId,
  title: string,
  body: string,
): Promise<{ entityId: string; actionId: string; entity: WireEntity }> {
  const id = newId();
  const r = ok(await run(g, 'entity_create', { id, title, tags: [], body }));
  return { entityId: id, actionId: r.actionId, entity: r.results[0] as WireEntity };
}

/** Своё числовое свойство владельца — предмет слияния; возвращает его id. */
async function numberProperty(g: GraphId, key: string): Promise<string> {
  const r = ok(
    await run(g, 'property_create', {
      key,
      label: { ru: key },
      description: { ru: 'поле слияния' },
      type: { kind: 'number' },
      status: 'active',
    }),
  );
  return (r.results[0] as { property: string }).property;
}

/** Тело держателя свойства `user/effort`: смарт-лист с query-блоком по нему. */
const HOLDER_BODY = 'Список\n\n{{query: aspect=orbis/task, user/effort=5}}';

interface BodyColumns {
  body_revision: number;
  body_action_id: string | null;
  body_changed_at: Date;
}

/** Три колонки записи — сырым SELECT'ом: их пишет триггер, и проверять их надо мимо любого кода чтения. */
async function rawEntity(id: string): Promise<BodyColumns> {
  const rows = (await admin.db.execute(sql`
    SELECT body_revision, body_action_id::text AS body_action_id, body_changed_at
      FROM entities WHERE id = ${id}::uuid`)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (row === undefined) throw new Error(`записи ${id} нет`);
  return {
    body_revision: row.body_revision as number,
    body_action_id: (row.body_action_id as string | null) ?? null,
    // Сырая выдача drizzle отдаёт timestamptz строкой (date-парсеры postgres.js отключены) — приводим как wire.ts
    body_changed_at: new Date(String(row.body_changed_at)),
  };
}

describe('колонки тела (задача 7, §8.1)', () => {
  test('создание: ревизия 1, действие — id записи журнала, время — момент инструкции', async () => {
    const g = await freshGraph();
    const t0 = Date.now();
    const r = await createNote(g, 'заметка', 'текст');
    const row = await rawEntity(r.entityId);
    expect(row.body_revision).toBe(1);
    expect(row.body_action_id).toBe(r.actionId);
    expect(row.body_changed_at).toBeInstanceOf(Date);
    // Момент инструкции, а не умолчание колонки и не «когда-то»: часы базы и процесса — одной машины стенда
    expect(Math.abs(row.body_changed_at.getTime() - t0)).toBeLessThan(60_000);
  });

  test('правка тела: ревизия +1, действие — новое; правка свойства и тега колонки не трогает', async () => {
    const g = await freshGraph();
    const n = await createNote(g, 'заметка', 'текст');
    const created = await rawEntity(n.entityId);
    const u = ok(
      await run(g, 'entity_update', {
        id: n.entityId,
        body: 'новый текст',
        expectedBodyRevision: n.entity.bodyRevision,
      }),
    );
    const edited = await rawEntity(n.entityId);
    expect([edited.body_revision, edited.body_action_id]).toEqual([2, u.actionId]);
    expect(edited.body_changed_at.getTime()).toBeGreaterThan(created.body_changed_at.getTime());

    // Правка тега, заголовка и свойства (с навешиванием аспекта) тело не меняет — колонки те же до миллисекунды
    ok(await run(g, 'entity_update', { id: n.entityId, tags: ['метка'], title: 'Заметка 2' }));
    ok(
      await run(g, 'entity_update', {
        id: n.entityId,
        props: { 'orbis/task_status': 'planned' },
        aspects: { attach: ['orbis/task'] },
      }),
    );
    expect(await rawEntity(n.entityId)).toEqual(edited);
  });

  test('правка тем же текстом: ни ревизии, ни «действия тела до» (IS DISTINCT FROM)', async () => {
    const g = await freshGraph();
    const n = await createNote(g, 'заметка', 'тот же текст');
    const created = await rawEntity(n.entityId);
    const u = ok(
      await run(g, 'entity_update', {
        id: n.entityId,
        body: 'тот же текст',
        expectedBodyRevision: n.entity.bodyRevision,
      }),
    );
    expect(await rawEntity(n.entityId)).toEqual(created);
    // Запись журнала правки есть, но тело она не сменила — «действия тела до» у неё нет вовсе (К-34)
    const entry = await journalOf(g, u.actionId);
    expect(entry).toBeDefined();
    expect(entry?.bodyBefore ?? null).toBeNull();
  });

  test('пачка: одно действие на транзакцию — колонка у всех записей пачки = batchId', async () => {
    const g = await freshGraph();
    const a = await createNote(g, 'а', 'текст а');
    const b = newId();
    const batchId = newId();
    ok(
      await execute(
        db,
        req(
          g,
          [
            { tool: 'entity_create', input: { id: b, title: 'б', tags: [], body: 'текст б' } },
            {
              tool: 'entity_update',
              input: {
                id: a.entityId,
                body: 'текст а2',
                expectedBodyRevision: a.entity.bodyRevision,
              },
            },
          ],
          { batchId },
        ),
        { sink },
      ),
    );
    const rowA = await rawEntity(a.entityId);
    const rowB = await rawEntity(b);
    expect([rowA.body_revision, rowA.body_action_id]).toEqual([2, batchId]);
    expect([rowB.body_revision, rowB.body_action_id]).toEqual([1, batchId]);
  });

  test('пачка: вторая правка тела той же записи видит ревизию +1 в виртуальной строке (РП-17)', async () => {
    const g = await freshGraph();
    const n = await createNote(g, 'заметка', 'исходный');
    const db0 = await rawEntity(n.entityId);

    // Виртуальная строка — триггер в памяти: вторая правка сверяется с ревизией ПОСЛЕ первой, а не с устаревшей
    // (иначе с гейтом по ревизии — задача 8 — «тело + тело» в пачке прошла бы молча, Д-13). Сверяем с тем, что
    // поставит база: у строки, прочитанной под замком, — те же три колонки.
    const current = {
      body: n.entity.body,
      bodyDoc: null,
      bodyRevision: db0.body_revision,
      bodyActionId: db0.body_action_id,
      bodyChangedAt: db0.body_changed_at,
    } as unknown as typeof entities.$inferSelect;
    const at = new Date();
    const first = stampVirtualBody(current, { body: 'а', bodyDoc: null }, 'пачка', at);
    const second = stampVirtualBody(first, { body: 'б', bodyDoc: null }, 'пачка', at);
    expect([first.bodyRevision, first.bodyActionId]).toEqual([2, 'пачка']);
    expect([second.bodyRevision, second.bodyActionId]).toEqual([3, 'пачка']);
    // Тот же текст виртуальную строку не двигает — ровно как триггер (IS DISTINCT FROM)
    const same = stampVirtualBody(second, { body: 'б', bodyDoc: null }, 'другое', at);
    expect([same.bodyRevision, same.bodyActionId]).toEqual([3, 'пачка']);
    // Документ сравнивается как jsonb: порядок ключей не различие
    expect(
      bodyChanges(
        { body: 'x', bodyDoc: { v: 1, doc: { type: 'doc', content: [] } } },
        { body: 'x', bodyDoc: { doc: { content: [], type: 'doc' }, v: 1 } },
      ),
    ).toBe(false);

    // И вживую: пачка из двух правок тела одной записи. Гейт тела — по ревизии (задача 8): вторая операция называет
    // ревизию, которую поставит первая, — виртуальная строка пачки её видит.
    const batchId = newId();
    const r = ok(
      await execute(
        db,
        req(
          g,
          [
            {
              tool: 'entity_update',
              input: { id: n.entityId, body: 'а', expectedBodyRevision: 1 },
            },
            {
              tool: 'entity_update',
              input: { id: n.entityId, body: 'б', expectedBodyRevision: 2 },
            },
          ],
          { batchId },
        ),
        { sink },
      ),
    );
    const results = r.results as WireEntity[];
    expect(results.map((e) => e.bodyRevision)).toEqual([2, 3]);
    const row = await rawEntity(n.entityId);
    expect([row.body_revision, row.body_action_id]).toEqual([3, batchId]);
    // «До» — значение ДО ПЕРВОЙ правки этой записи в пачке (первый ключ побеждает)
    expect((await journalOf(g, batchId))?.bodyBefore).toEqual({ [n.entityId]: n.actionId });
  });

  test('пачка «создать и поправить тело»: «до» у созданной записи — пусто, а не само действие', async () => {
    const g = await freshGraph();
    const id = newId();
    const batchId = newId();
    ok(
      await execute(
        db,
        req(
          g,
          [
            { tool: 'entity_create', input: { id, title: 'новая', tags: [], body: 'черновик' } },
            {
              tool: 'entity_update',
              input: { id, body: 'чистовик', expectedBodyRevision: 1 },
            },
          ],
          { batchId },
        ),
        { sink },
      ),
    );
    const row = await rawEntity(id);
    expect([row.body_revision, row.body_action_id]).toEqual([2, batchId]);
    // До пачки записи не было — «действия тела до» у неё нет; ссылка на саму пачку замкнула бы цепочку на себя
    expect((await journalOf(g, batchId))?.bodyBefore).toEqual({ [id]: null });
  });

  test('запись журнала хранит «действие тела до» только для записей, чьё тело сменилось', async () => {
    const g = await freshGraph();
    const a = await createNote(g, 'а', 'текст а');
    const b = await createNote(g, 'б', 'текст б');
    const c = await createNote(g, 'в', 'текст в');
    const batchId = newId();
    ok(
      await execute(
        db,
        req(
          g,
          [
            {
              tool: 'entity_update',
              input: {
                id: a.entityId,
                body: 'текст а2',
                expectedBodyRevision: a.entity.bodyRevision,
              },
            },
            { tool: 'entity_update', input: { id: b.entityId, title: 'Б' } },
            {
              tool: 'entity_update',
              input: {
                id: c.entityId,
                body: 'текст в',
                expectedBodyRevision: c.entity.bodyRevision,
              },
            },
          ],
          { batchId },
        ),
        { sink },
      ),
    );
    expect((await journalOf(g, batchId))?.bodyBefore).toEqual({ [a.entityId]: a.actionId });
    // Одиночная правка без тела — поля нет вовсе, а не пустой объект
    const t = ok(await run(g, 'entity_update', { id: b.entityId, title: 'Б2' }));
    expect((await journalOf(g, t.actionId))?.bodyBefore ?? null).toBeNull();
  });

  test('засев тела проекта в attach: колонка — действие attach, «до» — действие создания', async () => {
    const g = await freshGraph();
    const n = await createNote(g, 'будущий проект', '');
    const a = ok(
      await run(g, 'attach_orbis_project', {
        entity_id: n.entityId,
        data: { 'orbis/project_stage': 'active' },
      }),
    );
    const row = await rawEntity(n.entityId);
    expect([row.body_revision, row.body_action_id]).toEqual([2, a.actionId]);
    expect((await journalOf(g, a.actionId))?.bodyBefore).toEqual({ [n.entityId]: n.actionId });
  });

  test('слияние свойства: у держателей колонка = действие слияния, «до» — в bodies[] и в body_before', async () => {
    const g = await freshGraph();
    const sourceId = await numberProperty(g, 'user/effort');
    const intoId = await numberProperty(g, 'user/energy');
    const holder = await createNote(g, 'Смарт-лист', HOLDER_BODY);
    const plain = await createNote(g, 'Без блока', 'просто текст');

    const merged = ok(await run(g, 'property_merge', { source: sourceId, into: intoId }));
    const row = await rawEntity(holder.entityId);
    expect([row.body_revision, row.body_action_id]).toEqual([2, merged.actionId]);
    expect((await rawEntity(plain.entityId)).body_action_id).toBe(plain.actionId);
    const entry = await journalOf(g, merged.actionId);
    expect(entry?.bodyBefore).toEqual({ [holder.entityId]: holder.actionId });
    const inverse = entry?.inverse[0]?.payload as {
      bodies: Array<{ entityId: string; bodyActionBefore: string | null }>;
    };
    expect(inverse.bodies.map((b) => [b.entityId, b.bodyActionBefore])).toEqual([
      [holder.entityId, holder.actionId],
    ]);

    // Отмена слияния: сырой SQL отката тоже под объявленным действием — колонка держателя = id записи отмены, а сама
    // запись отмены хранит «действие тела до» (перенос I-2 ревью задачи 5)
    ok(await undoAction(db, { identity: personal(g), actionId: merged.actionId }));
    const undo = await undoRecordOf(g, merged.actionId);
    expect(undo).toBeDefined();
    const back = await rawEntity(holder.entityId);
    expect([back.body_revision, back.body_action_id]).toEqual([3, undo?.id ?? '']);
    expect(undo?.bodyBefore).toEqual({ [holder.entityId]: merged.actionId });
  });

  test('пачка [создание держателя, слияние]: «до» держателя — пусто, а не сама пачка (M-2 гейта)', async () => {
    const g = await freshGraph();
    const sourceId = await numberProperty(g, 'user/effort');
    const intoId = await numberProperty(g, 'user/energy');
    const id = newId();
    const batchId = newId();
    ok(
      await execute(
        db,
        req(
          g,
          [
            {
              tool: 'entity_create',
              input: { id, title: 'Смарт-лист', tags: [], body: HOLDER_BODY },
            },
            { tool: 'property_merge', input: { source: sourceId, into: intoId } },
          ],
          { batchId },
        ),
        { sink },
      ),
    );
    // Создание и слияние в одной транзакции: колонка держателя — пачка, ревизия — 2 (слияние переписало блок)
    const row = await rawEntity(id);
    expect([row.body_revision, row.body_action_id]).toEqual([2, batchId]);
    // «До» — значение колонки ДО транзакции: записи не было. Сырая колонка под замком слияния уже несёт саму пачку —
    // её в «до» класть нельзя ни в запись журнала, ни в данные отмены держателя
    const entry = await journalOf(g, batchId);
    expect(entry?.bodyBefore).toEqual({ [id]: null });
    const mergeUndo = entry?.inverse.find((op) => op.op === 'property_merge_undo')?.payload as {
      bodies: Array<{ entityId: string; bodyActionBefore: string | null }>;
    };
    expect(mergeUndo.bodies.map((b) => [b.entityId, b.bodyActionBefore])).toEqual([[id, null]]);
  });

  test('id пачки в ВЕРХНЕМ регистре (модель через MCP): «до» держателя — пусто, колонка — id пачки (M-5 гейта)', async () => {
    // uuid в базе — в нижнем регистре: колонка, прочитанная под замком слияния, несёт пачку в каноне, и сравнение с
    // объявленным действием без приведения регистра не узнало бы в ней само действие — «до» сослалось бы на пачку.
    const g = await freshGraph();
    const sourceId = await numberProperty(g, 'user/effort');
    const intoId = await numberProperty(g, 'user/energy');
    const id = newId();
    const batchId = newId().toUpperCase();
    ok(
      await execute(
        db,
        req(
          g,
          [
            {
              tool: 'entity_create',
              input: { id, title: 'Смарт-лист', tags: [], body: HOLDER_BODY },
            },
            { tool: 'property_merge', input: { source: sourceId, into: intoId } },
          ],
          { batchId },
        ),
        { sink },
      ),
    );
    const row = await rawEntity(id);
    expect([row.body_revision, row.body_action_id]).toEqual([2, batchId.toLowerCase()]);
    const entry = await journalOf(g, batchId.toLowerCase());
    expect(entry?.bodyBefore).toEqual({ [id]: null });
    const mergeUndo = entry?.inverse.find((op) => op.op === 'property_merge_undo')?.payload as {
      bodies: Array<{ entityId: string; bodyActionBefore: string | null }>;
    };
    expect(mergeUndo.bodies.map((b) => [b.entityId, b.bodyActionBefore])).toEqual([[id, null]]);
  });

  test('отмена ПАЧКИ: запись отмены хранит «до» по каждой записи, чьё тело откат сменил (M-3 гейта)', async () => {
    const g = await freshGraph();
    const a = await createNote(g, 'а', 'текст а');
    const b = await createNote(g, 'б', 'текст б');
    const batchId = newId();
    ok(
      await execute(
        db,
        req(
          g,
          [
            {
              tool: 'entity_update',
              input: {
                id: a.entityId,
                body: 'текст а2',
                expectedBodyRevision: a.entity.bodyRevision,
              },
            },
            {
              tool: 'entity_update',
              input: {
                id: b.entityId,
                body: 'текст б2',
                expectedBodyRevision: b.entity.bodyRevision,
              },
            },
          ],
          { batchId },
        ),
        { sink },
      ),
    );
    // Inverse из двух операций — отмена идёт путём пачки (`executeBatch` во внутреннем режиме), не одиночным
    ok(await undoAction(db, { identity: personal(g), actionId: batchId }));
    const undo = await undoRecordOf(g, batchId);
    expect(undo).toBeDefined();
    expect(undo?.bodyBefore).toEqual({ [a.entityId]: batchId, [b.entityId]: batchId });
    for (const id of [a.entityId, b.entityId]) {
      const row = await rawEntity(id);
      expect([row.body_revision, row.body_action_id]).toEqual([3, undo?.id ?? '']);
    }
  });

  test('сев без журнала (NOOP) оставляет колонку пустой (К-34)', async () => {
    const g = await freshGraph();
    await setupGraph(db, personal(g));
    const rows = (await admin.db.execute(sql`
      SELECT count(*)::int AS total, count(body_action_id)::int AS stamped
        FROM entities WHERE graph_id = ${g}::uuid`)) as unknown as Array<{
      total: number;
      stamped: number;
    }>;
    // Премиса: сев действительно завёл записи — иначе «ни одной с действием» была бы пустотой
    expect(rows[0]?.total).toBeGreaterThan(0);
    expect(rows[0]?.stamped).toBe(0);
  });

  test('писатель вне executor на соединении после объявления получает NULL, а не ошибку (NULLIF)', async () => {
    const g = await freshGraph();
    const n = await createNote(g, 'заметка', 'текст');
    // Одно соединение (пул на одно подключение): транзакция объявила действие и закоммитилась, следующий писатель
    // на ТОМ ЖЕ соединении — вне executor'а (ops-скрипт, перенос тел)
    const one = adminDb();
    try {
      await one.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('orbis.body_action', ${newId()}, true)`);
      });
      // Премиса NULLIF: после COMMIT настройка на этом соединении ОПРЕДЕЛЕНА и пуста (Postgres 17 стенда)
      const setting = (await one.db.execute(
        sql`SELECT current_setting('orbis.body_action', true) AS v`,
      )) as unknown as Array<{ v: string | null }>;
      expect(setting[0]?.v).toBe('');
      await one.db.execute(
        sql`UPDATE entities SET body = 'правка вне приложения' WHERE id = ${n.entityId}::uuid`,
      );
    } finally {
      await one.client.end();
    }
    const row = await rawEntity(n.entityId);
    expect([row.body_revision, row.body_action_id]).toEqual([2, null]);
  });

  test('отмена ставит колонке id своей записи отмены (заведён до применения)', async () => {
    const g = await freshGraph();
    const n = await createNote(g, 'заметка', 'исходный');
    const u = ok(
      await run(g, 'entity_update', {
        id: n.entityId,
        body: 'правка',
        expectedBodyRevision: n.entity.bodyRevision,
      }),
    );
    ok(await undoAction(db, { identity: personal(g), actionId: u.actionId }));
    const undo = await undoRecordOf(g, u.actionId);
    expect(undo).toBeDefined();
    const row = await rawEntity(n.entityId);
    expect([row.body_revision, row.body_action_id]).toEqual([3, undo?.id ?? '']);
    // Запись отмены тоже меняет тело — и хранит «действие тела до» (§8.6, перенос I-2 ревью задачи 5): колонку ДО
    // отмены, то есть отменённую правку
    expect(undo?.bodyBefore).toEqual({ [n.entityId]: u.actionId });
  });

  test('ответ правки несёт bodyRevision и bodyChangedAt (RETURNING)', async () => {
    const g = await freshGraph();
    const n = await createNote(g, 'заметка', 'текст');
    const created = await rawEntity(n.entityId);
    expect(n.entity.bodyRevision).toBe(1);
    expect(n.entity.bodyChangedAt).toBe(created.body_changed_at.toISOString());
    const u = ok(
      await run(g, 'entity_update', {
        id: n.entityId,
        body: 'правка',
        expectedBodyRevision: n.entity.bodyRevision,
      }),
    );
    const e = u.results[0] as WireEntity;
    const row = await rawEntity(n.entityId);
    expect(e.bodyRevision).toBe(2);
    expect(e.bodyChangedAt).toBe(row.body_changed_at.toISOString());
    // Чтение одной записи (`entity.get`) несёт те же поля — с них клиент начинает правку текста
    const read = await withIdentity(db, personal(g), (tx) =>
      readEntity(tx, g, { id: n.entityId, include: ['body'] }),
    );
    expect([read.entity.bodyRevision, read.entity.bodyChangedAt]).toEqual([
      2,
      row.body_changed_at.toISOString(),
    ]);
  });

  test('правка ДОКУМЕНТОМ тела (сохранение редактора, «вернуть версию»): тот же триггер, то же действие', async () => {
    const g = await freshGraph();
    const n = await createNote(g, 'заметка', 'текст');
    const u = ok(
      await run(g, 'entity_update', {
        id: n.entityId,
        bodyDoc: parseBody('текст из редактора'),
        expectedBodyRevision: n.entity.bodyRevision,
      }),
    );
    const row = await rawEntity(n.entityId);
    expect([row.body_revision, row.body_action_id]).toEqual([2, u.actionId]);
    expect((await journalOf(g, u.actionId))?.bodyBefore).toEqual({ [n.entityId]: n.actionId });
  });
});
