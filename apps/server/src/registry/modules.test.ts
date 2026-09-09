// apps/server/src/registry/modules.test.ts
// Приёмка §С8-22: серверная половина модуля «Финансы» — маска включённости, операция
// `module_set` с журналом и undo, фильтр реестра тулов, гейт записи, подписки и канал модели.
//
// Тесты интеграционные: одна живая БД под `withIdentity`, потому что предмет проверки —
// СТРОКА `user_settings.disabled_modules` и то, что по ней видят четыре поверхности сразу.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MODULE_IDS } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  appDb,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { makeChatJournalSink } from '../executor/journal';
import { undoLast } from '../executor/undo';
import { appRouter } from '../router';
import { seedCategoryId, seedOwnerGraph } from '../seed/onboarding';
import { createCallerFactory } from '../trpc';
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
// категорию ТОГО ЖЕ владельца (`aggregates.test.ts:93`).
const CATEGORY_ID = seedCategoryId(owner, 'food');
let txId = '';
let noteId = '';

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
  // НЕПУСТОЙ выдаче — два пустых списка совпадут и при сломанном движке.
  await seedOne({
    title: 'Позвонить в банк',
    tags: [],
    props: { 'orbis/task_status': 'planned', 'orbis/due_date': today },
    aspects: ['orbis/task'],
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

describe('module_set: переключение — действие исполнителя с журналом и undo (§Б8-1 №28)', () => {
  // Вход блока назван явно: `owner` пришёл из общего `beforeAll` без выключенных модулей,
  // и полагаться на это молча значило бы завязать блок на порядок соседей.
  beforeAll(async () => {
    await setModules([]);
  });

  test('ручка выключает модуль; настройки отдают маску наружу', async () => {
    await caller.user.setModuleEnabled({ module: 'finance', enabled: false });
    expect(await withIdentity(db, owner, (tx) => disabledModulesOf(tx, owner))).toEqual([
      'finance',
    ]);
    expect((await caller.user.getSettings()).disabledModules).toEqual(['finance']);
  });

  test('inverse — ПРЕЖНЕЕ состояние, а не обратный знак входа', async () => {
    const r = await execute(
      db,
      {
        actorUserId: owner,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'module_set', input: { module: 'goals', enabled: false } }],
      },
      { sink },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const action = await actionOf(r.actionId);
    expect(action?.type).toBe('module_set');
    expect(action?.entity_id).toBeNull(); // меняется устройство системы, а не запись графа
    expect(action?.inverse).toEqual([
      { op: 'module_set', payload: { module: 'goals', enabled: true } },
    ]);
  });

  test('undo возвращает модуль во включённое состояние', async () => {
    // Второй аргумент — ОБЪЕКТ (`undo.ts:229`); последнее неотменённое действие журнала —
    // выключение `goals` предыдущим тестом, `finance` остаётся выключенным.
    expect((await undoLast(db, { actorUserId: owner })).ok).toBe(true);
    expect(await withIdentity(db, owner, (tx) => disabledModulesOf(tx, owner))).toEqual([
      'finance',
    ]);
  });

  test('повтор выключения: inverse — «уже был выключен», а не обратный знак входа', async () => {
    // Тест выше не различает две реализации: `goals` был ВКЛЮЧЁН, и «прежнее состояние» там
    // совпадает с «обратным знаком входа». Различает их ПОВТОР: `finance` выключен с первого
    // теста блока, и inverse обязан сказать «оставался выключенным». Обратный знак входа дал
    // бы здесь `enabled: true` — то есть undo ВКЛЮЧИЛ бы модуль, которого это действие не
    // выключало.
    const r = await execute(
      db,
      {
        actorUserId: owner,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'module_set', input: { module: 'finance', enabled: false } }],
      },
      { sink },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await inverseOf(r.actionId)).toEqual([
      { op: 'module_set', payload: { module: 'finance', enabled: false } },
    ]);
  });
});
