// apps/server/src/executor/text-session.test.ts
// Сеанс правки текста (спека скорости §8.5, §13.1; Р-11, К-13, К-14, К-34; план А задача 9): автосохранения
// редактора владельца (`entity.update` с `autosave: true`) складываются в ОДНУ запись журнала, пока паузы набора
// короче 10 минут и текущий текст дал этот же сеанс; любая другая запись, давшая тело, сеанс закрывает.
//
// ВРЕМЯ. Колонку `body_changed_at` ставит триггер часами БАЗЫ (`clock_timestamp()`, 0026), а время записи журнала —
// `now()` транзакции; часы запроса их не двигают, и роутер часов не принимает. Поэтому «прошло N минут» здесь —
// сдвиг отметок графа назад под админом (`elapse`): и времени изменения тела, и времени записей журнала — как будто
// всё случилось на N минут раньше. Точные «14:02–14:18» для подписей — прямой установкой отметок (`placeAt`) ПОСЛЕ
// того, как сеанс честно сложился по сдвигам. Журнал читается только помощниками и API журнала.
import { afterAll, describe, expect, test } from 'bun:test';
import {
  APP_ASPECT,
  APP_NAV,
  type GraphId,
  HOME_PROPERTY,
  newId,
  PAGE_ASPECT,
} from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import { SUPPLY_KEYS } from '@orbis/shared/supply';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import {
  accountOf,
  addMember,
  adminDb,
  appDb,
  freshGraph,
  personal,
  requireEnv,
} from '../../test/helpers';
import { actionsOf, journalOf, undoRecordOf } from '../../test/journal-helpers';
import { ensureGlobalThread } from '../chat/threads';
import { withIdentity } from '../db/with-identity';
import { type Identity, identityOfGrant } from '../identity';
import { buildContext, OWNER_EDITS_HEADING } from '../llm/context';
import { effectiveRegistry } from '../registry/cache';
import { appRouter } from '../router';
import { revertToEtalon } from '../supply/mechanism';
import { supplyCreateOps, supplyRecordId } from '../supply/records';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';
import { execute } from './executor';
import { makeJournalSink } from './journal';
import * as J from './journal-read';
import { assertNothingAppended, SESSION_PAUSE_MS, sessionSpan } from './text-session';
import type { ExecuteResult } from './types';
import { undoAction } from './undo';

requireEnv();

const { db, client } = appDb();
const admin = adminDb();
const sink = makeJournalSink();
const createCaller = createCallerFactory(appRouter);

afterAll(async () => {
  await client.end();
  await admin.client.end();
});

type Caller = ReturnType<typeof createCaller>;

function callerFor(g: GraphId, identity: Identity = personal(g)): Caller {
  return createCaller({ identity, actorKind: 'owner', db, clientVersion: null });
}

