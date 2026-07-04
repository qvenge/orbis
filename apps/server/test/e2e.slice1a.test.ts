// apps/server/test/e2e.slice1a.test.ts
// Сквозной e2e-сценарий слайса 1a (Task 15): «день из 02 §5» на уровне API, два
// пользователя. Не TDD — это интеграция уже принятого ядра (Task 1–14) поверх живой БД
// через createCallerFactory (боевой синк — внутри роутеров, §7.8). Один describe,
// последовательные test-шаги (bun исполняет их в порядке объявления), общий state в
// переменных describe-скоупа; truncateAll — один раз в beforeAll.
//
// Что доказывается: сид → эмуляция fast-path-ввода → cross-aspect сущность → query
// смарт-листов и count → update+undo с журналом действий → excludeBlocked → экспорт
// всего графа → изоляция второго пользователя (RLS §4.10) на трёх срезах: query
// категорий, undoLast и экспорт.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entitySchema, globalThreadId, newId } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import type { ActionRecord } from '../src/executor/types';
import { appRouter } from '../src/router';
import { SEED_CATEGORIES } from '../src/seed/categories';
import { seedCategoryId } from '../src/seed/onboarding';
import { createCallerFactory } from '../src/trpc';
import { appDb, freshUserId, requireEnv, truncateAll } from './helpers';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

