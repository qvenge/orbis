// Интеграционные тесты диспатча тулов (§9.2): живая БД, executor без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
// Политика §7.10 подключена (Task 5): уровень мутации назначает classifyToolCall
// (policy/confirmation, юнит-тесты там же); здесь — поведение уровней через dispatch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  entityThreadId,
  newId,
  type PropertyDefinition,
} from '@orbis/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  executeWithFixtureCategories as execute,
  freshUserId,
  rawEntityRow,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { ensureEntityThread, ensureGlobalThread } from '../chat/threads';
import { chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { makeChatJournalSink } from '../executor/journal';
import type { ActionRecord, WireEntity } from '../executor/types';
import { issuePatGrant, verifyBearer } from '../oauth/grants';
import { approvePending } from '../policy/pending';
import type { RegistrySnapshot } from '../registry/load';
import { bumpOwnerRegistryVersion } from '../registry/version';
import { appRouter } from '../router';
import { agentLoopHelpers } from '../test/agent-loop-helpers';
import { createCallerFactory } from '../trpc';
import {
  dispatchTool,
  registryOperationSummary,
  routineDeferForbidden,
  routineGate,
  type ToolCallCtx,
} from './dispatch';
import { buildToolRegistry, type RoutineRef } from './registry';
import { REGISTRY_TOOL_NAMES } from './registry-tools';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const userB = freshUserId();
const CATEGORY_REF = '019e4466-aaaa-7e07-b5d4-64be9721da51';
/**
 * Своя категория для userC. С §А6-1 ссылка обязана указывать на категорию ТОГО ЖЕ
 * владельца, а id сущности глобально уникален — общая на два владельца константа
 * доставалась бы первому, и второму цель была бы «не найдена» (RLS её скрывает).
 */
const CATEGORY_REF_C = '019e4466-cccc-7e07-b5d4-64be9721da51';
const T0 = new Date('2026-07-04T10:00:00.000Z');

function ctxFor(over: Partial<ToolCallCtx> = {}): ToolCallCtx {
  return {
    db,
    actorUserId: userA,
    actorKind: 'ai',
    source: 'chat',
    explicitCommand: false,
    clock: () => T0,
    ...over,
  };
}

/** Сид-сущность через executor без синка — без audit-шума в тредах. */
async function seedEntity(owner: string, input: Record<string, unknown>): Promise<WireEntity> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input }],
  });
  if (!r.ok) throw new Error(`seedEntity: ${r.error.code} ${r.error.message}`);
  return r.results[0] as WireEntity;
}

async function messagesIn(owner: string, threadId: string) {
  return withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(chatMessages.createdAt, chatMessages.id),
  );
}

function expectError(r: Awaited<ReturnType<typeof dispatchTool>>, code: string): void {
  expect(r.status).toBe('error');
  if (r.status === 'error') expect(r.error.code).toBe(code);
}

/** Новая правда строки (§А1-1) под identity владельца: значения по id свойства. */
async function propsOfRowA(id: string, owner = userA): Promise<Record<string, unknown>> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select({ props: entities.props }).from(entities).where(eq(entities.id, id)),
  );
  return (rows[0]?.props ?? {}) as Record<string, unknown>;
}

/** Заголовок строки под identity владельца — проба «отказ случился ДО исполнения». */
async function titleOfRowA(id: string, owner = userA): Promise<string | undefined> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select({ title: entities.title }).from(entities).where(eq(entities.id, id)),
  );
  return rows[0]?.title;
}

/** Список интерпретаций строки — вторая половина новой правды. */
async function aspectsOfRowA(id: string, owner = userA): Promise<string[]> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select({ aspects: entities.aspects }).from(entities).where(eq(entities.id, id)),
  );
  return rows[0]?.aspects ?? [];
}

beforeAll(async () => {
  await truncateAll();
  // Кастомный аспект userA с «-» в ключе: на нём видно, что имя тула ОДНО у реестра,
  // диспатча и исполнителя (§А9-1) — прежде нормализаций было две.
  await seedCustomAspect(userA, {
    key: 'user/sleep-log',
    label: { ru: 'Сон', en: 'Sleep Log' },
    aiInstructions: 'Пиши часы сна числом.',
    properties: [{ key: 'hours', type: { kind: 'number' }, required: true }],
  });
});

afterAll(async () => {
  await client.end();
});

describe('dispatchTool: резолв по реестру', () => {
  test('неизвестный тул → error/FORBIDDEN_LEVEL (§7.10 ряд «!known»: fail-closed, 403 маппингом errors.ts)', async () => {
    // Уровень определяет classifyToolCall, dispatch только мапит его в код ошибки —
    // ни модель, ни агент не обходят запрет переформулировкой имени вызова
    const r = await dispatchTool(ctxFor(), 'entity_delete', { id: newId() });
    expectError(r, 'FORBIDDEN_LEVEL');
  });

  test('невалидный envelope read-тула ({} для entity_query) → error/VALIDATION', async () => {
    const r = await dispatchTool(ctxFor(), 'entity_query', {});
    expectError(r, 'VALIDATION');
  });
});

describe('dispatchTool: мутации через executor (§9.2; уровни §7.10 подключит Task 5)', () => {
  test('entity_create: сущность создана; audit в переданный threadId с actor_kind=ai, source=chat; card entity_card', async () => {
    // Отдельный (не глобальный) тред — проверяем именно «переданный threadId»
    const host = await seedEntity(userA, { title: 'Хост-тред', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));

    const r = await dispatchTool(ctxFor({ threadId }), 'entity_create', {
      title: 'Тестовая задача',
      tags: ['dispatch'],
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const e = r.result as WireEntity;
    expect(e.title).toBe('Тестовая задача');
    expect(e.createdAt).toBe(T0.toISOString());

    // Карточка (02 §2.3): keyFields — id СВОЙСТВ из viewConfig аспекта (§А9-2, Задача 12);
    // из трёх ключевых заполнено только состояние.
    expect(r.card).toEqual({
      kind: 'entity_card',
      entityId: e.id,
      title: 'Тестовая задача',
      aspects: ['orbis/task'],
      keyFields: { 'orbis/task_status': 'inbox' },
      undoActionId: expect.any(String),
    });

    // audit-сообщение легло в переданный тред; актор — внутренний AI
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    const md = msgs[0]?.metadata as { actions?: ActionRecord[] };
    const action = md.actions?.[0];
    expect(action?.actor_kind).toBe('ai');
    expect(action?.source).toBe('chat');
    expect(action?.actor_user_id).toBe(userA);
    if (r.card?.kind === 'entity_card') expect(action?.id).toBe(r.card.undoActionId as string);
  });

  // V1.5: прогон — вторая половина атрибуции. Без него правка модели неотличима от
  // любой другой чатовой, и откат прогона (rollback.ts ищет действия контейнмент-пробой
  // по run_id) не нашёл бы того, что она сделала.
  test('entity_update с ctx.runId: прогон доезжает до action журнала', async () => {
    const host = await seedEntity(userA, { title: 'Хост-тред прогона', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const target = await seedEntity(userA, { title: 'Цель прогона', tags: [] });
    const runId = newId();

    const r = await dispatchTool(ctxFor({ threadId, source: 'chat', runId }), 'entity_update', {
      id: target.id,
      title: 'Правка в прогоне',
    });
    expect(r.status).toBe('ok');

    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    const action = (msgs[0]?.metadata as { actions?: ActionRecord[] }).actions?.[0];
    expect(action?.run_id).toBe(runId);
  });

  test('attach_orbis_task: аспект установлен; без threadId audit — в глобальный тред', async () => {
    const target = await seedEntity(userA, { title: 'Без аспекта', tags: [] });
    const globalThread = await withIdentity(db, userA, (tx) => ensureGlobalThread(tx, userA));
    const before = (await messagesIn(userA, globalThread)).length;

    const r = await dispatchTool(ctxFor(), 'attach_orbis_task', {
      entity_id: target.id,
      data: { 'orbis/task_status': 'in_progress', 'orbis/priority': 'high' },
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const e = r.result as WireEntity;
    expect(e.props).toMatchObject({
      'orbis/task_status': 'in_progress',
      'orbis/priority': 'high',
    });
    expect(e.aspects).toContain('orbis/task');
    expect(r.card?.kind).toBe('entity_card');
    if (r.card?.kind === 'entity_card') {
      expect(r.card.keyFields).toEqual({
        'orbis/task_status': 'in_progress',
        'orbis/priority': 'high',
      });
      expect(r.card.undoActionId).toBeDefined();
    }

    const after = await messagesIn(userA, globalThread);
    expect(after.length).toBe(before + 1);
    const md = after[after.length - 1]?.metadata as { actions?: ActionRecord[] };
    expect(md.actions?.[0]?.actor_kind).toBe('ai');
  });

  test('entity_update: card entity_card с undoActionId; ошибка executor пробрасывается структурированно', async () => {
    const target = await seedEntity(userA, { title: 'До правки', tags: [] });
    const ok = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      title: 'После правки',
    });
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok' && ok.card?.kind === 'entity_card') {
      expect(ok.card.title).toBe('После правки');
      expect(ok.card.undoActionId).toBeDefined();
    }

    // §5.2: правка body без expectedUpdatedAt → VALIDATION из executor'а
    const bad = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      body: 'новый текст',
    });
    expectError(bad, 'VALIDATION');
  });

  test('attach_* кастомного аспекта с «-» в ключе: имя ОДНО у реестра, диспатча и исполнителя (§А9-1)', async () => {
    // До Задачи 12 нормализаций было две: реестр показывал `attach_user_sleep_log`, а
    // исполнитель ждал `attach_user_sleep-log` (замена только «/»), и держал их вместе
    // переводчик в диспатче. Дефис в ключе — единственное место, где они расходились.
    const target = await seedEntity(userA, { title: 'Сон', tags: [] });
    const r = await dispatchTool(ctxFor(), 'attach_user_sleep_log', {
      entity_id: target.id,
      data: { 'user/hours': 7.5 },
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect((r.result as WireEntity).props['user/hours']).toBe(7.5);
    expect((r.result as WireEntity).aspects).toContain('user/sleep-log');
    if (r.card?.kind === 'entity_card') expect(r.card.keyFields).toEqual({ 'user/hours': 7.5 });
    // Прежнего имени исполнительной формы больше не существует: диспатч ничего не переводит.
    expectError(
      await dispatchTool(ctxFor(), 'attach_user_sleep-log', {
        entity_id: target.id,
        data: { 'user/hours': 8 },
      }),
      'FORBIDDEN_LEVEL',
    );
  });

  test('batch_execute: атомарная группа исполняется, results по операциям, один audit-action типа batch', async () => {
    const host = await seedEntity(userA, { title: 'Хост batch-треда', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const r = await dispatchTool(ctxFor({ threadId }), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_create', input: { title: 'batch-1', tags: [] } },
        { tool: 'entity_create', input: { title: 'batch-2', tags: [] } },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect((r.result as unknown[]).length).toBe(2);
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    const md = msgs[0]?.metadata as { actions?: ActionRecord[] };
    expect(md.actions?.[0]?.type).toBe('batch');
  });

  test('batch_execute: вложенный attach по ПУБЛИЧНОМУ имени реестра (дефисный кастомный аспект) → успех', async () => {
    // Имя операции — реестровое, и с Задачи 12 оно же исполнительное (§А9-1): переводить
    // нечего, диспатч только проверяет, что тул в реестре есть.
    const id = newId();
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_create', input: { id, title: 'batch + attach', tags: [] } },
        { tool: 'attach_user_sleep_log', input: { entity_id: id, data: { 'user/hours': 6 } } },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const results = r.result as WireEntity[];
    expect(results.length).toBe(2);
    expect(results[1]?.props['user/hours']).toBe(6);
    expect(results[1]?.aspects).toContain('user/sleep-log');
  });

  test('batch_execute: неизвестное имя операции → структурная VALIDATION с индексом элемента', async () => {
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_create', input: { title: 'x', tags: [] } },
        { tool: 'no_such_tool', input: {} },
      ],
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') {
      expect((r.error.details as { index: number; tool: string }).index).toBe(1);
      expect((r.error.details as { index: number; tool: string }).tool).toBe('no_such_tool');
    }
  });
});

// ---------------------------------------------------------------------------
// Модель-обращённая поверхность (§А9-1/§А9-2, приёмка §С8-2): контракты тулов говорят
// свойствами по `key`, проекция ответа — тоже, старой карты и `meta` в них больше нет.
// ---------------------------------------------------------------------------

describe('LLM-контракты entity_create/entity_update на свойствах (§А9-1)', () => {
  test('entity_create: props по key И по id, аспект списком; неизвестный key → VALIDATION с подсказкой', async () => {
    const r = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Такси до аэропорта',
      tags: [],
      // ОБЕ стороны границы в одной фикстуре: два свойства адресованы `key`, третье — id
      // (у встроенных они совпадают, но резолв обязан принимать оба — §А9-1).
      props: {
        'orbis/amount': '10.00',
        'orbis/direction': 'expense',
        'orbis/occurred_on': '2026-07-04',
        'orbis/finance_category': CATEGORY_REF,
      },
      aspects: ['orbis/financial'],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const created = r.result as WireEntity;
    // В СТРОКЕ значения лежат по id свойства (§А1-1), а не по имени поля аспекта. Набор
    // ТОЧНЫЙ: доменный инвариант финансов (`occurred_on` обязателен у факта) прошёл — то
    // есть вход доехал до конца конвейера записи, а не остановился на схеме.
    expect(await propsOfRowA(created.id)).toEqual({
      'orbis/amount': '10.00',
      'orbis/direction': 'expense',
      'orbis/occurred_on': '2026-07-04',
      'orbis/finance_category': CATEGORY_REF,
    });
    expect(await aspectsOfRowA(created.id)).toEqual(['orbis/financial']);

    // Неизвестный адрес отвергается НА ГРАНИЦЕ и с подсказкой ближайшего ключа.
    const typo = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Опечатка в имени свойства',
      tags: [],
      props: { 'orbis/amout': '10.00' },
    });
    expectError(typo, 'VALIDATION');
    if (typo.status !== 'error') return;
    const details = typo.error.details as { reason?: string; property?: string; nearest?: string };
    expect(details.reason).toBe('UNKNOWN_PROPERTY');
    expect(details.property).toBe('orbis/amout');
    expect(details.nearest).toBe('orbis/amount');
    expect(typo.error.message).toContain('orbis/amount');

    // Далёкое имя подсказки НЕ получает: «похоже» — это опечатка, а не другое слово.
    const foreign = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Совсем чужое имя',
      tags: [],
      props: { 'user/выдуманное-поле': 1 },
    });
    expectError(foreign, 'VALIDATION');
    if (foreign.status === 'error') {
      expect((foreign.error.details as { nearest?: string }).nearest).toBeUndefined();
    }
  });

  test('unset с опечаткой → VALIDATION UNKNOWN_PROPERTY: граница — ЕДИНСТВЕННАЯ защита снятия', async () => {
    // Дальше по конвейеру опечатка в `unset` — МОЛЧАЛИВЫЙ УСПЕХ: гейт прав пропускает
    // неизвестный id (`writeDenial` его не знает), `applyPropsPatch` удаляет ключ, которого
    // нет, а валидатор видит валидное состояние. То есть у второй половины патча нет ни
    // одного рубежа, кроме этой границы, — и `props`-ветка её не заменяет.
    const target = await seedEntity(userA, {
      title: 'Цель опечатки в unset',
      tags: [],
      props: { 'orbis/task_status': 'waiting', 'orbis/waiting_for': 'курьера' },
      aspects: ['orbis/task'],
    });

    const typo = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      unset: ['orbis/waiting_fo'],
    });
    expectError(typo, 'VALIDATION');
    if (typo.status !== 'error') return;
    const details = typo.error.details as { reason?: string; property?: string; nearest?: string };
    expect(details.reason).toBe('UNKNOWN_PROPERTY');
    expect(details.property).toBe('orbis/waiting_fo');
    expect(details.nearest).toBe('orbis/waiting_for');

    // Обе стороны границы в одной фикстуре: ПРАВИЛЬНОЕ имя в том же `unset` проходит и
    // действительно снимает значение — иначе «отказ» был бы отказом чему угодно.
    expect((await propsOfRowA(target.id))['orbis/waiting_for']).toBe('курьера');
    const ok = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      unset: ['orbis/waiting_for'],
    });
    expect(ok.status).toBe('ok');
    expect((await propsOfRowA(target.id))['orbis/waiting_for']).toBeUndefined();

    // И в batch та же граница: `unset` вложенной операции проверяется наравне с верхней.
    const inBatch = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: target.id, title: 'Переименование' } },
        { tool: 'entity_update', input: { id: target.id, unset: ['orbis/waiting_fo'] } },
      ],
    });
    expectError(inBatch, 'VALIDATION');
    if (inBatch.status === 'error') {
      expect((inBatch.error.details as { reason?: string }).reason).toBe('UNKNOWN_PROPERTY');
    }
    // Отказ ДО исполнения: заголовок соседней операции батча не поехал.
    expect(await titleOfRowA(target.id)).toBe('Цель опечатки в unset');
  });

  test('entity_update: unset снимает значение, aspects.detach снимает аспект — значения остаются (Р9)', async () => {
    const target = await seedEntity(userA, {
      title: 'Задача с ожиданием',
      tags: [],
      props: { 'orbis/task_status': 'waiting', 'orbis/waiting_for': 'ответа банка' },
      aspects: ['orbis/task'],
    });
    expect((await propsOfRowA(target.id))['orbis/waiting_for']).toBe('ответа банка');

    const unset = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      unset: ['orbis/waiting_for'],
    });
    expect(unset.status).toBe('ok');
    const afterUnset = await propsOfRowA(target.id);
    expect(afterUnset['orbis/waiting_for']).toBeUndefined();
    // Снялось РОВНО названное: соседнее свойство того же аспекта на месте.
    expect(afterUnset['orbis/task_status']).toBe('waiting');

    // Снятие аспекта значения НЕ трогает (Р9): аспект — не владелец поля.
    const detach = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      aspects: { detach: ['orbis/task'] },
    });
    expect(detach.status).toBe('ok');
    expect(await aspectsOfRowA(target.id)).toEqual([]);
    expect((await propsOfRowA(target.id))['orbis/task_status']).toBe('waiting');

    // …и обратно: attach возвращает интерпретацию, значения при этом не переписывая.
    const attach = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      aspects: { attach: ['orbis/task'] },
    });
    expect(attach.status).toBe('ok');
    expect(await aspectsOfRowA(target.id)).toEqual(['orbis/task']);
    expect((await propsOfRowA(target.id))['orbis/task_status']).toBe('waiting');
  });

  test('meta и старая карта аспектов → VALIDATION на ОБОИХ входах: тул и надмножество исполнителя', async () => {
    const target = await seedEntity(userA, { title: 'Цель старой формы', tags: [] });
    // `additionalProperties: false` контракта тула: мешка `meta` больше нет вовсе (§А1-3).
    expectError(
      await dispatchTool(ctxFor(), 'entity_create', {
        title: 'С мешком',
        tags: [],
        meta: { amount: '500.00', direction: 'expense' },
      }),
      'VALIDATION',
    );
    // Фикстура НАМЕРЕННО говорит старой картой — тест утверждает её ОТКАЗ.
    expectError(
      await dispatchTool(ctxFor(), 'entity_update', {
        id: target.id,
        aspects: { 'orbis/task': { status: 'done' } },
      }),
      'VALIDATION',
    );

    // …и НАДМНОЖЕСТВО ИСПОЛНИТЕЛЯ — тоже отказ, с «Пересева мира». Оно было последним
    // входом старой карты во всём сервере; пока союз стоял, эта половина теста проверяла
    // ПРИЁМ той же формы.
    const viaUi = await execute(db, {
      actorUserId: userA,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: target.id, aspects: { 'orbis/task': { status: 'done' } } },
        },
      ],
    });
    expect(viaUi.ok).toBe(false);
    if (viaUi.ok) return;
    expect(viaUi.error.code).toBe('VALIDATION');
    // Отказ ДО записи: статус не изменился.
    expect((await propsOfRowA(target.id))['orbis/task_status']).toBeUndefined();
  });

  test('entity_query печатает props по KEY, без meta и без карты аспектов (§А9-2)', async () => {
    const owner = freshUserId();
    // Обе стороны границы в фикстуре: встроенное свойство (key = id) и СВОЁ, у которого
    // key и id РАЗНЫЕ, — только на втором видно, что печатается именно key.
    const admin = adminDb();
    try {
      await admin.db.execute(sql`
        INSERT INTO property_definitions
          (id, owner_id, key, label, description, type, status, storage, rank, flags)
        VALUES ('user/p-mood', ${owner}, 'user/mood',
                ${JSON.stringify({ ru: 'Настроение' })}::jsonb,
                ${JSON.stringify({ ru: 'Как прошёл день' })}::jsonb,
                ${JSON.stringify({ kind: 'number' })}::jsonb, 'active', 'props', 300, '{}'::jsonb)
        ON CONFLICT (owner_id, id) WHERE owner_id IS NOT NULL DO NOTHING`);
      await bumpOwnerRegistryVersion(admin.db, owner); // мутация реестра двигает версию (§А10-1)
    } finally {
      await admin.client.end();
    }
    const created = await seedEntity(owner, {
      title: 'День с настроением',
      tags: ['llm-projection'],
      props: { 'orbis/task_status': 'inbox', 'user/p-mood': 8 },
      aspects: ['orbis/task'],
    });

    const r = await dispatchTool(ctxFor({ actorUserId: owner }), 'entity_query', {
      query: 'tags=llm-projection',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const rows = r.result as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.props).toEqual({ 'orbis/task_status': 'inbox', 'user/mood': 8 });
    // Внутренний id пользовательского свойства до модели НЕ доезжает (Р12).
    expect(Object.keys(row.props as object)).not.toContain('user/p-mood');
    expect(row.aspects).toEqual(['orbis/task']);
    expect(row.id).toBe(created.id);
    // Ни мешка, ни старой карты, ни служебных полей внутреннего wire.
    for (const gone of ['meta', 'aspectsMap', 'ownerId', 'queryRefs']) {
      expect(`${gone}: ${gone in row}`).toBe(`${gone}: false`);
    }
  });
});

describe('dispatchTool: политика подтверждений §7.10 (закрывает контракт-заглушку shared/contracts/confirmation-policy)', () => {
  test('archives инициативой AI (entity_update archived:true, explicitCommand=false) → pending_confirmation; ничего не исполнено', async () => {
    // Task 6: explicit-уровень создаёт pending-карточку (policy/pending) вместо
    // временной VALIDATION Task 5; сам pending-механизм покрыт policy/pending.test.ts —
    // здесь фиксируется контракт dispatch: status + card + отсутствие следа в графе/журнале.
    const host = await seedEntity(userA, { title: 'Хост-тред политики', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const target = await seedEntity(userA, { title: 'Кандидат на архив', tags: [] });

    const r = await dispatchTool(ctxFor({ threadId }), 'entity_update', {
      id: target.id,
      archived: true,
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;
    expect(r.card).toEqual({
      kind: 'confirmation_card',
      mode: 'explicit',
      pendingId: r.pendingId,
      summary: 'entity_update',
    });
    // §7.10: до подтверждения ничего не записано — ни в граф, ни в журнал; в тред
    // легла только карточка-запрос (без metadata.actions — это НЕ запись журнала §7.8)
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, target.id)),
    );
    expect(rows[0]?.archived).toBe(false);
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.id).toBe(r.pendingId);
    expect((msgs[0]?.metadata as { actions?: unknown }).actions).toBeUndefined();
  });

  test('batch из 11 архиваций → pending_confirmation (ряд archives); все сущности остались неархивированными', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push((await seedEntity(userA, { title: `Архив-${i}`, tags: ['pol-arch'] })).id);
    }
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: ids.map((id) => ({ tool: 'entity_update', input: { id, archived: true } })),
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status === 'pending_confirmation' && r.card.kind === 'confirmation_card') {
      expect(r.card.summary).toBe('11 операций');
    }
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(inArray(entities.id, ids)),
    );
    expect(rows.length).toBe(11);
    expect(rows.every((row) => row.archived === false)).toBe(true);
  });

  test('дедуп pending по batch_id: ретрай того же batch на explicit-уровне не плодит вторую карточку', async () => {
    // Minor-4 Task 6 закрыт не только протоколом pendingNote, но и БД: pendingId
    // детерминирован по batch_id (pendingMessageId) → повтор того же batch = ON CONFLICT.
    // Свежий владелец — глобальный тред пуст, поэтому счёт pending-карточек точен.
    const user = freshUserId();
    const ctx = ctxFor({ actorUserId: user });
    const target = await seedEntity(user, { title: 'Цель дедупа pending', tags: [] });
    const globalThreadId = await withIdentity(db, user, (tx) => ensureGlobalThread(tx, user));
    const call = {
      batch_id: newId(),
      operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
    };

    const r1 = await dispatchTool(ctx, 'batch_execute', call);
    expect(r1.status).toBe('pending_confirmation');
    const r2 = await dispatchTool(ctx, 'batch_execute', call); // ретрай ТОГО ЖЕ batch_id
    expect(r2.status).toBe('pending_confirmation');
    if (r1.status !== 'pending_confirmation' || r2.status !== 'pending_confirmation') return;

    // Детерминизм по batch_id: тот же pendingId (на старой логике — новый newId)
    expect(r2.pendingId).toBe(r1.pendingId);
    // В треде ровно одна pending-карточка — второй ретрай не создал дубль (ON CONFLICT)
    const pendings = (await messagesIn(user, globalThreadId)).filter(
      (m) => (m.metadata as { pending?: unknown }).pending !== undefined,
    );
    expect(pendings).toHaveLength(1);
    expect(pendings[0]?.id).toBe(r1.pendingId);
  });

  test('batch из 11 обычных операций → pending_confirmation (ряд масштаба > 10); ничего не создано', async () => {
    const ids = Array.from({ length: 11 }, () => newId());
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: ids.map((id, i) => ({
        tool: 'entity_create',
        input: { id, title: `Массовая-${i}`, tags: [] },
      })),
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;
    // ФОЛБЭК НЕ ПОТЕРЯН И СЧЁТ НЕ ЗАДВОЕН (ре-ревью фикс-раунда 1 Задачи 16). В этой пачке
    // сводке собираться не из чего — ни реестра, ни автономии, — и масштаб говорит
    // `pendingSummary`. Приписка «— в пачке из N» сюда не приезжает по построению: она живёт
    // в той же ветке, что и собранная сводка, а собранной сводки здесь нет.
    expect(r.card).toEqual({
      kind: 'confirmation_card',
      mode: 'explicit',
      pendingId: r.pendingId,
      summary: '11 операций',
    });
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, ids)),
    );
    expect(rows.length).toBe(0);
  });

  test('batch из 5 обычных операций → preview: ИСПОЛНЕН (сущности в БД) + card confirmation_card mode=preview, summary «5 операций»', async () => {
    const ids = Array.from({ length: 5 }, () => newId());
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: ids.map((id, i) => ({
        tool: 'entity_create',
        input: { id, title: `Превью-${i}`, tags: [] },
      })),
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect((r.result as unknown[]).length).toBe(5);
    expect(r.card).toEqual({ kind: 'confirmation_card', mode: 'preview', summary: '5 операций' });
    // §7.10: предпросмотр информационный, не блокирующий — действие уже исполнено
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, ids)),
    );
    expect(rows.length).toBe(5);
  });

  test('одиночная не-архивирующая мутация → уровень execute: исполняется немедленно, карточка entity_card постфактум', async () => {
    const r = await dispatchTool(ctxFor(), 'entity_create', { title: 'Уровень execute', tags: [] });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.card?.kind).toBe('entity_card');
  });

  test('fix round: schema-invalid entity_update с archived:true → честная VALIDATION с issues, НЕ pending (§7.10: уровень — ПОСЛЕ структурной валидации)', async () => {
    // Без envelope-валидации до классификации модель получала бы отказ уровня вместо
    // zod-issues (терялся путь самокоррекции), а pending создавался бы из
    // невалидированного payload'а — нарушение «executor применяет тот же payload,
    // который был провалидирован в момент запроса подтверждения» (§7.10)
    const target = await seedEntity(userA, { title: 'Невалидный патч', tags: [] });
    const r = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      archived: true,
      title: 123, // невалидный тип
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') {
      const details = r.error.details as { issues?: unknown[] };
      expect(Array.isArray(details.issues)).toBe(true);
    }
  });

  test('fix round: batch архиваций с невалидным uuid операции → VALIDATION с index/issues, НЕ pending', async () => {
    const ops = Array.from({ length: 11 }, () => ({
      tool: 'entity_update',
      input: { id: newId(), archived: true },
    }));
    ops[5] = { tool: 'entity_update', input: { id: 'не-uuid', archived: true } };
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: ops,
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') {
      const details = r.error.details as { index?: number; issues?: unknown[] };
      expect(details.index).toBe(5);
      expect(Array.isArray(details.issues)).toBe(true);
    }
  });
});

