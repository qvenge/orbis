// apps/server/src/executor/undo.test.ts
// Интеграционные тесты Task 11: Undo §7.8 — отмена НЕ правит журнал (новое
// запись отмены — строка журнала в треде отменённого), inverse через внутренний режим executor'а
// (LWW-откат body без optimistic-check, восстановление ЗАТРОНУТЫХ СВОЙСТВ — §А7-4),
// повторная отмена, undoLast со сканом с конца, undo связей и batch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { materializeBatchId, newId, recurringInstanceId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  accountOf,
  adminDb,
  appDb,
  executeWithFixtureCategories as execute,
  freshGraph,
  mintGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { actionsOf, journalOf, undoRecordOf, wholeJournalOf } from '../../test/journal-helpers';
import { ensureEntityThread } from '../chat/threads';
import { withIdentity } from '../db/with-identity';
import { materializeInstances } from '../recurring/materialize';
import { makeJournalSink } from './journal';
import type { JournalEntry } from './journal-read';
import type { ExecuteErr, ExecuteOk, ExecuteRequest, ExecuteResult, WireEntity } from './types';
import { undoAction, undoLast } from './undo';

requireEnv();

const { db, client } = appDb();
const sink = makeJournalSink();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function err(r: ExecuteResult): ExecuteErr {
  if (r.ok) throw new Error('ожидался структурированный отказ, получен успех');
  return r;
}

function req(
  user: GraphId,
  tool: string,
  input: unknown,
  over: Partial<ExecuteRequest> = {},
): ExecuteRequest {
  return {
    identity: personal(user),
    actorKind: 'owner',
    source: 'fast_path',
    operations: [{ tool, input }],
    ...over,
  };
}

async function adminRows(query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    return [...(await admin.execute(query))];
  } finally {
    await adminClient.end();
  }
}

async function entityRow(id: string): Promise<Record<string, unknown>> {
  const rows = await adminRows(
    sql`SELECT title, body, props, aspects, tags, archived FROM entities WHERE id = ${id}`,
  );
  const row = rows[0];
  if (!row) throw new Error(`сущность ${id} не найдена`);
  return row;
}

/** Значения свойств строки — новая правда сущности (§А1-1), а не её старая проекция. */
async function propsOf(id: string): Promise<Record<string, unknown>> {
  return (await entityRow(id)).props as Record<string, unknown>;
}

/** Запись журнала по id действия — по ней читается ФОРМА operations/inverse (§А7-4). */
async function actionById(user: GraphId, actionId: string): Promise<JournalEntry> {
  const action = await journalOf(user, actionId);
  if (!action) throw new Error(`действие ${actionId} не найдено в журнале`);
  return action;
}

/** Число записей отмены действия у владельца — повторная отмена второй записи не пишет (§7.8). */
async function undoMessageCount(user: GraphId, actionId: string): Promise<number> {
  return (await wholeJournalOf(user)).filter((e) => e.undoes === actionId).length;
}

/** Число действий в журнале владельца (записи отмены — не действия). */
async function actionMessageCount(user: GraphId): Promise<number> {
  return (await actionsOf(user)).length;
}

async function relCount(sourceId: string, targetId: string, role: string): Promise<number> {
  const rows = await adminRows(
    sql`SELECT count(*)::int AS n FROM relations
        WHERE source_id = ${sourceId} AND target_id = ${targetId} AND role = ${role}`,
  );
  return rows[0]?.n as number;
}

describe('undoAction: создание → архивация (§7.8)', () => {
  const user = mintGraph();
  let actionId = '';
  let entityId = '';

  test('undo entity_create архивирует сущность и пишет запись отмены; нового action не порождает', async () => {
    const r = ok(
      await execute(db, req(user, 'entity_create', { title: 'Отменяемая', tags: [] }), { sink }),
    );
    actionId = r.actionId;
    entityId = (r.results[0] as WireEntity).id;
    const actionsBefore = await actionMessageCount(user);

    const u = ok(await undoAction(db, { identity: personal(user), actionId }));
    // Ответ отмены — `UndoResult` (задача 10 плана А): id ЗАПИСИ ОТМЕНЫ, отменённое — в `undone`
    expect(u.actionId).toBe((await undoRecordOf(user, actionId))?.id as string);

    const row = await entityRow(entityId);
    expect(row.archived).toBe(true); // создание → архивация (жёсткого удаления нет)
    expect(await undoMessageCount(user, actionId)).toBe(1);
    // undo НЕ порождает нового action (undo неотменяем): журнал действий не вырос
    expect(await actionMessageCount(user)).toBe(actionsBefore);
  });

  test('повторный undo того же action → VALIDATION «уже отменено»', async () => {
    const again = err(await undoAction(db, { identity: personal(user), actionId }));
    expect(again.error.code).toBe('VALIDATION');
    expect(again.error.message).toContain('уже отменено');
    expect(await undoMessageCount(user, actionId)).toBe(1); // второй записи отмены нет
  });

  test('чужой action под userB → NOT_FOUND (RLS скоупит журнал владельцем)', async () => {
    const userB = await freshGraph();
    const r = err(await undoAction(db, { identity: personal(userB), actionId }));
    expect(r.error.code).toBe('NOT_FOUND');
  });
});