function ok(r: ExecuteResult): Extract<ExecuteResult, { ok: true }> {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

const codeOf = (e: TRPCError): string | undefined =>
  (e.cause as { code?: string } | undefined)?.code;

/** Запись владельца без журнала (сев с пустым синком): колонка тела пуста (К-34), журнал графа чист для проверок. */
async function seedNote(
  g: GraphId,
  title: string,
  body: string,
  aspects: string[] = [],
  props: Record<string, unknown> = {},
): Promise<string> {
  const id = newId();
  ok(
    await execute(db, {
      identity: personal(g),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_create', input: { id, title, tags: [], body, aspects, props } }],
    }),
  );
  return id;
}

interface BodyColumns {
  body: string;
  body_revision: number;
  body_action_id: string | null;
  body_changed_at: Date;
}

/** Колонки тела — сырым SELECT'ом под админом: их пишет триггер, проверять их надо мимо кода чтения. */
async function rawEntity(id: string): Promise<BodyColumns> {
  const rows = (await admin.db.execute(sql`
    SELECT body, body_revision, body_action_id::text AS body_action_id, body_changed_at
      FROM entities WHERE id = ${id}::uuid`)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (row === undefined) throw new Error(`записи ${id} нет`);
  return {
    body: row.body as string,
    body_revision: row.body_revision as number,
    body_action_id: (row.body_action_id as string | null) ?? null,
    body_changed_at: new Date(String(row.body_changed_at)),
  };
}

/**
 * «Прошло N минут»: отметки графа — время изменения тела записей и время записей журнала (с боковой таблицей) —
 * сдвигаются на N минут назад. Триггер тела столбцовый (`UPDATE OF body, body_doc`), правка одной отметки его не будит.
 */
async function elapse(g: GraphId, minutes: number): Promise<void> {
  const ms = Math.round(minutes * 60_000);
  const shift = sql`(${ms}::int * interval '1 millisecond')`;
  await admin.db.execute(
    sql`UPDATE entities SET body_changed_at = body_changed_at - ${shift} WHERE graph_id = ${g}::uuid`,
  );
  await admin.db.execute(
    sql`UPDATE action_journal SET created_at = created_at - ${shift} WHERE graph_id = ${g}::uuid`,
  );
  await admin.db.execute(
    sql`UPDATE action_journal_entities SET created_at = created_at - ${shift} WHERE graph_id = ${g}::uuid`,
  );
}

/** Точные отметки для подписей: время записей журнала и время изменения тела записей. */
async function placeAt(
  g: GraphId,
  at: { journal?: Record<string, Date>; bodyChangedAt?: Record<string, Date> },
): Promise<void> {
  for (const [id, when] of Object.entries(at.journal ?? {})) {
    await admin.db.execute(
      sql`UPDATE action_journal SET created_at = ${when.toISOString()}::timestamptz
           WHERE graph_id = ${g}::uuid AND id = ${id}::uuid`,
    );
  }
  for (const [id, when] of Object.entries(at.bodyChangedAt ?? {})) {
    await admin.db.execute(
      sql`UPDATE entities SET body_changed_at = ${when.toISOString()}::timestamptz WHERE id = ${id}::uuid`,
    );
  }
}

/** Редактор владельца на одной записи: автосохранения через роутер, ревизия — из ответа (как у `useBodySave`). */
class Editor {
  constructor(
    readonly caller: Caller,
    readonly id: string,
    public rev: number,
  ) {}

  static async open(caller: Caller, id: string): Promise<Editor> {
    return new Editor(caller, id, (await rawEntity(id)).body_revision);
  }

  async save(body: string): Promise<void> {
    const r = await this.caller.entity.update({
      id: this.id,
      body,
      expectedBodyRevision: this.rev,
      autosave: true,
    });
    this.rev = r.bodyRevision;
  }

  /** Сохранение ДОКУМЕНТОМ — форма настоящего редактора. */
  async saveDoc(markdown: string): Promise<void> {
    const r = await this.caller.entity.update({
      id: this.id,
      bodyDoc: parseBody(markdown) as never,
      expectedBodyRevision: this.rev,
      autosave: true,
    });
    this.rev = r.bodyRevision;
  }

  /** Перечитать ревизию после чужой правки (клиент получает её перечитыванием записи). */
  async reload(): Promise<void> {
    this.rev = (await rawEntity(this.id)).body_revision;
  }
}

async function sessionsOf(g: GraphId): Promise<J.JournalEntry[]> {
  return (await actionsOf(g)).filter((e) => e.textSession);
}

/** Единственная запись сеанса графа (ошибка, если их не одна). */
async function onlySession(g: GraphId): Promise<J.JournalEntry> {
  const sessions = await sessionsOf(g);
  expect(sessions).toHaveLength(1);
  return sessions[0] as J.JournalEntry;
}

function agentCtx(g: GraphId) {
  return {
    db,
    identity: personal(g),
    actorKind: 'agent' as const,
    source: 'mcp' as const,
    explicitCommand: false,
  };
}

function chatCtx(g: GraphId) {
  return {
    db,
    identity: personal(g),
    actorKind: 'ai' as const,
    source: 'chat' as const,
    explicitCommand: false,
  };
}

describe('сеанс правки текста (§8.5): продолжение', () => {
  test('(а) автосохранения с паузами < 10 мин — одна запись text_session; пауза — от последнего изменения, а не от начала', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'Заметка', 'исходный текст');
    const ed = await Editor.open(callerFor(g), id);

    await ed.save('первое');
    const s = await onlySession(g);
    expect((await rawEntity(id)).body_action_id).toBe(s.id);

    // Пауза 2 минуты — продолжение: новой записи нет, колонка — тот же сеанс (К-34), ревизия растёт
    await elapse(g, 2);
    await ed.saveDoc('второе');
    expect((await onlySession(g)).id).toBe(s.id);
    const row = await rawEntity(id);
    expect([row.body_action_id, row.body_revision, row.body]).toEqual([s.id, 3, 'второе']);

    // Ещё три паузы по 3 минуты: сеанс длится уже 11 минут, но каждая пауза короче 10 — запись всё та же
    for (const text of ['третье', 'четвёртое', 'пятое']) {
      await elapse(g, 3);
      await ed.save(text);
    }
    expect((await onlySession(g)).id).toBe(s.id);
    expect((await actionsOf(g)).map((e) => e.id)).toEqual([s.id]);
    expect(await rawEntity(id)).toMatchObject({ body_action_id: s.id, body: 'пятое' });

    // Ответ продолжения — id сеанса (§8.2): исполнитель с запросом, который строит роутер
    const r = ok(
      await execute(
        db,
        {
          identity: personal(g),
          actorKind: 'owner',
          source: 'ui',
          textSession: true,
          operations: [
            {
              tool: 'entity_update',
              input: { id, body: 'шестое', expectedBodyRevision: ed.rev },
            },
          ],
        },
        { sink },
      ),
    );
    expect(r.actionId).toBe(s.id);
    expect((await actionsOf(g)).map((e) => e.id)).toEqual([s.id]);
  });

  test('(б) пауза ≥ 10 минут — новая запись; её «действие тела до» — прошлый сеанс', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'Заметка', 'исходный текст');
    const ed = await Editor.open(callerFor(g), id);
    await ed.save('первое');
    await elapse(g, 9);
    await ed.save('второе');
    const s1 = await onlySession(g);

    await elapse(g, SESSION_PAUSE_MS / 60_000); // ровно 10 минут — уже не пауза набора
    await ed.save('третье');
    const sessions = await sessionsOf(g);
    expect(sessions.map((e) => e.id)[0]).toBe(s1.id);
    expect(sessions).toHaveLength(2);
    const s2 = sessions[1] as J.JournalEntry;
    expect((await rawEntity(id)).body_action_id).toBe(s2.id);
    expect(s2.bodyBefore).toEqual({ [id]: s1.id });
    // «До» нового сеанса — текст, которым закончился прошлый
    expect(s2.inverse).toEqual([{ op: 'entity_update', payload: { id, body: 'второе' } }]);

    await elapse(g, 11);
    await ed.save('четвёртое');
    expect(await sessionsOf(g)).toHaveLength(3);
  });

  test('(в) правка тела агентом между сохранениями — следующее автосохранение открывает новую запись; сеанс другого человека в том же графе не продолжается', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'Заметка', 'исходный текст');
    const ed = await Editor.open(callerFor(g), id);
    await ed.save('владелец');
    const s1 = await onlySession(g);

    const agent = await dispatchTool(agentCtx(g), 'entity_update', {
      id,
      body: 'агент дописал',
      expectedBodyRevision: ed.rev,
    });
    if (agent.status !== 'ok') throw new Error(`агент: ${JSON.stringify(agent)}`);
    const byAgent = (await actionsOf(g)).find((e) => e.actorKind === 'agent');
    expect(byAgent?.textSession).toBe(false);
    expect((await rawEntity(id)).body_action_id).toBe(byAgent?.id ?? '');

    await ed.reload();
    await ed.save('владелец поверх агента');
    const sessions = await sessionsOf(g);
    expect(sessions).toHaveLength(2);
    const s2 = sessions[1] as J.JournalEntry;
    expect(s2.id).not.toBe(s1.id);
    expect(s2.bodyBefore).toEqual({ [id]: byAgent?.id ?? '' });
    expect((await rawEntity(id)).body_action_id).toBe(s2.id);

    // Другой человек в том же графе (грант оператора): его автосохранение — его сеанс, и владелец его не продолжает
    const other = await freshGraph();
    await addMember(g, accountOf(other), 'operator');
    const edOther = await Editor.open(
      callerFor(g, identityOfGrant({ accountId: accountOf(other), graphId: g })),
      id,
    );
    await edOther.save('второй человек');
    const theirs = (await sessionsOf(g)).find((e) => e.actorUserId === accountOf(other));
    expect(theirs).toBeDefined();
    expect((await rawEntity(id)).body_action_id).toBe(theirs?.id ?? '');

    await ed.reload();
    await ed.save('владелец снова');
    const last = (await sessionsOf(g)).at(-1);
    expect(last?.actorUserId).toBe(accountOf(g));
    expect(last?.id).not.toBe(theirs?.id);
    expect(await sessionsOf(g)).toHaveLength(4);
  });

  test('(г) слияние свойства, переписавшее тело держателя, закрывает сеанс', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const property = async (key: string): Promise<string> =>
      (
        ok(
          await execute(
            db,
            {
              identity: personal(g),
              actorKind: 'owner',
              source: 'ui',
              operations: [
                {
                  tool: 'property_create',
                  input: {
                    key,
                    label: { ru: key },
                    description: { ru: 'поле слияния' },
                    type: { kind: 'number' },
                    status: 'active',
                  },
                },
              ],
            },
            { sink },
          ),
        ).results[0] as { property: string }
      ).property;
    const sourceId = await property('user/effort');
    const intoId = await property('user/energy');
    const id = await seedNote(g, 'Смарт-лист', 'Список');
    const ed = await Editor.open(caller, id);
    await ed.save('Список\n\n{{query: aspect=orbis/task, user/effort=5}}');
    const s1 = await onlySession(g);

    const merged = ok(
      await execute(
        db,
        {
          identity: personal(g),
          actorKind: 'owner',
          source: 'ui',
          operations: [{ tool: 'property_merge', input: { source: sourceId, into: intoId } }],
        },
        { sink },
      ),
    );
    expect((await rawEntity(id)).body_action_id).toBe(merged.actionId);

    await ed.reload();
    await ed.save('Список дописан\n\n{{query: aspect=orbis/task, user/energy=5}}');
    const sessions = await sessionsOf(g);
    expect(sessions.map((e) => e.id)).toEqual([s1.id, expect.any(String)]);
    expect(sessions[1]?.bodyBefore).toEqual({ [id]: merged.actionId });
  });

  test('(д) жест с телом внутри сеанса («Сделать страницей», пачка) — своя запись; следующее автосохранение — новый сеанс', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const id = await seedNote(g, 'Заметка', 'исходный текст');
    const ed = await Editor.open(caller, id);
    await ed.save('набор');
    const s1 = await onlySession(g);

    const gesture = await caller.entity.updateBatch({
      label: 'Сделать страницей',
      operations: [
        {
          tool: 'entity_update',
          input: {
            id,
            expectedBodyRevision: ed.rev,
            body: 'набор страницы',
            aspects: { attach: [PAGE_ASPECT] },
          },
        },
      ],
    });
    const batch = await journalOf(g, gesture.actionId);
    expect(batch?.textSession).toBe(false);
    expect((await rawEntity(id)).body_action_id).toBe(gesture.actionId);

    await ed.reload();
    await ed.save('набор после жеста');
    const sessions = await sessionsOf(g);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.id).toBe(s1.id);
    expect(sessions[1]?.bodyBefore).toEqual({ [id]: gesture.actionId });
  });

  test('(е) закрепление версии тела не трогает и сеанс не закрывает; восстановление версии — закрывает', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const id = await seedNote(g, 'Заметка', 'исходный текст');
    const ed = await Editor.open(caller, id);
    await ed.save('первая редакция');
    const s1 = await onlySession(g);

    const version = await caller.version.pin({ entityId: id, label: 'первая' });
    await ed.save('вторая редакция');
    expect((await onlySession(g)).id).toBe(s1.id);

    const restored = await caller.version.restore({
      versionId: version.id,
      expectedBodyRevision: ed.rev,
    });
    const restoreAction = (await rawEntity(id)).body_action_id;
    expect(restoreAction).not.toBe(s1.id);
    expect((await journalOf(g, restoreAction ?? ''))?.type).toBe('batch');

    ed.rev = restored.bodyRevision;
    await ed.save('после восстановления');
    const sessions = await sessionsOf(g);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.bodyBefore).toEqual({ [id]: restoreAction });
  });

  test('(ж) отмена сеанса — запись отмены сама становится действием тела; следующий набор открывает новый сеанс', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'Заметка', 'исходный текст');
    const ed = await Editor.open(callerFor(g), id);
    await ed.save('первое');
    await ed.save('второе');
    const s1 = await onlySession(g);

    ok(await undoAction(db, { identity: personal(g), actionId: s1.id }));
    const undo = await undoRecordOf(g, s1.id);
    const back = await rawEntity(id);
    // Отмена вернула текст ДО сеанса целиком и стала действием текущего тела
    expect([back.body, back.body_action_id]).toEqual(['исходный текст', undo?.id ?? '']);

    await ed.reload();
    await ed.save('новый набор');
    const sessions = await sessionsOf(g);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.bodyBefore).toEqual({ [id]: undo?.id ?? '' });
  });

  test('(з) правка заголовка между автосохранениями сеанс не закрывает', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const id = await seedNote(g, 'Заметка', 'исходный текст');
    const ed = await Editor.open(caller, id);
    await ed.save('первое');
    const s1 = await onlySession(g);

    await caller.entity.update({ id, title: 'Заметка переименована' });
    expect((await rawEntity(id)).body_action_id).toBe(s1.id);
    await elapse(g, 4);
    await ed.save('второе');
    expect((await onlySession(g)).id).toBe(s1.id);
    // Запись заголовка — своя, обычная; сеанс остался один
    expect((await actionsOf(g)).map((e) => e.textSession)).toEqual([true, false]);
  });

  test('(о) отменённый сеанс с нулевым итогом (отмена текста не сменила) не продолжается', async () => {
    const g = await freshGraph();
    const id = await seedNote(g, 'Заметка', 'исходный текст');
    const ed = await Editor.open(callerFor(g), id);
    await ed.save('набрал');
    await ed.save('исходный текст'); // стёр до исходного
    const s1 = await onlySession(g);

    ok(await undoAction(db, { identity: personal(g), actionId: s1.id }));
    expect(await undoRecordOf(g, s1.id)).toBeDefined();
    // Текст не сменился — триггер колонку не двинул (IS DISTINCT FROM): она всё ещё указывает на отменённый сеанс
    expect((await rawEntity(id)).body_action_id).toBe(s1.id);

    await ed.reload();
    await ed.save('новый набор');
    const sessions = await sessionsOf(g);
    expect(sessions).toHaveLength(2);
    expect((await rawEntity(id)).body_action_id).toBe(sessions[1]?.id ?? '');
  });

  test('(п) прочие писатели тела закрывают сеанс: засев тела проекта правкой, «вернуть как было» поставки', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);

    // Засев тела проекта (С10): набрал и стёр всё — тело пусто; навешивание проекта засевает заготовку своей записью
    const id = await seedNote(g, 'Будущий проект', '');
    const ed = await Editor.open(caller, id);
    await ed.save('черновик');
    await ed.save('');
    const s1 = await onlySession(g);
    await caller.entity.update({
      id,
      aspects: { attach: ['orbis/project'] },
      props: { 'orbis/project_stage': 'active' },
    });
    const seeded = await rawEntity(id);
    expect(seeded.body).not.toBe('');
    expect(seeded.body_action_id).not.toBe(s1.id);
    await ed.reload();
    await ed.save('план проекта');
    expect((await sessionsOf(g)).map((e) => e.bodyBefore)).toEqual([
      { [id]: null },
      { [id]: seeded.body_action_id },
    ]);

    // Поставка: запись поставки владелец правит сеансом, «вернуть как было» — своя запись, сеанс закрыт
    const reg = await withIdentity(db, personal(g), (tx) => effectiveRegistry(tx, g));
    ok(
      await execute(
        db,
        {
          identity: personal(g),
          actorKind: 'owner',
          source: 'ui',
          mechanism: 'supply',
          batchId: newId(),
          operations: supplyCreateOps(g, SUPPLY_KEYS, (k) => supplyRecordId(g, k), reg),
        },
        { sink },
      ),
    );
    const page = supplyRecordId(g, 'horizon-year');
    const edPage = await Editor.open(caller, page);
    await edPage.save('Мои цели');
    const s3 = (await sessionsOf(g)).at(-1) as J.JournalEntry;
    expect(s3.entityId).toBe(page);
    const { actionId: reverted } = await revertToEtalon(
      { db, identity: personal(g) },
      'horizon-year',
    );
    expect((await rawEntity(page)).body_action_id).toBe(reverted);
    await edPage.reload();
    await edPage.save('Мои цели снова');
    const last = (await sessionsOf(g)).at(-1) as J.JournalEntry;
    expect(last.id).not.toBe(s3.id);
    expect(last.bodyBefore).toEqual({ [page]: reverted });
  });

  test('(н) автосохранение записи-страницы с «домом», самого приложения и проекта продолжает сеанс без дописанных операций', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const page = await seedNote(g, 'Страница', 'текст страницы', [PAGE_ASPECT]);
    const appId = newId();
    ok(
      await execute(
        db,
        {
          identity: personal(g),
          actorKind: 'owner',
          source: 'ui',
          operations: [
            {
              tool: 'entity_create',
              input: {
                id: appId,
                title: 'Приложение',
                tags: [],
                aspects: [APP_ASPECT],
                props: { [APP_NAV]: [page] },
              },
            },
          ],
        },
        { sink },
      ),
    );
    const homeOf = async (entityId: string): Promise<unknown> => {
      const got = await caller.entity.get({ id: entityId });
      return got.entity.props[HOME_PROPERTY];
    };
    expect(await homeOf(page)).toBe(appId);
    const project = await seedNote(g, 'Проект', 'план проекта', ['orbis/project'], {
      'orbis/project_stage': 'active',
    });

    for (const id of [page, appId, project]) {
      const ed = await Editor.open(caller, id);
      await ed.save(`первое — ${id}`);
      await elapse(g, 1);
      await ed.save(`второе — ${id}`);
    }
    const sessions = await sessionsOf(g);
    expect(sessions.map((e) => e.entityId)).toEqual([page, appId, project]);
    for (const s of sessions) {
      // Ни бюджет-хука, ни «дома», ни пересчёта предков, ни пометок ссылок — только сама правка тела
      expect(s.operations).toEqual([
        { op: 'entity_update', payload: { id: s.entityId, textSession: true } },
      ]);
      expect((await rawEntity(s.entityId as string)).body_action_id).toBe(s.id);
    }
    expect(await homeOf(page)).toBe(appId);
  });
});

