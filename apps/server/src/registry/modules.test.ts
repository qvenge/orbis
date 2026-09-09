// apps/server/src/registry/modules.test.ts
// Приёмка §С8-22: серверная половина модуля «Финансы» — маска включённости, операция
// `module_set` с журналом и undo, фильтр реестра тулов, гейт записи, подписки и канал модели.
//
// Тесты интеграционные: одна живая БД под `withIdentity`, потому что предмет проверки —
// СТРОКА `user_settings.disabled_modules` и то, что по ней видят четыре поверхности сразу.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { addDays, MODULE_IDS, recurringInstanceId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  appDb,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { budgetOverview } from '../budget/aggregates';
import { defaultCurrencyOf } from '../budget/binding';
import { ensureGlobalThread } from '../chat/threads';
import { userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { makeChatJournalSink } from '../executor/journal';
import { undoLast } from '../executor/undo';
import { buildContext } from '../llm/context';
import { DEFAULT_TIMEZONE, ownerTimeZone } from '../query/context';
import { materializeInstances } from '../recurring/materialize';
import { appRouter } from '../router';
import { seedCategoryId, seedOwnerGraph } from '../seed/onboarding';
import { agendaListOf, agendaSubscriptionOf } from '../subscriptions/agenda';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { buildToolRegistry } from '../tools/registry';
import { createCallerFactory } from '../trpc';
import { effectiveRegistry } from './cache';
import { disabledModulesOf, setModuleDisabled } from './modules';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
/**
 * Владелец ТОЛЬКО для чтения-записи маски: у него нет строки настроек, и это предмет первого
 * теста. Сид мира завёл бы её вместе с графом — проверять «строки нет» стало бы не на ком,
 * а гонять маску на общем владельце значило бы утащить состояние в соседние блоки.
 */
const maskOwner = freshUserId();
// Боевой синк журнала: без него `execute` уходит в NOOP_SINK, и «отмени последнее» не
// нашло бы ни одного действия — предмет проверки блока `module_set` пропал бы вместе с ним.
const sink = makeChatJournalSink();
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({ actorUserId: owner, actorKind: 'owner', db, clientVersion: null });

const TZ = 'Europe/Moscow'; // дефолт сида §7.3 — им же сервер считает «сегодня»
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const curMonth = today.slice(0, 7);
function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
// Категория сид-мира, а не выдуманный uuid: с §А6-1 ссылка обязана указывать на живую
// категорию ТОГО ЖЕ владельца (тот же приём, что в `budget/aggregates.test.ts`).
const CATEGORY_ID = seedCategoryId(owner, 'food');
let txId = '';
let noteId = '';
/**
 * ВТОРОЙ носитель для attach-теста. Один `noteId` на два теста делал их зависимыми: снимите
 * гейт update — и тест attach превращается в «повторный attach уже навешенного аспекта» и
 * краснеет каскадом, скрывая, какой именно гейт сняли (гейт-ревью, мутация M2b: 2 fail
 * вместо 1).
 */
let attachNoteId = '';

async function seedOne(input: Record<string, unknown>): Promise<string> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    mechanism: 'seed',
    operations: [{ tool: 'entity_create', input }],
  });
  if (!r.ok) throw new Error(`сид: ${r.error.code} — ${r.error.message}`);
  return (r.results[0] as { id: string }).id;
}

/**
 * ВЕСЬ мир заводится ЗДЕСЬ, при всех включённых модулях. Перенести это в `beforeAll`
 * отдельного describe нельзя: блоки одного файла идут подряд, и к третьему из них Финансы уже
 * выключены — сид транзакции упал бы `MODULE_DISABLED`, то есть ровно тем, что проверяется.
 */