describe('dispatchTool: чтения без политики (§7.10, ряд «read → execute» — юнит классификатора)', () => {
  test('entity_query: список wire-сущностей + card query_result (count, entityIds, title из запроса)', async () => {
    const created = await seedEntity(userA, { title: 'Для поиска', tags: ['qtest'] });
    const r = await dispatchTool(ctxFor(), 'entity_query', {
      query: 'tags=qtest, title=Поиск',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const list = r.result as WireEntity[];
    expect(list.map((e) => e.id)).toEqual([created.id]);
    expect(r.card).toEqual({
      kind: 'query_result',
      title: 'Поиск',
      count: 1,
      entityIds: [created.id],
    });
  });

  test('entity_query: RLS — чужие сущности не видны', async () => {
    await seedEntity(userB, { title: 'Чужая', tags: ['qtest-b'] });
    const r = await dispatchTool(ctxFor(), 'entity_query', { query: 'tags=qtest-b' });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result as WireEntity[]).toHaveLength(0);
  });

  test('entity_query: ошибка грамматики → error/VALIDATION со структурой (§6.4)', async () => {
    const r = await dispatchTool(ctxFor(), 'entity_query', { query: 'nosuchfield=42' });
    expectError(r, 'VALIDATION');
  });

  // §А5-4: у тула два входа, и второй существует ради того, чего плоская строка НЕ
  // выражает, — дерева. Поэтому проверяется не «ast принимается», а что он отбирает и
  // где отказывает: схема канона на входе, реестр — компилятором.
  test('entity_query {ast}: дерево канона отбирает; {query}+{ast} вместе и неизвестный id — VALIDATION', async () => {
    const inbox = await seedEntity(userA, {
      title: 'Дерево: inbox',
      tags: ['qtest-ast'],
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    });
    await seedEntity(userA, {
      title: 'Дерево: done',
      tags: ['qtest-ast'],
      props: { 'orbis/task_status': 'done' },
      aspects: ['orbis/task'],
    });

    // `(статус inbox ИЛИ planned) И тег` — плоской строкой §А5-3 такое не пишется.
    const ok = await dispatchTool(ctxFor(), 'entity_query', {
      ast: {
        filter: {
          and: [
            { tag: 'qtest-ast' },
            {
              or: [
                { prop: 'orbis/task_status', op: 'eq', value: 'inbox' },
                { prop: 'orbis/task_status', op: 'eq', value: 'planned' },
              ],
            },
          ],
        },
        title: 'Дерево',
      },
    });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    expect((ok.result as WireEntity[]).map((e) => e.id)).toEqual([inbox.id]);
    // Проекция читается из того же дерева — карточка не знает, текстом её просили или ast.
    expect((ok.card as { title?: string }).title).toBe('Дерево');

    // Два входа сразу — два разных запроса в одном вызове; молчаливый победитель был бы
    // отбором «не того» (§С8-3).
    expectError(
      await dispatchTool(ctxFor(), 'entity_query', {
        query: 'tags=qtest-ast',
        ast: { filter: null },
      }),
      'VALIDATION',
    );
    // Ни одного — тоже отказ, а не «весь граф».
    expectError(await dispatchTool(ctxFor(), 'entity_query', {}), 'VALIDATION');

    // Схема канона стоит на входе: узел с чужим ключом до компилятора не доезжает.
    expectError(
      await dispatchTool(ctxFor(), 'entity_query', { ast: { filter: { нетtакого: 1 } } }),
      'VALIDATION',
    );

    // А вот РЕЕСТР проверяет компилятор — id, которого в нём нет, даёт UNKNOWN_FIELD.
    const unknown = await dispatchTool(ctxFor(), 'entity_query', {
      ast: { filter: { prop: 'orbis/нетtакого', op: 'eq', value: 'x' } },
    });
    expectError(unknown, 'VALIDATION');
    if (unknown.status === 'error') {
      expect((unknown.error.details as { reason?: string }).reason).toBe('UNKNOWN_FIELD');
    }

    // Форма литерала — тоже до SQL: 'банан' рядом с ::date дал бы ошибку Postgres.
    const badForm = await dispatchTool(ctxFor(), 'entity_query', {
      ast: { filter: { prop: 'orbis/due_date', op: 'eq', value: 'банан' } },
    });
    expectError(badForm, 'VALIDATION');
    if (badForm.status === 'error') {
      expect((badForm.error.details as { reason?: string }).reason).toBe('TYPE');
    }
  });

  // Глубина входа `ast:` стережётся ЯВНЫМ капом ДО схемы и до компиляции. Ниже по
  // конвейеру её не остановить ничем: zod рекурсивен и исчерпывает стек внутри safeParse,
  // а то, что через него проходит, компилируется в цепочку `NOT COALESCE(…)`, на которой
  // отвечает уже парсер Postgres (исчерпание его собственного стека) — не ExecError, мимо
  // всех catch'ей. Между двумя порогами лежала ПОЛОСА, где наружу уходил сырой обрыв;
  // проверяются обе её стороны и середина.
  test('entity_query {ast}: глубже капа — VALIDATION/QUERY_TOO_DEEP на всех порядках', async () => {
    const nested = (n: number) => {
      let filter: unknown = { tag: 'дом' };
      for (let i = 0; i < n; i++) filter = { not: filter };
      return { ast: { filter } };
    };
    // 5500 — середина той самой полосы. Числа порогов НЕ пиннятся: они свойства чужого
    // кода (версия zod, сборка Postgres, размер кадра) и поедут без нашего ведома. Пиннится
    // то, что теперь верно на любой их стороне: отказ структурный на всех порядках глубины.
    for (const depth of [70, 5500, 8000]) {
      const r = await dispatchTool(ctxFor(), 'entity_query', nested(depth));
      expectError(r, 'VALIDATION');
      if (r.status === 'error') {
        expect(`${depth}: ${(r.error.details as { reason?: string }).reason}`).toBe(
          `${depth}: QUERY_TOO_DEEP`,
        );
      }
    }
    // Кап отвергает ГЛУБИНУ, а не вложенность вообще: дерево вдвое мельче капа работает.
    const ok = await dispatchTool(ctxFor(), 'entity_query', nested(20));
    expect(ok.status).toBe('ok');
    // Меряется ДЕРЕВО, а не конверт: `{ast:{filter: chain(n)}}` даёт n+2 уровня AST,
    // поэтому последняя законная цепочка — на два короче капа, а следующая уже отвергнута.
    // Пара соседних, а не «мелкое ок / огромное отказ»: иначе граница не запинена.
    expect((await dispatchTool(ctxFor(), 'entity_query', nested(62))).status).toBe('ok');
    expect((await dispatchTool(ctxFor(), 'entity_query', nested(63))).status).toBe('error');
    // Текст отказа называет ровно ту величину, которую код и меряет, — сам кап.
    const refused = await dispatchTool(ctxFor(), 'entity_query', nested(63));
    if (refused.status === 'error') expect(refused.error.message).toContain('64');
  });

  // Мост старой грамматики удалён (Задача 21b) вместе с последним текстом, написанным ею.
  // Проверяется не «упало», а ФОРМА ОТКАЗА: старое имя поля обязано получить `UNKNOWN_FIELD`
  // с позицией, а не молчаливый ноль результатов (§А5-3ж) — молчание модель истолковала бы
  // как «таких сущностей нет» и пошла бы дальше по неверной ветке.
  test('entity_query: старая форма текста — отказ с позицией, а не пустая выдача', async () => {
    const created = await seedEntity(userA, {
      title: 'Мост',
      tags: ['qtest-bridge'],
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    });
    // Вторая сущность под тем же тегом — КОНТРОЛЬ: без неё «условие по статусу отработало»
    // и «условие молча выброшено» дают один и тот же ответ на выборке из одной строки.
    await seedEntity(userA, {
      title: 'Мост: закрытая',
      tags: ['qtest-bridge'],
      props: { 'orbis/task_status': 'done' },
      aspects: ['orbis/task'],
    });
    const ids = async (query: string) => {
      const r = await dispatchTool(ctxFor(), 'entity_query', { query });
      expect(r.status).toBe('ok');
      return r.status === 'ok' ? (r.result as WireEntity[]).map((e) => e.id) : [];
    };
    // Key-форма: условие по статусу ОТСЕИВАЕТ закрытую, а не просто «не падает».
    expect(await ids('tags=qtest-bridge, orbis/task_status=inbox')).toEqual([created.id]);
    expect((await ids('tags=qtest-bridge')).length).toBe(2);

    const legacy = await dispatchTool(ctxFor(), 'entity_query', {
      query: 'tags=qtest-bridge, aspect=orbis/task, status=inbox',
    });
    expect(legacy.status).toBe('error');
    if (legacy.status === 'error') {
      expect(legacy.error.message).toContain("'status'");
      expect((legacy.error.details as { reason?: string }).reason).toBe('UNKNOWN_FIELD');
      expect((legacy.error.details as { position?: number }).position).toBeGreaterThan(0);
    }
  });

  test('entity_get: include по умолчанию body+relations; несуществующий id → NOT_FOUND', async () => {
    const created = await seedEntity(userA, { title: 'Читаемая', tags: [] });
    const r = await dispatchTool(ctxFor(), 'entity_get', { id: created.id });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      const out = r.result as { entity: WireEntity; relations?: unknown[]; backlinks?: unknown };
      expect(out.entity.id).toBe(created.id);
      expect(Array.isArray(out.relations)).toBe(true);
      expect(out.backlinks).toBeUndefined();
    }

    const missing = await dispatchTool(ctxFor(), 'entity_get', { id: newId() });
    expectError(missing, 'NOT_FOUND');
  });
});

describe('dispatchTool: import_csv_start — вход в импорт из чата (Task C4c, 03-budget §3.4)', () => {
  /** Число сущностей и строк entity_origins владельца — СЫРЫМ админ-соединением (мимо RLS). */
  async function rawWriteCounts(user: string): Promise<{ entities: number; origins: number }> {
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = (await admin.execute(sql`
        SELECT
          (SELECT count(*)::int FROM entities WHERE owner_id = ${user}) AS entities,
          (SELECT count(*)::int FROM entity_origins WHERE owner_id = ${user}) AS origins
      `)) as unknown as Array<{ entities: number; origins: number }>;
      return { entities: rows[0]?.entities ?? 0, origins: rows[0]?.origins ?? 0 };
    } finally {
      await adminClient.end();
    }
  }

  test('source=chat → status ok и карточка import_review (форма — дословно web-тип ImportReviewData)', async () => {
    const r = await dispatchTool(ctxFor(), 'import_csv_start', {});
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // Литеральная сверка формы целиком (toEqual): карточки сервера и web-типы
    // НАМЕРЕННО не общие — расхождение имени поля с ImportReviewData
    // (apps/web/src/features/chat/cards/types.ts) клиент молча не отрисует
    expect(r.card).toEqual({ kind: 'import_review' });
  });

  test('гейт §8: отказ резолвера import.csv → LIMIT, карточки нет', async () => {
    // Денайл-путь через инъецируемый шов ctx.entitlements (тот же приём, что у роутера
    // импорта после ac44b05): боевой резолвер плана dev всё разрешает, и без шва эта
    // ветка была бы непокрываемой.
    const r = await dispatchTool(
      ctxFor({
        entitlements: (_user, key) =>
          key === 'import.csv' ? { allowed: false, limit: 0 } : { allowed: true, limit: null },
      }),
      'import_csv_start',
      {},
    );
    expectError(r, 'LIMIT');
    expect('card' in r).toBe(false);
  });

  test('internalOnly fail-closed: source=mcp → структурная ошибка, карточки нет', async () => {
    const r = await dispatchTool(
      ctxFor({ actorKind: 'agent', source: 'mcp' }),
      'import_csv_start',
      {},
    );
    expectError(r, 'VALIDATION');
    expect('card' in r).toBe(false);
  });

  test('строгий пустой envelope: лишнее поле → VALIDATION', async () => {
    const r = await dispatchTool(ctxFor(), 'import_csv_start', { file: 'statement.csv' });
    expectError(r, 'VALIDATION');
  });

  test('тул ничего не пишет: число entities и строк entity_origins владельца не изменилось', async () => {
    const before = await rawWriteCounts(userA);
    const r = await dispatchTool(ctxFor(), 'import_csv_start', {});
    expect(r.status).toBe('ok');
    const after = await rawWriteCounts(userA);
    expect(after).toEqual(before);
  });
});

describe('dispatchTool: undo_last — «отмени последнее» словами в чате (хвост V1, Д-1; §7.8)', () => {
  // Свой владелец: «последнее» считается по ВСЕМУ журналу владельца, и общий userA дал бы
  // порядок, зависящий от соседних describe
  const userU = freshUserId();
  const chat = (over: Partial<ToolCallCtx> = {}) => ctxFor({ actorUserId: userU, ...over });

  async function archivedOf(id: string): Promise<boolean | undefined> {
    const rows = await withIdentity(db, userU, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
    );
    return rows[0]?.archived;
  }

  test('source=chat, актор ai: снимает последнее видимое действие журнала (fast_path владельца), результат — что откачено; повтор → «отменять нечего»', async () => {
    // Действие владельца из другой поверхности (fast_path, журнал с синком): «отмени
    // последнее» в чате обязано достать и его — журнал один на владельца
    const created = await execute(
      db,
      {
        actorUserId: userU,
        actorKind: 'owner',
        source: 'fast_path',
        operations: [{ tool: 'entity_create', input: { title: 'Обед 340', tags: [] } }],
      },
      { sink: makeChatJournalSink() },
    );
    if (!created.ok) throw new Error(created.error.message);
    const entity = created.results[0] as WireEntity;
    expect(await archivedOf(entity.id)).toBe(false);

    const r = await dispatchTool(chat(), 'undo_last', {});
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // Нового action undo не порождает (неотменяем) — actionId в результате диспатча НЕТ,
    // иначе send-message завёл бы на него ActionSummary как на undo-адресуемое действие
    expect(r.actionId).toBeUndefined();
    expect(r.card).toBeUndefined();
    const result = r.result as Record<string, unknown>;
    expect(result.undone).toBe(true);
    expect(result.actionId).toBe(created.actionId);
    expect(result.type).toBe('entity_created');
    expect(result.entityId).toBe(entity.id);
    expect(String(result.title)).toContain('Обед 340');
    // Inverse применён: создание снято архивом
    expect(await archivedOf(entity.id)).toBe(true);

    // Второй раз отменять нечего — штатный ok, не error_card
    const again = await dispatchTool(chat(), 'undo_last', {});
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect((again.result as Record<string, unknown>).undone).toBe(false);
  });

  test('системные действия пропускаются: последнее видимое — правка чата (source chat, актор ai)', async () => {
    const target = await seedEntity(userU, { title: 'Правка чатом', tags: [] });
    const edited = await dispatchTool(chat(), 'entity_update', {
      id: target.id,
      title: 'Правка чатом (переименовано)',
    });
    expect(edited.status).toBe('ok');
    // Системная запись поверх — как материализация §5.4: «отмени последнее» её не берёт
    const sys = await execute(
      db,
      {
        actorUserId: userU,
        actorKind: 'ai',
        source: 'system',
        operations: [{ tool: 'entity_create', input: { title: 'Системный след', tags: [] } }],
      },
      { sink: makeChatJournalSink() },
    );
    if (!sys.ok) throw new Error(sys.error.message);

    const r = await dispatchTool(chat(), 'undo_last', {});
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const result = r.result as Record<string, unknown>;
    expect(result.undone).toBe(true);
    expect(result.actionId).toBe(edited.status === 'ok' ? edited.actionId : undefined);
    const rows = await withIdentity(db, userU, (tx) =>
      tx.select({ title: entities.title }).from(entities).where(eq(entities.id, target.id)),
    );
    expect(rows[0]?.title).toBe('Правка чатом');
    expect(await archivedOf((sys.results[0] as WireEntity).id)).toBe(false);
  });

  test('internalOnly fail-closed: source=mcp → VALIDATION; от прогона рутины → FORBIDDEN_LEVEL (закрыт и в act с allowed_tools [undo_last]); чат не-ai актором → FORBIDDEN_LEVEL', async () => {
    const before = await execute(
      db,
      {
        actorUserId: userU,
        actorKind: 'owner',
        source: 'fast_path',
        operations: [{ tool: 'entity_create', input: { title: 'Не трогать', tags: [] } }],
      },
      { sink: makeChatJournalSink() },
    );
    if (!before.ok) throw new Error(before.error.message);
    const untouched = (before.results[0] as WireEntity).id;

    expectError(
      await dispatchTool(chat({ actorKind: 'agent', source: 'mcp' }), 'undo_last', {}),
      'VALIDATION',
    );
    const { routineCtx } = agentLoopHelpers(db);
    for (const mode of ['propose', 'act'] as const) {
      expectError(
        await dispatchTool(routineCtx(userU, mode, ['undo_last']), 'undo_last', {}),
        'FORBIDDEN_LEVEL',
      );
    }
    // Вторая линия самого диспатча: чат, но актор не ai (контекст собран не тем вызывающим)
    expectError(
      await dispatchTool(chat({ actorKind: 'owner' }), 'undo_last', {}),
      'FORBIDDEN_LEVEL',
    );
    // Ничего не откачено
    expect(await archivedOf(untouched)).toBe(false);
  });

  test('строгий пустой envelope: лишнее поле → VALIDATION', async () => {
    expectError(await dispatchTool(chat(), 'undo_last', { id: newId() }), 'VALIDATION');
  });
});

describe('dispatchTool: user_query — агрегация SQL-ем (решение 7, §3.3 точность)', () => {
  beforeAll(async () => {
    for (const amount of ['100.50', '200.25']) {
      await seedEntity(userA, {
        title: `Расход ${amount}`,
        tags: ['uqtest'],
        props: {
          'orbis/amount': amount,
          'orbis/direction': 'expense',
          'orbis/finance_category': CATEGORY_REF,
          'orbis/occurred_on': '2026-07-01',
        },
        aspects: ['orbis/financial'],
      });
    }
  });

  test('sum по amount: decimal-строка без потери точности + card.aggregate', async () => {
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'aspect=orbis/financial, tags=uqtest',
      aggregate: 'sum',
      field: 'orbis/amount',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.result).toBe('300.75');
    expect(r.card).toEqual({
      kind: 'query_result',
      count: 2,
      entityIds: [],
      aggregate: { op: 'sum', value: '300.75' },
    });
  });

  test('limit из query игнорируется агрегацией (агрегат по всей выборке)', async () => {
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'aspect=orbis/financial, tags=uqtest, limit=1',
      aggregate: 'sum',
      field: 'orbis/amount',
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result).toBe('300.75');
  });

  test('count: число сущностей выборки; field не требуется', async () => {
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'aspect=orbis/financial, tags=uqtest',
      aggregate: 'count',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.result).toBe(2);
    expect(r.card).toEqual({
      kind: 'query_result',
      count: 2,
      entityIds: [],
      aggregate: { op: 'count', value: '2' },
    });
  });

  test('count по children_of=this без контекста сущности → структурная VALIDATION, не throw (fix round)', async () => {
    // QueryCompileError count-пути обязан мапиться в error-результат, как в sum/entity_query
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'children_of=this',
      aggregate: 'count',
    });
    expectError(r, 'VALIDATION');
  });

  test('internalOnly fail-closed: user_query при source=mcp → структурная ошибка (fix round)', async () => {
    // Не полагаемся только на фильтрацию списка тулов в MCP-адаптере (Task 10)
    const r = await dispatchTool(ctxFor({ actorKind: 'agent', source: 'mcp' }), 'user_query', {
      query: 'aspect=orbis/financial, tags=uqtest',
      aggregate: 'count',
    });
    expectError(r, 'VALIDATION');
  });

  test('sum без field → VALIDATION; sum по нечисловому полю → VALIDATION; неизвестное поле → VALIDATION', async () => {
    const base = { query: 'aspect=orbis/financial, tags=uqtest' };
    expectError(
      await dispatchTool(ctxFor(), 'user_query', { ...base, aggregate: 'sum' }),
      'VALIDATION',
    );
    expectError(
      await dispatchTool(ctxFor(), 'user_query', { ...base, aggregate: 'sum', field: 'direction' }),
      'VALIDATION',
    );
    expectError(
      await dispatchTool(ctxFor(), 'user_query', {
        ...base,
        aggregate: 'sum',
        field: 'nosuchfield',
      }),
      'VALIDATION',
    );
  });
});

