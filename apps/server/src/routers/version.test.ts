// apps/server/src/routers/version.test.ts
// Тесты роутера version (§9.1, С11): закрепление версии тела, выдача снимков и откат.
// Роутер — только трансляция: pin/restore идут через executor (единственный путь мутаций,
// 00-arch §4), list читает под RLS. Против живой БД, caller как в бою (createCallerFactory).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { canonicalizeBody } from '@orbis/shared/doc';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

/** Caller от лица владельца: ctx как в бою (§9.1); clientVersion=null — гейт версии пропускает. */
function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

/** Ошибка вызова процедуры — TRPCError, с внятным падением при неожиданном успехе. */
async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

const owner = freshUserId();
const a = callerFor(owner);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('version.pin / version.list / version.restore (С11)', () => {
  test('pin → list → правка тела → restore: тело канонично эквивалентно снимку, аспекты и связи не тронуты (инвариант 8)', async () => {
    const id = newId();
    const neighbour = newId();
    await a.entity.create({
      input: {
        id,
        title: 'Док',
        tags: [],
        body: '# Раз\n\n- два\n',
        aspects: { 'orbis/task': { status: 'planned' } },
      },
      source: 'quick_capture',
    });
    await a.entity.create({
      input: { id: neighbour, title: 'Сосед', tags: [] },
      source: 'quick_capture',
    });
    await a.relation.create({ source_id: id, target_id: neighbour, relation_type: 'related_to' });

    const v = await a.version.pin({ entityId: id, label: 'до правки' });
    expect(v.hasDoc).toBe(true);
    expect(v.entityId).toBe(id);
    expect(v.actorKind).toBe('owner');

    const list = await a.version.list({ entityId: id });
    expect(list.map((x) => x.id)).toEqual([v.id]);
    expect(list[0]?.label).toBe('до правки');

    const e1 = await a.entity.get({ id, include: ['body', 'bodyDoc'] });
    await a.entity.update({
      id,
      expectedUpdatedAt: e1.entity.updatedAt,
      body: '# Совсем другое',
      aspects: { 'orbis/task': { status: 'waiting' } },
    });
    const e2 = await a.entity.get({ id, include: ['body', 'bodyDoc'] });
    expect(e2.entity.body).not.toBe(e1.entity.body);

    const restored = await a.version.restore({
      versionId: v.id,
      expectedUpdatedAt: e2.entity.updatedAt,
    });
    expect(restored.body).toBe(canonicalizeBody('# Раз\n\n- два\n').body);
    // Инвариант 8: откат трогает ТОЛЬКО тело — аспекты остаются текущими (С11),
    expect(restored.aspectsMap['orbis/task']).toEqual({ status: 'waiting' });
    // …как и связи: снимок их не хранит и восстановление не переписывает граф
    const after = await a.entity.get({ id, include: ['relations'] });
    expect(after.relations?.map((r) => r.targetId)).toEqual([neighbour]);
  });

  test('restore со стухшим expectedUpdatedAt → CONFLICT (409), тело не изменилось', async () => {
    const id = newId();
    await a.entity.create({
      input: { id, title: 'Гонка', tags: [], body: 'снимок' },
      source: 'quick_capture',
    });
    const v = await a.version.pin({ entityId: id, label: 'снимок' });

    const e1 = await a.entity.get({ id });
    await a.entity.update({ id, expectedUpdatedAt: e1.entity.updatedAt, body: 'правка соседа' });
    const e2 = await a.entity.get({ id });

    // Стухший штамп: тело правил кто-то ещё после того, как экран прочитал сущность (§5.2)
    const err = await trpcError(
      a.version.restore({ versionId: v.id, expectedUpdatedAt: e1.entity.updatedAt }),
    );
    expect(err.code).toBe('CONFLICT');
    expect((await a.entity.get({ id })).entity.body).toBe(e2.entity.body);
    // Отказ — на гейте тела, а не на снимке: версия по-прежнему на месте
    expect((await a.version.list({ entityId: id })).map((x) => x.id)).toEqual([v.id]);
  });

  test('снимок сущности без body_doc (легаси-строка) хранит только body; restore идёт строкой', async () => {
    const id = newId();
    // Не канон: список сразу за заголовком без пустой строки — так писали тела до конверсии
    const legacy = '# Раз\n- два';
    const { db: admin, client: adminClient } = adminDb();
    try {
      // Строка «до бэкфилла»: body_doc пуст. Вставка мимо executor'а намеренна — его путь
      // такое состояние больше не порождает, а в базе оно живёт с прошлых релизов.
      await admin.execute(
        sql`INSERT INTO entities (id, owner_id, title, body)
            VALUES (${id}, ${owner}, ${'Легаси'}, ${legacy})`,
      );
    } finally {
      await adminClient.end();
    }

    const v = await a.version.pin({ entityId: id, label: 'легаси' });
    expect(v.hasDoc).toBe(false); // документ берётся «как лежит»: NULL не конвертируем
    expect((await a.version.list({ entityId: id }))[0]?.hasDoc).toBe(false);

    const before = await a.entity.get({ id });
    await a.entity.update({ id, expectedUpdatedAt: before.entity.updatedAt, body: 'затёрли' });
    const e2 = await a.entity.get({ id });

    const restored = await a.version.restore({
      versionId: v.id,
      expectedUpdatedAt: e2.entity.updatedAt,
    });
    // Тело восстановлено строкой и приведено к канону тем же конвейером, что запись редактора
    expect(restored.body).toBe(canonicalizeBody(legacy).body);
    expect(restored.body).not.toBe(legacy); // канон посчитал executor, снимок хранил сырую строку
  });

  test('«отмени последнее» после pin удаляет версию (undo как у entity_origin_*)', async () => {
    const id = newId();
    await a.entity.create({
      input: { id, title: 'Под откат', tags: [], body: 'тело' },
      source: 'quick_capture',
    });
    const v = await a.version.pin({ entityId: id, label: 'x' });
    expect((await a.version.list({ entityId: id })).map((x) => x.id)).toEqual([v.id]);

    await a.ai.undoLast();
    expect((await a.version.list({ entityId: id })).find((x) => x.id === v.id)).toBeUndefined();
  });

  test('чужие версии недостижимы: list пуст, pin и restore → NOT_FOUND (RLS §4.10)', async () => {
    const b = callerFor(freshUserId());
    const id = newId();
    await a.entity.create({
      input: { id, title: 'Только моё', tags: [], body: 'тело' },
      source: 'quick_capture',
    });
    const v = await a.version.pin({ entityId: id, label: 'моя' });
    const mine = await a.entity.get({ id });

    expect(await b.version.list({ entityId: id })).toEqual([]);
    expect(
      (await trpcError(b.version.pin({ entityId: id, label: 'чужая' }))).code,
      // чужая и несуществующая сущность неразличимы намеренно (§4.10)
    ).toBe('NOT_FOUND');
    expect(
      (
        await trpcError(
          b.version.restore({ versionId: v.id, expectedUpdatedAt: mine.entity.updatedAt }),
        )
      ).code,
    ).toBe('NOT_FOUND');
  });
});