beforeAll(async () => {
  await truncateAll();
  await seedOwnerGraph(db, owner);
  noteId = await seedOne({ title: 'Заметка', tags: [], props: {}, aspects: ['orbis/note'] });
  attachNoteId = await seedOne({
    title: 'Заметка для attach',
    tags: [],
    props: {},
    aspects: ['orbis/note'],
  });
  txId = await seedOne({
    title: 'Такси',
    tags: [],
    props: {
      'orbis/amount': '600.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': CATEGORY_ID,
      'orbis/occurred_on': today,
    },
    aspects: ['orbis/financial'],
  });
  await seedOne({
    title: `Конверт Еда ${curMonth}`,
    tags: [],
    props: {
      'orbis/finance_category': CATEGORY_ID,
      'orbis/limit': '10000.00',
      'orbis/period_start': `${curMonth}-01`,
      'orbis/period_end': lastDayOf(curMonth),
    },
    aspects: ['orbis/budget'],
  });
  // Строка окна Agenda: «чужая подписка не шелохнулась» (шаг 15) обязана проверяться на
  // НЕПУСТОЙ выдаче — два пустых списка совпадут и при сломанном движке. Секция `window`
  // идёт по слоту `moment` контракта «когда», а он привязан к `orbis/start_at`
  // (`orbis/schedule`), НЕ к `orbis/due_date` — задачи без расписания в окне не видно, и
  // фикстура брифа отдавала бы пустой список (адрес опровергнут деревом).
  await seedOne({
    title: 'Позвонить в банк',
    tags: [],
    props: {
      'orbis/task_status': 'planned',
      'orbis/due_date': today,
      'orbis/start_at': `${today}T09:00:00.000Z`,
      'orbis/all_day': false,
    },
    aspects: ['orbis/task', 'orbis/schedule'],
  });
});
afterAll(async () => {
  await client.end();
});

/**
 * Явный вход каждого блока по маске. Пишем НАПРЯМУЮ, мимо исполнителя: фикстура — названное
 * планом исключение из «только через executor», журнал здесь не предмет проверки, а
 * унаследованная от предыдущего блока маска превратила бы порядок тестов в скрытый вход.
 */
async function setModules(disabled: readonly string[]): Promise<void> {
  await withIdentity(db, owner, async (tx) => {
    for (const m of MODULE_IDS) await setModuleDisabled(tx, owner, m, disabled.includes(m));
  });
}

/**
 * ВХОД БЛОКА по маске. `beforeAll` внутри describe для этого не годится: bun 1.2.7 исполняет
 * ВСЕ describe-level `beforeAll` файла ДО первого теста (проверено пробой), и «вход блока»
 * выродился бы в общий вход файла, где выигрывает последний объявленный. `beforeEach` с
 * замком исполняется в свой момент и ровно один раз на блок — то, что и требовалось: маска,
 * унаследованная от соседа, превратила бы порядок тестов в скрытый вход.
 */
function blockEntry(disabled: readonly string[]): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await setModules(disabled);
  };
}

describe('маска модулей: чтение и запись (§Б8-1)', () => {
  test('строки настроек нет — маска пуста, а не отказ', async () => {
    expect(await withIdentity(db, maskOwner, (tx) => disabledModulesOf(tx, maskOwner))).toEqual([]);
  });

  test('выключение идемпотентно, включение снимает ровно один модуль', async () => {
    await withIdentity(db, maskOwner, async (tx) => {
      await tx.insert(userSettings).values({ ownerId: maskOwner });
      await setModuleDisabled(tx, maskOwner, 'finance', true);
      await setModuleDisabled(tx, maskOwner, 'finance', true); // повтор не дублирует
      await setModuleDisabled(tx, maskOwner, 'goals', true);
    });
    expect(
      [...(await withIdentity(db, maskOwner, (tx) => disabledModulesOf(tx, maskOwner)))].sort(),
    ).toEqual(['finance', 'goals']);
    await withIdentity(db, maskOwner, (tx) => setModuleDisabled(tx, maskOwner, 'finance', false));
    expect(await withIdentity(db, maskOwner, (tx) => disabledModulesOf(tx, maskOwner))).toEqual([
      'goals',
    ]);
  });

  test('строку настроек заводит сама маска, и её дефолты = дефолты КОДА (Ф-Б1-10)', async () => {
    // Владельца без онбординга строкой `user_settings` снабжает теперь `setModuleDisabled`
    // своим `INSERT … ON CONFLICT` (эррата 08.09 к задаче 0b: сев 0b её больше не пишет).
    // Разойдись дефолты КОЛОНОК с дефолтами КОДА — один и тот же владелец считал бы «сегодня»
    // и валюту по-разному до и после первого выключения модуля.
    //
    // Сравнивается ПОВЕДЕНИЕ, а не литералы: `ownerTimeZone`/`defaultCurrencyOf` — те самые
    // читатели, чьё умолчание «дефолтом кода» и является; пин на строковые константы зеленел
    // бы и при расхождении с колонкой.
    const fresh = freshUserId();
    const read = (u: string) =>
      withIdentity(db, u, async (tx) => [
        await ownerTimeZone(tx, u),
        await defaultCurrencyOf(tx, u),
      ]);
    const before = await read(fresh);
    await withIdentity(db, fresh, (tx) => setModuleDisabled(tx, fresh, 'finance', true));
    expect(await read(fresh)).toEqual(before);
    expect(before[0]).toBe(DEFAULT_TIMEZONE);
  });
});