/** Caller от лица владельца: ctx как в бою (§9.1); clientVersion=null — гейт версии пропускает. */
function callerFor(user: string) {
  return createCaller({ actorUserId: user, db, clientVersion: null });
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

/** Метаданные audit-/undo-сообщения журнала (§4.6/§7.8). */
type JournalMeta = { actions?: ActionRecord[]; type?: string; undoes?: string };

describe('e2e слайс 1a: день из 02 §5 (два пользователя)', () => {
  // Общий state сценария — заполняется по шагам, читается последующими.
  const userA = freshUserId();
  const userB = freshUserId();
  const a = callerFor(userA);
  const b = callerFor(userB);

  let globalA = ''; // id глобального треда A
  let foodId = ''; // id категории «Еда» (найдена query, не хардкод)
  let obedId = ''; // id сущности «Обед» (fast-path-расход)
  let sneakersId = ''; // id задачи «купить кроссовки» (cross-aspect)
  let blockerId = ''; // id задачи-блокера
  let updateActionId = ''; // id действия entity_update (для повторного undo)

  beforeAll(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await client.end();
  });

  // ── Шаг 1: онбординг-сид A ────────────────────────────────────────────────
  test('шаг 1: seedOnboarding(A) — 15 сущностей, настройки, глобальный тред', async () => {
    const seeded = await a.user.seedOnboarding();
    expect(seeded).toEqual({ seeded: true });

    // Идемпотентность §7: повтор ничего не создаёт
    expect(await a.user.seedOnboarding()).toEqual({ seeded: false });

    // 12 категорий + 3 smart lists = 15 сущностей
    const cats = await a.entity.query({ query: 'tags=category' });
    expect(cats.length).toBe(12);
    const lists = await a.entity.query({ query: 'tags=smart-list' });
    expect(lists.length).toBe(3);

    // Настройки §7.3 — дефолты стартового набора
    const settings = await a.user.getSettings();
    expect(settings.timezone).toBe('Europe/Moscow');
    expect(settings.defaultCurrency).toBe('RUB');

    // Глобальный тред §7.3 создан сидом; ensure идемпотентен и отдаёт его id
    const t = await a.chat.ensureThread({});
    expect(t).toEqual({ threadId: globalThreadId(userA) });
    globalA = t.threadId;
  });

  // ── Шаг 2: эмуляция fast-path-результата (расход «обед 340») ───────────────
  test('шаг 2: ввод «обед 340» + entity.create расхода → audit-сообщение с action и inverse', async () => {
    // id «Еды» — из результата сидирования (query по тегу+FTS), НЕ хардкод uuid
    const found = await a.entity.query({ query: 'tags=category, search=Еда' });
    expect(found.length).toBe(1);
    foodId = found[0]?.id ?? '';
    expect(foodId).toBe(seedCategoryId(userA, 'food')); // сходится с формулой сида (§5.4)

    // Реплика пользовательского ввода в глобальный тред (сам парсер — 1c)
    const userMsg = await a.chat.appendUserMessage({
      id: newId(),
      threadId: globalA,
      content: 'обед 340',
    });
    expect(userMsg.role).toBe('user');

    // Результат fast-path: расход с аспектом orbis/financial (§3.3)
    const obed = await a.entity.create({
      source: 'fast_path',
      input: {
        id: newId(),
        title: 'Обед',
        tags: ['expense'],
        aspects: {
          'orbis/financial': {
            amount: '340.00',
            direction: 'expense',
            category_ref: foodId,
            occurred_on: '2026-07-03',
          },
        },
      },
    });
    obedId = obed.id;
    expect(() => entitySchema.parse(obed)).not.toThrow();
    // decimal хранится строкой без искажений IEEE-754 (§13.6)
    expect(obed.aspects['orbis/financial']?.amount).toBe('340.00');

    // В глобальном треде появилось audit-сообщение с action создания и его inverse (§7.8)
    const msgs = await a.chat.listMessages({ threadId: globalA });
    const audit = msgs.find((m) => (m.metadata as JournalMeta).actions?.[0]?.entity_id === obedId);
    if (!audit) throw new Error('ожидалось audit-сообщение создания «Обед»');
    const action = (audit.metadata as JournalMeta).actions?.[0];
    expect(action?.type).toBe('entity_created');
    expect(action?.operations[0]?.op).toBe('entity_create');
    // inverse создания — архивация (§7.8: жёсткого удаления нет)
    expect(action?.inverse[0]).toEqual({
      op: 'entity_update',
      payload: { id: obedId, archived: true },
    });

    // Пользовательская реплика «обед 340» тоже в треде (не audit)
    expect(msgs.some((m) => m.role === 'user' && m.content === 'обед 340')).toBe(true);
  });

  // ── Шаг 3: cross-aspect сущность «купить кроссовки» (§2.4) ──────────────────
  test('шаг 3: задача «купить кроссовки» — orbis/task + orbis/financial(planned) + orbis/schedule', async () => {
    const clothingId = seedCategoryId(userA, 'clothing');
    const sneakers = await a.entity.create({
      source: 'quick_capture',
      input: {
        id: newId(),
        title: 'Купить кроссовки',
        tags: ['task'],
        aspects: {
          'orbis/task': { status: 'inbox' },
          // planned-операция §3.3 обязана иметь дату occurred_on
          'orbis/financial': {
            amount: '5000.00',
            direction: 'expense',
            category_ref: clothingId,
            planned: true,
            occurred_on: '2026-07-05',
          },
          'orbis/schedule': { start_at: '2026-07-05T10:00:00Z' },
        },
      },
    });
    sneakersId = sneakers.id;
    expect(() => entitySchema.parse(sneakers)).not.toThrow();
    // Три аспекта на одной сущности — cross-aspect (§2.4)
    expect(Object.keys(sneakers.aspects).sort()).toEqual([
      'orbis/financial',
      'orbis/schedule',
      'orbis/task',
    ]);
    expect(sneakers.aspects['orbis/task']?.status).toBe('inbox');
    expect(sneakers.aspects['orbis/financial']?.planned).toBe(true);
  });

  // ── Шаг 4: query Inbox-блока Daily Planning + count без limit ───────────────
  test('шаг 4: Inbox-блок находит задачу; count без limit совпадает с query', async () => {
    // Дословный Inbox-блок из тела Daily Planning (02 §3.3)
    const inbox =
      'aspect=orbis/task, status=inbox, sortBy=created_at:desc, display=list, title=Inbox';
    const rows = await a.entity.query({ query: inbox });
    expect(rows.map((r) => r.id)).toEqual([sneakersId]);
    expect(() => entitySchema.parse(rows[0])).not.toThrow();

    // count игнорирует limit (бейджи §3.2) и совпадает с числом строк query
    const { count } = await a.entity.count({ query: inbox });
    expect(count).toBe(rows.length);
    expect(count).toBe(1);
  });

  // ── Шаг 5: update→done, undo, повторный undo → ошибка ──────────────────────
  test('шаг 5: update статус→done (completed_at); undoLast возвращает статус; повторный undo → BAD_REQUEST', async () => {
    // Переход в done проставляет completed_at сервером (§3.2)
    const done = await a.entity.update({
      id: sneakersId,
      aspects: { 'orbis/task': { status: 'done' } },
    });
    expect(done.aspects['orbis/task']?.status).toBe('done');
    expect(typeof done.aspects['orbis/task']?.completed_at).toBe('string');

    // actionId действия-обновления — из audit-сообщения глобального треда (§7.8)
    const before = await a.chat.listMessages({ threadId: globalA });
    const updateMsg = before.find((m) => {
      const act = (m.metadata as JournalMeta).actions?.[0];
      return act?.type === 'entity_updated' && act.entity_id === sneakersId;
    });
    updateActionId = (updateMsg?.metadata as JournalMeta).actions?.[0]?.id ?? '';
    expect(updateActionId).not.toBe('');

    // undoLast гасит именно это (последнее) действие
    const undone = await a.ai.undoLast();
    expect(undone.ok).toBe(true);
    expect(undone.actionId).toBe(updateActionId);

    // Статус вернулся к inbox, completed_at снят (inverse восстановил ключ целиком, §7.8)
    const reverted = await a.entity.get({ id: sneakersId });
    expect(reverted.entity.aspects['orbis/task']?.status).toBe('inbox');
    expect(reverted.entity.aspects['orbis/task']?.completed_at).toBeUndefined();

    // Undo добавил в тред undo-сообщение {type:'undo', undoes}
    const after = await a.chat.listMessages({ threadId: globalA });
    expect(
      after.some(
        (m) =>
          (m.metadata as JournalMeta).type === 'undo' &&
          (m.metadata as JournalMeta).undoes === updateActionId,
      ),
    ).toBe(true);

    // Повторный undo того же action → BAD_REQUEST «уже отменено» (§7.8)
    const again = await trpcError(a.ai.undo({ actionId: updateActionId }));
    expect(again.code).toBe('BAD_REQUEST');
  });

  // ── Шаг 6: blocks-связь + excludeBlocked скрывает заблокированную ───────────
  test('шаг 6: relation.create(blocks) + excludeBlocked=true скрывает заблокированную задачу', async () => {
    const blocker = await a.entity.create({
      source: 'quick_capture',
      input: {
        id: newId(),
        title: 'Дождаться зарплаты',
        tags: ['task'],
        aspects: { 'orbis/task': { status: 'inbox' } },
      },
    });
    blockerId = blocker.id;

    // blocker блокирует «купить кроссовки»: source блокирует target (§4.2)
    const rel = await a.relation.create({
      source_id: blockerId,
      target_id: sneakersId,
      relation_type: 'blocks',
    });
    expect(rel.relationType).toBe('blocks');

    const openTasks = 'aspect=orbis/task, status=!done&!cancelled';
    // Без excludeBlocked видны обе задачи (обе inbox после undo шага 5)
    const all = await a.entity.query({ query: openTasks });
    const allIds = all.map((r) => r.id);
    expect(allIds).toContain(sneakersId);
    expect(allIds).toContain(blockerId);

    // С excludeBlocked=true заблокированная (target живой blocks) исчезает, блокер остаётся
    const unblocked = await a.entity.query({ query: `${openTasks}, excludeBlocked=true` });
    const unblockedIds = unblocked.map((r) => r.id);
    expect(unblockedIds).not.toContain(sneakersId);
    expect(unblockedIds).toContain(blockerId);
    expect(unblockedIds).toEqual([blockerId]);
  });

  // ── Шаг 7: экспорт содержит ВЕСЬ граф A (сущности, связи, сообщения, настройки) ─
  test('шаг 7: exportData(A) — 18 сущностей, 1 связь, 1 тред, 7 сообщений (вкл. audit и undo)', async () => {
    const exp = await a.user.exportData();
    expect(exp.format).toBe('orbis-export');
    expect(exp.version).toBe(1);

    // 15 сидов + «Обед» + «купить кроссовки» + «Дождаться зарплаты» = 18
    expect(exp.entities.length).toBe(18);
    for (const e of exp.entities) expect(() => entitySchema.parse(e)).not.toThrow();
    const expIds = new Set(exp.entities.map((e) => e.id));
    expect(expIds.has(obedId)).toBe(true);
    expect(expIds.has(sneakersId)).toBe(true);
    expect(expIds.has(blockerId)).toBe(true);
    for (const c of SEED_CATEGORIES) expect(expIds.has(seedCategoryId(userA, c.slug))).toBe(true);

    // decimal «Обеда» сохранён строкой без искажений (§13.6, персистентный JSON)
    const obed = exp.entities.find((e) => e.id === obedId);
    expect(obed?.aspects['orbis/financial']?.amount).toBe('340.00');
    expect(obed?.aspects['orbis/financial']?.occurred_on).toBe('2026-07-03');

    // Одна связь blocks
    expect(exp.relations.length).toBe(1);
    expect(exp.relations[0]?.relationType).toBe('blocks');

    // Один тред (глобальный) и 7 сообщений: 1 user + 6 системных
    expect(exp.chatThreads.length).toBe(1);
    expect(exp.chatThreads[0]?.entityId).toBeNull();
    expect(exp.chatMessages.length).toBe(7);
    // Пользовательская реплика присутствует
    expect(exp.chatMessages.some((m) => m.role === 'user' && m.content === 'обед 340')).toBe(true);
    // audit-сообщений с непустым action — 5 (create×3, update×1, relation×1)
    const auditCount = exp.chatMessages.filter(
      (m) => ((m.metadata as JournalMeta).actions ?? []).length > 0,
    ).length;
    expect(auditCount).toBe(5);
    // ровно одно undo-сообщение
    const undoCount = exp.chatMessages.filter(
      (m) => (m.metadata as JournalMeta).type === 'undo',
    ).length;
    expect(undoCount).toBe(1);

    // Настройки в дампе; кастомных аспектов нет (встроенные §9.4 не экспортируются)
    expect(exp.userSettings?.timezone).toBe('Europe/Moscow');
    expect(exp.aspectDefinitions.length).toBe(0);
  });

  // ── Шаг 8: пользователь B независим; RLS изолирует его от графа A ───────────
  test('шаг 8: B независим — seed, query категорий видит только свои, undoLast не дотягивается до A', async () => {
    // Срез изоляции №0: сид B независим от A
    expect(await b.user.seedOnboarding()).toEqual({ seeded: true });

    // Срез изоляции №1: B видит 12 СВОИХ категорий, ни одной чужой (RLS §4.10)
    const bCats = await b.entity.query({ query: 'tags=category' });
    expect(bCats.length).toBe(12);
    const bIds = new Set(bCats.map((c) => c.id));
    const bExpected = new Set(SEED_CATEGORIES.map((c) => seedCategoryId(userB, c.slug)));
    expect(bIds).toEqual(bExpected);
    expect(bIds.has(foodId)).toBe(false); // «Еда» пользователя A недостижима

    // Срез изоляции №2: у B нет журналируемых действий (сид идёт мимо журнала) —
    // undoLast не находит ничего и НЕ дотягивается до действий A
    const noUndo = await trpcError(b.ai.undoLast());
    expect(noUndo.code).toBe('NOT_FOUND');
    // и точечный undo действия A из-под B невидим (RLS) → NOT_FOUND, не отмена
    const foreign = await trpcError(b.ai.undo({ actionId: updateActionId }));
    expect(foreign.code).toBe('NOT_FOUND');

    // Срез изоляции №3: экспорт B — только его 15 сидов, без данных A
    const bExp = await b.user.exportData();
    expect(bExp.entities.length).toBe(15);
    expect(bExp.relations.length).toBe(0);
    expect(bExp.chatThreads.length).toBe(1);
    expect(bExp.chatMessages.length).toBe(0);
    expect(new Set(bExp.entities.map((e) => e.id)).has(obedId)).toBe(false);

    // Граф A не тронут вмешательствами B (перекрёстная проверка изоляции)
    const aExp = await a.user.exportData();
    expect(aExp.entities.length).toBe(18);
    expect(aExp.relations.length).toBe(1);
    // «купить кроссовки» так и осталась inbox (B её не отменял/менял)
    const aSneakers = aExp.entities.find((e) => e.id === sneakersId);
    expect(aSneakers?.aspects['orbis/task']?.status).toBe('inbox');
  });
});