/**
 * Единица отката — СВОЙСТВО (§А7-4). До реформы inverse нёс прежнее значение всего
 * аспект-ключа, и отмена правки статуса возвращала `orbis/task` целиком: правку соседнего
 * поля, легшую позже, откат уносил заодно. Здесь это и проверяется — и на форме записи
 * журнала, и на итоговой строке.
 */
describe('undoAction: entity_update — LWW-откат по СВОЙСТВУ (§7.8, §А7-4)', () => {
  const T = new Date('2026-08-26T10:00:00.000Z');

  test('inverse несёт прежние значения ТОЛЬКО затронутых свойств; третье свойство аспекта переживает откат', async () => {
    const user = await freshGraph();
    const created = ok(
      await execute(
        db,
        req(
          user,
          'entity_create',
          {
            title: 'Старый',
            tags: [],
            body: 'v1',
            props: {
              'orbis/task_status': 'inbox',
              'orbis/priority': 'low',
              'orbis/due_date': '2026-07-01',
            },
            aspects: ['orbis/task'],
          },
          { clock: () => T },
        ),
        { sink },
      ),
    );
    const e = created.results[0] as WireEntity;

    // Правка ДВУХ свойств одного аспекта: третьего (due_date) патч не касается вовсе,
    // а completed_at дописывает правило каталога `task_completed_at` (§3.2) — и оно обязано
    // попасть в откат
    const updated = ok(
      await execute(
        db,
        req(
          user,
          'entity_update',
          {
            id: e.id,
            title: 'Новый',
            body: 'v2',
            expectedBodyRevision: e.bodyRevision,
            props: { 'orbis/task_status': 'done', 'orbis/priority': 'high' },
            aspects: { attach: ['orbis/task'] },
          },
          { clock: () => T },
        ),
        { sink },
      ),
    );
    const undoTarget = updated.actionId;

    // Форма записи: единица — свойство по id, старой карты в полезной нагрузке нет
    const action = await actionById(user, undoTarget);
    expect(action.operations).toEqual([
      {
        op: 'entity_update',
        payload: {
          id: e.id,
          title: 'Новый',
          body: 'v2',
          props: {
            'orbis/task_status': 'done',
            'orbis/priority': 'high',
            // Штамп записи, а не `clock()` (Р-И-3): правка в тот же тик, что create, — `T+1ms` (§5.2).
            'orbis/completed_at': (updated.results[0] as WireEntity).updatedAt,
          },
        },
      },
    ]);
    expect(action.inverse).toEqual([
      {
        op: 'entity_update',
        payload: {
          id: e.id,
          title: 'Старый',
          body: 'v1',
          props: { 'orbis/priority': 'low', 'orbis/task_status': 'inbox' },
          // completed_at до операции не было — откат его СНИМАЕТ, а не восстанавливает
          unset: ['orbis/completed_at'],
        },
      },
    ]);

    // Правка соседнего свойства ПОСЛЕ отменяемого действия — то, что старая единица
    // отката (весь аспект-ключ) уносила молча. Она же двигает updated_at вперёд:
    // inverse с body упёрся бы в §5.2, если бы не внутренний режим
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: e.id,
          props: { 'orbis/due_date': '2026-09-09' },
          aspects: { attach: ['orbis/task'] },
        }),
        { sink },
      ),
    );

    const u = ok(await undoAction(db, { identity: personal(user), actionId: undoTarget }));
    expect(u.actionId).toBe((await undoRecordOf(user, undoTarget))?.id as string);

    const row = await entityRow(e.id);
    expect(row.title).toBe('Старый');
    expect(row.body).toBe('v1'); // восстановлен несмотря на изменившийся updated_at
    const props = row.props as Record<string, unknown>;
    expect(props['orbis/task_status']).toBe('inbox');
    expect(props['orbis/priority']).toBe('low');
    // Снято, а не восстановлено: до операции свойства не было
    expect(Object.hasOwn(props, 'orbis/completed_at')).toBe(false);
    // ДЕЛИВЕРЕБЛ §А7-4: чужая правка третьего свойства ПЕРЕЖИЛА откат
    expect(props['orbis/due_date']).toBe('2026-09-09');
    expect(row.aspects).toEqual(['orbis/task']);
    // поле вне свойств, не затронутое отменяемым действием, тоже не откатывается
    expect(row.tags).toEqual([]);
  });

  test('attach аспекта: inverse = detach + unset ровно добавленных свойств; чужие значения остаются', async () => {
    const user = await freshGraph();
    const created = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Заметка',
          tags: [],
          props: { 'orbis/pinned': true },
          aspects: ['orbis/note'],
        }),
        { sink },
      ),
    );
    const e = created.results[0] as WireEntity;

    const attached = ok(
      await execute(
        db,
        req(
          user,
          'attach_orbis_task',
          { entity_id: e.id, data: { 'orbis/task_status': 'planned', 'orbis/priority': 'high' } },
          { clock: () => T },
        ),
        { sink },
      ),
    );

    const action = await actionById(user, attached.actionId);
    expect(action.operations).toEqual([
      {
        op: 'attach_orbis_task',
        payload: {
          entity_id: e.id,
          props: { 'orbis/priority': 'high', 'orbis/task_status': 'planned' },
          aspects: { attach: ['orbis/task'] },
        },
      },
    ]);
    expect(action.inverse).toEqual([
      {
        op: 'entity_update',
        payload: {
          id: e.id,
          unset: ['orbis/priority', 'orbis/task_status'],
          aspects: { detach: ['orbis/task'] },
        },
      },
    ]);

    ok(await undoAction(db, { identity: personal(user), actionId: attached.actionId }));
    const row = await entityRow(e.id);
    expect(row.aspects).toEqual(['orbis/note']);
    // Значение, существовавшее ДО attach, откат не трогает
    expect(row.props).toEqual({ 'orbis/pinned': true });
  });

  test('слитое свойство orbis/finance_category: одна правка — оба носителя, откат возвращает значение', async () => {
    const user = await freshGraph();
    const catA = newId();
    const catB = newId();
    const created = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Транзакция-конверт',
          tags: [],
          props: {
            'orbis/amount': '340.00',
            'orbis/currency': 'RUB',
            'orbis/direction': 'expense',
            'orbis/finance_category': catA,
            'orbis/occurred_on': '2026-08-26',
            'orbis/limit': '1000.00',
            'orbis/period_start': '2026-11-01',
            'orbis/period_end': '2026-11-30',
          },
          aspects: ['orbis/financial', 'orbis/budget'],
        }),
        { sink },
      ),
    );
    const e = created.results[0] as WireEntity;

    const updated = ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: e.id,
          props: { 'orbis/finance_category': catB },
          aspects: { attach: ['orbis/financial'] },
        }),
        { sink },
      ),
    );
    // Одно свойство в журнале — при том, что старая карта поменялась у ДВУХ ключей (В1)
    const action = await actionById(user, updated.actionId);
    expect(action.operations[0]?.payload).toEqual({
      id: e.id,
      props: { 'orbis/finance_category': catB },
    });
    expect(action.inverse[0]?.payload).toEqual({
      id: e.id,
      props: { 'orbis/finance_category': catA },
    });
    // Свойство ОДНО на двух носителей (§А8/В1): и правка, и откат двигают одно значение,
    // а не две половины, которые могли бы разъехаться.
    const afterUpdate = (await entityRow(e.id)).props as Record<string, unknown>;
    expect(afterUpdate['orbis/finance_category']).toBe(catB);
    expect((await entityRow(e.id)).aspects).toEqual(['orbis/financial', 'orbis/budget']);

    ok(await undoAction(db, { identity: personal(user), actionId: updated.actionId }));
    const back = (await entityRow(e.id)).props as Record<string, unknown>;
    expect(back['orbis/finance_category']).toBe(catA);
  });

  test('материализованное умолчание валюты снимается откатом: шов слитого orbis/currency закрыт', async () => {
    const user = await freshGraph();
    const cat = newId();
    // Транзакция БЕЗ валюты: у financial поле необязательно, умолчание не материализуется
    const created = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Расход без валюты',
          tags: [],
          props: {
            'orbis/amount': '340.00',
            'orbis/direction': 'expense',
            'orbis/finance_category': cat,
            'orbis/occurred_on': '2026-08-26',
          },
          aspects: ['orbis/financial'],
        }),
        { sink },
      ),
    );
    const e = created.results[0] as WireEntity;
    expect(Object.hasOwn(await propsOf(e.id), 'orbis/currency')).toBe(false);

    // Аспект конверта навешивается НОВОЙ формой и БЕЗ валюты: категория у него уже есть
    // (слитое свойство), поэтому патч не касается ни одного свойства financial — ровно тот
    // угол, в котором прежний inverse (по аспект-ключам) не нёс financial-половину
    const updated = ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: e.id,
          props: {
            'orbis/limit': '1000.00',
            // Период вне даты транзакции — чтобы бюджет-хук не связал запись с самой собой
            'orbis/period_start': '2026-11-01',
            'orbis/period_end': '2026-11-30',
          },
          aspects: { attach: ['orbis/budget'] },
        }),
        { sink },
      ),
    );
    const materialized = await propsOf(e.id);
    expect(typeof materialized['orbis/currency']).toBe('string'); // умолчание владельца легло

    ok(await undoAction(db, { identity: personal(user), actionId: updated.actionId }));
    const props = await propsOf(e.id);
    // ШОВ: до операции валюты не было — после отката её тоже нет
    expect(Object.hasOwn(props, 'orbis/currency')).toBe(false);
    expect(Object.hasOwn(props, 'orbis/limit')).toBe(false);
    expect((await entityRow(e.id)).aspects).toEqual(['orbis/financial']);
  });
});