/**
 * Строка журнала §7.8 по её id. Журнал живёт в `metadata` audit-сообщения
 * (`executor/journal.ts`), отдельной таблицы `actions` в базе НЕТ — адрес брифа опровергнут
 * деревом. Ищем по `actionId`, а не по «последнему по времени»: `created_at` точности 3
 * на двух записях одной миллисекунды дал бы неустойчивый порядок.
 */
type JournalAction = {
  type: string;
  entity_id: string | null;
  inverse: { op: string; payload: unknown }[];
};
async function actionOf(actionId: string): Promise<JournalAction | undefined> {
  const rows = (await withIdentity(db, owner, (tx) =>
    tx.execute(sql`
      SELECT m.metadata->'actions'->0 AS action
      FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
      WHERE t.owner_id = ${owner}::uuid
        AND m.metadata->'actions'->0->>'id' = ${actionId}`),
  )) as unknown as { action: JournalAction }[];
  return rows[0]?.action;
}
async function inverseOf(actionId: string): Promise<JournalAction['inverse'] | undefined> {
  return (await actionOf(actionId))?.inverse;
}

/** Переключение Финансов через исполнителя — с боевым синком, иначе журнала не будет. */
function setFinance(enabled: boolean) {
  return execute(
    db,
    {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'module_set', input: { module: 'finance', enabled } }],
    },
    { sink },
  );
}

