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
import { addDays, entitySchema, globalThreadId, newId } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import type { ActionRecord } from '../src/executor/types';
import { DEFAULT_TIMEZONE, todayInTimeZone } from '../src/query/context';
import { appRouter } from '../src/router';
import { SEED_CATEGORIES } from '../src/seed/categories';
import { seedCategoryId } from '../src/seed/onboarding';
import { createCallerFactory } from '../src/trpc';
import { appDb, freshUserId, requireEnv, truncateAll } from './helpers';

/**
 * «Сегодня» глазами СЕРВЕРА: та же функция и та же зона по умолчанию, которыми date-токены
 * разворачивает компилятор. Своя строка здесь разъехалась бы с ним на каждом прогоне возле
 * полуночи, и блок «Сегодня» в шаге 4b начал бы мигать без всякой связи с кодом.
 */
const TODAY = todayInTimeZone(DEFAULT_TIMEZONE);

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
  let laterId = ''; // id задачи со сроком за горизонтом (контроль блока «Сегодня»)
  let updateActionId = ''; // id действия entity_update (для повторного undo)

  beforeAll(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await client.end();
  });

  // ── Шаг 1: онбординг-сид A ────────────────────────────────────────────────
  test('шаг 1: seedOnboarding(A) — 18 сущностей, настройки, глобальный тред', async () => {
    const seeded = await a.user.seedOnboarding();
    expect(seeded).toEqual({ seeded: true });

    // Идемпотентность §7: повтор ничего не создаёт
    expect(await a.user.seedOnboarding()).toEqual({ seeded: false });

    // 12 категорий + 6 smart lists (три исходных, два горизонта E4, «Рутины» V1.9) = 18
    const cats = await a.entity.query({ query: 'tags=category' });
    expect(cats.length).toBe(12);
    const lists = await a.entity.query({ query: 'tags=smart-list' });
    expect(lists.length).toBe(6);

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
        props: {
          'orbis/amount': '340.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': foodId,
          'orbis/occurred_on': '2026-07-03',
        },
        aspects: ['orbis/financial'],
      },
    });
    obedId = obed.id;
    expect(() => entitySchema.parse(obed)).not.toThrow();
    // decimal хранится строкой без искажений IEEE-754 (§13.6)
    expect(obed.props['orbis/amount']).toBe('340.00');

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
        props: {
          // `orbis/due_date` — СЕГОДНЯ, и это не украшение фикстуры: на нём стоит
          // единственная проверка ОСМЫСЛЕННОСТИ выдачи моста (шаг 4b). Без срока блок
          // «Сегодня» отбирал бы пусто, и любой ассерт над пустым списком проходил бы при
          // любом поведении компилятора — ровно та инертность, которую нашёл предфильтр (I-3).
          'orbis/task_status': 'inbox',
          'orbis/due_date': TODAY,
          // planned-операция §3.3 обязана иметь дату occurred_on
          'orbis/amount': '5000.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': clothingId,
          'orbis/planned': true,
          'orbis/occurred_on': '2026-07-05',
          'orbis/start_at': '2026-07-05T10:00:00Z',
        },
        // Три аспекта — ЯВНЫМ списком: старая карта вешала их самим фактом ключей.
        aspects: ['orbis/task', 'orbis/financial', 'orbis/schedule'],
      },
    });
    sneakersId = sneakers.id;
    expect(() => entitySchema.parse(sneakers)).not.toThrow();
    // Три аспекта на одной сущности — cross-aspect (§2.4)
    expect([...sneakers.aspects].sort()).toEqual([
      'orbis/financial',
      'orbis/schedule',
      'orbis/task',
    ]);
    expect(sneakers.props['orbis/task_status']).toBe('inbox');
    expect(sneakers.props['orbis/planned']).toBe(true);
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

  // ── Шаг 4b: КАЖДЫЙ query-блок сидированных смарт-листов исполняется сервером ──
  test('шаг 4b: все query-блоки шести смарт-листов исполняются через мост старой формы', async () => {
    // С Задачи 9b сервер разбирает текст каноном (§А5-3), а тела смарт-листов написаны
    // СТАРОЙ формой и переводятся только Задачей 21. Между этими двумя задачами их читает
    // переходный мост — и проверять его надо на настоящих телах из БД, а не на образцах в
    // тесте: образец переживёт правку сида, а владелец увидит красную плашку.
    //
    // Вторая задача — КОНТРОЛЬ, и без неё проверка ниже односторонняя: с одной задачей в
    // графе «блок отобрал правильно» и «блок отобрал всё» дают ОДИН И ТОТ ЖЕ ответ, и
    // ассерт их не различает (ровно та инертность, что нашёл предфильтр, I-3). Срок у неё
    // за горизонтом: «Сегодня» обязан её НЕ показать, «Позже» — показать.
    const later = await a.entity.create({
      source: 'quick_capture',
      input: {
        id: newId(),
        title: 'Продлить страховку',
        tags: ['task'],
        props: { 'orbis/task_status': 'inbox', 'orbis/due_date': addDays(TODAY, 30) },
        aspects: ['orbis/task'],
      },
    });
    laterId = later.id;

    const lists = await a.entity.query({ query: 'tags=smart-list' });
    expect(lists.length).toBeGreaterThanOrEqual(6);
    const blocks = lists.flatMap((e) =>
      [...(e.body ?? '').matchAll(/\{\{query:([\s\S]*?)\}\}/g)].map((m) => (m[1] as string).trim()),
    );
    // Страховка от «регулярка перестала находить»: пустой список прошёл бы цикл молча.
    expect(blocks.length).toBeGreaterThanOrEqual(9);
    for (const block of blocks) {
      // Отказ обязан быть видимым в отчёте вместе с самим текстом блока: без него
      // «не прошло» приходится искать, перебирая тела руками.
      const rows = await a.entity.query({ query: block }).catch((e: unknown) => {
        throw new Error(`блок не исполнился: «${block}» — ${(e as Error).message}`);
      });
      expect(Array.isArray(rows)).toBe(true);
      // Бейдж сайдбара считает первый блок тем же путём — count обязан пройти тоже.
      const { count } = await a.entity.count({ query: block });
      expect(typeof count).toBe('number');
    }
    // ОСМЫСЛЕННОСТЬ ВЫДАЧИ, а не «вызов не бросил». Блок «Сегодня» отбирает РОВНО одну
    // сущность графа — задачу со сроком сегодня; всё остальное (18 сидированных, расход
    // «Обед») в него не попадает ни по аспекту, ни по сроку. Точный набор, а не «непусто»
    // и не «все с аспектом task»: обе крайности — пустая выдача и выдача целиком — обязаны
    // краснеть, и обе краснеют (проверено двумя противоположными мутациями `tokenCond`).
    const today = blocks.find((b) => b.includes('due_date=today'));
    if (today === undefined) throw new Error('в телах нет блока «Сегодня»');
    const todayRows = await a.entity.query({ query: today });
    expect(todayRows.map((r) => r.id)).toEqual([sneakersId]);
    // И бейдж сайдбара считает то же самое: у count своя ветка компиляции.
    expect((await a.entity.count({ query: today })).count).toBe(1);

    // Обратная сторона того же факта: задача со сроком через месяц стоит в «Позже» и
    // отсутствует в «Сегодня». Без этой пары ассерт выше краснел бы только на «пусто», а
    // на «отобрал всё подряд» оставался бы зелёным.
    expect(todayRows.map((r) => r.id)).not.toContain(laterId);
    const later7 = blocks.find((b) => b.includes('due_date=after_7d'));
    if (later7 === undefined) throw new Error('в телах нет блока «Позже»');
    expect((await a.entity.query({ query: later7 })).map((r) => r.id)).toEqual([laterId]);
  });

  // ── Шаг 5: update→done, undo, повторный undo → ошибка ──────────────────────
  test('шаг 5: update статус→done (completed_at); undoLast возвращает статус; повторный undo → BAD_REQUEST', async () => {
    // Переход в done проставляет completed_at сервером (§3.2)
    const done = await a.entity.update({
      id: sneakersId,
      props: { 'orbis/task_status': 'done' },
    });
    expect(done.props['orbis/task_status']).toBe('done');
    expect(typeof done.props['orbis/completed_at']).toBe('string');

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
    expect(reverted.entity.props['orbis/task_status']).toBe('inbox');
    expect(reverted.entity.props['orbis/completed_at']).toBeUndefined();

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
        props: { 'orbis/task_status': 'inbox' },
        aspects: ['orbis/task'],
      },
    });
    blockerId = blocker.id;

    // blocker блокирует «купить кроссовки»: source блокирует target (§4.2, роль dependency)
    const rel = await a.relation.create({
      source_id: blockerId,
      target_id: sneakersId,
      role: 'dependency',
    });
    expect(rel.role).toBe('dependency');
    // Переходная колонка — производная от роли и до 0017 едет рядом
    expect(rel.relationType).toBe('blocks');

    const openTasks = 'aspect=orbis/task, status=!done&!cancelled';
    // Без excludeBlocked видны все открытые задачи (после undo шага 5 их три: кроссовки,
    // блокер и контрольная «Продлить страховку» из шага 4b)
    const all = await a.entity.query({ query: openTasks });
    const allIds = all.map((r) => r.id);
    expect(allIds).toContain(sneakersId);
    expect(allIds).toContain(blockerId);
    expect(allIds).toContain(laterId);

    // С excludeBlocked=true заблокированная (target живой blocks) исчезает, блокер остаётся
    const unblocked = await a.entity.query({ query: `${openTasks}, excludeBlocked=true` });
    const unblockedIds = unblocked.map((r) => r.id);
    expect(unblockedIds).not.toContain(sneakersId);
    expect(unblockedIds).toContain(blockerId);
    // Точный НАБОР, а не «содержит»: сахар обязан вычесть ровно заблокированную и никого
    // больше. Порядок не задан (в блоке нет sortBy), поэтому сравниваются отсортированные.
    expect([...unblockedIds].sort()).toEqual([blockerId, laterId].sort());
  });

  // ── Шаг 7: экспорт содержит ВЕСЬ граф A (сущности, связи, сообщения, настройки) ─
  test('шаг 7: exportData(A) — 22 сущности, 3 связи (dependency + два зеркала ref), 1 тред, 8 сообщений (вкл. audit и undo)', async () => {
    const exp = await a.user.exportData();
    expect(exp.format).toBe('orbis-export');
    // v2 (§С5): сущности новой формы плюс строки реестров ВЛАДЕЛЬЦА (Задача 13c).
    expect(exp.version).toBe(2);

    // 18 сидов + «Обед» + «купить кроссовки» + «Продлить страховку» (контроль шага 4b) +
    // «Дождаться зарплаты» = 22
    expect(exp.entities.length).toBe(22);
    for (const e of exp.entities) expect(() => entitySchema.parse(e)).not.toThrow();
    const expIds = new Set(exp.entities.map((e) => e.id));
    expect(expIds.has(obedId)).toBe(true);
    expect(expIds.has(sneakersId)).toBe(true);
    expect(expIds.has(blockerId)).toBe(true);
    expect(expIds.has(laterId)).toBe(true);
    for (const c of SEED_CATEGORIES) expect(expIds.has(seedCategoryId(userA, c.slug))).toBe(true);

    // decimal «Обеда» сохранён строкой без искажений (§13.6, персистентный JSON)
    const obed = exp.entities.find((e) => e.id === obedId);
    expect(obed?.props['orbis/amount']).toBe('340.00');
    expect(obed?.props['orbis/occurred_on']).toBe('2026-07-03');

    // Три связи: одна роли `dependency` (шаг 6) и два зеркала ссылочных свойств (§А6-2) —
    // «Обед» и «купить кроссовки» несут `orbis/finance_category`, и на каждую категорию
    // исполнитель поставил ребро роли `ref` с подписью свойства в `meta`.
    const byRole = new Map(exp.relations.map((r) => [r.role, r]));
    expect(exp.relations.length).toBe(3);
    expect(byRole.has('dependency')).toBe(true);
    const refEdges = exp.relations.filter((r) => r.role === 'ref');
    expect(refEdges.length).toBe(2);
    expect(new Set(refEdges.map((r) => r.sourceId))).toEqual(new Set([obedId, sneakersId]));
    for (const edge of refEdges) {
      expect((edge.meta as { property?: string }).property).toBe('orbis/finance_category');
    }

    // Один тред (глобальный) и 8 сообщений: 1 user + 7 системных
    expect(exp.chatThreads.length).toBe(1);
    expect(exp.chatThreads[0]?.entityId).toBeNull();
    expect(exp.chatMessages.length).toBe(8);
    // Пользовательская реплика присутствует
    expect(exp.chatMessages.some((m) => m.role === 'user' && m.content === 'обед 340')).toBe(true);
    // audit-сообщений с непустым action — 6 (create×4, update×1, relation×1)
    const auditCount = exp.chatMessages.filter(
      (m) => ((m.metadata as JournalMeta).actions ?? []).length > 0,
    ).length;
    expect(auditCount).toBe(6);
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

    // Срез изоляции №3: экспорт B — только его 18 сидов, без данных A
    const bExp = await b.user.exportData();
    expect(bExp.entities.length).toBe(18);
    expect(bExp.relations.length).toBe(0);
    expect(bExp.chatThreads.length).toBe(1);
    expect(bExp.chatMessages.length).toBe(0);
    expect(new Set(bExp.entities.map((e) => e.id)).has(obedId)).toBe(false);

    // Граф A не тронут вмешательствами B (перекрёстная проверка изоляции)
    const aExp = await a.user.exportData();
    expect(aExp.entities.length).toBe(22);
    expect(aExp.relations.length).toBe(3);
    // «купить кроссовки» так и осталась inbox (B её не отменял/менял)
    const aSneakers = aExp.entities.find((e) => e.id === sneakersId);
    expect(aSneakers?.props['orbis/task_status']).toBe('inbox');
  });
});
