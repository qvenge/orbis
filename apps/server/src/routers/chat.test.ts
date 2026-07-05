// apps/server/src/routers/chat.test.ts
// Интеграционные тесты Task 12: роутеры chat (треды §4.5, сообщения §4.6) и ai (undo §7.8)
// через createCallerFactory против живой БД. Мутации entity идут боевым синком —
// audit-сообщения видны в тредах (§7.8).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId, globalThreadId, newId } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { ActionRecord } from '../executor/types';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

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

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

describe('chat.ensureThread (§4.5)', () => {
  test('без entityId — глобальный тред с детерминированным id; вызов идемпотентен', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const t1 = await caller.chat.ensureThread({});
    expect(t1).toEqual({ threadId: globalThreadId(user) });
    expect(await caller.chat.ensureThread({})).toEqual(t1);
  });

  test('с entityId — тред сущности; несуществующая сущность → NOT_FOUND', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const e = await caller.entity.create({
      input: { title: 'Носитель треда', tags: [] },
      source: 'fast_path',
    });
    expect(await caller.chat.ensureThread({ entityId: e.id })).toEqual({
      threadId: entityThreadId(user, e.id),
    });
    const err = await trpcError(caller.chat.ensureThread({ entityId: crypto.randomUUID() }));
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('chat.appendUserMessage / chat.listMessages (§4.6)', () => {
  test('append → list по created_at DESC; limit и before; wire-таймстампы UTC Z', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const { threadId } = await caller.chat.ensureThread({});

    const m1 = await caller.chat.appendUserMessage({
      id: newId(),
      threadId,
      content: 'первое',
    });
    expect(m1.role).toBe('user');
    expect(m1.createdAt.endsWith('Z')).toBe(true);
    await Bun.sleep(10); // разводим created_at: курсор before — ms-точность wire-формы
    const m2 = await caller.chat.appendUserMessage({
      id: newId(),
      threadId,
      content: 'второе',
    });

    const all = await caller.chat.listMessages({ threadId });
    expect(all.map((m) => m.content)).toEqual(['второе', 'первое']); // created_at DESC

    expect((await caller.chat.listMessages({ threadId, limit: 1 })).map((m) => m.id)).toEqual([
      m2.id,
    ]);
    // before — курсор по createdAt (wire-форма самого старого загруженного)
    expect(
      (await caller.chat.listMessages({ threadId, before: m2.createdAt })).map((m) => m.id),
    ).toEqual([m1.id]);
  });

  // Golden (1c-2 Task 2): составной курсор (createdAt, id) — устойчивость к ms-коллизии.
  // Два сообщения в ОДНУ И ТУ ЖЕ createdAt (разные id): пагинация по границе ровно между
  // ними не должна терять/задваивать. Старый ms-курсор (lt createdAt) исключал бы второе
  // (same ms) целиком — оно бы пропало со страницы 2.
  test('пагинация по границе двух сообщений с одинаковым createdAt — оба ровно один раз', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const { threadId } = await caller.chat.ensureThread({});

    const same = new Date('2026-07-05T12:00:00.000Z'); // одна ms на двоих
    const older = new Date(same.getTime() - 1000);
    // id — tiebreak при равной createdAt: A с большим id первый в DESC, B со меньшим — второй
    // (строковое сравнение канонических UUID совпадает с порядком типа uuid в Postgres)
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const idBig = id1 > id2 ? id1 : id2;
    const idSmall = id1 > id2 ? id2 : id1;
    const idOlder = crypto.randomUUID();
    await withIdentity(db, user, (tx) =>
      tx.insert(chatMessages).values([
        { id: idBig, threadId, role: 'user', content: 'A', createdAt: same },
        { id: idSmall, threadId, role: 'user', content: 'B', createdAt: same },
        { id: idOlder, threadId, role: 'user', content: 'C', createdAt: older },
      ]),
    );

    // Клиентская пагинация: limit=1 разводит границу ровно между A и B (одна createdAt).
    // Курсор — как шлёт клиент: `${createdAt}|${id}` самого старого загруженного.
    const collected: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await caller.chat.listMessages({ threadId, before, limit: 1 });
      if (page.length === 0) break;
      const m = page[0];
      if (!m) break;
      collected.push(m.id);
      before = `${m.createdAt}|${m.id}`;
    }
    // Порядок стабилен (createdAt desc, id desc); каждое ровно один раз, B не потеряно
    expect(collected).toEqual([idBig, idSmall, idOlder]);
  });

  // Ревью Task 2: недоверенный before-курсор валидируется строгой regex ДО резолвера —
  // мусор и кривой uuid отбиваются чистым 400, а не 500 из Postgres (invalid uuid syntax).
  test('невалидный before-курсор → BAD_REQUEST (400), не 500', async () => {
    const caller = callerFor(freshUserId());
    const threadId = crypto.randomUUID();
    // id-часть не-uuid: без строгой валидации дошло бы до Postgres → 500
    const badId = await trpcError(
      caller.chat.listMessages({ threadId, before: '2026-07-05T12:00:00.000Z|not-a-uuid' }),
    );
    expect(badId.code).toBe('BAD_REQUEST');
    // явный мусор в createdAt-части
    const garbage = await trpcError(caller.chat.listMessages({ threadId, before: '2026' }));
    expect(garbage.code).toBe('BAD_REQUEST');
    // легитимный составной курсор и легаси-ISO по-прежнему валидны (валидация не сработала)
    await caller.chat.listMessages({
      threadId,
      before: `2026-07-05T12:00:00.000Z|${crypto.randomUUID()}`,
    });
    await caller.chat.listMessages({ threadId, before: '2026-07-05T12:00:00.000Z' });
  });

  test('чужой тред: append → NOT_FOUND (RLS: чужое и несуществующее неразличимы)', async () => {
    const owner = freshUserId();
    const stranger = freshUserId();
    const { threadId } = await callerFor(owner).chat.ensureThread({});
    const err = await trpcError(
      callerFor(stranger).chat.appendUserMessage({ id: newId(), threadId, content: 'взлом' }),
    );
    expect(err.code).toBe('NOT_FOUND');
    // и список чужого треда пуст — RLS скрывает сообщения
    expect(await callerFor(stranger).chat.listMessages({ threadId })).toEqual([]);
  });
});