describe('module_set: переключение — действие исполнителя с журналом и undo (§Б8-1 №28)', () => {
  // Вход блока назван явно: `owner` начинает без выключенных модулей, и полагаться на это
  // молча значило бы завязать блок на порядок соседей.
  beforeEach(blockEntry([]));

  /**
   * Переключается ТОЛЬКО `finance` (Ф-Б1-57б): у остальных четырёх модулей серверной
   * половины §Б8-1 в Б-1 нет, и схема входа их не принимает. Поэтому весь блок ходит по
   * одному модулю, а «прежнее состояние» разводится ПОРЯДКОМ операций, а не вторым именем.
   */
  test('ручка выключает модуль; настройки отдают маску наружу', async () => {
    await caller.user.setModuleEnabled({ module: 'finance', enabled: false });
    expect(await withIdentity(db, owner, (tx) => disabledModulesOf(tx, owner))).toEqual([
      'finance',
    ]);
    expect((await caller.user.getSettings()).disabledModules).toEqual(['finance']);
  });

  test('inverse — ПРЕЖНЕЕ состояние, а не обратный знак входа', async () => {
    // Вход теста: `finance` выключен предыдущим. Включаем и снова выключаем — прежним
    // состоянием ВТОРОГО действия оказывается «включён», и его обязан вернуть inverse.
    await setFinance(true);
    const r = await setFinance(false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const action = await actionOf(r.actionId);
    expect(action?.type).toBe('module_set');
    expect(action?.entity_id).toBeNull(); // меняется устройство системы, а не запись графа
    expect(action?.inverse).toEqual([
      { op: 'module_set', payload: { module: 'finance', enabled: true } },
    ]);
  });

  test('undo возвращает модуль во включённое состояние', async () => {
    // Второй аргумент — ОБЪЕКТ (`undoLast`, `executor/undo.ts`); последнее неотменённое действие
    // журнала — выключение `finance` предыдущим тестом.
    expect((await undoLast(db, { actorUserId: owner })).ok).toBe(true);
    expect(await withIdentity(db, owner, (tx) => disabledModulesOf(tx, owner))).toEqual([]);
  });

  test('повтор выключения: inverse — «уже был выключен», а не обратный знак входа', async () => {
    // Тест выше не различает две реализации: на СМЕНЕ состояния «прежнее состояние» и
    // «обратный знак входа» совпадают всегда. Различает их ПОВТОР: второе выключение уже
    // выключенного обязано сказать «оставался выключенным». Обратный знак входа дал бы
    // здесь `enabled: true` — то есть undo ВКЛЮЧИЛ бы модуль, которого это действие не
    // выключало.
    await setFinance(false);
    const r = await setFinance(false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await inverseOf(r.actionId)).toEqual([
      { op: 'module_set', payload: { module: 'finance', enabled: false } },
    ]);
  });

  test('module_set — операция ВЛАДЕЛЬЦА: агенту и рутине отказ (Ф-Б1-57г)', async () => {
    // Снаружи операция недостижима (её нет ни в одном реестре тулов), но обещание докблока
    // «единственный вход — ручка владельца» держал бы чужой код. Гейт по актору — защита в
    // глубину: `execute()` доступен всякому серверному пути.
    const mask = () => withIdentity(db, owner, (tx) => disabledModulesOf(tx, owner));
    const before = await mask();
    for (const actorKind of ['agent', 'ai'] as const) {
      const denied = await execute(db, {
        actorUserId: owner,
        actorKind,
        // Вход выбран ПРОТИВОПОЛОЖНЫМ текущему состоянию: пройди отказ мимо — маска
        // изменилась бы, и сравнение ниже это увидело бы.
        operations: [
          {
            tool: 'module_set',
            input: { module: 'finance', enabled: !before.includes('finance') },
          },
        ],
        source: 'mcp',
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN_LEVEL');
    }
    expect(await mask()).toEqual(before);
  });
});

describe('§С8-22: маска на реестре тулов — один фильтр на четыре поверхности', () => {
  beforeEach(blockEntry([])); // предыдущий блок оставил finance выключенным

  test('выключенные Финансы уносят ровно свои тулы и ничего сверх', async () => {
    const all = (await withIdentity(db, owner, (tx) => buildToolRegistry(tx, owner))).map(
      (d) => d.name,
    );
    expect(all).toContain('budget_status');
    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'module_set', input: { module: 'finance', enabled: false } }],
    });
    const masked = (await withIdentity(db, owner, (tx) => buildToolRegistry(tx, owner))).map(
      (d) => d.name,
    );
    // Консервативность §С1-3 п.9: разница — ровно пять имён Финансов
    expect(all.filter((n) => !masked.includes(n)).sort()).toEqual([
      'attach_orbis_budget',
      'attach_orbis_category',
      'attach_orbis_financial',
      'budget_status',
      'import_csv_start',
    ]);
    expect(masked.filter((n) => !all.includes(n))).toEqual([]);
  });

  test('вызов скрытого маской тула — MODULE_DISABLED, а не «неизвестный тул»', async () => {
    // Порядок аргументов — (ctx, name, input) (`dispatchTool`); форма контекста — как в
    // `tools/dispatch.test.ts`.
    const ctx: ToolCallCtx = {
      db,
      actorUserId: owner,
      actorKind: 'owner',
      source: 'chat',
      explicitCommand: false,
    };
    const out = await dispatchTool(ctx, 'budget_status', {});
    expect(out.status).toBe('error');
    if (out.status !== 'error') return; // сужение союза: у ветки 'ok' поля `error` нет вовсе
    expect(out.error.code).toBe('MODULE_DISABLED');
    expect(out.error.details).toMatchObject({ tool: 'budget_status', module: 'finance' });
  });

  test('скрытый маской тул ВНУТРИ batch_execute — тот же MODULE_DISABLED (Ф-Б1-57в)', async () => {
    // Пачка не вправе отвечать про тот же тул иначе, чем одиночный вызов: «неизвестный тул
    // операции» научил бы модель, что тула нет вовсе, и она пошла бы искать обход вместо
    // того, чтобы сказать владельцу про выключенный модуль.
    const ctx: ToolCallCtx = {
      db,
      actorUserId: owner,
      actorKind: 'owner',
      source: 'chat',
      explicitCommand: false,
    };
    const out = await dispatchTool(ctx, 'batch_execute', {
      batch_id: crypto.randomUUID(),
      operations: [
        {
          tool: 'attach_orbis_financial',
          input: {
            entity_id: noteId,
            data: {
              'orbis/amount': '10.00',
              'orbis/direction': 'expense',
              'orbis/occurred_on': today,
              'orbis/finance_category': CATEGORY_ID,
            },
          },
        },
      ],
    });
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.error.code).toBe('MODULE_DISABLED');
    expect(out.error.details).toMatchObject({
      index: 0,
      tool: 'attach_orbis_financial',
      module: 'finance',
    });
  });

  test('в пачке НЕсуществующий тул остаётся «неизвестным», а не MODULE_DISABLED', async () => {
    // Обратная сторона предыдущего: вторая линия отвечает только про тул, который в системе
    // ЕСТЬ. Иначе опечатка в имени получала бы отказ про модуль, которого у неё нет.
    const ctx: ToolCallCtx = {
      db,
      actorUserId: owner,
      actorKind: 'owner',
      source: 'chat',
      explicitCommand: false,
    };
    const out = await dispatchTool(ctx, 'batch_execute', {
      batch_id: crypto.randomUUID(),
      operations: [{ tool: 'attach_orbis_nonesuch', input: { entity_id: noteId, data: {} } }],
    });
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.error.code).toBe('VALIDATION');
  });
});