describe('undoAction: связи и batch (§7.8)', () => {
  test('undo relation_create удаляет связь', async () => {
    const user = await freshGraph();
    const s = ok(
      await execute(db, req(user, 'entity_create', { title: 'Источник', tags: [] }), { sink }),
    ).results[0] as WireEntity;
    const t = ok(
      await execute(db, req(user, 'entity_create', { title: 'Цель', tags: [] }), { sink }),
    ).results[0] as WireEntity;
    const rel = ok(
      await execute(
        db,
        req(user, 'relation_create', {
          source_id: s.id,
          target_id: t.id,
          role: 'mention',
        }),
        { sink },
      ),
    );
    expect(await relCount(s.id, t.id, 'mention')).toBe(1);

    ok(await undoAction(db, { identity: personal(user), actionId: rel.actionId }));
    expect(await relCount(s.id, t.id, 'mention')).toBe(0);
    expect(await undoMessageCount(user, rel.actionId)).toBe(1);
  });

  test('undo batch применяет inverse в обратном порядке одним tx: связь удалена, сущности архивированы', async () => {
    const user = await freshGraph();
    const batchId = newId();
    const sId = newId();
    const tId = newId();
    const r = ok(
      await execute(
        db,
        {
          identity: personal(user),
          actorKind: 'owner',
          source: 'chat',
          batchId,
          operations: [
            { tool: 'entity_create', input: { id: sId, title: 'Пакет-А', tags: [] } },
            { tool: 'entity_create', input: { id: tId, title: 'Пакет-Б', tags: [] } },
            {
              tool: 'relation_create',
              input: { source_id: sId, target_id: tId, role: 'mention' },
            },
          ],
        },
        { sink },
      ),
    );
    expect(r.actionId).toBe(batchId);

    const u = ok(await undoAction(db, { identity: personal(user), actionId: batchId }));
    expect(u.actionId).toBe((await undoRecordOf(user, batchId))?.id as string);
    expect(await relCount(sId, tId, 'mention')).toBe(0);
    expect((await entityRow(sId)).archived).toBe(true);
    expect((await entityRow(tId)).archived).toBe(true);
    expect(await undoMessageCount(user, batchId)).toBe(1);
  });

  test('undo attach восстанавливает прежнее отсутствие аспект-ключа (null → detach)', async () => {
    const user = await freshGraph();
    const e = ok(
      await execute(db, req(user, 'entity_create', { title: 'Без аспекта', tags: [] }), { sink }),
    ).results[0] as WireEntity;
    const attach = ok(
      await execute(
        db,
        req(user, 'attach_orbis_task', { entity_id: e.id, data: { 'orbis/task_status': 'inbox' } }),
        { sink },
      ),
    );
    ok(await undoAction(db, { identity: personal(user), actionId: attach.actionId }));
    const row = await entityRow(e.id);
    // Аспекта до attach не было — откат снимает его целиком, значений не остаётся.
    expect(row.aspects).toEqual([]);
    expect(row.props).toEqual({});
  });
});

