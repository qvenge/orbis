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