describe('§С8-22: запись при выключенном модуле — create/attach нет, update да', () => {
  // `CATEGORY_ID`, `txId`, `noteId` пришли из ОБЩЕГО `beforeAll` файла (шаг 3): они заведены до
  // первого выключения — завести их здесь уже нельзя, гейт шага 11 не пустил бы.
  beforeEach(blockEntry(['finance']));

  test('entity_create с orbis/financial → MODULE_DISABLED; ядро — проходит', async () => {
    const denied = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_create',
          input: {
            title: 'Такси',
            tags: [],
            aspects: ['orbis/financial'],
            props: {
              'orbis/amount': '500.00',
              'orbis/direction': 'expense',
              'orbis/occurred_on': '2026-09-03',
              'orbis/finance_category': CATEGORY_ID,
            },
          },
        },
      ],
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('MODULE_DISABLED');
    expect(denied.error.details).toMatchObject({ module: 'finance', aspect: 'orbis/financial' });
    expect(
      (
        await execute(db, {
          actorUserId: owner,
          actorKind: 'owner',
          source: 'ui',
          operations: [
            {
              tool: 'entity_create',
              input: { title: 'Заметка', tags: [], aspects: ['orbis/note'], props: {} },
            },
          ],
        })
      ).ok,
    ).toBe(true);
  });

  test('правка существующей транзакции и повторный attach того же аспекта — разрешены', async () => {
    // txId создан ДО выключения модуля (общий `beforeAll` файла, шаг 3). Поля `version` у
    // `entity_update` НЕТ: CAS-предусловие §5.2 называется `expectedUpdatedAt`, оно
    // необязательно, и здесь не нужно — конкурента у теста нет. Лишний ключ `.strict()`
    // отверг бы кодом `VALIDATION`, то есть до гейта §Б8-3 проверка бы не дошла вовсе
    // (адрес брифа опровергнут деревом).
    expect(
      (
        await execute(db, {
          actorUserId: owner,
          actorKind: 'owner',
          source: 'ui',
          operations: [
            { tool: 'entity_update', input: { id: txId, props: { 'orbis/amount': '700.00' } } },
          ],
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await execute(db, {
          actorUserId: owner,
          actorKind: 'owner',
          source: 'ui',
          operations: [
            {
              tool: 'attach_orbis_financial',
              input: {
                entity_id: txId,
                data: {
                  'orbis/amount': '800.00',
                  'orbis/direction': 'expense',
                  'orbis/occurred_on': '2026-09-03',
                  'orbis/finance_category': CATEGORY_ID,
                },
              },
            },
          ],
        })
      ).ok,
    ).toBe(true);
  });

  test('entity_update, добавляющий аспект модуля, — MODULE_DISABLED (третий путь появления)', async () => {
    // Гейт в create и attach без третьей точки был бы дырой: `entity_update` навешивает
    // аспект полем `aspects.attach` — тем же путём, что и `attach_*`, только другим тулом.
    const denied = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: noteId, aspects: { attach: ['orbis/category'] } },
        },
      ],
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('MODULE_DISABLED');
  });

  test('навешивание НОВОГО аспекта модуля на существующую запись — MODULE_DISABLED', async () => {
    const denied = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'attach_orbis_category',
          input: { entity_id: attachNoteId, data: { 'orbis/icon': '🍏' } },
        },
      ],
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('MODULE_DISABLED');
  });
});