describe('dispatchTool: user_query материализует окно запроса (обязательство ревью A3, §5.4)', () => {
  // Свой пользователь: до вызова user_query у него НЕТ ни одного инстанса — сумма
  // видна только если сам вызов материализовал окно (тот же каркас, что entity_query)
  const userC = freshUserId();
  const tz = 'Europe/Moscow'; // дефолт queryContext без строки user_settings
  const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const tomorrow = (() => {
    const [y, m, d] = localToday.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  })();

  test('user_query c occurred_on=next_7d видит суммы свеже-материализованных инстансов', async () => {
    await seedEntity(userC, {
      title: 'Абонемент',
      tags: [],
      props: {
        'orbis/start_at': `${tomorrow}T12:00:00+03:00`,
        'orbis/timezone': tz,
        'orbis/recurrence': { freq: 'weekly', interval: 1 },
        'orbis/amount': '150.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': CATEGORY_REF_C,
        'orbis/recurring': true,
      },
      aspects: ['orbis/schedule', 'orbis/financial'],
    });
    const r = await dispatchTool(ctxFor({ actorUserId: userC }), 'user_query', {
      query: 'aspect=orbis/financial, orbis/occurred_on=next_7d',
      aggregate: 'sum',
      field: 'orbis/amount',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // еженедельно с завтра: в окне next_7d ровно один инстанс (шаблон без occurred_on
    // в выборку не попадает) — сумма именно свеже-материализованного инстанса
    expect(r.result).toBe('150.00');

    const count = await dispatchTool(ctxFor({ actorUserId: userC }), 'user_query', {
      query: 'aspect=orbis/financial, orbis/occurred_on=next_7d',
      aggregate: 'count',
    });
    expect(count.status).toBe('ok');
    if (count.status === 'ok') expect(count.result).toBe(1);
  });
});

describe('dispatchTool: thread_post — сообщение в тред сущности мимо executor', () => {
  test('agent/mcp: сообщение role=user с metadata.author_kind=agent; action НЕ журналится', async () => {
    const target = await seedEntity(userA, { title: 'Задача агента', tags: [] });
    const r = await dispatchTool(ctxFor({ actorKind: 'agent', source: 'mcp' }), 'thread_post', {
      entity_id: target.id,
      content: 'Начал работу над задачей.',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    const threadId = entityThreadId(userA, target.id);
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[0]?.content).toBe('Начал работу над задачей.');
    // пометка автора-агента; журналирования action нет — сообщение и есть артефакт
    expect(msgs[0]?.metadata).toEqual({ author_kind: 'agent' });
  });

  // V1.6: у поста в треде теперь два не-владельческих автора — внешний агент и
  // внутренний исполнитель рутины. Оба помечаются, иначе владелец не отличит их
  // заметку от своей; прогон в run_id связывает пост с историей рутины.
  test('внутренний AI (actorKind=ai) с runId: пометка author_kind=ai и run_id прогона', async () => {
    const target = await seedEntity(userA, { title: 'Задача AI', tags: [] });
    const runId = newId();
    const r = await dispatchTool(ctxFor({ runId }), 'thread_post', {
      entity_id: target.id,
      content: 'Заметка от AI.',
    });
    expect(r.status).toBe('ok');
    const msgs = await messagesIn(userA, entityThreadId(userA, target.id));
    expect(msgs[0]?.metadata).toEqual({ author_kind: 'ai', run_id: runId });
  });

  // Прогон рутины помечается вдвойне: run_id ведёт в историю прогона, routine_id — в саму
  // рутину. Одного run_id не хватило бы ленте: чтобы назвать автора, ей пришлось бы
  // сходить за прогоном вторым запросом.
  test('прогон рутины: пометка author_kind=ai, run_id прогона и routine_id рутины', async () => {
    const { routineCtx } = agentLoopHelpers(db);
    const target = await seedEntity(userA, { title: 'Задача рутины', tags: [] });
    // thread_post — мутирующий тул: рутине он открыт только белым списком режима act
    const ctx = routineCtx(userA, 'act', ['thread_post'], { clock: () => T0 });
    const r = await dispatchTool(ctx, 'thread_post', {
      entity_id: target.id,
      content: 'Заметка от рутины.',
    });
    expect(r.status).toBe('ok');
    const msgs = await messagesIn(userA, entityThreadId(userA, target.id));
    expect(msgs[0]?.metadata).toEqual({
      author_kind: 'ai',
      run_id: ctx.runId,
      routine_id: ctx.routine.id,
    });
  });

  test('владелец (actorKind=owner): metadata пустая — помечать автором самого владельца нечего', async () => {
    const target = await seedEntity(userA, { title: 'Задача владельца', tags: [] });
    const r = await dispatchTool(ctxFor({ actorKind: 'owner' }), 'thread_post', {
      entity_id: target.id,
      content: 'Заметка владельца.',
    });
    expect(r.status).toBe('ok');
    const msgs = await messagesIn(userA, entityThreadId(userA, target.id));
    expect(msgs[0]?.metadata).toEqual({});
  });

  test('несуществующая и чужая (RLS) сущность → единый NOT_FOUND', async () => {
    expectError(
      await dispatchTool(ctxFor({ actorKind: 'agent', source: 'mcp' }), 'thread_post', {
        entity_id: newId(),
        content: 'x',
      }),
      'NOT_FOUND',
    );
    const foreign = await seedEntity(userB, { title: 'Чужая задача', tags: [] });
    expectError(
      await dispatchTool(ctxFor({ actorKind: 'agent', source: 'mcp' }), 'thread_post', {
        entity_id: foreign.id,
        content: 'x',
      }),
      'NOT_FOUND',
    );
  });

  test('невалидный envelope (пустой content) → VALIDATION', async () => {
    const target = await seedEntity(userA, { title: 'Задача', tags: [] });
    expectError(
      await dispatchTool(ctxFor(), 'thread_post', { entity_id: target.id, content: '' }),
      'VALIDATION',
    );
  });

  test('идемпотентность по client-id (id): ретрай с тем же id не создаёт второй пост (ON CONFLICT §2.1)', async () => {
    const target = await seedEntity(userA, { title: 'Задача ретрая', tags: [] });
    const msgId = newId();
    const ctx = ctxFor({ actorKind: 'agent', source: 'mcp' });
    const r1 = await dispatchTool(ctx, 'thread_post', {
      id: msgId,
      entity_id: target.id,
      content: 'Заметка №1',
    });
    expect(r1.status).toBe('ok');
    // Ретрай с тем же id (и даже иным content) — исходный пост, append-only §4.6
    const r2 = await dispatchTool(ctx, 'thread_post', {
      id: msgId,
      entity_id: target.id,
      content: 'Заметка №1 (ретрай)',
    });
    expect(r2.status).toBe('ok');
    if (r1.status !== 'ok' || r2.status !== 'ok') return;
    expect((r2.result as { id: string }).id).toBe((r1.result as { id: string }).id);

    // Ровно один пост в треде; content — исходный (правок нет)
    const msgs = await messagesIn(userA, entityThreadId(userA, target.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.id).toBe(msgId);
    expect(msgs[0]?.content).toBe('Заметка №1');
  });
});

// ---------------------------------------------------------------------------
// Скоуп worker (С7, §4.14): гейт доступа ДО любой записи + сужение thread_post
// ---------------------------------------------------------------------------

describe('dispatchTool: скоуп worker — fail-closed гейт доступа (С7, §4.14)', () => {
  const owner = freshUserId();
  let grantId: string;
  let ticket: WireEntity;
  let project: WireEntity;
  let note: WireEntity;

  /** Контекст вызова от имени фонового исполнителя (MCP + грант со скоупом worker). */
  const worker = () =>
    ctxFor({
      actorUserId: owner,
      actorKind: 'agent',
      source: 'mcp',
      grant: { id: grantId, scope: 'worker', label: 'w' },
    });

  beforeAll(async () => {
    // Грант выдаётся штатным путём (Задача 8 научила issuePatGrant области): инвариант
    // assertAssignment требует ЖИВОГО гранта владельца, а вставка строки руками обходила
    // бы ровно тот код, которым скоуп теперь и записывается.
    const token = await issuePatGrant(db, {
      ownerId: owner,
      label: 'worker-тест',
      scope: 'worker',
    });
    const identity = await verifyBearer(db, token);
    if (identity === null) throw new Error('выданный worker-PAT не прошёл verifyBearer');
    grantId = identity.grantId;
    project = await seedEntity(owner, {
      title: 'Проект исполнителя',
      tags: [],
      props: { 'orbis/project_stage': 'active' },
      aspects: ['orbis/project'],
    });
    ticket = await seedEntity(owner, {
      title: 'Тикет исполнителя',
      tags: [],
      props: {
        'orbis/task_status': 'planned',
        'orbis/executor': 'agent',
        'orbis/grant': grantId,
      },
      aspects: ['orbis/task', 'orbis/assignment'],
    });
    note = await seedEntity(owner, { title: 'Личная заметка владельца', tags: [] });
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'relation_create',
          input: { source_id: project.id, target_id: ticket.id, role: 'ticket' },
        },
      ],
    });
    if (!r.ok) throw new Error(`сид связи проект→тикет: ${r.error.code} ${r.error.message}`);
  });

  test('worker: entity_update / attach_orbis_task / batch_execute → FORBIDDEN_LEVEL, ничего не записано', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      [
        'entity_update',
        {
          id: ticket.id,
          props: { 'orbis/task_status': 'done' },
          aspects: { attach: ['orbis/task'] },
        },
      ],
      ['attach_orbis_task', { entity_id: ticket.id, data: { 'orbis/task_status': 'done' } }],
      [
        'batch_execute',
        {
          batch_id: newId(),
          operations: [
            {
              tool: 'entity_update',
              input: {
                id: ticket.id,
                props: { 'orbis/task_status': 'done' },
                aspects: { attach: ['orbis/task'] },
              },
            },
          ],
        },
      ],
      ['entity_create', { title: 'Сущность мимо назначения', tags: [] }],
      ['relation_delete', { source_id: project.id, target_id: ticket.id, role: 'ticket' }],
    ];
    for (const [name, input] of calls) {
      expectError(await dispatchTool(worker(), name, input), 'FORBIDDEN_LEVEL');
    }
    // Гейт стоит ДО записи: статус тикета не изменился, связь проект→тикет на месте
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ props: entities.props }).from(entities).where(eq(entities.id, ticket.id)),
    );
    expect((rows[0]?.props as Record<string, unknown>)['orbis/task_status']).toBe('planned');
  });

  test('worker: entity_get / entity_query / budget_status исполняются', async () => {
    const got = await dispatchTool(worker(), 'entity_get', { id: ticket.id });
    expect(got.status).toBe('ok');
    const queried = await dispatchTool(worker(), 'entity_query', { query: 'aspect=orbis/task' });
    expect(queried.status).toBe('ok');
    const budget = await dispatchTool(worker(), 'budget_status', {});
    expect(budget.status).toBe('ok');
  });

  test('worker: thread_post в тред назначенного тикета и его проекта — ок; в тред чужой заметки — FORBIDDEN_LEVEL', async () => {
    const onTicket = await dispatchTool(worker(), 'thread_post', {
      entity_id: ticket.id,
      content: 'Взял тикет в работу.',
    });
    expect(onTicket.status).toBe('ok');
    const onProject = await dispatchTool(worker(), 'thread_post', {
      entity_id: project.id,
      content: 'Сводка по проекту.',
    });
    expect(onProject.status).toBe('ok');
    // Заметка владельца исполнителю не назначена — отказ, и до записи: тред пуст
    expectError(
      await dispatchTool(worker(), 'thread_post', {
        entity_id: note.id,
        content: 'не моя заметка',
      }),
      'FORBIDDEN_LEVEL',
    );
    expect(await messagesIn(owner, entityThreadId(owner, note.id))).toHaveLength(0);
  });

  test('worker: thread_post в НЕСУЩЕСТВУЮЩИЙ id → FORBIDDEN_LEVEL, а не NOT_FOUND', async () => {
    // Отличать «нет такой записи» от «не твоя» исполнителю не положено: иначе периметр
    // превращается в оракул чужого графа — перебором id можно было бы узнать, что у
    // владельца есть, а чего нет. Проверка периметра стоит ДО ensureEntityThread.
    expectError(
      await dispatchTool(worker(), 'thread_post', { entity_id: newId(), content: 'в никуда' }),
      'FORBIDDEN_LEVEL',
    );
  });

  test('worker: thread_post в АРХИВИРОВАННЫЙ назначенный тикет → FORBIDDEN_LEVEL', async () => {
    const archivedTicket = await seedEntity(owner, {
      title: 'Тикет, убранный в архив',
      tags: [],
      props: {
        'orbis/task_status': 'planned',
        'orbis/executor': 'agent',
        'orbis/grant': grantId,
      },
      aspects: ['orbis/task', 'orbis/assignment'],
    });
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: archivedTicket.id, archived: true } }],
    });
    if (!r.ok) throw new Error(`архивация тикета: ${r.error.code} ${r.error.message}`);

    // Архив — «убрано с глаз»: периметр записи исполнителя за ним не тянется
    expectError(
      await dispatchTool(worker(), 'thread_post', {
        entity_id: archivedTicket.id,
        content: 'пишу в архив',
      }),
      'FORBIDDEN_LEVEL',
    );
    expect(await messagesIn(owner, entityThreadId(owner, archivedTicket.id))).toHaveLength(0);
  });

  test('НЕЗНАКОМОЕ значение scope сужает доступ так же, как worker (fail-closed, С7)', async () => {
    // Колонка `scope` — text: значение в неё могло лечь мимо нашего перечисления (ручная
    // правка, откат миграции, будущий скоуп на старом коде). verifyBearer отдаёт его КАК
    // ЕСТЬ, а гейт обязан читать «не full → не полный доступ». Сравнение с одним лишь
    // 'worker' открыло бы такому гранту весь граф — ровно наоборот.
    const token = await issuePatGrant(db, { ownerId: owner, label: 'скоуп из будущего' });
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.execute(
        sql`UPDATE agent_grants SET scope = 'foo' WHERE owner_id = ${owner}::uuid AND label = 'скоуп из будущего'`,
      );
    } finally {
      await adminClient.end();
    }
    const identity = await verifyBearer(db, token);
    if (identity === null) throw new Error('PAT с незнакомым скоупом не прошёл verifyBearer');
    // verifyBearer не нормализует значение — иначе гейт проверялся бы на подделке
    expect(String(identity.scope)).toBe('foo');

    const unknownScope = ctxFor({
      actorUserId: owner,
      actorKind: 'agent',
      source: 'mcp',
      grant: { id: identity.grantId, scope: identity.scope, label: identity.label },
    });
    expectError(
      await dispatchTool(unknownScope, 'entity_update', {
        id: ticket.id,
        props: { 'orbis/task_status': 'done' },
        aspects: { attach: ['orbis/task'] },
      }),
      'FORBIDDEN_LEVEL',
    );
    // …и это не «отказ всему»: чтения и глаголы такому гранту открыты, как worker'у
    expect((await dispatchTool(unknownScope, 'entity_get', { id: ticket.id })).status).toBe('ok');
    expect((await dispatchTool(unknownScope, 'orbis_my_queue', {})).status).toBe('ok');
  });

  test('скоуп full сужению thread_post не подчиняется: пишет в любой свой тред', async () => {
    const r = await dispatchTool(
      ctxFor({
        actorUserId: owner,
        actorKind: 'agent',
        source: 'mcp',
        grant: { id: grantId, scope: 'full', label: 'f' },
      }),
      'thread_post',
      { entity_id: note.id, content: 'Полный доступ пишет куда угодно в графе владельца.' },
    );
    expect(r.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Глаголы исполнителя: уровень execute на самом dispatch (инвариант 4, §9.3)
// ---------------------------------------------------------------------------

/**
 * Инвариант 4 проверяется здесь ПОВЕДЕНИЕМ диспатча, а не только классификатором
 * (юниты — policy/confirmation.test.ts): между таблицей §7.10 и ответом агенту лежат
 * гейт скоупа, envelope-валидация, `levelGate` и явная ветка «level !== execute» — и
 * pending мог бы родиться на любом из этих шагов. Поэтому круг гоняется целиком: у
 * фонового прогона нет человека, который нажал бы «подтвердить».
 */
describe('dispatchTool: глаголы исполнителя никогда не дают pending (инвариант 4, §9.3)', () => {
  const owner = freshUserId();
  let grantId: string;
  let projectId: string;

  /** Контекст фонового исполнителя: MCP + грант worker, без явной команды человека. */
  const workerCtx = () =>
    ctxFor({
      actorUserId: owner,
      actorKind: 'agent',
      source: 'mcp',
      explicitCommand: false, // за вызовом агента прямой команды владельца нет
      grant: { id: grantId, scope: 'worker', label: 'w' },
    });

  /** Тикет, назначенный этому гранту, — вход круга. */
  async function seedTicket(title: string): Promise<string> {
    const ticket = await seedEntity(owner, {
      title,
      tags: [],
      props: {
        'orbis/task_status': 'planned',
        'orbis/executor': 'agent',
        'orbis/grant': grantId,
      },
      aspects: ['orbis/task', 'orbis/assignment'],
    });
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'relation_create',
          input: { source_id: projectId, target_id: ticket.id, role: 'ticket' },
        },
      ],
    });
    if (!r.ok) throw new Error(`сид связи проект→тикет: ${r.error.code} ${r.error.message}`);
    return ticket.id;
  }

  /** Вызов глагола + сверка «ok и НЕ pending» одним местом; отдаёт result глагола. */
  async function verb(
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await dispatchTool(workerCtx(), name, input);
    // Сначала — сам инвариант: pending недопустим ни при каком исходе глагола
    expect(r.status).not.toBe('pending_confirmation');
    if (r.status !== 'ok') throw new Error(`«${name}»: ожидался ok, получено ${JSON.stringify(r)}`);
    return r.result as Record<string, unknown>;
  }

  beforeAll(async () => {
    const token = await issuePatGrant(db, { ownerId: owner, label: 'круг', scope: 'worker' });
    const identity = await verifyBearer(db, token);
    if (identity === null) throw new Error('выданный worker-PAT не прошёл verifyBearer');
    grantId = identity.grantId;
    projectId = (
      await seedEntity(owner, {
        title: 'Проект круга',
        tags: [],
        body: '## Процесс\n\nВетка, тесты, отчёт.\n',
        props: { 'orbis/project_stage': 'active' },
        aspects: ['orbis/project'],
      })
    ).id;
  });

  test('круг my_queue → claim → step → checkpoint: каждый глагол исполнен, ни одного pending', async () => {
    const ticketId = await seedTicket('Тикет до чекпойнта');

    const queue = await verb('orbis_my_queue', {});
    expect((queue.tickets as Array<{ id: string }>).some((t) => t.id === ticketId)).toBe(true);

    const claimed = await verb('orbis_claim_task', { ticket_id: ticketId });
    const runId = claimed.run_id as string;
    expect(claimed.replayed).toBe(false);

    const stepped = await verb('orbis_run_step', { run_id: runId, summary: 'Прочитал задание' });
    expect(stepped.step_count).toBe(1);

    const checked = await verb('orbis_checkpoint', {
      run_id: runId,
      question: 'Какой подход выбрать?',
    });
    expect(checked.ticket_status).toBe('waiting');
  });

  test('круг claim → step → finish на новом тикете: те же execute, ни одного pending', async () => {
    const ticketId = await seedTicket('Тикет до итога');

    const claimed = await verb('orbis_claim_task', { ticket_id: ticketId });
    const runId = claimed.run_id as string;
    await verb('orbis_run_step', { run_id: runId, summary: 'Починил парсер' });

    const finished = await verb('orbis_finish', { run_id: runId, report: 'Готово, проверь' });
    expect(finished.ticket_id).toBe(ticketId);
    // Тикет закрывает не агент (С8): без may_close итог уводит тикет на проверку
    expect(finished.ticket_status).toBe('waiting');
  });

  test('карточки подтверждения глагол не порождает: во всех тредах владельца ни одной pending-записи', async () => {
    // Сверка по состоянию, а не по возвращённому статусу: pending — это ЗАПИСЬ в тред
    // (policy/pending), и «status не pending» ещё не значит «карточка не легла».
    // RLS скоупит chat_messages владельцем — счёт точен по всему его журналу.
    const rows = await withIdentity(db, owner, (tx) =>
      tx.execute(
        sql`SELECT
              count(*) FILTER (WHERE metadata @> '{"pending": {}}'::jsonb)::int AS pendings,
              count(*) FILTER (WHERE metadata @> '{"actions": []}'::jsonb)::int AS audits
            FROM chat_messages`,
      ),
    );
    const { pendings, audits } = rows[0] as { pendings: number; audits: number };
    expect(pendings).toBe(0);
    // Не вырожденно: круги выше действительно писали в журнал этого владельца —
    // «ноль карточек» здесь означает «глаголы исполнились», а не «ничего не было»
    expect(audits).toBeGreaterThan(0);
  });

  test('глагол без гранта (чат/UI-контекст) → VALIDATION: прогон адресуется конкретному доступу (agentOnly)', async () => {
    // Вторая линия гейта agentOnly: реестр чата такие дефы отсекает сам
    // (ai/send-message.ts), но диспатч обязан отказать любому вызывающему без гранта —
    // иначе прогон было бы не к кому отнести
    for (const [name, input] of [
      ['orbis_my_queue', {}],
      ['orbis_claim_task', { ticket_id: newId() }],
      ['orbis_run_step', { run_id: newId(), summary: 'шаг мимо гранта' }],
      ['orbis_checkpoint', { run_id: newId(), question: 'вопрос мимо гранта?' }],
      ['orbis_finish', { run_id: newId(), report: 'итог мимо гранта' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await dispatchTool(ctxFor({ actorUserId: owner }), name, input);
      expectError(r, 'VALIDATION');
    }
  });
});

describe('CAS-предусловие не протекает в путь модели (dispatch/MCP)', () => {
  // Тул-контракт модели не растёт ради сервера: precondition живёт в exec-схеме
  // executor'а, а вход модели и MCP идёт через strict-схему тула (entityUpdateInput) —
  // лишний ключ режется ДО классификации §7.10 и до executor'а. Соседи по смыслу —
  // «bodyDoc не протекает в путь модели» (executor/body-doc.test.ts).
  const PRECONDITION = [{ property: 'orbis/task_status', in: ['planned'] }];

  test('одиночный entity_update с precondition от модели — VALIDATION, правка не применена', async () => {
    const target = await seedEntity(userA, {
      title: 'Тикет модели',
      tags: [],
      props: { 'orbis/task_status': 'planned' },
      aspects: ['orbis/task'],
    });
    const r = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      precondition: PRECONDITION,
      props: { 'orbis/task_status': 'in_progress' },
      aspects: { attach: ['orbis/task'] },
    });
    expectError(r, 'VALIDATION');
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select().from(entities).where(eq(entities.id, target.id)),
    );
    expect((rows[0]?.props as Record<string, unknown>)['orbis/task_status']).toBe('planned');
  });

  test('precondition внутри операции batch_execute — VALIDATION с индексом операции', async () => {
    const target = await seedEntity(userA, {
      title: 'Тикет модели в batch',
      tags: [],
      props: { 'orbis/task_status': 'planned' },
      aspects: ['orbis/task'],
    });
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: target.id,
            precondition: PRECONDITION,
            props: { 'orbis/task_status': 'in_progress' },
            aspects: { attach: ['orbis/task'] },
          },
        },
      ],
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') {
      expect((r.error.details as { index: number; tool: string }).index).toBe(0);
      expect((r.error.details as { index: number; tool: string }).tool).toBe('entity_update');
    }
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select().from(entities).where(eq(entities.id, target.id)),
    );
    expect((rows[0]?.props as Record<string, unknown>)['orbis/task_status']).toBe('planned');
  });
});

describe('Внутренние операции версий недостижимы из пути модели (С11, §9.2)', () => {
  // Закрепление и удаление версии живут в exec-схемах executor'а и в CORE_TOOLS не
  // регистрируются: единственный вход — роутер version (рука владельца). Проверка не
  // декоративна — у precondition и bodyDoc такая же граница уже закреплена тестами выше,
  // а у версий закрытость держалась только на том, что имён нет в реестре.
  for (const tool of ['entity_version_pin', 'entity_version_delete']) {
    test(`batch_execute с операцией ${tool} → VALIDATION «неизвестный тул операции»`, async () => {
      const target = await seedEntity(userA, { title: `Цель ${tool}`, tags: [] });
      const r = await dispatchTool(ctxFor(), 'batch_execute', {
        batch_id: newId(),
        operations: [{ tool, input: { entity_id: target.id, id: newId(), label: 'из модели' } }],
      });
      expectError(r, 'VALIDATION');
      if (r.status === 'error') {
        expect((r.error.details as { index: number; tool: string }).tool).toBe(tool);
      }
    });

    test(`одиночный вызов ${tool} → неизвестный тул (структурный отказ, не исполнение)`, async () => {
      const r = await dispatchTool(ctxFor(), tool, { entity_id: newId(), label: 'из модели' });
      expect(r.status).toBe('error');
      if (r.status === 'error') expect(r.error.message).toContain('неизвест');
    });
  }
});