describe('undoLast: скан журнала с конца (§7.8)', () => {
  test('пропускает уже отменённое и undo-записи, применяет inverse первого неотменённого', async () => {
    const user = await freshGraph();
    const r1 = ok(
      await execute(db, req(user, 'entity_create', { title: 'Первая', tags: [] }), { sink }),
    );
    const e1 = r1.results[0] as WireEntity;
    const r2 = ok(
      await execute(db, req(user, 'entity_create', { title: 'Вторая', tags: [] }), { sink }),
    );
    const e2 = r2.results[0] as WireEntity;

    // последнее действие отменяем явно — его запись отмены станет последней строкой журнала
    ok(await undoAction(db, { identity: personal(user), actionId: r2.actionId }));
    expect((await entityRow(e2.id)).archived).toBe(true);

    // undoLast: пропускает undo-запись (не action) и отменённое r2 → отменяет r1
    const u = ok(await undoLast(db, { identity: personal(user) }));
    expect(u.actionId).toBe(r1.actionId);
    expect((await entityRow(e1.id)).archived).toBe(true);

    // всё отменено → структурированный отказ
    const none = err(await undoLast(db, { identity: personal(user) }));
    expect(none.error.code).toBe('NOT_FOUND');
  });

  test('«отмени последнее» пропускает системные действия (source=system): откатывается fast-path, инстансы живы (fix round A3)', async () => {
    const user = await freshGraph();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
      new Date(),
    );
    // Действие владельца: «обед 340» здесь — создание recurring-шаблона (fast_path)
    const rTpl = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Шаблон с материализацией',
          tags: [],
          props: {
            'orbis/start_at': `${today}T09:00:00+03:00`,
            'orbis/timezone': 'Europe/Moscow',
            'orbis/recurrence': { freq: 'daily', interval: 1 },
          },
          aspects: ['orbis/schedule'],
        }),
        { sink },
      ),
    );
    const tpl = rTpl.results[0] as WireEntity;

    // Между действием владельца и его отменой случилась системная материализация
    // (§5.4) — её batch-audit стал ПОСЛЕДНИМ action'ом журнала
    const m = await materializeInstances({
      db,
      identity: personal(user),
      from: today,
      to: today,
      today,
    });
    expect(m.created).toBe(1);
    const instanceId = recurringInstanceId(tpl.id, today);

    // «последнее» = последнее ВИДИМОЕ пользователю действие: системный batch
    // пропускается, откатывается создание шаблона; инстансы не архивируются молча
    const u = ok(await undoLast(db, { identity: personal(user) }));
    expect(u.actionId).toBe(rTpl.actionId);
    expect((await entityRow(tpl.id)).archived).toBe(true); // отменён именно fast_path
    expect((await entityRow(instanceId)).archived).toBe(false); // инстанс жив

    // Точечный undo по action_id системного batch остаётся возможным (§2.8, путь A5):
    // id action'а batch = его детерминированный batch_id (materializeBatchId)
    ok(
      await undoAction(db, {
        identity: personal(user),
        actionId: materializeBatchId(tpl.id, today, today),
      }),
    );
    expect((await entityRow(instanceId)).archived).toBe(true);
  });
});