describe('§С8-22: подписки и сохранённые AST при выключенном модуле', () => {
  beforeEach(blockEntry([])); // блок начинает со всех включённых

  /**
   * Движок Agenda зовётся ТАК ЖЕ, как его зовёт ручка (`routers/agenda.ts`, задача 6):
   * `agendaListOf(tx, ownerId, def, args)`, где `def` — строка снимка, добытая
   * `agendaSubscriptionOf`. Обёртки «на два аргумента» у него нет — и заводить её здесь
   * значило бы проверять не тот путь, по которому ходит прод.
   */
  const agenda = () =>
    withIdentity(db, owner, async (tx) =>
      agendaListOf(tx, owner, agendaSubscriptionOf(await effectiveRegistry(tx, owner)), {
        today,
        timeZone: TZ,
        days: 8,
      }),
    );

  test('Budget-ведомость пуста, Agenda — байт-в-байт как до выключения', async () => {
    const before = await budgetOverview(db, owner, curMonth);
    expect(before.envelopes.length).toBeGreaterThan(0);
    const agendaBefore = await agenda();
    expect(agendaBefore.rows.length).toBeGreaterThan(0); // сравнение не вырождено в «пусто = пусто»
    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'module_set', input: { module: 'finance', enabled: false } }],
    });
    const after = await budgetOverview(db, owner, curMonth);
    expect([
      after.envelopes,
      after.comingUp,
      after.planned,
      after.unbudgeted,
      after.alertCount,
    ]).toEqual([[], [], [], [], 0]);
    // Консервативность §С1-3 п.9: чужая подписка не шелохнулась
    expect(await agenda()).toEqual(agendaBefore);
  });

  test('сохранённый AST с orbis/amount продолжает резолвиться и находить записи (§Б8-3)', async () => {
    // `entity.query` отдаёт МАССИВ строк (`routers/entity.ts`), не конверт с `items`.
    const found = await caller.entity.query({ query: 'aspect=orbis/financial, orbis/amount>100' });
    expect(found.length).toBeGreaterThan(0); // определения остаются резолвимыми на чтение
  });

  test('повторное включение — всё на месте', async () => {
    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'module_set', input: { module: 'finance', enabled: true } }],
    });
    expect((await budgetOverview(db, owner, curMonth)).envelopes.length).toBeGreaterThan(0);
    expect(
      (await withIdentity(db, owner, (tx) => buildToolRegistry(tx, owner))).map((d) => d.name),
    ).toContain('budget_status');
  });

  test('Планировщик выключен — Повестка пуста, ведомость Финансов не шелохнулась', async () => {
    // Обратное направление той же врезки: без него врезка Agenda не покрыта ни одним тестом
    // (мутация гейт-ревью «снять её целиком» была зелёной). Маска пишется НАПРЯМУЮ:
    // `module_set` в Б-1 принимает только `finance` (Ф-Б1-57б), а движок спрашивает саму
    // колонку — то есть путь проверяется тот же, что у прода после Б-3.
    const budgetBefore = await budgetOverview(db, owner, curMonth);
    expect(budgetBefore.envelopes.length).toBeGreaterThan(0);
    expect((await agenda()).rows.length).toBeGreaterThan(0);
    // `finally` — не вежливость: провались утверждение внутри, и `planner` остался бы
    // выключенным, а соседний тест канала покраснел бы каскадом на чужой причине.
    await setModules(['planner']);
    try {
      expect(await agenda()).toEqual({
        today,
        timezone: TZ,
        rows: [],
        truncated: { window: false, overdue: false },
      });
      // Консервативность §С1-3 п.9 в другую сторону: чужая подписка не шелохнулась
      expect(await budgetOverview(db, owner, curMonth)).toEqual(budgetBefore);
    } finally {
      await setModules([]);
    }
  });

  test('канал модели: проза Финансов и инструкции orbis/financial уходят вместе с модулем и возвращаются с ним (§Б8-3)', async () => {
    // Канал собирается ТЕМ ЖЕ `buildContext`, что и чат (`llm/context.ts`), — юнит на
    // `modulePromptFragments` (шаг 2) не отвечает, доносит ли их до модели сама сборка.
    const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));
    const channel = () =>
      withIdentity(db, owner, (tx) => buildContext(tx, { ownerId: owner, threadId }));
    const setFinance = (enabled: boolean) =>
      execute(db, {
        actorUserId: owner,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'module_set', input: { module: 'finance', enabled } }],
      });
    const on = (await channel()).system;
    expect(on).toContain('Бюджет (тул budget_status):'); // проза манифеста (шаг 14)
    expect(on).toContain('- orbis/financial:'); // инструкция аспекта модуля (§Б8-3)
    await setFinance(false);
    const off = (await channel()).system;
    expect(off).not.toContain('Бюджет (тул budget_status):');
    expect(off).not.toContain('- orbis/financial:');
    expect(off).toContain('- orbis/task:'); // чужие инструкции на месте — маска, а не пустота
    await setFinance(true);
    expect((await channel()).system).toBe(on); // включение возвращает канал байт-в-байт
    // Канал рутины (`routines/context.ts`) зовёт ту же `aspectInstructionsSection(tx, disabled)`
    // с той же маской — второго пути у инструкций нет, отдельного прогона не заводится.
  });
});