describe('chat.appendUserMessage: идемпотентный повтор по client-UUID (fix round, зеркально §5.3)', () => {
  test('повтор с тем же id → 200, та же строка, счётчик сообщений не вырос', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const { threadId } = await caller.chat.ensureThread({});
    const id = newId();
    const first = await caller.chat.appendUserMessage({ id, threadId, content: 'ретрай' });
    const replay = await caller.chat.appendUserMessage({ id, threadId, content: 'ретрай' });
    expect(replay).toEqual(first); // идемпотентный повтор — форма та же, флага не нужно
    expect((await caller.chat.listMessages({ threadId })).length).toBe(1);
  });

  test('повтор с тем же id, но другим content → возвращается ИСХОДНАЯ строка', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const { threadId } = await caller.chat.ensureThread({});
    const id = newId();
    const first = await caller.chat.appendUserMessage({ id, threadId, content: 'оригинал' });
    const replay = await caller.chat.appendUserMessage({ id, threadId, content: 'другое' });
    expect(replay.content).toBe('оригинал'); // содержимое первой записи, не перезапись
    expect(replay).toEqual(first);
    expect((await caller.chat.listMessages({ threadId })).length).toBe(1);
  });

  test('id занят сообщением чужого пользователя → CONFLICT, без SQL-текста в message', async () => {
    // id занимает ЧУЖОЕ сообщение — под RLS оно невидимо второму пользователю
    const stranger = freshUserId();
    const strangerCaller = callerFor(stranger);
    const strangerThread = await strangerCaller.chat.ensureThread({});
    const id = newId();
    await strangerCaller.chat.appendUserMessage({
      id,
      threadId: strangerThread.threadId,
      content: 'чужое',
    });

    const user = freshUserId();
    const caller = callerFor(user);
    const { threadId } = await caller.chat.ensureThread({});
    const e = await trpcError(caller.chat.appendUserMessage({ id, threadId, content: 'моё' }));
    expect(e.code).toBe('CONFLICT');
    // нейтральный текст: без раскрытия SQL-структуры и параметров
    expect(e.message).not.toContain('insert into');
    expect(e.message.toLowerCase()).not.toContain('failed query');
    expect(e.message).not.toContain('params:');
  });
});

describe('ai.undo / ai.undoLast (§7.8)', () => {
  test('undoLast гасит последний create: сущность архивирована, actionId — отменённого действия', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'Отменяемая', tags: [] },
      source: 'fast_path',
    });

    // action попал в глобальный тред боевым синком (§7.8)
    const audit = await caller.chat.listMessages({ threadId: globalThreadId(user) });
    const actions = (audit[0]?.metadata as { actions?: ActionRecord[] }).actions ?? [];
    const action = actions[0];
    if (!action) throw new Error('ожидался action в журнале');

    const undone = await caller.ai.undoLast();
    expect(undone.ok).toBe(true);
    expect(undone.actionId).toBe(action.id);

    // inverse create — архивация (§7.8)
    const got = await caller.entity.get({ id: created.id });
    expect(got.entity.archived).toBe(true);

    // неотменённых действий больше нет (undo не порождает нового action)
    const empty = await trpcError(caller.ai.undoLast());
    expect(empty.code).toBe('NOT_FOUND');
  });

  test('undo по actionId; повторная отмена → BAD_REQUEST (уже отменено)', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'Точечная отмена', tags: [] },
      source: 'quick_capture',
    });
    const audit = await caller.chat.listMessages({ threadId: globalThreadId(user) });
    const action = ((audit[0]?.metadata as { actions?: ActionRecord[] }).actions ?? [])[0];
    if (!action) throw new Error('ожидался action в журнале');

    const undone = await caller.ai.undo({ actionId: action.id });
    expect(undone.ok).toBe(true);
    expect((await caller.entity.get({ id: created.id })).entity.archived).toBe(true);

    const again = await trpcError(caller.ai.undo({ actionId: action.id }));
    expect(again.code).toBe('BAD_REQUEST');

    // несуществующий actionId → NOT_FOUND
    const missing = await trpcError(caller.ai.undo({ actionId: crypto.randomUUID() }));
    expect(missing.code).toBe('NOT_FOUND');
  });
});