describe('сеанс правки текста (§8.5): форма записи и признак', () => {
  test('(к) запись сеанса хранит «до» и «действие тела до», «после» — нет', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const created = await caller.entity.create({
      input: { title: 'Заметка', tags: [], body: 'до сеанса' },
      source: 'ui',
    });
    const ed = new Editor(caller, created.id, created.bodyRevision);
    await ed.save('раз');
    await ed.saveDoc('два');
    await ed.save('три');
    const s = await onlySession(g);
    expect(s.type).toBe('entity_updated');
    expect(s.operations).toEqual([
      { op: 'entity_update', payload: { id: created.id, textSession: true } },
    ]);
    for (const op of s.operations) {
      expect(Object.keys(op.payload)).not.toContain('body');
      expect(Object.keys(op.payload)).not.toContain('bodyDoc');
    }
    expect(s.inverse).toEqual([
      { op: 'entity_update', payload: { id: created.id, body: 'до сеанса' } },
    ]);
    expect(s.bodyBefore).toEqual({ [created.id]: created.actionId ?? '' });
    expect(s.entityIds).toEqual([created.id]);
    // Текущий текст — в самой записи графа
    expect((await rawEntity(created.id)).body).toBe('три');
  });

  test('(и) autosave — только тело владельца: свойство, заголовок, пачка, другой актор → VALIDATION; у тула агента поля нет; правки тела моделью — каждая своя запись', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const id = await seedNote(g, 'Заметка', 'исходный текст');
    const rev = (await rawEntity(id)).body_revision;

    for (const extra of [
      { props: { 'orbis/task_status': 'done' }, aspects: { attach: ['orbis/task'] } },
      { title: 'и заголовок' },
      { tags: ['метка'] },
    ]) {
      const e = await trpcError(
        caller.entity.update({
          id,
          body: 'текст',
          expectedBodyRevision: rev,
          autosave: true,
          ...extra,
        }),
      );
      expect([e.code, codeOf(e)]).toEqual(['BAD_REQUEST', 'VALIDATION']);
    }
    // Без тела — не автосохранение
    const bare = await trpcError(caller.entity.update({ id, title: 'только', autosave: true }));
    expect([bare.code, codeOf(bare)]).toEqual(['BAD_REQUEST', 'VALIDATION']);
    // Элемент пачки признака не знает: пачка — жест, а не набор
    const inBatch = await trpcError(
      caller.entity.updateBatch({
        operations: [
          {
            tool: 'entity_update',
            input: { id, body: 'x', expectedBodyRevision: rev, autosave: true } as never,
          },
        ],
      }),
    );
    expect(inBatch.code).toBe('BAD_REQUEST');
    expect(await actionsOf(g)).toEqual([]);
    expect((await rawEntity(id)).body).toBe('исходный текст');

    // Исполнитель: признак сеанса — только у одиночной правки владельца
    const exec = (over: Record<string, unknown>) =>
      execute(
        db,
        {
          identity: personal(g),
          actorKind: 'owner',
          source: 'ui',
          textSession: true,
          operations: [
            { tool: 'entity_update', input: { id, body: 'x', expectedBodyRevision: rev } },
          ],
          ...over,
        },
        { sink },
      );
    for (const over of [{ actorKind: 'ai', source: 'chat' }, { batchId: newId() }]) {
      const r = await exec(over);
      expect(r.ok ? 'ok' : r.error.code).toBe('VALIDATION');
    }

    // Тул агента: поля нет в контракте — строгий разбор отказывает
    const agent = await dispatchTool(agentCtx(g), 'entity_update', {
      id,
      body: 'агент',
      expectedBodyRevision: rev,
      autosave: true,
    });
    expect(agent.status === 'error' ? agent.error.code : agent.status).toBe('VALIDATION');
    expect(await actionsOf(g)).toEqual([]);

    // Правки тела моделью в чате — каждая своя запись, без признака сеанса
    for (const [i, body] of ['модель раз', 'модель два'].entries()) {
      const r = await dispatchTool(chatCtx(g), 'entity_update', {
        id,
        body,
        expectedBodyRevision: rev + i,
      });
      expect(r.status).toBe('ok');
    }
    const edits = await actionsOf(g);
    expect(edits.map((e) => [e.actorKind, e.textSession])).toEqual([
      ['ai', false],
      ['ai', false],
    ]);
  });

  test('sessionSpan: начало — время записи, конец — время изменения тела, пока колонка = сеанс; иначе конца нет', () => {
    const entry = { id: 'S', createdAt: new Date('2026-07-04T11:02:00Z') } as J.JournalEntry;
    const changed = new Date('2026-07-04T11:18:00Z');
    expect(sessionSpan(entry, { bodyActionId: 'S', bodyChangedAt: changed })).toEqual({
      start: entry.createdAt,
      end: changed,
    });
    expect(sessionSpan(entry, { bodyActionId: 'X', bodyChangedAt: changed })).toEqual({
      start: entry.createdAt,
      end: null,
    });
    expect(sessionSpan(entry, { bodyActionId: null, bodyChangedAt: changed }).end).toBeNull();
  });

  test('инвариант записи сеанса: дописанная операция — исключение (транзакция откатывается), без дописанных — молча', () => {
    expect(() => assertNothingAppended('S', [])).not.toThrow();
    expect(() =>
      assertNothingAppended('S', [{ op: 'props_recomputed', payload: { recomputed: 1 } }]),
    ).toThrow(/инвариант сеанса правки текста.*props_recomputed/);
  });
});