describe('§Б8-3 против §С1-3 п.9: материализация — не создание (Ф-Б1-57а)', () => {
  beforeEach(blockEntry([]));

  test('финансовый recurring-шаблон материализуется при выключенных Финансах, без warn и без потери строк Повестки', async () => {
    // Шаблон заводится при ВКЛЮЧЁННЫХ Финансах — это законная запись владельца. Дальше
    // модуль выключается, и сервер обязан продолжать рождать инстансы: инстанс — следствие
    // существующего шаблона, а не новая запись. Иначе выключение Финансов молча уносило бы
    // строки ЧУЖОЙ подписки (Повестки) — буква §С1-3 п.9.
    const templateId = await seedOne({
      title: 'Аренда',
      tags: [],
      props: {
        'orbis/start_at': `${today}T09:00:00+03:00`,
        'orbis/timezone': TZ,
        'orbis/recurrence': { freq: 'daily', interval: 1 },
        'orbis/amount': '340.00',
        'orbis/currency': 'RUB',
        'orbis/direction': 'expense',
        'orbis/finance_category': CATEGORY_ID,
        'orbis/recurring': true,
      },
      aspects: ['orbis/schedule', 'orbis/financial'],
    });

    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'module_set', input: { module: 'finance', enabled: false } }],
    });

    // `console.warn` — наблюдаемый след отказа: `materializeInstances` не роняет запрос
    // вызывающего, а ПРОПУСКАЕТ шаблон с warn. Без перехвата тест зеленел бы на `created: 0`.
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    let created = 0;
    try {
      created = (
        await materializeInstances({
          db,
          ownerId: owner,
          from: today,
          to: addDays(today, 2),
          today,
        })
      ).created;
    } finally {
      console.warn = realWarn;
    }
    expect(warns.filter((w) => w.includes('recurring/materialize'))).toEqual([]);
    expect(created).toBeGreaterThan(0);

    // Инстансы видны в окне Повестки — то, что теряется, если гейт стоит на materialize.
    const rows = await withIdentity(db, owner, async (tx) =>
      agendaListOf(tx, owner, agendaSubscriptionOf(await effectiveRegistry(tx, owner)), {
        today,
        timeZone: TZ,
        days: 3,
      }),
    );
    const instanceIds = [today, addDays(today, 1), addDays(today, 2)].map((d) =>
      recurringInstanceId(templateId, d),
    );
    expect(rows.rows.filter((r) => instanceIds.includes(r.entity.id)).length).toBeGreaterThan(0);
  });
});