describe('V1: выдача автономии рутине из чата → pending_confirmation (V1.10, инвариант 7)', () => {
  /** Рутина в минимальной валидной форме (V1.1). */
  /**
   * Рутина СВОЙСТВАМИ (§А9-1) — форма, которой говорят тулы: `props` у create/update и
   * `data` у `attach_*`; ею же фикстуры `seedEntity` идут через `execute`.
   */
  const routineProps = (over: Record<string, unknown> = {}) => ({
    'orbis/routine_stage': 'active',
    'orbis/routine_at': '07:00',
    'orbis/routine_mode': 'propose',
    ...over,
  });

  /** Список аспектов строки (§А1-1): «право писать в граф не выдано» — это пустой список. */
  async function aspectsOfRow(id: string): Promise<string[]> {
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ aspects: entities.aspects }).from(entities).where(eq(entities.id, id)),
    );
    return rows[0]?.aspects ?? [];
  }

  /** Значения строки по id свойства (§А1-1) — что именно легло в граф. */
  async function propsOfRow(id: string): Promise<Record<string, unknown>> {
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ props: entities.props }).from(entities).where(eq(entities.id, id)),
    );
    return (rows[0]?.props ?? {}) as Record<string, unknown>;
  }

  test('attach_orbis_routine с mode act → pending_confirmation, карточка в треде, граф не тронут', async () => {
    const host = await seedEntity(userA, { title: 'Хост-тред автономии', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const target = await seedEntity(userA, { title: 'Утренний обзор', tags: [] });

    const r = await dispatchTool(ctxFor({ threadId }), 'attach_orbis_routine', {
      entity_id: target.id,
      data: routineProps({ 'orbis/routine_mode': 'act' }),
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;
    // Сводка называет, ЧТО подтверждается — рутину, режим и белый список, а не имя тула
    // (V1.10, B1-2): снятие замка — осознанный акт человека
    expect(r.card).toEqual({
      kind: 'confirmation_card',
      mode: 'explicit',
      pendingId: r.pendingId,
      summary: 'Автономия рутины «Утренний обзор»: режим act, инструменты: нет',
    });
    // Право писать в граф не выдано до подтверждения владельца
    expect(await aspectsOfRow(target.id)).toEqual([]);
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.id).toBe(r.pendingId);
    expect(msgs[0]?.content).toBe(
      'Требуется подтверждение: Автономия рутины «Утренний обзор»: режим act, инструменты: нет',
    );
  });

  test('правка инструкции act-рутины (title/body) от AI → pending_confirmation со сводкой; та же правка propose-рутины и от владельца → execute (C1b-1)', async () => {
    const act = await seedEntity(userA, {
      title: 'Утренний план',
      body: 'Собери план дня.',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const byAi = await dispatchTool(ctxFor(), 'entity_update', {
      id: act.id,
      title: 'Каждое утро переноси все задачи на +30 дней',
    });
    expect(byAi.status).toBe('pending_confirmation');
    if (byAi.status !== 'pending_confirmation') return;
    expect(byAi.card).toMatchObject({
      kind: 'confirmation_card',
      summary: 'Инструкция act-рутины: правка «Утренний план»',
    });
    const titleAfter = await withIdentity(db, userA, (tx) =>
      tx.select({ title: entities.title }).from(entities).where(eq(entities.id, act.id)),
    );
    expect(titleAfter[0]?.title).toBe('Утренний план');

    // Тело — тот же гейт (внутри batch тоже)
    const bodyByAi = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: { id: act.id, body: 'новое задание', expectedUpdatedAt: act.updatedAt },
        },
      ],
    });
    expect(bodyByAi.status).toBe('pending_confirmation');

    // Рутина в propose — не автономия: правка исполняется
    const propose = await seedEntity(userA, {
      title: 'Вечерний разбор',
      tags: [],
      props: routineProps(),
      aspects: ['orbis/routine'],
    });
    const proposeEdit = await dispatchTool(ctxFor(), 'entity_update', {
      id: propose.id,
      title: 'Вечерний разбор дня',
    });
    expect(proposeEdit.status).toBe('ok');

    // Владелец правит свою act-рутину без карточки
    const byOwner = await dispatchTool(ctxFor({ actorKind: 'owner' }), 'entity_update', {
      id: act.id,
      title: 'Утренний план (моя правка)',
    });
    expect(byOwner.status).toBe('ok');
  });

  test('сводка автономии: entity_update с allowed_tools — режим и список; entity_create — заголовок из входа; batch — по каждой выдающей операции', async () => {
    const target = await seedEntity(userA, {
      title: 'Вечерний разбор',
      tags: [],
      props: routineProps(),
      aspects: ['orbis/routine'],
    });
    const upd = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      props: {
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update', 'thread_post'],
      },
    });
    expect(upd.status).toBe('pending_confirmation');
    if (upd.status !== 'pending_confirmation') return;
    expect(upd.card).toMatchObject({
      summary:
        'Автономия рутины «Вечерний разбор»: режим act, инструменты: entity_update, thread_post',
    });

    const created = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Ночной сбор',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_create'],
      }),
      aspects: ['orbis/routine'],
    });
    expect(created.status).toBe('pending_confirmation');
    if (created.status !== 'pending_confirmation') return;
    expect(created.card).toMatchObject({
      summary: 'Автономия рутины «Ночной сбор»: режим act, инструменты: entity_create',
    });

    const batch = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: target.id, title: 'Переименовано' } },
        {
          tool: 'entity_update',
          input: { id: target.id, props: { 'orbis/allowed_tools': [] } },
        },
      ],
    });
    expect(batch.status).toBe('pending_confirmation');
    if (batch.status !== 'pending_confirmation') return;
    expect(batch.card).toMatchObject({
      summary: 'Автономия рутины «Вечерний разбор»: инструменты: нет — в пачке из 2 операции',
    });
  });

  test('сводка НАЗЫВАЕТ СНЯТИЕ: unset доверенности даёт карточку с текстом, а не пустую (N-1)', async () => {
    // Фикс-раунд 1 научил замок видеть `unset`, а сводка осталась читать только `props`:
    // вызов поднимал уровень и отдавал ПУСТУЮ строку — владелец видел «Требуется
    // подтверждение: » и карточку без единого сведения о том, что он подтверждает.
    const armed = await seedEntity(userA, {
      title: 'Утренний обзор',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });

    // A. Только снятие белого списка.
    const stripOnly = await dispatchTool(ctxFor(), 'entity_update', {
      id: armed.id,
      unset: ['orbis/allowed_tools'],
    });
    expect(stripOnly.status).toBe('pending_confirmation');
    if (stripOnly.status !== 'pending_confirmation') return;
    expect(stripOnly.card).toMatchObject({
      summary: 'Автономия рутины «Утренний обзор»: снимает белый список',
    });
    // Строка ленты — её владелец читает раньше карточки, и она обязана нести ТО ЖЕ. Тред
    // берётся тот, в который пишет `createPending`: `ctxFor()` без `threadId` кладёт запись
    // в ГЛОБАЛЬНЫЙ тред, и прежняя проверка (по треду сущности, отрицанием) читала пустой
    // массив — она не могла провалиться ни при какой мутации сводки.
    const feed = await messagesIn(
      userA,
      await withIdentity(db, userA, (tx) => ensureGlobalThread(tx, userA)),
    );
    expect(feed.find((m) => m.id === stripOnly.pendingId)?.content).toBe(
      'Требуется подтверждение: Автономия рутины «Утренний обзор»: снимает белый список',
    );

    // B. Смешанный патч: карточка обязана назвать И выдачу, И снятие — прежде она
    // рассказывала МЕНЬШЕ, чем делает вызов.
    const mixed = await dispatchTool(ctxFor(), 'entity_update', {
      id: armed.id,
      props: { 'orbis/routine_mode': 'act' },
      unset: ['orbis/allowed_tools'],
    });
    expect(mixed.status).toBe('pending_confirmation');
    if (mixed.status !== 'pending_confirmation') return;
    expect(mixed.card).toMatchObject({
      summary: 'Автономия рутины «Утренний обзор»: режим act, снимает белый список',
    });

    // C. Снятие режима называется своим именем, а не «белым списком».
    const mode = await dispatchTool(ctxFor(), 'entity_update', {
      id: armed.id,
      unset: ['orbis/routine_mode'],
    });
    expect(mode.status).toBe('pending_confirmation');
    if (mode.status !== 'pending_confirmation') return;
    expect(mode.card).toMatchObject({
      summary: 'Автономия рутины «Утренний обзор»: снимает режим',
    });

    // Граф не тронут ни одним из трёх: уровень explicit — до approve ничего не пишется.
    const after = await propsOfRow(armed.id);
    expect(after['orbis/routine_mode']).toBe('act');
    expect(after['orbis/allowed_tools']).toEqual(['entity_update']);
  });

  test('РАЗОРУЖЕНИЕ ЗАМЕНОЙ НОСИТЕЛЯ: attach без allowed_tools на вооружённой рутине → подтверждение (Р-12-2)', async () => {
    // `attach_*` заменяет носитель целиком (§А7-4): свойство, не названное в `data`,
    // снимается. По ФОРМЕ вызова этого не видно — различает только состояние цели.
    const armed = await seedEntity(userA, {
      title: 'Вооружённая рутина',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_create'],
      }),
      aspects: ['orbis/routine'],
    });

    const disarm = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: armed.id,
      data: routineProps(), // mode propose, белый список НЕ назван → он будет стёрт
    });
    expect(disarm.status).toBe('pending_confirmation');
    if (disarm.status !== 'pending_confirmation') return;
    expect(disarm.card).toMatchObject({
      summary: 'Автономия рутины «Вооружённая рутина»: режим propose, снимает белый список',
    });
    // Ничего не записано: белый список на месте, режим прежний.
    const kept = await propsOfRow(armed.id);
    expect(kept['orbis/allowed_tools']).toEqual(['entity_create']);
    expect(kept['orbis/routine_mode']).toBe('act');

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: тот же вызов на БЕЗОРУЖНОЙ рутине снимать нечего — он
    // исполняется без карточки. Без этой половины проба ловила бы любой attach подряд.
    const plain = await seedEntity(userA, {
      title: 'Безоружная рутина',
      tags: [],
      props: routineProps(),
      aspects: ['orbis/routine'],
    });
    const harmless = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: plain.id,
      data: routineProps(),
    });
    expect(harmless.status).toBe('ok');

    // И третья: признак носителя обязателен (Р9) — запись со значениями доверенности, но
    // БЕЗ аспекта рутины, разоружаемой рутиной не считается.
    const ghost = await seedEntity(userA, { title: 'Бывшая рутина', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({ props: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] } })
        .where(eq(entities.id, ghost.id)),
    );
    const onGhost = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: ghost.id,
      data: routineProps(),
    });
    expect(onGhost.status).toBe('ok');
  });

  test('ЭХО ДОВЕРЕННОСТИ через attach: повтор белого списка и гашение режима → подтверждение (фикс-раунд 3)', async () => {
    // Проба «пропало ли свойство» ловила только СНЯТИЕ. Модель делает `entity_get`, видит
    // белый список и повторяет его эхом в `data` — свойство на месте, а act-режим гаснет тем
    // же вызовом и МОЛЧА. Тот же переход через `entity_update` карточку требовал: замок
    // держал смысл на одном пути и не держал на соседнем.
    const armed = await seedEntity(userA, {
      title: 'Эхо-рутина',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_create'],
      }),
      aspects: ['orbis/routine'],
    });
    const echo = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: armed.id,
      data: routineProps({
        'orbis/routine_mode': 'propose',
        'orbis/allowed_tools': ['entity_create'],
      }),
    });
    expect(echo.status).toBe('pending_confirmation');
    if (echo.status !== 'pending_confirmation') return;
    expect(echo.card).toMatchObject({
      summary: 'Автономия рутины «Эхо-рутина»: режим propose, инструменты: entity_create',
    });
    expect((await propsOfRow(armed.id))['orbis/routine_mode']).toBe('act');

    // ОБЕСЦЕНИВАНИЕ БЕЗ СНЯТИЯ: белого списка у рутины нет вовсе, снимать нечего — гаснет
    // ТОЛЬКО режим, и «снятого» в разнице с состоянием по-прежнему ноль.
    const actOnly = await seedEntity(userA, {
      title: 'Только режим',
      tags: [],
      props: routineProps({ 'orbis/routine_mode': 'act' }),
      aspects: ['orbis/routine'],
    });
    const quench = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: actOnly.id,
      data: routineProps(),
    });
    expect(quench.status).toBe('pending_confirmation');
    if (quench.status !== 'pending_confirmation') return;
    expect(quench.card).toMatchObject({
      summary: 'Автономия рутины «Только режим»: режим propose, инструменты: нет',
    });
    expect((await propsOfRow(actOnly.id))['orbis/routine_mode']).toBe('act');

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: тот же attach на propose-рутине без белого списка ничего в
    // доверенности не меняет → исполняется молча. Без неё проба ловила бы любой attach.
    const same = await seedEntity(userA, {
      title: 'Ничего не меняет',
      tags: [],
      props: routineProps(),
      aspects: ['orbis/routine'],
    });
    const noop = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: same.id,
      data: routineProps(),
    });
    expect(noop.status).toBe('ok');
  });

  test('ВООРУЖЕНИЕ БЕЗ act: attach/create, НАЗЫВАЮЩИЕ белый список, — выдача доверенности (двухшаговая эскалация)', async () => {
    // Шаг 1 двухшаговой эскалации: модель молча расширяет доверенность (`propose` +
    // белый список), шаг 2 просит только режим — и карточка вооружения про инструменты
    // молчит по правилу «у update молчание значит прежний». Владелец подтверждал `act`,
    // не увидев, ЧЕМ рутина вооружена.
    const target = await seedEntity(userA, { title: 'Тихое вооружение', tags: [] });
    const step1 = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: target.id,
      data: routineProps({ 'orbis/allowed_tools': ['entity_create', 'entity_update'] }),
    });
    expect(step1.status).toBe('pending_confirmation');
    if (step1.status !== 'pending_confirmation') return;
    expect(step1.card).toMatchObject({
      summary:
        'Автономия рутины «Тихое вооружение»: режим propose, инструменты: entity_create, entity_update',
    });
    expect(await aspectsOfRow(target.id)).toEqual([]);

    // Тот же смысл через `entity_create` — тот же ответ: носитель здесь тоже кладётся
    // ЦЕЛИКОМ, и propose-рутина, рождённая сразу с белым списком, это то же вооружение.
    const created = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Рождена вооружённой',
      tags: [],
      props: routineProps({ 'orbis/allowed_tools': ['entity_create'] }),
      aspects: ['orbis/routine'],
    });
    expect(created.status).toBe('pending_confirmation');
    if (created.status !== 'pending_confirmation') return;
    expect(created.card).toMatchObject({
      summary: 'Автономия рутины «Рождена вооружённой»: режим propose, инструменты: entity_create',
    });

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: обычная propose-рутина белого списка не называет — ни один
    // из двух путей карточки не требует. Иначе правило ловило бы всякое заведение рутины.
    const plainAttach = await seedEntity(userA, { title: 'Обычная через attach', tags: [] });
    const okAttach = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: plainAttach.id,
      data: routineProps(),
    });
    expect(okAttach.status).toBe('ok');
    const okCreate = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Обычная через create',
      tags: [],
      props: routineProps(),
      aspects: ['orbis/routine'],
    });
    expect(okCreate.status).toBe('ok');
  });

  test('СНЯТИЕ АСПЕКТА РУТИНЫ: detach у вооружённой → подтверждение, у безоружной → ok (четвёртый путь)', async () => {
    // `aspects.detach` значений НЕ трогает (Р9): режим и белый список уцелеют в `props`, а
    // рутина исчезнет из носителей — то есть перестанет работать. Для владельца это то же
    // разоружение, только четвёртым путём.
    const armed = await seedEntity(userA, {
      title: 'Рутина под снос',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const detach = await dispatchTool(ctxFor(), 'entity_update', {
      id: armed.id,
      aspects: { detach: ['orbis/routine'] },
    });
    expect(detach.status).toBe('pending_confirmation');
    if (detach.status !== 'pending_confirmation') return;
    expect(detach.card).toMatchObject({
      summary: 'Автономия рутины «Рутина под снос»: снимает аспект рутины',
    });
    expect(await aspectsOfRow(armed.id)).toContain('orbis/routine');

    // Вооружённость белым списком — тоже вооружённость: режим propose, но инструменты выданы.
    const listed = await seedEntity(userA, {
      title: 'Только список',
      tags: [],
      props: routineProps({ 'orbis/allowed_tools': ['entity_update'] }),
      aspects: ['orbis/routine'],
    });
    const detachListed = await dispatchTool(ctxFor(), 'entity_update', {
      id: listed.id,
      aspects: { detach: ['orbis/routine'] },
    });
    expect(detachListed.status).toBe('pending_confirmation');

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ, ГРУБАЯ: у БЕЗОРУЖНОЙ рутины (propose, свойства списка нет)
    // снятие аспекта доверенности не касается — исполняется молча.
    const unarmed = await seedEntity(userA, {
      title: 'Безоружная под снос',
      tags: [],
      props: routineProps(),
      aspects: ['orbis/routine'],
    });
    const ok = await dispatchTool(ctxFor(), 'entity_update', {
      id: unarmed.id,
      aspects: { detach: ['orbis/routine'] },
    });
    expect(ok.status).toBe('ok');
    expect(await aspectsOfRow(unarmed.id)).toEqual([]);

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ, ТОНКАЯ: список ЕСТЬ, но ПУСТ. Ровно это и есть решение
    // `autonomyArmed` («пустой список вооружением не считается»), и без этого ряда мутация
    // `tools.length >= 0` выживала: грубая сторона выше её не различает.
    const emptyList = await seedEntity(userA, {
      title: 'Пустой список под снос',
      tags: [],
      props: routineProps({ 'orbis/allowed_tools': [] }),
      aspects: ['orbis/routine'],
    });
    // Фикстура обязана НЕСТИ проверяемое: если бы сид потерял ключ, ряд стал бы копией грубого.
    expect((await propsOfRow(emptyList.id))['orbis/allowed_tools']).toEqual([]);
    const okEmpty = await dispatchTool(ctxFor(), 'entity_update', {
      id: emptyList.id,
      aspects: { detach: ['orbis/routine'] },
    });
    expect(okEmpty.status).toBe('ok');
    expect(await aspectsOfRow(emptyList.id)).toEqual([]);
  });

  test('ПУСТОЙ белый список — не вооружение: один ответ у набора и у состояния (фикс-раунд 4)', async () => {
    // Набор отвечал «выдача» (свойство названо), состояние — «безоружна» (список пуст):
    // владельца просили подтвердить выдачу НИЧЕГО — «инструменты: нет». Ответ теперь один,
    // и считает его одна функция `autonomyArmed`.
    const viaAttach = await seedEntity(userA, { title: 'Пустой список через attach', tags: [] });
    const attachEmpty = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: viaAttach.id,
      data: routineProps({ 'orbis/allowed_tools': [] }),
    });
    expect(attachEmpty.status).toBe('ok');

    const createEmpty = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Пустой список через create',
      tags: [],
      props: routineProps({ 'orbis/allowed_tools': [] }),
      aspects: ['orbis/routine'],
    });
    expect(createEmpty.status).toBe('ok');

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: тот же вход с ОДНИМ элементом — выдача, карточка обязательна.
    const one = await seedEntity(userA, { title: 'Один инструмент', tags: [] });
    const attachOne = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: one.id,
      data: routineProps({ 'orbis/allowed_tools': ['entity_create'] }),
    });
    expect(attachOne.status).toBe('pending_confirmation');

    // И третья: ОПУСТОШЕНИЕ непустого списка заменой носителя — разоружение, карточка нужна.
    // «Пустой список не вооружает» и «опустошить список можно молча» — разные утверждения.
    const armed = await seedEntity(userA, {
      title: 'Опустошаемая',
      tags: [],
      props: routineProps({ 'orbis/allowed_tools': ['entity_create'] }),
      aspects: ['orbis/routine'],
    });
    const emptied = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: armed.id,
      data: routineProps({ 'orbis/allowed_tools': [] }),
    });
    expect(emptied.status).toBe('pending_confirmation');
    if (emptied.status !== 'pending_confirmation') return;
    expect(emptied.card).toMatchObject({
      summary: 'Автономия рутины «Опустошаемая»: режим propose, инструменты: нет',
    });
    expect((await propsOfRow(armed.id))['orbis/allowed_tools']).toEqual(['entity_create']);
  });

  test('карточка честно называет ОБЪЕКТ: свойства доверенности на записи без аспекта рутины — не «автономия рутины»', async () => {
    // Значения живут независимо от аспекта (Р9), поэтому модель вправе положить белый список
    // на что угодно. Уровень это поднимает (значения вооружат запись, как только аспект
    // появится), но карточка «Автономия рутины «Не рутина»» врала про объект.
    const created = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Не рутина',
      tags: [],
      props: { 'orbis/allowed_tools': ['entity_create'] },
    });
    expect(created.status).toBe('pending_confirmation');
    if (created.status !== 'pending_confirmation') return;
    expect(created.card).toMatchObject({
      summary: 'Свойства доверенности рутины на записи «Не рутина»: инструменты: entity_create',
    });

    // Правка ЖИВОЙ записи без аспекта рутины — тем же языком.
    const note = await seedEntity(userA, { title: 'Просто заметка', tags: [] });
    const upd = await dispatchTool(ctxFor(), 'entity_update', {
      id: note.id,
      props: { 'orbis/routine_mode': 'act' },
    });
    expect(upd.status).toBe('pending_confirmation');
    if (upd.status !== 'pending_confirmation') return;
    expect(upd.card).toMatchObject({
      summary: 'Свойства доверенности рутины на записи «Просто заметка»: режим act',
    });

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: тот же набор С аспектом рутины — «Автономия рутины», и
    // навешивание аспекта ТОЙ ЖЕ операцией (aspects.attach) считается наравне.
    const asRoutine = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Настоящая рутина',
      tags: [],
      props: routineProps({ 'orbis/allowed_tools': ['entity_create'] }),
      aspects: ['orbis/routine'],
    });
    expect(asRoutine.status).toBe('pending_confirmation');
    if (asRoutine.status !== 'pending_confirmation') return;
    expect(asRoutine.card).toMatchObject({
      summary: 'Автономия рутины «Настоящая рутина»: режим propose, инструменты: entity_create',
    });
    const becomes = await dispatchTool(ctxFor(), 'entity_update', {
      id: note.id,
      props: { 'orbis/routine_mode': 'act' },
      aspects: { attach: ['orbis/routine'] },
    });
    expect(becomes.status).toBe('pending_confirmation');
    if (becomes.status !== 'pending_confirmation') return;
    // ОЖИДАНИЕ ПЕРЕПИСЫВАЕТСЯ ВТОРОЙ РАЗ, И ЭТО СКАЗАНО ВСЛУХ. Раунд 5 добавил сюда фразу
    // «навешивает аспект рутины»; раунд 7 её УБРАЛ, и это СУЖЕНИЕ поведения, принятого ревью.
    // Причина: проба теперь спрашивает не выключатель по отдельности, а ОТБОР ЦЕЛИКОМ, а у
    // этой заметки нет `orbis/routine_stage` — навесив аспект, она рутиной РАБОТАТЬ не станет
    // и в `activeRoutines` не попадёт. Оживления не случилось, называть его нечем; правку
    // доверенности карточка по-прежнему называет — её держит гейт формы.
    // Дыры сужение не открывает: сторона ниже показывает, что вызов, который РЕАЛЬНО включает
    // такую запись, карточку требует.
    expect(becomes.card).toMatchObject({
      summary: 'Автономия рутины «Просто заметка»: режим act',
    });
    // Тот самый вызов: стадии не было — вызов ставит рабочую, и запись оживает вооружённой.
    // Слово выбрано по прежнему значению: «переводит в рабочую стадию», а не «снимает паузу» —
    // на паузе она не стояла.
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({
          aspects: ['orbis/routine'],
          props: { 'orbis/routine_at': '07:00', 'orbis/routine_mode': 'act' },
        })
        .where(eq(entities.id, note.id)),
    );
    const switchOn = await dispatchTool(ctxFor(), 'entity_update', {
      id: note.id,
      props: { 'orbis/routine_stage': 'active' },
    });
    expect(switchOn.status).toBe('pending_confirmation');
    if (switchOn.status !== 'pending_confirmation') return;
    expect(switchOn.card).toMatchObject({
      // Сводка называет ИТОГОВУЮ доверенность (режим act), а не свойства патча — в патче одна
      // стадия. Ровно за этим `revives` и несёт значения, а не флаг.
      summary: 'Автономия рутины «Просто заметка»: режим act, переводит в рабочую стадию',
    });
  });

  test('НАВЕШИВАНИЕ АСПЕКТА на боевые значения → подтверждение; на мирные — ok (шестой путь, Р-12-5)', async () => {
    // Значения доверенности переживают снятие аспекта (Р9) и живут на любой записи, поэтому
    // «сделай эту запись рутиной» — самостоятельный акт вооружения, даже когда в патче нет ни
    // одного свойства. Сценарий: владелец подтвердил «снимает аспект рутины» и считает рутину
    // убранной — модель следующим вызовом бесшумно возвращала её вооружённой.
    const ghost = await seedEntity(userA, { title: 'Бывшая act-рутина', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({
          props: {
            'orbis/routine_stage': 'active',
            'orbis/routine_at': '07:00',
            'orbis/routine_mode': 'act',
            'orbis/allowed_tools': ['entity_update'],
          },
        })
        .where(eq(entities.id, ghost.id)),
    );
    const revive = await dispatchTool(ctxFor(), 'entity_update', {
      id: ghost.id,
      aspects: { attach: ['orbis/routine'] },
    });
    expect(revive.status).toBe('pending_confirmation');
    if (revive.status !== 'pending_confirmation') return;
    // Карточка называет, ЧЕМ оживает рутина: свойств в патче НЕТ ни одного, значения итоговые.
    // ОЖИДАНИЕ РАСШИРЕНО ФИКС-РАУНДОМ 9, И ЭТО СКАЗАНО ВСЛУХ: тот же вызов теперь называет и
    // то, что ТЕЛО записи с этого мига — инструкция act-рутины. Права и текст собрались молча
    // (act-режим лежал на записи, вызов вернул носитель) — ровно зазор, который раунд 9 закрыл.
    expect(revive.card).toMatchObject({
      summary:
        'Автономия рутины «Бывшая act-рутина»: режим act, инструменты: entity_update, навешивает аспект рутины; Инструкция act-рутины: тело «Бывшая act-рутина» становится инструкцией',
    });
    expect(await aspectsOfRow(ghost.id)).toEqual([]);

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: та же форма вызова на МИРНЫХ значениях (propose, списка нет) —
    // обычное заведение рутины, исполняется молча. Отличие от ряда выше ровно одно: значения.
    const calm = await seedEntity(userA, { title: 'Бывшая propose-рутина', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({
          props: {
            'orbis/routine_stage': 'active',
            'orbis/routine_at': '07:00',
            'orbis/routine_mode': 'propose',
          },
        })
        .where(eq(entities.id, calm.id)),
    );
    const plain = await dispatchTool(ctxFor(), 'entity_update', {
      id: calm.id,
      aspects: { attach: ['orbis/routine'] },
    });
    expect(plain.status).toBe('ok');
    expect(await aspectsOfRow(calm.id)).toEqual(['orbis/routine']);

    // ТРЕТЬЯ СТОРОНА: уровень считается по ИТОГОВОМУ состоянию, а не по одной половине вызова.
    // `props` здесь доверенности не касается (время запуска), поэтому гейт формы молчит —
    // ответить обязано состояние.
    const both = await seedEntity(userA, { title: 'Оживляемая с расписанием', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({
          props: {
            'orbis/routine_stage': 'active',
            'orbis/routine_at': '07:00',
            'orbis/routine_mode': 'act',
          },
        })
        .where(eq(entities.id, both.id)),
    );
    const withSchedule = await dispatchTool(ctxFor(), 'entity_update', {
      id: both.id,
      props: { 'orbis/routine_at': '09:00' },
      aspects: { attach: ['orbis/routine'] },
    });
    expect(withSchedule.status).toBe('pending_confirmation');

    // …и в обратную сторону: тот же вызов СНИМАЕТ боевой режим тем же патчем — итог мирный.
    // (Карточку он всё равно требует: патч трогает доверенность, и это ветка формы, не
    // состояния. Здесь важно, что проба носителя на итоге не настаивает на своём «вооружает».)
    const disarming = await dispatchTool(ctxFor(), 'entity_update', {
      id: both.id,
      props: { 'orbis/routine_mode': 'propose' },
      aspects: { attach: ['orbis/routine'] },
    });
    expect(disarming.status).toBe('pending_confirmation');
    if (disarming.status !== 'pending_confirmation') return;
    expect(disarming.card).toMatchObject({
      summary: 'Автономия рутины «Оживляемая с расписанием»: режим propose',
    });

    // ЧЕТВЁРТАЯ: аспект УЖЕ на строке — навешивать нечего, доверенность не двигается.
    const already = await seedEntity(userA, {
      title: 'Уже рутина',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const noop = await dispatchTool(ctxFor(), 'entity_update', {
      id: already.id,
      aspects: { attach: ['orbis/routine'] },
    });
    expect(noop.status).toBe('ok');
  });

  test('ВОЗВРАТ ИЗ АРХИВА вооружённой act-рутины → подтверждение; обычной записи и безоружной — ok (седьмой путь, Р-12-6)', async () => {
    // Отбор прогонов (`activeRoutines`) требует трёх условий: аспект, stage active и NOT
    // archived. Замок держал первое (Р-12-5) и не держал третье: `entity_update
    // {archived:false}` возвращал вооружённую act-рутину в работу молча — ряд §7.10 смотрит
    // только `archived === true`. Воспроизведено живьём до правки: status ok, карточки нет.
    async function archive(id: string): Promise<void> {
      await withIdentity(db, userA, (tx) =>
        tx.update(entities).set({ archived: true }).where(eq(entities.id, id)),
      );
    }
    async function archivedOfRow(id: string): Promise<boolean | undefined> {
      const rows = await withIdentity(db, userA, (tx) =>
        tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
      );
      return rows[0]?.archived;
    }

    const armed = await seedEntity(userA, {
      title: 'Архивная вооружённая',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    await archive(armed.id);
    const revive = await dispatchTool(ctxFor(), 'entity_update', {
      id: armed.id,
      archived: false,
    });
    expect(revive.status).toBe('pending_confirmation');
    if (revive.status !== 'pending_confirmation') return;
    // Карточка называет, ЧЕМ рутина возвращается в работу: свойств в патче нет ни одного.
    expect(revive.card).toMatchObject({
      summary:
        'Автономия рутины «Архивная вооружённая»: режим act, инструменты: entity_update, возвращает из архива',
    });
    expect(await archivedOfRow(armed.id)).toBe(true);

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ, БЕЗОРУЖНАЯ РУТИНА: та же форма вызова, отличие ровно одно —
    // значения мирные. Возвращать в работу propose-рутину модель вправе молча.
    const calm = await seedEntity(userA, {
      title: 'Архивная propose-рутина',
      tags: [],
      props: routineProps(),
      aspects: ['orbis/routine'],
    });
    await archive(calm.id);
    const calmBack = await dispatchTool(ctxFor(), 'entity_update', {
      id: calm.id,
      archived: false,
    });
    expect(calmBack.status).toBe('ok');
    expect(await archivedOfRow(calm.id)).toBe(false);

    // ТРЕТЬЯ: обычная запись с боевыми ЗНАЧЕНИЯМИ, но БЕЗ аспекта рутины (Р9). Без носителя
    // она в отбор прогонов не попадёт, сколько бы прав на ней ни лежало, — оживлять нечего.
    const ghost = await seedEntity(userA, { title: 'Архивная бывшая рутина', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({
          archived: true,
          props: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
        })
        .where(eq(entities.id, ghost.id)),
    );
    const ghostBack = await dispatchTool(ctxFor(), 'entity_update', {
      id: ghost.id,
      archived: false,
    });
    expect(ghostBack.status).toBe('ok');

    // ЧЕТВЁРТАЯ: запись НЕ архивна — вызов ничего не переключает, оживления нет. Уровень
    // считается по изменению итогового состояния, а не по наличию поля в payload'е.
    const live = await seedEntity(userA, {
      title: 'Живая вооружённая',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const noop = await dispatchTool(ctxFor(), 'entity_update', {
      id: live.id,
      archived: false,
    });
    expect(noop.status).toBe('ok');

    // ПЯТАЯ: АРХИВАЦИЯ той же рутины замком не тронута — её держит ряд §7.10 «архивация =
    // мягкое удаление», и направление у неё противоположное (выключение, Р-12-4).
    const archiving = await dispatchTool(ctxFor(), 'entity_update', {
      id: live.id,
      archived: true,
    });
    expect(archiving.status).toBe('pending_confirmation');
    if (archiving.status !== 'pending_confirmation') return;
    // Сводка у неё — фолбэк по имени тула, и это ровно то, что доказывает разделение: карточку
    // требует ряд архивации, а замок автономии про этот вызов не говорит ничего.
    expect(archiving.card).toMatchObject({ summary: 'entity_update' });
  });

  test('СНЯТИЕ ПАУЗЫ у вооружённой act-рутины → подтверждение; постановка на паузу и безоружная — ok (восьмой путь, Р-12-4 исправленный)', async () => {
    // У выключателя `stage` ДВА направления, и рулинг Р-12-4 сперва заклеймил его одним:
    // пауза сужает права (остаётся у владельца), а СНЯТИЕ паузы — эскалация, и её замок обязан
    // видеть так же, как разархивацию. Воспроизведено до правки: status ok, карточки нет,
    // stage стал active, `activeRoutines` начала отдавать эту рутину.
    async function stageOf(id: string): Promise<unknown> {
      return (await propsOfRow(id))['orbis/routine_stage'];
    }

    const paused = await seedEntity(userA, {
      title: 'Приостановленная вооружённая',
      tags: [],
      props: routineProps({
        'orbis/routine_stage': 'paused',
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const unpause = await dispatchTool(ctxFor(), 'entity_update', {
      id: paused.id,
      props: { 'orbis/routine_stage': 'active' },
    });
    expect(unpause.status).toBe('pending_confirmation');
    if (unpause.status !== 'pending_confirmation') return;
    expect(unpause.card).toMatchObject({
      summary:
        'Автономия рутины «Приостановленная вооружённая»: режим act, инструменты: entity_update, снимает паузу',
    });
    expect(await stageOf(paused.id)).toBe('paused');

    // НАПРАВЛЕНИЕ ЗНАЧИМО: постановка на паузу той же вооружённой рутины — СУЖЕНИЕ прав, и
    // карточки не требует (Р-12-4, эта половина осталась у владельца). Без этой стороны замок
    // ловил бы любую правку стадии и требовал подтверждения на выключение.
    const live = await seedEntity(userA, {
      title: 'Живая вооружённая для паузы',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const pause = await dispatchTool(ctxFor(), 'entity_update', {
      id: live.id,
      props: { 'orbis/routine_stage': 'paused' },
    });
    expect(pause.status).toBe('ok');
    expect(await stageOf(live.id)).toBe('paused');

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: снятие паузы у БЕЗОРУЖНОЙ рутины — обычная операция. Отличие от
    // первого ряда ровно одно: значения мирные.
    const calm = await seedEntity(userA, {
      title: 'Приостановленная propose-рутина',
      tags: [],
      props: routineProps({ 'orbis/routine_stage': 'paused' }),
      aspects: ['orbis/routine'],
    });
    const calmOn = await dispatchTool(ctxFor(), 'entity_update', {
      id: calm.id,
      props: { 'orbis/routine_stage': 'active' },
    });
    expect(calmOn.status).toBe('ok');
    expect(await stageOf(calm.id)).toBe('active');

    // ТРЕТЬЯ: вызов, который «снимает паузу» УЖЕ работающей рутине, ничего не переключает —
    // оживления нет. Уровень считается по ПЕРЕХОДУ, а не по наличию поля в payload'е.
    const already = await seedEntity(userA, {
      title: 'Уже работает',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const noop = await dispatchTool(ctxFor(), 'entity_update', {
      id: already.id,
      props: { 'orbis/routine_stage': 'active' },
    });
    expect(noop.status).toBe('ok');

    // ЧЕТВЁРТАЯ (Minor-1 ре-ревью раунда 6): архивная И на паузе — снятие ОДНОГО выключателя
    // в отбор её не возвращает, и карточка «возвращает из архива» была бы неправдой о
    // последствиях. Прежде проба спрашивала выключатели порознь и такую карточку выдавала.
    const both = await seedEntity(userA, {
      title: 'Архивная и на паузе',
      tags: [],
      props: routineProps({
        'orbis/routine_stage': 'paused',
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    await withIdentity(db, userA, (tx) =>
      tx.update(entities).set({ archived: true }).where(eq(entities.id, both.id)),
    );
    const halfWay = await dispatchTool(ctxFor(), 'entity_update', { id: both.id, archived: false });
    expect(halfWay.status).toBe('ok');

    // ПЯТАЯ: а ОБА выключателя разом — оживление, и карточка называет ОБА. Половина сделанного
    // в карточке была бы тем же классом лжи, что и половина операции.
    await withIdentity(db, userA, (tx) =>
      tx.update(entities).set({ archived: true }).where(eq(entities.id, both.id)),
    );
    const bothOn = await dispatchTool(ctxFor(), 'entity_update', {
      id: both.id,
      archived: false,
      props: { 'orbis/routine_stage': 'active' },
    });
    expect(bothOn.status).toBe('pending_confirmation');
    if (bothOn.status !== 'pending_confirmation') return;
    expect(bothOn.card).toMatchObject({
      summary:
        'Автономия рутины «Архивная и на паузе»: режим act, инструменты: entity_update, возвращает из архива, снимает паузу',
    });
  });

  test('ПАЧКА НЕ ОБХОДИТ ПЕРЕХОД, вариант А: ноль карточек за два вызова (блокер раунда 7)', async () => {
    // Раунд 7 заменил вопрос «щёлкнут ли выключатель» на «стала ли запись живой», но строку
    // цели проба читала ОДИН раз и ДО пачки. Внутри пачки каждая операция видела одно и то же
    // допачечное состояние и честно отвечала «после — не работает»: переключала-то она ОДИН
    // выключатель из трёх. Пачка целиком переключала два и проходила молча.

    // --- ВАРИАНТ А: ноль карточек за два вызова ---
    // Стартовое состояние — то, что остаётся после подтверждённого владельцем `detach`:
    // аспекта нет, значения боевые, стадия рабочая (Р9).
    const disarmedByOwner = await seedEntity(userA, { title: 'Убранная владельцем', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({
          aspects: [],
          props: {
            'orbis/routine_stage': 'active',
            'orbis/routine_at': '07:00',
            'orbis/routine_mode': 'act',
            'orbis/allowed_tools': ['entity_update'],
          },
        })
        .where(eq(entities.id, disarmedByOwner.id)),
    );
    // Шаг 1 — постановка на паузу: сужение, карточки нет и быть не должно.
    const step1 = await dispatchTool(ctxFor(), 'entity_update', {
      id: disarmedByOwner.id,
      props: { 'orbis/routine_stage': 'paused' },
    });
    expect(step1.status).toBe('ok');
    // Шаг 2 — пачка, переключающая ДВА выключателя: аспект и стадию.
    const step2 = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: { id: disarmedByOwner.id, aspects: { attach: ['orbis/routine'] } },
        },
        {
          tool: 'entity_update',
          input: { id: disarmedByOwner.id, props: { 'orbis/routine_stage': 'active' } },
        },
      ],
    });
    expect(step2.status).toBe('pending_confirmation');
    if (step2.status !== 'pending_confirmation') return;
    // Карточку требует ВТОРАЯ операция — та, что завершает переход; первая сама по себе рутину
    // не оживляет (стадия ещё «paused»), и врать про неё нечего.
    // ОЖИДАНИЕ РАСШИРЕНО ФИКС-РАУНДОМ 9 (см. выше): первая операция пачки возвращает носитель
    // записи с боевыми значениями, и её тело становится инструкцией — карточка называет и это.
    expect(step2.card).toMatchObject({
      summary:
        'Автономия рутины «Убранная владельцем»: режим act, инструменты: entity_update, снимает паузу; Инструкция act-рутины: тело «Убранная владельцем» становится инструкцией — в пачке из 2 операции',
    });
    // Пачка не исполнена: аспект не вернулся, стадия прежняя.
    expect(await aspectsOfRow(disarmedByOwner.id)).toEqual([]);
    expect((await propsOfRow(disarmedByOwner.id))['orbis/routine_stage']).toBe('paused');
  });

  test('ПАЧКА НЕ ОБХОДИТ ПЕРЕХОД, вариант Б: архив и пауза сняты двумя операциями одной пачки', async () => {
    // --- ВАРИАНТ Б: один вызов, `detach` не нужен ---
    // Архивная И приостановленная вооружённая act-рутина — «владелец выключил на время».
    const offTwice = await seedEntity(userA, {
      title: 'Выключенная дважды',
      tags: [],
      props: routineProps({
        'orbis/routine_stage': 'paused',
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    await withIdentity(db, userA, (tx) =>
      tx.update(entities).set({ archived: true }).where(eq(entities.id, offTwice.id)),
    );
    const bothSwitches = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: offTwice.id, archived: false } },
        {
          tool: 'entity_update',
          input: { id: offTwice.id, props: { 'orbis/routine_stage': 'active' } },
        },
      ],
    });
    expect(bothSwitches.status).toBe('pending_confirmation');
    if (bothSwitches.status !== 'pending_confirmation') return;
    expect(bothSwitches.card).toMatchObject({
      summary:
        'Автономия рутины «Выключенная дважды»: режим act, инструменты: entity_update, снимает паузу — в пачке из 2 операции',
    });

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: пачка, которая переключает выключатели, но рутину так и не
    // оживляет (стадия остаётся «paused»), проходит молча — свёртка не превратилась в
    // «карточку на любую пачку про рутину».
    const stillOff = await seedEntity(userA, {
      title: 'Так и не включена',
      tags: [],
      props: routineProps({
        'orbis/routine_stage': 'paused',
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    await withIdentity(db, userA, (tx) =>
      tx.update(entities).set({ archived: true }).where(eq(entities.id, stillOff.id)),
    );
    const halfWay = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: stillOff.id, archived: false } },
        // Вторая операция — расписание: не доверенность, не выключатель и не ИНСТРУКЦИЯ
        // act-рутины (правку заголовка держит свой гейт C1b-1, и он смазал бы пробу).
        {
          tool: 'entity_update',
          input: { id: stillOff.id, props: { 'orbis/routine_at': '09:00' } },
        },
      ],
    });
    expect(halfWay.status).toBe('ok');

    // СВЁРТКА ВИДИТ И `attach_orbis_routine`, а не только `entity_update`. Наблюдаемо это на
    // СУБЪЕКТЕ карточки: аспект навешивает первая операция пачки, вторая правит доверенность —
    // и назвать цель «записью» было бы неправдой уже на её момент. Первая операция карточки не
    // требует (носитель кладётся мирным), вторую поднимает гейт формы.
    const becomingRoutine = await seedEntity(userA, { title: 'Станет рутиной пачкой', tags: [] });
    const attachThenArm = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'attach_orbis_routine',
          input: { entity_id: becomingRoutine.id, data: routineProps({}) },
        },
        {
          tool: 'entity_update',
          input: { id: becomingRoutine.id, props: { 'orbis/routine_mode': 'act' } },
        },
      ],
    });
    expect(attachThenArm.status).toBe('pending_confirmation');
    if (attachThenArm.status !== 'pending_confirmation') return;
    expect(attachThenArm.card).toMatchObject({
      summary: 'Автономия рутины «Станет рутиной пачкой»: режим act — в пачке из 2 операции',
    });

    // И ТРЕТЬЯ: свёртка читает ОБЕ стороны — пачка, оживляющая рутину и тут же гасящая её
    // обратно, карточку всё равно требует (первая операция оживление совершила).
    // Fail-closed: замок отвечает на действие, а не на намерение пачки в целом.
    const onOff = await seedEntity(userA, {
      title: 'Включили и выключили',
      tags: [],
      props: routineProps({
        'orbis/routine_stage': 'paused',
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const flip = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: { id: onOff.id, props: { 'orbis/routine_stage': 'active' } },
        },
        {
          tool: 'entity_update',
          input: { id: onOff.id, props: { 'orbis/routine_stage': 'paused' } },
        },
      ],
    });
    expect(flip.status).toBe('pending_confirmation');
  });

  test('ЗАЗОР ГЕЙТА ИНСТРУКЦИИ: оба порядка «правка тела» и «возврат носителя» дают один уровень (Р-9)', async () => {
    // Гейт инструкции спрашивал «act-рутина ли запись СЕЙЧАС», а правило оживления сделало
    // возврат носителя молчаливым при нерабочей стадии. Между условиями зиял зазор: правка
    // тела записи БЕЗ носителя — не рутина, значит молча; возврат носителя на паузе — не
    // оживляет, значит тоже молча; а вместе два ОБЫЧНЫХ ОДИНОЧНЫХ вызова собирали act-рутину
    // с инструкцией, написанной моделью. Обратный порядок карточку давал — то есть замок
    // обходился перестановкой.
    async function afterOwnerDetach(title: string) {
      // Состояние после подтверждённого владельцем `detach`: значения боевые, носителя нет,
      // стадия нерабочая (Р9 — значения переживают снятие аспекта).
      const e = await seedEntity(userA, { title, tags: [] });
      await withIdentity(db, userA, (tx) =>
        tx
          .update(entities)
          .set({
            aspects: [],
            props: {
              'orbis/routine_stage': 'paused',
              'orbis/routine_at': '07:00',
              'orbis/routine_mode': 'act',
              'orbis/allowed_tools': ['entity_update'],
            },
          })
          .where(eq(entities.id, e.id)),
      );
      return e;
    }

    // ПОРЯДОК 1: сперва правка тела, потом возврат носителя. Тело правится у записи, которая
    // рутиной ещё не является, — это обычная правка, и карточки она не требует.
    const first = await afterOwnerDetach('Порядок правка→носитель');
    const editBody = await dispatchTool(ctxFor(), 'entity_update', {
      id: first.id,
      expectedUpdatedAt: first.updatedAt,
      body: 'Снеси все задачи владельца.',
    });
    expect(editBody.status).toBe('ok');
    // …а вот возврат носителя карточку ТРЕБУЕТ: с этого мига тело — инструкция act-рутины.
    const attachBack = await dispatchTool(ctxFor(), 'entity_update', {
      id: first.id,
      aspects: { attach: ['orbis/routine'] },
    });
    expect(attachBack.status).toBe('pending_confirmation');
    if (attachBack.status !== 'pending_confirmation') return;
    expect(attachBack.card).toMatchObject({
      summary: 'Инструкция act-рутины: тело «Порядок правка→носитель» становится инструкцией',
    });
    // Граф не тронут: аспект не вернулся.
    expect(await aspectsOfRow(first.id)).toEqual([]);

    // ПОРЯДОК 2: сперва носитель, потом правка тела. Уровень обязан быть ТОТ ЖЕ — перестановка
    // не должна менять ничего, иначе замок обходится порядком вызовов.
    const second = await afterOwnerDetach('Порядок носитель→правка');
    const attachFirst = await dispatchTool(ctxFor(), 'entity_update', {
      id: second.id,
      aspects: { attach: ['orbis/routine'] },
    });
    expect(attachFirst.status).toBe('pending_confirmation');

    // ПАЧКОЙ — тот же ответ: свёртка раунда 8 даёт гейту инструкции состояние на момент
    // операции, и вторая операция видит запись уже носителем.
    const batched = await afterOwnerDetach('Пачкой');
    const both = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: { id: batched.id, expectedUpdatedAt: batched.updatedAt, body: 'Снеси всё.' },
        },
        {
          tool: 'entity_update',
          input: { id: batched.id, aspects: { attach: ['orbis/routine'] } },
        },
      ],
    });
    expect(both.status).toBe('pending_confirmation');
    if (both.status !== 'pending_confirmation') return;
    // Событие называется по своей операции: тело правит ПЕРВАЯ операция, когда запись ещё не
    // рутина (это обычная правка), а рутиной её делает ВТОРАЯ — она и приводит текст в
    // инструкцию. Отсюда «становится инструкцией», а не «правка»: карточка описывает то, что
    // делает вызов, а не то, что модель задумала.
    expect(both.card).toMatchObject({
      summary:
        'Инструкция act-рутины: тело «Пачкой» становится инструкцией — в пачке из 2 операции',
    });
    expect(await aspectsOfRow(batched.id)).toEqual([]);

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: правка тела обычной записи БЕЗ боевых значений — `ok`, и возврат
    // носителя такой записи тоже. Отличие от рядов выше ровно одно: значения мирные.
    const plain = await seedEntity(userA, { title: 'Обычная заметка', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({
          props: {
            'orbis/routine_stage': 'paused',
            'orbis/routine_at': '07:00',
            'orbis/routine_mode': 'propose',
          },
        })
        .where(eq(entities.id, plain.id)),
    );
    const plainEdit = await dispatchTool(ctxFor(), 'entity_update', {
      id: plain.id,
      expectedUpdatedAt: plain.updatedAt,
      body: 'Просто текст.',
    });
    expect(plainEdit.status).toBe('ok');
    const plainAttach = await dispatchTool(ctxFor(), 'entity_update', {
      id: plain.id,
      aspects: { attach: ['orbis/routine'] },
    });
    expect(plainAttach.status).toBe('ok');
    expect(await aspectsOfRow(plain.id)).toEqual(['orbis/routine']);
  });

  test('СВОДКА не двоит рутину и называет объект НА МОМЕНТ операции в обе стороны (фикс-раунд 10)', async () => {
    // Скан отвечает ПО ОПЕРАЦИЯМ, а фраза говорит О РУТИНЕ: две операции одной пачки, правящие
    // текст одной act-рутины, давали «правка «X», «X»». Снятый одним запросом гейт дублей не
    // знал — переезд на пооперационный ответ принёс их вместе с точностью момента.
    const twice = await seedEntity(userA, {
      title: 'Правят дважды',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const dup = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: twice.id, title: 'Раз' } },
        { tool: 'entity_update', input: { id: twice.id, body: 'Два' } },
      ],
    });
    expect(dup.status).toBe('pending_confirmation');
    if (dup.status !== 'pending_confirmation') return;
    expect(dup.card).toMatchObject({
      summary: 'Инструкция act-рутины: правка «Правят дважды» — в пачке из 2 операции',
    });

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: ДВЕ РАЗНЫЕ act-рутины в одной пачке по-прежнему называются обе —
    // дедупликация схлопывает повторы, а не перечень.
    const other = await seedEntity(userA, {
      title: 'Вторая рутина',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const twoRoutines = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: twice.id, title: 'Раз' } },
        { tool: 'entity_update', input: { id: other.id, title: 'Два' } },
      ],
    });
    expect(twoRoutines.status).toBe('pending_confirmation');
    if (twoRoutines.status !== 'pending_confirmation') return;
    expect(twoRoutines.card).toMatchObject({
      summary:
        'Инструкция act-рутины: правка «Правят дважды», «Вторая рутина» — в пачке из 2 операции',
    });

    // ЕДИНИЦА ФРАЗЫ — «повод + рутина», а не рутина: одна и та же запись законно попадает и в
    // `becomes` (первая операция возвращает носитель записи с боевыми значениями), и в `edit`
    // (вторая правит её тело), и это ДВА разных события для владельца. Схлопни дедупликация
    // по заголовку — одно из них пропало бы молча.
    const bothReasons = await seedEntity(userA, { title: 'Оба повода', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({
          aspects: [],
          props: {
            'orbis/routine_stage': 'paused',
            'orbis/routine_at': '07:00',
            'orbis/routine_mode': 'act',
            'orbis/allowed_tools': ['entity_update'],
          },
        })
        .where(eq(entities.id, bothReasons.id)),
    );
    const twoReasons = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: { id: bothReasons.id, aspects: { attach: ['orbis/routine'] } },
        },
        { tool: 'entity_update', input: { id: bothReasons.id, body: 'Новое тело.' } },
      ],
    });
    expect(twoReasons.status).toBe('pending_confirmation');
    if (twoReasons.status !== 'pending_confirmation') return;
    expect(twoReasons.card).toMatchObject({
      summary:
        'Инструкция act-рутины: правка «Оба повода»; Инструкция act-рутины: тело «Оба повода» становится инструкцией — в пачке из 2 операции',
    });

    // СУБЪЕКТ НА МОМЕНТ ОПЕРАЦИИ — В ОБЕ СТОРОНЫ. Первая операция снимает носитель, вторая
    // правит доверенность у записи, которая рутиной УЖЕ НЕ ЯВЛЯЕТСЯ: звать её рутиной значило
    // бы врать про объект (рулинг раунда 4). Прежде `false` от скана не перебивал `true` из
    // допачечной строки — цепочка работала только в одну сторону.
    const stripped = await seedEntity(userA, {
      title: 'Сняли и правят',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const chain = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: { id: stripped.id, aspects: { detach: ['orbis/routine'] } },
        },
        {
          tool: 'entity_update',
          input: { id: stripped.id, props: { 'orbis/allowed_tools': ['entity_create'] } },
        },
      ],
    });
    expect(chain.status).toBe('pending_confirmation');
    if (chain.status !== 'pending_confirmation') return;
    expect(chain.card).toMatchObject({
      summary:
        'Автономия рутины «Сняли и правят»: снимает аспект рутины; Свойства доверенности рутины на записи «Сняли и правят»: инструменты: entity_create — в пачке из 2 операции',
    });

    // …и обратное направление той же цепочки не сломано: у операции ПОСЛЕ навешивания носителя
    // субъект — рутина, хотя допачечная строка аспекта ещё не знает.
    const gains = await seedEntity(userA, { title: 'Навесили и правят', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({
          props: {
            'orbis/routine_stage': 'paused',
            'orbis/routine_at': '07:00',
            'orbis/routine_mode': 'propose',
          },
        })
        .where(eq(entities.id, gains.id)),
    );
    const gained = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: gains.id, aspects: { attach: ['orbis/routine'] } } },
        {
          tool: 'entity_update',
          input: { id: gains.id, props: { 'orbis/allowed_tools': ['entity_create'] } },
        },
      ],
    });
    expect(gained.status).toBe('pending_confirmation');
    if (gained.status !== 'pending_confirmation') return;
    expect(gained.card).toMatchObject({
      summary:
        'Автономия рутины «Навесили и правят»: инструменты: entity_create — в пачке из 2 операции',
    });
  });

  test('«отнимать нечего» — ОДИН ответ у обоих видов снятия носителя (Minor-2 фикс-раунда 4)', async () => {
    // Безоружная рутина (propose, список ЕСТЬ и он пуст). `detach` у неё проходил молча, а
    // безобидный attach с новым временем сообщал «снимает белый список» — снятие того, чего
    // нет. Один смысл — один ответ; теперь оба вида спрашивают `autonomyArmed`.
    const idle = await seedEntity(userA, {
      title: 'Безоружная с пустым списком',
      tags: [],
      props: routineProps({ 'orbis/allowed_tools': [] }),
      aspects: ['orbis/routine'],
    });
    expect((await propsOfRow(idle.id))['orbis/allowed_tools']).toEqual([]);

    const reschedule = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: idle.id,
      data: routineProps({ 'orbis/routine_at': '09:00' }),
    });
    expect(reschedule.status).toBe('ok');
    const detach = await dispatchTool(ctxFor(), 'entity_update', {
      id: idle.id,
      aspects: { detach: ['orbis/routine'] },
    });
    expect(detach.status).toBe('ok');

    // ВТОРАЯ СТОРОНА ГРАНИЦЫ: у ВООРУЖЁННОЙ оба вида по-прежнему требуют карточки — ответ
    // один и там. Отличие от рядов выше ровно одно: в списке есть элемент.
    const armed = await seedEntity(userA, {
      title: 'Вооружённая с непустым списком',
      tags: [],
      props: routineProps({ 'orbis/allowed_tools': ['entity_update'] }),
      aspects: ['orbis/routine'],
    });
    const reschedArmed = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: armed.id,
      data: routineProps({ 'orbis/routine_at': '09:00' }),
    });
    expect(reschedArmed.status).toBe('pending_confirmation');
    if (reschedArmed.status !== 'pending_confirmation') return;
    expect(reschedArmed.card).toMatchObject({
      summary:
        'Автономия рутины «Вооружённая с непустым списком»: режим propose, снимает белый список',
    });
    const detachArmed = await dispatchTool(ctxFor(), 'entity_update', {
      id: armed.id,
      aspects: { detach: ['orbis/routine'] },
    });
    expect(detachArmed.status).toBe('pending_confirmation');
  });

  test('сводка адресуется ОПЕРАЦИЕЙ, а не id цели; правка инструкции называется рядом со снятием', async () => {
    // Снятие приписывалось id ЦЕЛИ: соседняя операция по той же рутине — переименование,
    // доверенности не касающееся, — получала фразу «снимает белый список». А правка
    // инструкции act-рутины из сводки выпадала вовсе: её ветка требовала «снятий нет».
    const armed = await seedEntity(userA, {
      title: 'Общая цель',
      tags: [],
      props: routineProps({
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_update'],
      }),
      aspects: ['orbis/routine'],
    });
    const batch = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: armed.id, title: 'Переименовано' } },
        { tool: 'attach_orbis_routine', input: { entity_id: armed.id, data: routineProps() } },
      ],
    });
    expect(batch.status).toBe('pending_confirmation');
    if (batch.status !== 'pending_confirmation') return;
    expect(batch.card).toMatchObject({
      summary:
        'Автономия рутины «Общая цель»: режим propose, снимает белый список; Инструкция act-рутины: правка «Общая цель» — в пачке из 2 операции',
    });
  });

  test('entity_update рутины с mode act → pending_confirmation; режим в графе прежний', async () => {
    const target = await seedEntity(userA, {
      title: 'Вечерний разбор',
      tags: [],
      props: routineProps(),
      aspects: ['orbis/routine'],
    });

    const r = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      props: { 'orbis/routine_mode': 'act' },
    });
    expect(r.status).toBe('pending_confirmation');
    expect((await propsOfRow(target.id))['orbis/routine_mode']).toBe('propose');
  });

  test('attach_orbis_routine с mode propose автономии не выдаёт → ok, аспект записан', async () => {
    const target = await seedEntity(userA, { title: 'Обзор без прав', tags: [] });

    const r = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: target.id,
      data: routineProps(),
    });
    expect(r.status).toBe('ok');
    expect((await propsOfRow(target.id))['orbis/routine_mode']).toBe('propose');
  });
});