// Запись отмены — строка журнала (спека скорости §11.2, РП-11, К-45): актор — кто отменил (владелец), источник — путь
// отмены, тред — тред отменённого, операции — применённый inverse (аудит), своего inverse нет (отмена неотменяема).
describe('запись отмены — строка журнала type undo (РП-11, К-45)', () => {
  test('отмена → строка type undo: undoes, источник — путь (ui у кнопки), актор — владелец, тред отменённого, inverse []', async () => {
    const user = await freshGraph();
    const created = ok(
      await execute(db, req(user, 'entity_create', { title: 'Носитель', tags: [] }), { sink }),
    );
    const e = created.results[0] as WireEntity;
    const thread = await withIdentity(db, personal(user), (tx) =>
      ensureEntityThread(tx, user, e.id),
    );
    // Правка — в треде записи: тред записи отмены обязан быть ТРЕДОМ ОТМЕНЁННОГО, а не глобальным
    const upd = ok(
      await execute(
        db,
        req(user, 'entity_update', { id: e.id, title: 'Правка' }, { threadId: thread }),
        {
          sink,
        },
      ),
    );
    const undone = await actionById(user, upd.actionId);
    ok(await undoAction(db, { identity: personal(user), actionId: upd.actionId }));

    const rec = await undoRecordOf(user, upd.actionId);
    if (rec === undefined) throw new Error('записи отмены нет');
    expect(rec.type).toBe('undo');
    expect(rec.undoes).toBe(upd.actionId);
    expect(rec.source).toBe('ui'); // путь по умолчанию — кнопка владельца (`ai.undo`)
    expect(rec.actorKind).toBe('owner');
    expect(rec.actorUserId).toBe(accountOf(user));
    expect(rec.mechanism).toBe('user');
    expect(rec.threadId).toBe(thread);
    expect(rec.title).toBe(`Отменено: ${undone.title}`);
    expect(rec.cardTool).toBe('undo');
    // Операции — применённый inverse (аудит), свой inverse пуст: отмена неотменяема (§0.2 п. 7)
    expect(rec.operations).toEqual(undone.inverse);
    expect(rec.inverse).toEqual([]);
    expect(rec.entityIds).toEqual(undone.entityIds);
    // Запись отмены — не действие (К-22): журнал действий не вырос
    expect((await actionsOf(user)).map((a) => a.id)).toEqual([created.actionId, upd.actionId]);
  });

  test('путь отмены — полем записи: «отмени последнее» из чата пишет source chat, исполнение при этом — system', async () => {
    const user = await freshGraph();
    const created = ok(
      await execute(db, req(user, 'entity_create', { title: 'Из чата отменю', tags: [] }), {
        sink,
      }),
    );
    ok(
      await undoAction(db, { identity: personal(user), actionId: created.actionId, path: 'chat' }),
    );
    expect((await undoRecordOf(user, created.actionId))?.source).toBe('chat');
  });

  test('id записи отмены заведён ДО применения: исполнитель пишет строку ровно с InternalUndoMode.undoRecordId', async () => {
    const user = await freshGraph();
    const created = ok(
      await execute(db, req(user, 'entity_create', { title: 'Отменю руками', tags: [] }), { sink }),
    );
    const undoing = await actionById(user, created.actionId);
    const undoRecordId = newId();
    let applied = false;
    ok(
      await execute(
        db,
        {
          identity: personal(user),
          actorKind: 'owner',
          source: 'system',
          operations: undoing.inverse.map((iv) => ({ tool: iv.op, input: iv.payload })),
        },
        {
          sink,
          internalUndo: {
            undoRecordId,
            undoing,
            path: 'ui',
            force: false,
            pinned: new Set(),
            continuation: { kind: 'none' },
            async onApplied() {
              applied = true;
            },
          },
        },
      ),
    );
    expect(applied).toBe(true);
    expect((await undoRecordOf(user, created.actionId))?.id).toBe(undoRecordId);
  });

  // Перепроверка «уже отменено» в транзакции применения (`onApplied`) ловит последовательный повтор и дождавшегося
  // конкурента; уникальность (graph_id, undoes) — последний рубеж, и отказ по ней — тот же VALIDATION, а не сырой 23505.
  test('повторная отмена мимо перепроверки → VALIDATION already_undone по уникальности (graph_id, undoes), вторая строка не легла', async () => {
    const user = await freshGraph();
    const created = ok(
      await execute(db, req(user, 'entity_create', { title: 'Дважды', tags: [] }), { sink }),
    );
    const undoing = await actionById(user, created.actionId);
    const run = () =>
      execute(
        db,
        {
          identity: personal(user),
          actorKind: 'owner',
          source: 'system',
          operations: undoing.inverse.map((iv) => ({ tool: iv.op, input: iv.payload })),
        },
        {
          sink,
          // Перепроверки нет намеренно: так выглядит гонка, в которой обе транзакции прошли её до чужого коммита
          internalUndo: {
            undoRecordId: newId(),
            undoing,
            path: 'ui',
            force: false,
            pinned: new Set(),
            continuation: { kind: 'none' },
            onApplied: async () => {},
          },
        },
      );
    ok(await run());
    const again = err(await run());
    expect(again.error.code).toBe('VALIDATION');
    expect(again.error.details).toEqual({ actionId: created.actionId, reason: 'already_undone' });
    expect(await undoMessageCount(user, created.actionId)).toBe(1);
  });
});