describe('сеанс правки текста (§8.5): «последнее» — по времени последнего изменения', () => {
  // 14:02–14:18 по Москве (зона владельца по умолчанию): начало сеанса, галочка, конец сеанса
  const AT = (hhmm: string) => new Date(`2026-07-04T${hhmm}:00.000Z`);
  const START = AT('11:02');
  const CHECK = AT('11:05');
  const END = AT('11:18');

  /**
   * Сеанс, внутри которого галочка: набор, через 3 минуты — галочка, дальше набор с паузами 5, 4 и 4 минуты (каждая
   * короче 10, а сеанс длится 16 минут). Затем отметки ставятся точно: начало 14:02, галочка 14:05, конец 14:18.
   */
  async function sessionAroundCheckbox(g: GraphId) {
    const caller = callerFor(g);
    const note = await seedNote(g, 'Заметка', 'до сеанса');
    const task = await seedNote(g, 'Задача', '', ['orbis/task']);
    const ed = await Editor.open(caller, note);
    await ed.save('начало');
    await elapse(g, 3);
    await caller.entity.update({ id: task, props: { 'orbis/task_status': 'done' } });
    for (const [pause, text] of [
      [5, 'середина'],
      [4, 'почти'],
      [4, 'конец'],
    ] as const) {
      await elapse(g, pause);
      await ed.save(text);
    }
    const session = await onlySession(g);
    const checkbox = (await actionsOf(g)).find((e) => !e.textSession) as J.JournalEntry;
    await placeAt(g, {
      journal: { [session.id]: START, [checkbox.id]: CHECK },
      bodyChangedAt: { [note]: END },
    });
    const placed = await journalOf(g, session.id);
    if (placed === undefined) throw new Error('запись сеанса пропала');
    return { note, task, session: placed, checkbox, ed };
  }

  test('(м) галочка внутри сеанса: «последнее» — сеанс; контекст модели — тем же порядком и с отрезком', async () => {
    const g = await freshGraph();
    const { note, session, checkbox, ed } = await sessionAroundCheckbox(g);
    const who = personal(g);
    expect(await withIdentity(db, who, (tx) => J.findLastUndoable(tx, g).then((e) => e?.id))).toBe(
      session.id,
    );
    const since = new Date(START.getTime() - 3_600_000);
    expect(
      await withIdentity(db, who, (tx) =>
        J.recentOwnerEdits(tx, g, since, 10).then((es) => es.map((e) => e.id)),
      ),
    ).toEqual([session.id, checkbox.id]);
    const entity = await rawEntity(note);
    expect(
      sessionSpan(session, {
        bodyActionId: entity.body_action_id,
        bodyChangedAt: entity.body_changed_at,
      }),
    ).toEqual({ start: START, end: END });

    const threadId = await withIdentity(db, who, (tx) => ensureGlobalThread(tx, g));
    const context = () =>
      withIdentity(db, who, (tx) =>
        buildContext(tx, { graphId: g, threadId, clock: () => AT('12:00') }),
      );
    expect((await context()).messages[0]?.content).toBe(
      [
        OWNER_EDITS_HEADING,
        '[правка владельца: Задача · 14:05]',
        '[правка владельца: правка текста «Заметка» 14:02–14:18]',
      ].join('\n'),
    );

    // Текст сменил другой — у сеанса известно только начало, и порядок — по нему (цена §16)
    const agent = await dispatchTool(agentCtx(g), 'entity_update', {
      id: note,
      body: 'агент',
      expectedBodyRevision: ed.rev,
    });
    expect(agent.status).toBe('ok');
    expect((await context()).messages[0]?.content).toBe(
      [
        OWNER_EDITS_HEADING,
        '[правка владельца: правка текста «Заметка» 14:02]',
        '[правка владельца: Задача · 14:05]',
      ].join('\n'),
    );
  });

  test('(л) «отмени последнее» после сеанса и более ранней галочки отменяет сеанс, а не галочку, и называет отрезок', async () => {
    const g = await freshGraph();
    const { note, task, session, checkbox } = await sessionAroundCheckbox(g);
    const r = await dispatchTool(chatCtx(g), 'undo_last', {});
    if (r.status !== 'ok') throw new Error(`undo_last: ${JSON.stringify(r)}`);
    expect(r.result).toMatchObject({
      undone: true,
      actionId: session.id,
      title: 'правка текста «Заметка» 14:02–14:18',
    });
    expect((await rawEntity(note)).body).toBe('до сеанса');
    expect(await undoRecordOf(g, checkbox.id)).toBeUndefined();
    const got = await callerFor(g).entity.get({ id: task });
    expect(got.entity.props['orbis/task_status']).toBe('done');
  });
});