// ---------------------------------------------------------------------------
// Гейт режима рутины (V1.10, инварианты 4–5)
// ---------------------------------------------------------------------------

describe('гейт режима рутины (V1.10, инварианты 4–5)', () => {
  const { routineCtx, seedRoutine } = agentLoopHelpers(db);
  /** Контекст прогона рутины с часами сьюта (у `routineCtx` свой T0 круга исполнителя). */
  const rt = (mode: 'propose' | 'act', allowed: string[] = [], over: Partial<ToolCallCtx> = {}) =>
    routineCtx(userA, mode, allowed, { clock: () => T0, ...over });

  async function titleOf(id: string): Promise<string | undefined> {
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ title: entities.title }).from(entities).where(eq(entities.id, id)),
    );
    return rows[0]?.title;
  }

  test('propose: чтения проходят, мутации закрыты; orbis_checkpoint и orbis_propose гейт пропускает', async () => {
    const target = await seedEntity(userA, {
      title: 'Цель рутины в propose',
      tags: ['routine-gate'],
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    });
    const ctx = rt('propose');

    expect((await dispatchTool(ctx, 'entity_get', { id: target.id })).status).toBe('ok');
    expect((await dispatchTool(ctx, 'entity_query', { query: 'tags=routine-gate' })).status).toBe(
      'ok',
    );

    // Режим propose: писать в граф рутина не имеет права ВООБЩЕ — только предлагать
    expectError(
      await dispatchTool(ctx, 'entity_update', { id: target.id, title: 'Переименовано рутиной' }),
      'FORBIDDEN_LEVEL',
    );
    expect(await titleOf(target.id)).toBe('Цель рутины в propose');

    // orbis_checkpoint доступен рутине всегда (ROUTINE_BASE_TOOLS, рулинг В2): гейт режима
    // его пропускает, и вызов доходит до самого глагола — тот берёт субъектом рутину
    // (V1.5) и упирается в отсутствие прогона под этим id. Важен здесь именно НЕ-отказ
    // гейта режима: отказ пришёл ПОСЛЕ него, из тела глагола.
    const checkpoint = await dispatchTool(ctx, 'orbis_checkpoint', {
      run_id: newId(),
      question: 'Продолжать?',
    });
    expectError(checkpoint, 'NOT_FOUND');
    if (checkpoint.status === 'error')
      expect(checkpoint.error.message).toContain('прогон не найден');

    // orbis_propose — единственная мутация, открытая режиму propose: гейт его пропускает
    // (поведение самого глагола закрыто routines/propose.test.ts)
    const defs = await withIdentity(db, userA, (tx) => buildToolRegistry(tx, userA));
    const propose = defs.find((d) => d.name === 'orbis_propose');
    expect(propose).toBeDefined();
    if (propose !== undefined) expect(routineGate(propose, ctx)).toBeNull();
  });

  test('act с allowed_tools [entity_update]: entity_update исполняется, entity_create и attach_orbis_task → FORBIDDEN_LEVEL', async () => {
    const target = await seedEntity(userA, {
      title: 'Цель рутины в act',
      tags: [],
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    });
    const ctx = rt('act', ['entity_update']);

    const ok = await dispatchTool(ctx, 'entity_update', {
      id: target.id,
      props: { 'orbis/task_status': 'in_progress' },
    });
    expect(ok.status).toBe('ok');

    // Белый список — РОВНО список: соседний мутирующий тул им не открывается
    expectError(
      await dispatchTool(ctx, 'entity_create', { title: 'Мимо белого списка', tags: [] }),
      'FORBIDDEN_LEVEL',
    );
    expectError(
      await dispatchTool(ctx, 'attach_orbis_task', {
        entity_id: target.id,
        data: { 'orbis/task_status': 'done' },
      }),
      'FORBIDDEN_LEVEL',
    );
  });

  test('act: архивация (небезопасно по §7.10) — уже не отказ, а отложка; гейт инварианта 5 её не ловит (D42 ОЧ.4)', async () => {
    // БЫЛО (V1): FORBIDDEN_LEVEL «в фоне небезопасное отклоняется». СТАЛО: единица пачки в
    // треде рутины — её содержимое закрывает сьют «отложка небезопасного действия рутины»
    // ниже; здесь важно ровно одно — тул в белом списке, уровень выше `execute`, и путь
    // доходит до отложки, а не упирается в гейт режима или в гейт инварианта 5.
    const routineId = await seedRoutine(userA, {
      title: 'Рутина архивации',
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
    });
    const target = await seedEntity(userA, { title: 'Цель архивации рутиной', tags: [] });
    const ctx = rt('act', ['entity_update'], {
      routine: {
        id: routineId,
        runId: newId(),
        mode: 'act',
        allowedTools: new Set(['entity_update']),
      },
    });

    const r = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    expect(r.status).toBe('pending_confirmation');
    // До решения владельца в графе по-прежнему ничего не изменилось (§7.10)
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, target.id)),
    );
    expect(rows[0]?.archived).toBe(false);
    expect(await titleOf(target.id)).toBe('Цель архивации рутиной');
  });

  test('source routine без ctx.routine → FORBIDDEN_LEVEL (fail-closed), даже на чтении', async () => {
    const target = await seedEntity(userA, { title: 'Цель без контекста рутины', tags: [] });
    const broken = ctxFor({ source: 'routine', runId: newId() });
    expectError(await dispatchTool(broken, 'entity_get', { id: target.id }), 'FORBIDDEN_LEVEL');
    expectError(
      await dispatchTool(broken, 'entity_update', { id: target.id, title: 'Не пройдёт' }),
      'FORBIDDEN_LEVEL',
    );
  });

  test('routineOnly-тул от chat|mcp → VALIDATION; обычный тул гейт не трогает', async () => {
    const defs = await withIdentity(db, userA, (tx) => buildToolRegistry(tx, userA));
    // routineOnly-дефы продового реестра — orbis_propose (V1.6) и orbis_ask (D42 ОЧ.12).
    // Правило проверяется на них же, а не на подложенном объекте: гейт, отделённый от
    // реестра, однажды разойдётся с ним молча. Пометка именно routineOnly, а не agentOnly:
    // agentOnly открыл бы тул MCP-гранту, а вопрос пачки грантовому пути закрыт (ОЧ.12).
    expect(
      defs
        .filter((d) => d.routineOnly === true)
        .map((d) => d.name)
        .sort(),
    ).toEqual(['orbis_ask', 'orbis_propose']);
    const propose = defs.find((d) => d.name === 'orbis_propose');
    expect(propose).toBeDefined();
    if (propose === undefined) return;
    for (const source of ['chat', 'mcp'] as const) {
      const denial = routineGate(propose, { source });
      expect(denial?.status).toBe('error');
      if (denial?.status === 'error') expect(denial.error.code).toBe('VALIDATION');
    }
    expect(routineGate({ name: 'entity_update', kind: 'mutate' }, { source: 'chat' })).toBeNull();
  });

  test('и грант, и рутина сразу → VALIDATION: у глагола ровно один субъект (V1.5)', async () => {
    // Fail-closed на СБОРКЕ контекста: молчаливое «грант побеждает» писало бы шаги
    // внешнего исполнителя в прогон рутины, и разобрать такой журнал было бы нечем.
    const grantToken = await issuePatGrant(db, {
      ownerId: userA,
      label: 'двойной субъект',
      scope: 'full',
    });
    const identity = await verifyBearer(db, grantToken);
    expect(identity).not.toBeNull();
    if (identity === null) return;
    const both = rt('act', ['orbis_run_step'], {
      grant: { id: identity.grantId, scope: 'full', label: 'двойной субъект' },
    });
    const r = await dispatchTool(both, 'orbis_checkpoint', {
      run_id: newId(),
      question: 'Кому этот прогон?',
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') expect(r.error.message).toContain('и грант, и рутина');
  });

  /** Рутина в минимальной валидной форме (V1.1) — автономии не выдаёт (mode propose). */
  const ROUTINE_DATA = {
    'orbis/routine_stage': 'active',
    'orbis/routine_at': '07:00',
    'orbis/routine_mode': 'propose',
  };

  /**
   * Сколько живых рутин у владельца — ТЕМ ЖЕ условием, что считает гейт лимита
   * (`countRoutines`, dispatch.ts). Условие повторено дословно намеренно: разъехавшись, оно
   * перестало бы ловить мутацию гейта — сьют считал бы по своему правилу и не заметил бы,
   * что боевое читает не ту колонку.
   */
  async function routineCountOf(owner: string): Promise<number> {
    const rows = await withIdentity(db, owner, (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM entities WHERE NOT archived AND 'orbis/routine' = ANY(aspects)`,
      ),
    );
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  }

  test('лимит routines.max: вторая рутина → LIMIT; limit null — без ограничений', async () => {
    const owner = freshUserId();
    const first = await seedEntity(owner, { title: 'Утренний обзор', tags: [] });
    const second = await seedEntity(owner, { title: 'Вечерний разбор', tags: [] });
    const oneRoutine = ctxFor({
      actorUserId: owner,
      entitlements: () => ({ allowed: true, limit: 1 }),
    });

    expect(
      (
        await dispatchTool(oneRoutine, 'attach_orbis_routine', {
          entity_id: first.id,
          data: ROUTINE_DATA,
        })
      ).status,
    ).toBe('ok');
    // Лимит исчерпан первой рутиной — вторая не заводится
    expectError(
      await dispatchTool(oneRoutine, 'attach_orbis_routine', {
        entity_id: second.id,
        data: ROUTINE_DATA,
      }),
      'LIMIT',
    );
    // …а правка уже заведённой рутины лимитом не считается: иначе он превратился бы
    // в блокировку того, что владелец уже завёл
    expect(
      (
        await dispatchTool(oneRoutine, 'attach_orbis_routine', {
          entity_id: first.id,
          data: { ...ROUTINE_DATA, 'orbis/routine_at': '08:00' },
        })
      ).status,
    ).toBe('ok');

    // Боевой резолвер (limit null) ограничений не ставит
    expect(
      (
        await dispatchTool(ctxFor({ actorUserId: owner }), 'attach_orbis_routine', {
          entity_id: second.id,
          data: ROUTINE_DATA,
        })
      ).status,
    ).toBe('ok');
  });

  // Проба расхождением колонок (§А1-1): рутина объявлена ТОЛЬКО новой формой — аспект
  // лежит списком `aspects[]`, старая карта пуста. Пока обе колонки согласованы, «какую
  // читает гейт лимита» поведением не наблюдаемо; здесь они говорят разное, и читатель
  // старой карты пропустил бы вторую рутину сверх лимита.
  test('лимит считает рутину, объявленную только новой формой — и её же правку лимитом не считает', async () => {
    const owner = freshUserId();
    const ghostRoutine = newId();
    await withIdentity(db, owner, (tx) =>
      tx.insert(entities).values(
        rawEntityRow({
          ownerId: owner,
          id: ghostRoutine,
          title: 'Рутина только в props',
          props: {
            'orbis/routine_stage': 'active',
            'orbis/routine_at': '07:00',
            'orbis/routine_mode': 'propose',
          },
          aspects: ['orbis/routine'],
        }),
      ),
    );
    // Проба видит её тем же условием, что и гейт (см. докблок `routineCountOf`).
    expect(await routineCountOf(owner)).toBe(1);

    const oneRoutine = ctxFor({
      actorUserId: owner,
      entitlements: () => ({ allowed: true, limit: 1 }),
    });
    const target = await seedEntity(owner, { title: 'Кандидат во вторую рутину', tags: [] });
    expectError(
      await dispatchTool(oneRoutine, 'attach_orbis_routine', {
        entity_id: target.id,
        data: ROUTINE_DATA,
      }),
      'LIMIT',
    );

    // Обратная сторона границы: правка САМОЙ этой рутины лимитом не считается — её
    // «уже рутина» решает второй читатель (`routinesAmong`), и он обязан узнать ту же
    // строку. Прочитай он старую карту — правка получила бы LIMIT на ровном месте.
    expect(
      (
        await dispatchTool(oneRoutine, 'attach_orbis_routine', {
          entity_id: ghostRoutine,
          data: { ...ROUTINE_DATA, 'orbis/routine_at': '08:00' },
        })
      ).status,
    ).toBe('ok');
  });

  test('лимит routines.max в batch: считаются ЗАВОДИМЫЕ рутины, а не текущее их число', async () => {
    // Группа исполняется целиком и уровнем preview (§7.10) — то есть СРАЗУ. Проверка
    // «сейчас рутин меньше лимита» пропустила бы batch, переваливающий за лимит всеми
    // своими операциями вместе: с limit 1 и нулём рутин завелись бы обе.
    const owner = freshUserId();
    const oneRoutine = ctxFor({
      actorUserId: owner,
      entitlements: () => ({ allowed: true, limit: 1 }),
    });
    const create = (title: string) => ({
      tool: 'entity_create',
      input: { title, tags: [], props: ROUTINE_DATA, aspects: ['orbis/routine'] },
    });

    expectError(
      await dispatchTool(oneRoutine, 'batch_execute', {
        batch_id: newId(),
        operations: [create('Первая рутина группы'), create('Вторая рутина группы')],
      }),
      'LIMIT',
    );
    expect(await routineCountOf(owner)).toBe(0);

    // Одна новая рутина в лимит помещается — отказ адресован масштабу, а не батчу
    const ok = await dispatchTool(oneRoutine, 'batch_execute', {
      batch_id: newId(),
      operations: [create('Единственная рутина группы')],
    });
    expect(ok.status).toBe('ok');
    expect(await routineCountOf(owner)).toBe(1);
  });

  test('batch_execute рутине закрыт даже белым списком (гейт режима)', async () => {
    // Отказ даёт гейт РЕЖИМА (`routineToolAllowed`, registry.ts): batch_execute вычтен из
    // белого списка рутины всегда — владелец не вправе открыть его ей даже намеренно.
    // Уровень §7.10 тут ни при чём: до классификации вызов не доходит. Белым списком при
    // этом сверяется только ВНЕШНЕЕ имя — вложенные операции им не проверяются
    const target = await seedEntity(userA, { title: 'Цель батча рутины', tags: [] });
    const ctx = rt('act', ['batch_execute', 'entity_update']);
    expectError(
      await dispatchTool(ctx, 'batch_execute', {
        batch_id: newId(),
        operations: [{ tool: 'entity_update', input: { id: target.id, title: 'Через батч' } }],
      }),
      'FORBIDDEN_LEVEL',
    );
    expect(await titleOf(target.id)).toBe('Цель батча рутины');
  });

  test('act с allowed_tools [entity_update]: правка ПРОГОНА (свой run: reply/outcome) → FORBIDDEN_LEVEL routine_untouchable; бухгалтерия system проходит (A-1)', async () => {
    // Рутина знает свой run_id (он в системном слое промпта) — подделать «ответ владельца»
    // или закрыть прогон она не должна ни своим, ни чужим прогоном
    const { propsOf, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);
    const routineId = await seedRoutine(userA, {
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
    });
    const { runId } = await seedRoutineRun(userA, { routineId, bucket: '2026-08-20T07:00' });
    const ctx = rt('act', ['entity_update'], {
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['entity_update']) },
    });

    const forged = await dispatchTool(ctx, 'entity_update', {
      id: runId,
      props: { 'orbis/run_reply': { text: 'да', at: T0.toISOString() } },
    });
    expectError(forged, 'FORBIDDEN_LEVEL');
    if (forged.status === 'error') {
      expect((forged.error.details as { reason?: string }).reason).toBe('routine_untouchable');
    }
    const closed = await dispatchTool(ctx, 'entity_update', {
      id: runId,
      props: { 'orbis/run_outcome': 'finished' },
    });
    expectError(closed, 'FORBIDDEN_LEVEL');
    const run = await propsOf(userA, runId);
    expect(run['orbis/run_outcome']).toBe('running');
    expect(run['orbis/run_reply']).toBeUndefined();

    // Та же запись шага бухгалтерией (system) — как её пишет раннер — проходит.
    // Механизм `verb` (§А4-4) обязателен: `step_count` — служебное свойство прогона
    // (`system_writable`, §А2-5), и раннер пишет его именно так.
    const bySystem = await execute(db, {
      actorUserId: userA,
      actorKind: 'ai',
      source: 'system',
      mechanism: 'verb',
      runId,
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: runId,
            props: { 'orbis/step_count': 1 },
            aspects: { attach: ['orbis/agent-run'] },
          },
        },
      ],
    });
    expect(bySystem.ok).toBe(true);
  });

  test('фикстура routineCtx: подменённая рутина везёт СВОЙ прогон в ctx.runId', async () => {
    // Обвязка Задач 7–9: расхождение ctx.runId и routine.runId всплыло бы только в
    // глаголах, где прогон ищется по одному, а субъект — по другому
    const real: RoutineRef = {
      id: newId(),
      runId: newId(),
      mode: 'act',
      allowedTools: new Set(['entity_update']),
    };
    const ctx = routineCtx(userA, 'propose', [], { routine: real });
    expect(ctx.routine).toBe(real);
    expect(ctx.runId).toBe(real.runId);
  });
});

// ---------------------------------------------------------------------------
// Объектный пре-чек рутинной мутации (D42 ОЧ.4, блокер Б2 ревью)
// ---------------------------------------------------------------------------

describe('объектный пре-чек рутинной мутации (D42 ОЧ.4)', () => {
  const { propsOf, routineCtx, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);
  /** Субъект-рутина в act с часами сьюта (у `routineCtx` свой T0 круга исполнителя). */
  const rt = (allowed: string[], over: Partial<ToolCallCtx> = {}) =>
    routineCtx(userA, 'act', allowed, { clock: () => T0, ...over });

  /**
   * Отказ пре-чека: код и пара `reason` — те же, что у запрета по объекту на стадии 4
   * executor'а (`invariants.ts`), различает источник отказа только текст.
   */
  function expectPrecheckDenial(
    r: Awaited<ReturnType<typeof dispatchTool>>,
    contains: string,
  ): void {
    expectError(r, 'FORBIDDEN_LEVEL');
    if (r.status !== 'error') return;
    expect((r.error.details as { reason?: string }).reason).toBe('routine_untouchable');
    expect(r.error.message).toContain(contains);
  }

  test('цель — рутина, прогон или назначенный тикет: архивация → отказ на диспатче с reason routine_untouchable (приёмка 12)', async () => {
    // Карточка «архивировать рутину», поставленная в пачку, умерла бы на «Принять» отказом
    // executor'а — владельцу, который ни в чём не виноват. Значит она не должна родиться.
    const routineId = await seedRoutine(userA, { title: 'Соседняя рутина' });
    const { runId } = await seedRoutineRun(userA, { routineId, bucket: '2026-08-21T07:00' });
    const assigned = await seedEntity(userA, {
      title: 'Назначенный тикет',
      tags: [],
      props: {
        'orbis/task_status': 'inbox',
        'orbis/executor': 'human',
        'orbis/assignee': 'Пётр',
      },
      aspects: ['orbis/task', 'orbis/assignment'],
    });
    const ctx = rt(['entity_update']);

    for (const id of [routineId, runId, assigned.id]) {
      expectPrecheckDenial(
        await dispatchTool(ctx, 'entity_update', { id, archived: true }),
        'рутина не может менять рутины, прогоны и назначения',
      );
    }
  });

  test('выдача автономии из фона (все три формы) → отказ на диспатче, не карточка в пачку (В1)', async () => {
    // «Принять все» одним нажатием сняло бы замок V1.10 мимоходом — поэтому автономия
    // не откладывается ни в какой форме
    const other = await seedRoutine(userA, { title: 'Чужая рутина' });
    const plain = await seedEntity(userA, { title: 'Кандидат в рутины', tags: [] });
    const ctx = rt(['entity_update', 'attach_orbis_routine', 'entity_create']);

    expectPrecheckDenial(
      await dispatchTool(ctx, 'entity_update', {
        id: other,
        props: { 'orbis/routine_mode': 'act' },
      }),
      'выдача автономии',
    );
    expectPrecheckDenial(
      await dispatchTool(ctx, 'attach_orbis_routine', {
        entity_id: plain.id,
        data: {
          'orbis/routine_stage': 'active',
          'orbis/routine_at': '07:00',
          'orbis/routine_mode': 'act',
        },
      }),
      'выдача автономии',
    );
    expectPrecheckDenial(
      await dispatchTool(ctx, 'entity_create', {
        title: 'Рутина руками рутины',
        tags: [],
        props: {
          'orbis/routine_stage': 'active',
          'orbis/routine_at': '07:00',
          'orbis/routine_mode': 'act',
        },
        aspects: ['orbis/routine'],
      }),
      'выдача автономии',
    );

    // Ничего не записано: ни чужой режим, ни аспект на кандидате
    expect((await propsOf(userA, other))['orbis/routine_mode']).toBe('propose');
    expect(await propsOf(userA, plain.id)).toEqual({});
  });

  test('правка инструкции act-рутины из фона → отказ на диспатче (пере-использован скан носителя)', async () => {
    const actRoutine = await seedRoutine(userA, {
      title: 'Утренний обзор в act',
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
    });
    const ctx = rt(['entity_update']);

    expectPrecheckDenial(
      await dispatchTool(ctx, 'entity_update', { id: actRoutine, body: 'Новая инструкция' }),
      'инструкции act-рутины',
    );
  });

  // Проба расхождением колонок (§А1-1): `orbis/routine_mode: 'act'` лежит в `props`, а
  // аспекта рутины на строке НЕТ (так выглядит запись после detach — Р9). Старая карта
  // такое состояние не выражала: containment по ней требовал ключа аспекта. Без признака
  // носителя правка заголовка обычной записи, когда-то бывшей act-рутиной, читалась бы
  // как правка инструкции act-рутины и получала бы отказ на ровном месте.
  test('значения act-рутины БЕЗ её аспекта правку не запрещают (Р9)', async () => {
    const ghost = await seedEntity(userA, { title: 'Бывшая act-рутина', tags: [] });
    await withIdentity(db, userA, (tx) =>
      tx
        .update(entities)
        .set({ props: { 'orbis/routine_mode': 'act', 'orbis/routine_stage': 'active' } })
        .where(eq(entities.id, ghost.id)),
    );
    const ctx = rt(['entity_update']);

    // Запрета нет: пре-чек молчит, и вызов уходит своим обычным путём (отложка).
    expect(
      await routineDeferForbidden(ctx, [], { grantsAutonomy: false, reconfigures: 'none' }, []),
    ).toBeNull();
    const r = await dispatchTool(ctx, 'entity_update', { id: ghost.id, title: 'Просто заметка' });
    expect(r.status).not.toBe('error');
  });

  test('связь концом в рутине или прогоне → отказ пре-чека; конец-НАЗНАЧЕНИЕ связь не запрещает', async () => {
    // До этой ветки диспатч сегодня не доводит: связи классифицируются как `execute`, а
    // пре-чек зовётся только выше него, batch же рутине закрыт совсем (ROUTINE_CLOSED_TOOLS).
    // Поэтому она проверяется прямым вызовом — тот же довод, по которому экспортирован
    // routineGate: рубеж, который никто не проверил, — это рубеж, которого нет.
    const routineId = await seedRoutine(userA, { title: 'Рутина как конец связи' });
    const { runId } = await seedRoutineRun(userA, { routineId, bucket: '2026-08-21T08:00' });
    const note = await seedEntity(userA, { title: 'Обычная заметка', tags: [] });
    const assigned = await seedEntity(userA, {
      title: 'Назначенный тикет как конец связи',
      tags: [],
      props: {
        'orbis/task_status': 'inbox',
        'orbis/executor': 'human',
        'orbis/assignee': 'Пётр',
      },
      aspects: ['orbis/task', 'orbis/assignment'],
    });
    const ctx = rt(['relation_create', 'relation_delete']);
    const link = (tool: string, source: string, target: string) => [
      { tool, input: { source_id: source, target_id: target, role: 'mention' } },
    ];
    const check = (ops: Array<{ tool: string; input: Record<string, unknown> }>) =>
      routineDeferForbidden(ctx, ops, { grantsAutonomy: false, reconfigures: 'none' }, []);

    // Цель связи — рутина; источник — прогон: направление запрета не меняет
    expect(await check(link('relation_create', note.id, routineId))).toContain(
      'рутина не может менять рутины, прогоны и назначения',
    );
    expect(await check(link('relation_delete', runId, note.id))).toContain(
      'рутина не может менять рутины, прогоны и назначения',
    );
    // Обе стороны обычные — откладывать можно
    expect(await check(link('relation_create', note.id, note.id))).toBeNull();
    // …а назначение конец связи не запрещает: пре-чек зеркалит запрет executor'а РОВНО
    // (assertRoutineRelationUntouchable смотрит только рутину и прогон), иначе он отказывал
    // бы в том, что на «Принять» прошло бы
    expect(await check(link('relation_create', note.id, assigned.id))).toBeNull();
  });

  test('обычная цель: пре-чек пропускает — архивация уезжает в отложку, а не в отказ; чатовый путь пре-чек не зовёт', async () => {
    const plain = await seedEntity(userA, { title: 'Обычная запись рутины', tags: [] });
    const routineId = await seedRoutine(userA, { title: 'Рутина для чатового пути' });
    const acting = await seedRoutine(userA, {
      title: 'Рутина обычной цели',
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
    });

    // Пре-чек касается ТОЛЬКО запретных объектов: обычная цель проходит его насквозь и
    // становится единицей пачки (D42 ОЧ.4) — отказа с `reason` здесь нет и быть не должно
    const deferred = await dispatchTool(
      rt(['entity_update'], {
        routine: {
          id: acting,
          runId: newId(),
          mode: 'act',
          allowedTools: new Set(['entity_update']),
        },
      }),
      'entity_update',
      { id: plain.id, archived: true },
    );
    expect(deferred.status).toBe('pending_confirmation');

    // Чат: пре-чек не зовётся вовсе — архивация РУТИНЫ по-прежнему уезжает в карточку
    // владельцу, который тут же на неё смотрит
    const threadId = await withIdentity(db, userA, (tx) =>
      ensureEntityThread(tx, userA, routineId),
    );
    const chat = await dispatchTool(ctxFor({ threadId }), 'entity_update', {
      id: routineId,
      archived: true,
    });
    expect(chat.status).toBe('pending_confirmation');
  });
});

// ---------------------------------------------------------------------------
// Отложка небезопасного действия рутины (D42 ОЧ.4, ОЧ.13)
// ---------------------------------------------------------------------------

describe('отложка небезопасного действия рутины (D42 ОЧ.4, ОЧ.13)', () => {
  const { routineCtx, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);

  /**
   * Контекст ЖИВОГО прогона ЖИВОЙ рутины: отложка кладёт карточку в тред рутины
   * (`ensureEntityThread`), а он требует настоящей сущности — подменённый id `routineCtx`
   * здесь не годится.
   */
  async function deferCtx(
    owner: string,
    over: Partial<ToolCallCtx> = {},
  ): Promise<{ ctx: ToolCallCtx; routineId: string; runId: string; threadId: string }> {
    const routineId = await seedRoutine(owner, {
      title: 'Рутина отложки',
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
    });
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-21T07:00' });
    const ctx = routineCtx(owner, 'act', ['entity_update'], {
      clock: () => T0,
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['entity_update']) },
      ...over,
    });
    const threadId = await withIdentity(db, owner, (tx) =>
      ensureEntityThread(tx, owner, routineId),
    );
    return { ctx, routineId, runId, threadId };
  }

  /** Pending-сообщения треда — единицы пачки прогона, как их видит владелец. */
  async function pendingsIn(owner: string, threadId: string) {
    return (await messagesIn(owner, threadId)).filter(
      (m) => (m.metadata as { pending?: unknown }).pending !== undefined,
    );
  }

  async function archivedOf(owner: string, id: string): Promise<boolean | undefined> {
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
    );
    return rows[0]?.archived;
  }

  test('рутина act: архивация записи → pending kind:action с предусловием archived in:[false] и снимком заголовка в карточке; модели вернулся pending_confirmation с pendingId; прогон-журнал §7.8 пуст (приёмка 2)', async () => {
    const owner = freshUserId();
    // Тред вызова НАРОЧНО чужой: единица ложится в тред РУТИНЫ (V1.6) — там, где владелец
    // читает её историю, — а не туда, куда пишет audit текущего вызова
    const host = await seedEntity(owner, { title: 'Посторонний тред', tags: [] });
    const hostThread = await withIdentity(db, owner, (tx) =>
      ensureEntityThread(tx, owner, host.id),
    );
    const { ctx, routineId, runId, threadId } = await deferCtx(owner, { threadId: hostThread });
    const target = await seedEntity(owner, {
      title: 'Прошлогодний отчёт',
      tags: [],
      props: { 'orbis/task_status': 'done' },
      aspects: ['orbis/task'],
    });

    const r = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;

    // Карточка своя, со снимком заголовка цели и строкой «было → станет»
    expect(r.card).toEqual({
      kind: 'deferred_action_card',
      pendingId: r.pendingId,
      runId,
      routineId,
      summary: 'Архивация: «Прошлогодний отчёт»',
      rows: [{ field: 'archived', before: 'false', after: 'true' }],
    });

    // Запись — единица пачки: явный kind, прогон, снятое предусловие по колонке
    const pendings = await pendingsIn(owner, threadId);
    expect(pendings).toHaveLength(1);
    const msg = pendings[0];
    expect(msg?.id).toBe(r.pendingId);
    const record = (msg?.metadata as { pending: Record<string, unknown> }).pending;
    expect(record.kind).toBe('action');
    expect(record.run_id).toBe(runId);
    expect(record.source).toBe('routine');
    expect(record.tool).toBe('entity_update');
    expect((record.input as Record<string, unknown>).precondition).toEqual([
      { property: 'orbis/archived', in: [false] },
    ]);
    expect(msg?.content).toBe('Отложено до решения: Архивация: «Прошлогодний отчёт»');

    // §7.8: отложка следа в журнале не оставляет — ни action'а, ни правки в графе
    expect((msg?.metadata as { actions?: unknown }).actions).toBeUndefined();
    expect(await archivedOf(owner, target.id)).toBe(false);
    // …и в треде вызова не осталось вообще ничего
    expect(await messagesIn(owner, hostThread)).toEqual([]);
  });

  test('ретрай того же вызова (в т.ч. с переставленными ключами JSON) → тот же pendingId, второй карточки нет (приёмка 15)', async () => {
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const target = await seedEntity(owner, { title: 'Цель ретрая', tags: [] });

    const first = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    // Тот же вызов с ПЕРЕСТАВЛЕННЫМИ ключами: личность единицы — от каноникализованного
    // payload'а, а не от текста JSON
    const again = await dispatchTool(ctx, 'entity_update', { archived: true, id: target.id });
    expect(first.status).toBe('pending_confirmation');
    expect(again.status).toBe('pending_confirmation');
    if (first.status !== 'pending_confirmation' || again.status !== 'pending_confirmation') return;

    expect(again.pendingId).toBe(first.pendingId);
    expect(await pendingsIn(owner, threadId)).toHaveLength(1);
    // Карточка ретрая — та же самая, что владелец уже видит в ленте
    expect(again.card).toEqual(first.card);
  });

  test('ретрай ПОСЛЕ правки цели владельцем → тот же pendingId и ПЕРВЫЙ снимок предусловий: личность единицы считается от ИСХОДНОГО payload модели, а предусловия не переснимаются (ОЧ.13, §9.4)', async () => {
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const target = await seedEntity(owner, {
      title: 'Цель, которую тронули между попытками',
      tags: [],
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    });
    const call = { id: target.id, archived: true, props: { 'orbis/task_status': 'done' } };

    const first = await dispatchTool(ctx, 'entity_update', call);
    expect(first.status).toBe('pending_confirmation');
    if (first.status !== 'pending_confirmation') return;

    // Владелец сдвинул статус — ВТОРОЕ снятие предусловий дало бы `in:['in_progress']`
    const own = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: target.id,
            props: { 'orbis/task_status': 'in_progress' },
            aspects: { attach: ['orbis/task'] },
          },
        },
      ],
    });
    expect(own.ok).toBe(true);

    const again = await dispatchTool(ctx, 'entity_update', call);
    expect(again.status).toBe('pending_confirmation');
    if (again.status !== 'pending_confirmation') return;
    // Хеш считается от payload'а МОДЕЛИ: он побайтово тот же, значит это тот же ретрай
    expect(again.pendingId).toBe(first.pendingId);
    const pendings = await pendingsIn(owner, threadId);
    expect(pendings).toHaveLength(1);
    // Предусловия — снимок ПЕРВОЙ постановки, а не сегодняшнего состояния
    const record = (pendings[0]?.metadata as { pending: Record<string, unknown> }).pending;
    expect((record.input as Record<string, unknown>).precondition).toEqual([
      { property: 'orbis/task_status', in: ['inbox'] },
      { property: 'orbis/archived', in: [false] },
    ]);
    // Карточка ретрая — тоже исходная, со «было» первой попытки
    expect(again.card).toEqual(first.card);
    if (again.card.kind !== 'deferred_action_card') return;
    // Строка адресуется СВОЙСТВОМ (§А1-1): ключа `aspect` у неё больше нет.
    expect(again.card.rows).toEqual([
      { field: 'orbis/task_status', before: 'inbox', after: 'done' },
      { field: 'archived', before: 'false', after: 'true' },
    ]);
  });

  test('11-я открытая единица → VALIDATION «пачка полна» с reason run_units_cap; ретрай уже стоящей единицы кап НЕ отвергает (Р-15); прогон может продолжаться (приёмка 16)', async () => {
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const e = await seedEntity(owner, { title: `Кандидат в архив ${i}`, tags: [] });
      ids.push(e.id);
      const r = await dispatchTool(ctx, 'entity_update', { id: e.id, archived: true });
      expect(r.status).toBe('pending_confirmation');
    }
    expect(await pendingsIn(owner, threadId)).toHaveLength(10);

    const eleventh = await seedEntity(owner, { title: 'Одиннадцатый', tags: [] });
    const over = await dispatchTool(ctx, 'entity_update', { id: eleventh.id, archived: true });
    expectError(over, 'VALIDATION');
    if (over.status === 'error') {
      expect(over.error.message).toContain('пачка полна');
      expect(over.error.details).toEqual({ reason: 'run_units_cap', limit: 10 });
    }
    // Отказ структурный: карточки нет, граф не тронут — прогон продолжается дальше
    expect(await pendingsIn(owner, threadId)).toHaveLength(10);
    expect(await archivedOf(owner, eleventh.id)).toBe(false);

    // Ретрай ДЕСЯТОЙ единицы при полной пачке — replay, а не отказ: наивный порядок
    // «кап → запись» отверг бы повтор того, что уже стоит
    const replay = await dispatchTool(ctx, 'entity_update', {
      id: ids[9] as string,
      archived: true,
    });
    expect(replay.status).toBe('pending_confirmation');
    expect(await pendingsIn(owner, threadId)).toHaveLength(10);
  });

  test('цель УЖЕ архивирована → структурный отказ CONFLICT при постановке, карточки нет (Minor ревью Задачи 5)', async () => {
    // Предусловие архивации ставится ЛИТЕРАЛОМ `in:[false]`, а не снимком. Если цель уже
    // в архиве, карточка родилась бы с «было: false» — ЛОЖЬЮ владельцу — и с заведомым
    // CONFLICT на «Принять», а модель считала бы единицу поставленной
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const target = await seedEntity(owner, { title: 'Уже в архиве', tags: [] });
    const own = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
    });
    expect(own.ok).toBe(true);

    const r = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    expectError(r, 'CONFLICT');
    if (r.status === 'error') {
      expect(r.error.details).toEqual({ reason: 'already_archived', id: target.id });
    }
    expect(await pendingsIn(owner, threadId)).toHaveLength(0);
  });

  test('отложка с несуществующим id цели → NOT_FOUND на диспатче, pending не создан', async () => {
    // Отказ обязан прийти МОДЕЛИ, здесь и сейчас, а не владельцу на кнопке «Принять»:
    // регресс, уносящий его на approve, без этого пина прошёл бы незаметно
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const r = await dispatchTool(ctx, 'entity_update', { id: newId(), archived: true });
    expectError(r, 'NOT_FOUND');
    expect(await pendingsIn(owner, threadId)).toHaveLength(0);
  });

  test('«Принять» отложенную архивацию после изменения цели → stale с mismatches (предусловия сняты при постановке и не переснимаются — ОЧ.13, §9.4)', async () => {
    const owner = freshUserId();
    const { ctx } = await deferCtx(owner);
    const target = await seedEntity(owner, { title: 'Цель, которую тронул владелец', tags: [] });

    const r = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;

    // Владелец архивировал сам — предусловие, снятое при постановке, больше не выполнено
    const own = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
    });
    expect(own.ok).toBe(true);

    const applied = await approvePending(db, { ownerId: owner, pendingId: r.pendingId });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error.code).toBe('CONFLICT');
    expect((applied.error.details as { mismatches?: unknown[] }).mismatches).toEqual([
      { property: 'orbis/archived', expected: [false], actual: true },
    ]);
  });

  test('чат/MCP: ветка createPending байт-в-байт прежняя (dedupeKey batch-only, карточка confirmation_card)', async () => {
    // Отложка — рычаг ТОЛЬКО фона: у чата и MCP за карточкой стоит владелец, который
    // смотрит на неё сейчас, и ни единицей пачки, ни дедупом по содержимому она не стала
    const owner = freshUserId();
    const host = await seedEntity(owner, { title: 'Хост-тред', tags: [] });
    const threadId = await withIdentity(db, owner, (tx) => ensureEntityThread(tx, owner, host.id));
    const target = await seedEntity(owner, { title: 'Цель чата', tags: [] });

    for (const source of ['chat', 'mcp'] as const) {
      const r = await dispatchTool(
        ctxFor({ actorUserId: owner, source, threadId }),
        'entity_update',
        { id: target.id, archived: true },
      );
      expect(r.status).toBe('pending_confirmation');
      if (r.status !== 'pending_confirmation') continue;
      expect(r.card).toEqual({
        kind: 'confirmation_card',
        mode: 'explicit',
        pendingId: r.pendingId,
        summary: 'entity_update',
      });
      const record = (
        (await messagesIn(owner, threadId)).find((m) => m.id === r.pendingId)?.metadata as {
          pending: Record<string, unknown>;
        }
      ).pending;
      // Ни kind, ни run_id, ни предусловий: запись чатового пути не изменилась ни на ключ
      expect(record.kind).toBeUndefined();
      expect(record.run_id).toBeUndefined();
      expect(record.input).toEqual({ id: target.id, archived: true });
    }
    // Дедуп ключуется batch_id: две одиночные архивации без него — две РАЗНЫЕ карточки
    const pendings = await pendingsIn(owner, threadId);
    expect(pendings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §С2-1: класс подтверждения мутаций реестра (приёмка §С8-11, Задача 16)
// ---------------------------------------------------------------------------

/**
 * «Молчаливых мутаций реестра не существует ни для какого актора» — живые пути каждого ряда
 * таблицы §С2-1. Ответы самого классификатора пиннятся юнитами (`policy/confirmation.test.ts`);
 * здесь проверяется, что вызов ДОХОДИТ до них и что за уровнем следует обещанное поведение:
 * карточка, единица пачки или отказ по объекту.
 */
describe('§С2-1: мутации реестра — уровень подтверждения на живых путях (приёмка §С8-11)', () => {
  const { routineCtx, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);

  /** Своё свойство владельца — через ту же операцию исполнителя, что зовут тул и роутер. */
  async function ownProperty(owner: string, ru: string): Promise<{ id: string; key: string }> {
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'property_create',
          input: {
            label: { ru },
            description: { ru: `Смысл «${ru}»` },
            type: { kind: 'number' },
            status: 'active',
          },
        },
      ],
    });
    if (!r.ok) throw new Error(`ownProperty: ${r.error.code} ${r.error.message}`);
    // Результат операции реестра — `{property, key}` (`executor.ts`), а не `{id}`.
    const out = r.results[0] as { property: string; key: string };
    return { id: out.property, key: out.key };
  }

  /** Строка реестра как она лежит: пробой «мутация НЕ применилась» служит она, а не ответ. */
  async function registryRow(owner: string, id: string) {
    const rows = (await withIdentity(db, owner, (tx) =>
      tx.execute(sql`
        SELECT label, status, merged_into FROM property_definitions
         WHERE owner_id = ${owner}::uuid AND id = ${id}`),
    )) as unknown as Array<{ label: Record<string, string>; status: string; merged_into: unknown }>;
    return rows[0];
  }

  /** Сколько СВОИХ строк свойств у владельца — проба «мутация ещё не применилась». */
  async function ownPropertyCount(owner: string): Promise<number> {
    const rows = (await withIdentity(db, owner, (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM property_definitions WHERE owner_id = ${owner}::uuid`,
      ),
    )) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }

  async function deltaRowsOf(owner: string): Promise<number> {
    const rows = (await withIdentity(db, owner, (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM registry_deltas WHERE owner_id = ${owner}::uuid`,
      ),
    )) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }

  /** Живой прогон живой act-рутины с названным белым списком — «садовник словаря». */
  async function gardener(owner: string, allowed: string[]) {
    const routineId = await seedRoutine(owner, {
      title: 'Садовник словаря',
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': allowed },
    });
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-26T09:00' });
    const ctx = routineCtx(owner, 'act', allowed, {
      clock: () => T0,
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(allowed) },
    });
    const threadId = await withIdentity(db, owner, (tx) =>
      ensureEntityThread(tx, owner, routineId),
    );
    return { ctx, routineId, runId, threadId };
  }

  async function pendingsOf(owner: string, threadId: string) {
    return (await messagesIn(owner, threadId)).filter(
      (m) => (m.metadata as { pending?: unknown }).pending !== undefined,
    );
  }

  test('property_create proposed из чата (actor model) → preview: исполнено + карточка; от владельца через UI-роутер → execute без карточки', async () => {
    const owner = freshUserId();
    const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));
    const input = {
      label: { ru: 'Усилие' },
      description: { ru: 'Сколько сил отнимет дело' },
      type: { kind: 'number' as const },
      status: 'proposed' as const,
    };

    const r = await dispatchTool(
      ctxFor({ actorUserId: owner, threadId }),
      'property_create',
      input,
    );
    // preview §7.10 — ИНФОРМАЦИОННЫЙ: действие исполнено, владельцу показана карточка.
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.card).toEqual({
      kind: 'confirmation_card',
      mode: 'preview',
      summary: 'Заведение свойства «Усилие» (предложение)',
    });
    const created = r.result as { property: string; key: string };
    expect((await registryRow(owner, created.property))?.status).toBe('proposed');
    // Карточка-запрос при этом НЕ рождалась: preview ничего не откладывает.
    expect(await pendingsOf(owner, threadId)).toHaveLength(0);

    // Тот же вызов рукой владельца — UI-роутером МИМО диспатча и политики (§С2-1 ряд 1
    // адресует preview не-владельцу). Проба не подменяет роутер своим `execute`: она зовёт
    // ту самую процедуру, которой пользуется экран.
    const caller = createCallerFactory(appRouter)({
      actorUserId: owner,
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    const byOwner = (await caller.registry.createProperty({
      ...input,
      label: { ru: 'Усилие владельца' },
      status: 'active',
    })) as { property: string };
    expect((await registryRow(owner, byOwner.property))?.status).toBe('active');
    expect(await pendingsOf(owner, threadId)).toHaveLength(0);
  });

  test('property_merge из чата → explicit-confirmation: карточка-запрос, реестр НЕ тронут; approve исполняет', async () => {
    const owner = freshUserId();
    const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));
    const source = await ownProperty(owner, 'Усилие');
    const into = await ownProperty(owner, 'Уровень усилия');

    const r = await dispatchTool(ctxFor({ actorUserId: owner, threadId }), 'property_merge', {
      source: source.id,
      into: into.id,
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;
    // КАРТОЧКА НАЗЫВАЕТ СОДЕРЖАНИЕ, А НЕ ИМЯ ТУЛА (гейт-ревью Задачи 16). §С8-11 требует у
    // слияния и дельты ДИФФ Ш1 — форму, в которой владелец ВИДИТ, что подтверждает;
    // «Требуется подтверждение: property_merge» не отвечает на этот вопрос и обучает жать
    // «Принять» вслепую. Фраза — той же функцией и по тому же снимку, что у карточки
    // preview и у отложенной единицы.
    expect(r.card).toEqual({
      kind: 'confirmation_card',
      mode: 'explicit',
      pendingId: r.pendingId,
      summary: 'Слияние свойств: «Усилие» → «Уровень усилия»',
    });
    // Пробы «не имя тула» и «не адрес» — обе стороны границы, а не одна: uuid в карточке
    // владельцу так же нечем истолковать, как и `property_merge`.
    if (r.card.kind !== 'confirmation_card') throw new Error('ожидалась карточка-запрос');
    expect(r.card.summary).not.toContain('property_merge');
    expect(r.card.summary).not.toContain(source.id);
    // Строка ЛЕНТЫ — то, что владелец видит в треде, а не только payload карточки.
    const line = (await messagesIn(owner, threadId)).find((m) => m.id === r.pendingId);
    expect(String(line?.content)).toBe(
      'Требуется подтверждение: Слияние свойств: «Усилие» → «Уровень усилия»',
    );
    // ДО подтверждения в реестре не изменилось ничего — ни `merged_into`, ни версия строки.
    expect((await registryRow(owner, source.id))?.merged_into).toBeNull();

    // Отказ ведёт к выходу: подтверждение владельца исполняет ровно этот вызов.
    await approvePending(db, { ownerId: owner, pendingId: r.pendingId });
    expect((await registryRow(owner, source.id))?.merged_into).toBe(into.id);
  });

  test('склейка поводов: пачка «слить свойства + разоружить act-рутину» называет ОБА, а не вытесняет одно другим', async () => {
    // Довод — тот же, по которому фикс-раунд 3 Задачи 12 переводил ветку инструкции со
    // «вместо» на «склеиваются»: владелец подписывает ВСЁ, что подняло уровень. Здесь
    // поводов два и они из разных ветвей — реестр (ряд 4a §С2-1) и автономия (V1.10).
    const owner = freshUserId();
    const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));
    const source = await ownProperty(owner, 'Усилие');
    const into = await ownProperty(owner, 'Уровень усилия');
    const routineId = await seedRoutine(owner, {
      title: 'Вооружённая рутина',
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
    });

    const r = await dispatchTool(ctxFor({ actorUserId: owner, threadId }), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'property_merge', input: { source: source.id, into: into.id } },
        {
          tool: 'entity_update',
          input: { id: routineId, props: { 'orbis/routine_mode': 'propose' } },
        },
      ],
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation' || r.card.kind !== 'confirmation_card') {
      throw new Error('ожидалась карточка-запрос');
    }
    // ПОЛНАЯ строка, а не префиксы: проба на `toContain('Автономия рутины')` зеленела бы и
    // с испорченным хвостом фразы — именно тем, который называет владельцу режим.
    expect(r.card.summary).toBe(
      'Автономия рутины «Вооружённая рутина»: режим propose; ' +
        'Слияние свойств: «Усилие» → «Уровень усилия» — в пачке из 2 операции',
    );
    // Ни слияние, ни разоружение до подтверждения не применены.
    expect((await registryRow(owner, source.id))?.merged_into).toBeNull();
  });

  test('property_merge от рутины (садовник) → отложенная единица пачки D42 в треде рутины, прогон продолжается', async () => {
    const owner = freshUserId();
    const source = await ownProperty(owner, 'Усилие');
    const into = await ownProperty(owner, 'Уровень усилия');
    const { ctx, routineId, runId, threadId } = await gardener(owner, ['property_merge']);

    const r = await dispatchTool(ctx, 'property_merge', { source: source.id, into: into.id });
    // «Прогон продолжается» — это ответ pending_confirmation вместо FORBIDDEN_LEVEL: модель
    // получает честное «отложено» и делает следующий шаг (D42 ОЧ.4).
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;
    expect(r.card).toEqual({
      kind: 'deferred_action_card',
      pendingId: r.pendingId,
      runId,
      routineId,
      // Владелец читает пачку ПОДПИСЯМИ, а не адресами: «019e4466-…» ему не отвечает.
      summary: 'Слияние свойств: «Усилие» → «Уровень усилия»',
      rows: [{ field: 'property_merge', before: 'Усилие', after: 'Уровень усилия' }],
    });

    const pendings = await pendingsOf(owner, threadId);
    expect(pendings).toHaveLength(1);
    const record = (pendings[0]?.metadata as { pending: Record<string, unknown> }).pending;
    expect(record.kind).toBe('action');
    expect(record.run_id).toBe(runId);
    expect(record.tool).toBe('property_merge');
    // Payload уезжает БАЙТ-В-БАЙТ: предусловий у операций реестра нет — свежее состояние
    // перечитывает сама операция под замком реестра (см. докблок snapshotRegistryUnit).
    expect(record.input).toEqual({ source: source.id, into: into.id });
    // Реестр до решения владельца не тронут.
    expect((await registryRow(owner, source.id))?.merged_into).toBeNull();

    // Ретрай того же шага не плодит вторую единицу — общий механизм отложки жив и здесь.
    const again = await dispatchTool(ctx, 'property_merge', { into: into.id, source: source.id });
    expect(again.status).toBe('pending_confirmation');
    if (again.status !== 'pending_confirmation') return;
    expect(again.pendingId).toBe(r.pendingId);
    expect(await pendingsOf(owner, threadId)).toHaveLength(1);

    // …а «Принять» исполняет отложенное — путь до конца, а не тупик.
    await approvePending(db, { ownerId: owner, pendingId: r.pendingId });
    expect((await registryRow(owner, source.id))?.merged_into).toBe(into.id);
  });

  test('property_update(status) от рутины — тоже отложенная единица: «было → станет» по полю патча', async () => {
    const owner = freshUserId();
    const target = await ownProperty(owner, 'Черновое свойство');
    const { ctx, threadId } = await gardener(owner, ['property_update']);

    const r = await dispatchTool(ctx, 'property_update', { id: target.id, status: 'deprecated' });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation' || r.card.kind !== 'deferred_action_card') {
      throw new Error('ожидалась отложенная единица');
    }
    expect(r.card.summary).toBe('Правка свойства «Черновое свойство»');
    expect(r.card.rows).toEqual([{ before: 'active', field: 'status', after: 'deprecated' }]);
    expect(await pendingsOf(owner, threadId)).toHaveLength(1);
    expect((await registryRow(owner, target.id))?.status).toBe('active');
  });

  test('property_create от рутины по белому списку → отложенная единица, а не FORBIDDEN_LEVEL (Р-24-7)', async () => {
    // «Показанное исполнимо» (тот же довод, по которому `batch_execute` закрыт рутине): тул
    // виден модели по белому списку, промпт `routine-v3` прямо велит им пользоваться, а PRD
    // §7.10 обещает «свои строки владельца откладываются» — до этой правки все трое
    // обещали путь, которому был гарантирован отказ по уровню.
    const owner = freshUserId();
    const { ctx, threadId } = await gardener(owner, ['property_create']);

    const r = await dispatchTool(ctx, 'property_create', {
      label: { ru: 'Усилие' },
      description: { ru: 'Сколько сил отнимет дело' },
      type: { kind: 'number' as const },
      status: 'proposed' as const,
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation' || r.card.kind !== 'deferred_action_card') {
      throw new Error('ожидалась отложенная единица');
    }
    expect(r.card.summary).toBe('Заведение свойства «Усилие» (предложение)');
    // Строки называют, ЧТО заведут, а не дампят конверт родовой строкой fail-closed-хвоста.
    expect(r.card.rows.map((x) => x.field)).toEqual(['label', 'description', 'type', 'status']);
    expect(await pendingsOf(owner, threadId)).toHaveLength(1);
    // До решения владельца строки в реестре нет.
    expect(await ownPropertyCount(owner)).toBe(0);

    await approvePending(db, { ownerId: owner, pendingId: r.pendingId });
    expect(await ownPropertyCount(owner)).toBe(1);
  });

  test('property_update{label} (без status) от рутины — тоже отложенная единица, а не отказ', async () => {
    // Сосед зелёного теста про `status` выше: тот же тул, тот же белый список, разница
    // только в поле патча — и она меняла исход с отложки на `FORBIDDEN_LEVEL`.
    const owner = freshUserId();
    const target = await ownProperty(owner, 'Усилие');
    const { ctx, threadId } = await gardener(owner, ['property_update']);

    const r = await dispatchTool(ctx, 'property_update', {
      id: target.id,
      label: { ru: 'Уровень усилия' },
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation' || r.card.kind !== 'deferred_action_card') {
      throw new Error('ожидалась отложенная единица');
    }
    expect(r.card.rows.map((x) => x.field)).toEqual(['label']);
    expect(await pendingsOf(owner, threadId)).toHaveLength(1);
  });

  test('единица реестра хранит адрес ИДЕНТИФИКАТОРОМ: освободившийся key не уводит «Принять» на чужую строку', async () => {
    // A5-Minor-1. `readOwnProperty`/`resolveMergePair` резолвят `id ИЛИ key`, а key
    // отклонённого неиспользованного `proposed` освобождается физическим удалением строки
    // (`freeKey`). Единица, поставленная по key, применилась бы к ОДНОФАМИЛЬЦУ, о котором на
    // карточке не было ни слова, — молча и необратимо.
    const owner = freshUserId();
    const { ctx } = await gardener(owner, ['property_update']);
    const first = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'property_create',
          input: {
            key: 'user/effort',
            label: { ru: 'Усилие' },
            description: { ru: 'Первое значение ключа' },
            type: { kind: 'number' as const },
            status: 'proposed' as const,
          },
        },
      ],
    });
    if (!first.ok) throw new Error(`фикстура: ${first.error.message}`);
    const firstId = (first.results[0] as { property: string }).property;

    // Единица ставится ПО KEY — так её и напишет модель.
    const r = await dispatchTool(ctx, 'property_update', {
      id: 'user/effort',
      label: { ru: 'Уровень усилия' },
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;

    // Владелец отклоняет неиспользованное предложение — строка удаляется, key свободен…
    const dropped = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'property_update', input: { id: firstId, status: 'deprecated' } }],
    });
    if (!dropped.ok) throw new Error(`отклонение: ${dropped.error.message}`);
    // …и тот же key занимает ДРУГОЕ свойство другого смысла.
    const second = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'property_create',
          input: {
            key: 'user/effort',
            label: { ru: 'Однофамилец' },
            description: { ru: 'Другое свойство под тем же ключом' },
            type: { kind: 'number' as const },
            status: 'active' as const,
          },
        },
      ],
    });
    if (!second.ok) throw new Error(`однофамилец: ${second.error.message}`);
    const secondId = (second.results[0] as { property: string }).property;

    // «Принять» честно упирается в исчезнувшую строку, а не правит однофамильца.
    const applied = await approvePending(db, { ownerId: owner, pendingId: r.pendingId });
    expect(applied.ok ? 'ok' : applied.error.code).toBe('NOT_FOUND');
    expect((await registryRow(owner, secondId))?.label).toEqual({ ru: 'Однофамилец' });
  });

  test('ЧАТОВАЯ карточка-запрос тоже хранит адрес id: освободившийся key не уводит «Принять»', async () => {
    // Тот же «однофамилец», что у отложенной единицы (тест выше), но по чатовому пути:
    // `property_update{status}` от AI даёт `explicit-confirmation` → карточка в треде, и она
    // ждёт решения владельца дольше всего. Первоисточник (A5-Minor-1) называл ОБЕ точки.
    const owner = freshUserId();
    const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));
    const first = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'property_create',
          input: {
            key: 'user/effort',
            label: { ru: 'Усилие' },
            description: { ru: 'Первое значение ключа' },
            type: { kind: 'number' as const },
            status: 'proposed' as const,
          },
        },
      ],
    });
    if (!first.ok) throw new Error(`фикстура: ${first.error.message}`);
    const firstId = (first.results[0] as { property: string }).property;

    // Модель просит смену статуса ПО KEY — карточка-запрос владельцу.
    const r = await dispatchTool(ctxFor({ actorUserId: owner, threadId }), 'property_update', {
      id: 'user/effort',
      status: 'deprecated',
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;

    // Владелец отклоняет неиспользованное предложение — строка удаляется, key свободен…
    const dropped = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'property_update', input: { id: firstId, status: 'deprecated' } }],
    });
    if (!dropped.ok) throw new Error(`отклонение: ${dropped.error.message}`);
    // …и тот же key занимает ДРУГОЕ свойство.
    const second = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'property_create',
          input: {
            key: 'user/effort',
            label: { ru: 'Однофамилец' },
            description: { ru: 'Другое свойство под тем же ключом' },
            type: { kind: 'number' as const },
            status: 'active' as const,
          },
        },
      ],
    });
    if (!second.ok) throw new Error(`однофамилец: ${second.error.message}`);
    const secondId = (second.results[0] as { property: string }).property;

    const applied = await approvePending(db, { ownerId: owner, pendingId: r.pendingId });
    expect(applied.ok ? 'ok' : applied.error.code).toBe('NOT_FOUND');
    expect((await registryRow(owner, secondId))?.status).toBe('active');
  });

  test('aspect_delta_set по ВСТРОЕННОМУ аспекту от рутины → отказ по объекту, единица НЕ рождается', async () => {
    // §С2-1 ряд 3 («`implements` встроенных аспектов, роли created_by: system, определения
    // чужих модулей»): в срезе А из перечисленного достижимы встроенные строки реестра —
    // `implements` пустует до части Б, роли тулами не адресуются (см. юнит-тест-tripwire в
    // `confirmation.test.ts`). Правило написано по АДРЕСУ объекта и накрывает их все.
    const owner = freshUserId();
    const { ctx, threadId } = await gardener(owner, ['aspect_delta_set', 'aspect_delta_remove']);

    for (const [tool, input] of [
      ['aspect_delta_set', { aspect: 'orbis/task', delta: { label: { ru: 'Дела' } } }],
      ['aspect_delta_remove', { aspect: 'orbis/task' }],
      // Машинерия делегирования — тот же отказ: скрыв `orbis/routine_mode` из аспекта
      // рутины, фон убрал бы доверенность с глаз владельца.
      [
        'aspect_delta_set',
        { aspect: 'orbis/routine', delta: { properties: { hide: ['orbis/routine_mode'] } } },
      ],
    ] as const) {
      const r = await dispatchTool(ctx, tool, input);
      expectError(r, 'FORBIDDEN_LEVEL');
      if (r.status !== 'error') continue;
      expect((r.error.details as { reason?: string }).reason).toBe('routine_untouchable');
      expect(r.error.message).toContain('перенастройка системного объекта');
      // Выход назван в самом отказе — иначе агент чинил бы не то.
      expect(r.error.message).toContain('orbis_ask');
    }
    // Ни единицы в пачке, ни дельты в реестре: «не откладывается никогда».
    expect(await pendingsOf(owner, threadId)).toHaveLength(0);
    expect(await deltaRowsOf(owner)).toBe(0);
  });

  test('тот же aspect_delta_set из ЧАТА → карточка-запрос, а не молчаливое исполнение', async () => {
    // Запрет по объекту адресован ФОНУ; в чате владелец стоит рядом и решает карточкой.
    const owner = freshUserId();
    const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));
    const r = await dispatchTool(ctxFor({ actorUserId: owner, threadId }), 'aspect_delta_set', {
      aspect: 'orbis/task',
      delta: { icon: '📌' },
    });
    expect(r.status).toBe('pending_confirmation');
    expect(await deltaRowsOf(owner)).toBe(0);
    if (r.status !== 'pending_confirmation') return;
    await approvePending(db, { ownerId: owner, pendingId: r.pendingId });
    expect(await deltaRowsOf(owner)).toBe(1);
  });

  test('MCP-агент с полным грантом отвечает так же, как чат: правила §7.10 едины (§9.3)', async () => {
    // Классификатор по `source` не ветвится намеренно — внешний агент не должен получать
    // более широкие права, придя другим транспортом. Пин на обоих концах шкалы.
    const owner = freshUserId();
    const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));
    const source = await ownProperty(owner, 'Усилие');
    const into = await ownProperty(owner, 'Уровень усилия');
    const token = await issuePatGrant(db, { ownerId: owner, scope: 'full', label: 'полный' });
    const identity = await verifyBearer(db, token);
    if (identity === null) throw new Error('выданный full-PAT не прошёл verifyBearer');
    const ctx = ctxFor({
      actorUserId: owner,
      actorKind: 'agent',
      source: 'mcp',
      threadId,
      grant: { id: identity.grantId, scope: identity.scope, label: identity.label },
    });

    const merge = await dispatchTool(ctx, 'property_merge', { source: source.id, into: into.id });
    expect(merge.status).toBe('pending_confirmation');
    expect((await registryRow(owner, source.id))?.merged_into).toBeNull();

    const create = await dispatchTool(ctx, 'property_create', {
      label: { ru: 'Агентское' },
      description: { ru: 'Заведено внешним агентом' },
      type: { kind: 'text' },
      status: 'proposed',
    });
    expect(create.status).toBe('ok');
    if (create.status !== 'ok') return;
    expect(create.card).toEqual({
      kind: 'confirmation_card',
      mode: 'preview',
      summary: 'Заведение свойства «Агентское» (предложение)',
    });
  });
});

// ---------------------------------------------------------------------------
// Правила сводки мутации реестра: нейтральность ко времени и перечень карточек
// (ре-ревью фикс-раунда 1 Задачи 16)
// ---------------------------------------------------------------------------

describe('сводка мутации реестра: правила, а не случаи (§С2-1)', () => {
  /** Своё свойство владельца в снимке: у него id-uuid и своя подпись (§А2-1, Р3). */
  const ownProp = (id: string, ru: string) => ({
    ...(BUILTIN_PROPERTY_META.find((p) => p.id === 'orbis/priority') as PropertyDefinition),
    id,
    key: `user/${ru}`,
    ownerId: newId(),
    label: { ru },
  });
  const SOURCE = '019e4466-1111-7e07-b5d4-64be9721da01';
  const INTO = '019e4466-2222-7e07-b5d4-64be9721da02';
  const REG: RegistrySnapshot = {
    properties: new Map([
      ...BUILTIN_PROPERTY_META.map((p) => [p.id, p] as const),
      [SOURCE, ownProp(SOURCE, 'Усилие')],
      [INTO, ownProp(INTO, 'Уровень усилия')],
    ]),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(),
    ownerVersion: 1,
    systemVersion: 1,
  };

  /**
   * ГОЛОВЫ ФРАЗ — отглагольные существительные, и это ПРАВИЛО (докблок
   * `registryOperationSummary`): одна и та же строка уезжает и на карточку, где действие уже
   * исполнено (`preview`), и на две, где оно ЕЩЁ НЕ произошло (запрос, отложенная единица).
   * Прошедшее время правдиво в одном случае из трёх, а в двух других сообщает «уже
   * случилось» там, где СПРАШИВАЮТ разрешение.
   *
   * Список закрытый и расширяется ОСОЗНАННО: шестая операция реестра, названная «Заведено» /
   * «Слито» / «Создано», уронит проверку и заставит перечитать это правило, а не молча
   * принесёт ту же ошибку заново. Ровно она и была найдена ре-ревью фикс-раунда 1.
   */
  const NEUTRAL_HEADS: ReadonlySet<string> = new Set([
    'Заведение',
    'Правка',
    'Слияние',
    'Настройка',
    'Сброс',
  ]);
  const headOf = (phrase: string): string => phrase.split(' ')[0] ?? '';

  test('фразы сводки нейтральны ко времени: голова каждой — отглагольное существительное', () => {
    // Фикстуры ведутся ОТ РЕЕСТРА ТУЛОВ, а не списком в тесте: шестой реестровый тул без
    // фикстуры уронит первую же строку, и фразу для него придётся написать осознанно.
    const payloads: Record<string, Record<string, unknown>> = {
      property_create: { label: { ru: 'Усилие' }, status: 'proposed' },
      property_update: { id: SOURCE, label: { ru: 'Усилие' } },
      property_merge: { source: SOURCE, into: INTO },
      aspect_delta_set: { aspect: 'orbis/task', delta: { icon: '📌' } },
      aspect_delta_remove: { aspect: 'orbis/task' },
    };
    expect(Object.keys(payloads).sort()).toEqual([...REGISTRY_TOOL_NAMES].sort());

    // Golden фраз целиком — рядом с правилом: он показывает, ЧТО именно правило разрешает.
    const phrases = Object.fromEntries(
      [...REGISTRY_TOOL_NAMES].map((tool) => [
        tool,
        registryOperationSummary(REG, tool, payloads[tool] as Record<string, unknown>),
      ]),
    );
    expect(phrases).toEqual({
      property_create: 'Заведение свойства «Усилие» (предложение)',
      property_update: 'Правка свойства «Усилие»',
      property_merge: 'Слияние свойств: «Усилие» → «Уровень усилия»',
      aspect_delta_set: 'Настройка аспекта «Задача»',
      aspect_delta_remove: 'Сброс настройки аспекта «Задача»',
    });

    for (const [tool, phrase] of Object.entries(phrases)) {
      // Фраза — в тапле, а не только имя тула: падение обязано показывать, ЧТО отвергнуто,
      // иначе чинить придётся вслепую (класс 7 ветки: отказ ведёт к выходу — и текст
      // падения теста тут ничем не отличается от текста ошибки в проде).
      expect([tool, phrase, NEUTRAL_HEADS.has(headOf(phrase))]).toEqual([tool, phrase, true]);
    }

    // ПРОБА НЕ ВАКУУМНА: снятая формулировка прошедшего времени правилом ОТВЕРГАЕТСЯ.
    // Без этой строки тест зеленел бы и на правиле «голова — любое слово».
    for (const past of [
      'Заведено свойство «Усилие»',
      'Слито свойство «Усилие»',
      'Создано свойство «Усилие»',
    ]) {
      expect([past, NEUTRAL_HEADS.has(headOf(past))]).toEqual([past, false]);
    }
  });

  /**
   * МЕСТА СБОРКИ КАРТОЧЕК — ПЕРЕЧЕНЬ ЗАКРЫТ ПО ВСЕМУ СЕРВЕРУ. Дефект «докблок пересчитал
   * карточки и ошибся» случался в этой задаче ДВАЖДЫ, и оба раза он был формы «место сборки
   * карточки, которое сводку не звало». Греп по вызовам `registryOperationSummary` такой
   * дефект не видит ПО ПОСТРОЕНИЮ — он ловит что угодно, кроме того, что уже дважды
   * случилось. Поэтому пин идёт по местам сборки САМИХ карточек.
   *
   * ОХРАНА РЕКУРСИВНАЯ, А НЕ ПО СПИСКУ ФАЙЛОВ, и это исправление раунда 3: прежняя редакция
   * смотрела в два жёстко названных файла, и пятая сборка карточки в третьем
   * (`routines/lifecycle.ts` — проба ре-ревью) проходила МОЛЧА, тогда как охраняемый докблок
   * утверждает абсолютно — «мест сборки четыре». Абсолютное утверждение при неабсолютной
   * охране — ровно то, что здесь уже дважды подводило. Теперь обходится весь
   * `apps/server/src`.
   *
   * ЧТО ИМЕННО ЛОВИТСЯ — сказано вслух, потому что «нельзя нигде» было бы третьим абсолютным
   * утверждением подряд, и оно уже опровергнуто: пин видит место, где род карточки записан
   * ЛИТЕРАЛОМ, и НЕ видит род, пришедший переменной или параметром фабрики (проба ре-ревью
   * `const kind = …; return { kind, mode: 'preview', … }` проходит и `biome check`, и пин).
   * Сегодня дыры нет — все шесть сборщиков `Card` пишут род литералом; условие, при котором
   * охрана обнулится: вынос inline-сборок в общий хелпер с родом-параметром. Тогда этот пин
   * правится вместе с рефакторингом, а не после него.
   *
   * ГРАНИЦА НАЗВАНА: сервер, и только он. Web карточки РИСУЕТ, но не собирает — union его
   * типов (`features/chat/cards/types.ts`) описывает то, что приезжает готовым, а
   * производитель у карточек один (`tools/registry.ts`, `Card`). Появится сборщик на клиенте
   * — граница станет неверной, и это условие названо здесь, а не подразумевается.
   *
   * СВЕРЯЕТСЯ ФОРМА МЕСТА, А НЕ ТЕКСТ СТРОКИ — второе исправление раунда 3. Прежняя редакция
   * сверяла обрезанную строку целиком и потому падала на ЗАКОННОМ переформатировании уже
   * учтённого места (однострочный литерал разложили на многострочный — пин красный, `biome
   * check` чист). Такой пин обучает править ожидание не глядя, то есть не защищает вовсе.
   * Пара «файл + род карточки» переформатирование переживает: разложение объекта на строки
   * не двигает ни файл, ни род.
   *
   * ОБЪЯВЛЕНИЯ ТИПА ОТСЕИВАЮТСЯ ОТРИЦАНИЕМ `;`, а не перечнем допустимых хвостов, и это
   * различие не стилистическое. Первая редакция раунда 3 требовала после рода запятую или
   * закрывающую скобку — и собственная мутационная проба тут же нашла форму, которую такой
   * перечень не видит: `{ kind: 'confirmation_card' as const, … }`. Перечислять хвосты
   * сборки — это снова «перечень форм вместо перечня переходов», класс, на котором эта ветка
   * горела. Инверсия закрыта по построению: у члена union'а (`tools/registry.ts`) за родом
   * стоит `;`, у сборки — что угодно другое. Ошибается такой отсев только В СТОРОНУ ЛИШНЕГО
   * (член union'а, написанный с запятой, станет красным и потребует взгляда), а не в сторону
   * пропуска — то есть fail-closed, как и положено охране.
   */
  test('места сборки карточек — перечень закрыт по всему apps/server/src: четыре, и три из четырёх идут через сводку', () => {
    const CARD = /kind:\s*'(confirmation_card|deferred_action_card)'\s*(?!;)/;
    const isComment = (line: string): boolean =>
      line.trimStart().startsWith('*') || line.trimStart().startsWith('//');
    const root = join(import.meta.dir, '..');
    const files = (readdirSync(root, { recursive: true }) as string[])
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
      .sort();
    // Обход не вырожден: файлов сотня с лишним, а не ноль (иначе пустой список сошёлся бы
    // с пустым ожиданием и «зелёный» означал бы «ничего не искали»).
    expect(files.length).toBeGreaterThan(100);

    const sites = files.flatMap((path) =>
      readFileSync(join(root, path), 'utf8')
        .split('\n')
        .flatMap((line) => {
          const kind = !isComment(line) ? CARD.exec(line)?.[1] : undefined;
          return kind === undefined ? [] : [`${path} → ${kind}`];
        }),
    );
    expect(sites.sort()).toEqual([
      // 2. карточка-ЗАПРОС: собирается здесь, а сводку ей передаёт диспатч (summaryParts)
      'policy/pending.ts → confirmation_card',
      // 4. preview ПАЧКИ — единственное место без сводки: у группы пополевого diff'а нет,
      //    её содержание и есть масштаб (решение, разобранное в докблоке сводки);
      // 1. preview ОДИНОЧНОГО вызова — зовёт сводку
      'tools/dispatch.ts → confirmation_card',
      'tools/dispatch.ts → confirmation_card',
      // 3. отложенная единица пачки D42 — зовёт сводку через snapshotRegistryUnit
      'tools/dispatch.ts → deferred_action_card',
    ]);
    // Не вырожденно, и обе стороны каждой границы:
    expect(CARD.test("      kind: 'confirmation_card',")).toBe(true); // сборка
    expect(CARD.test("      kind: 'confirmation_card' }")).toBe(true); // она же, в одну строку
    // …и она же с уточнением типа — форма, которую перечень допустимых хвостов ПРОПУСКАЛ
    expect(CARD.test("      kind: 'confirmation_card' as const,")).toBe(true);
    expect(CARD.test("      kind: 'confirmation_card';")).toBe(false); // ОБЪЯВЛЕНИЕ типа
    expect(CARD.test("      kind: 'entity_card',")).toBe(false); // чужой род карточки
  });
});
