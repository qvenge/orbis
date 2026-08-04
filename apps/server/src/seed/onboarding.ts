// apps/server/src/seed/onboarding.ts
// Онбординг-сидирование (02 §7): 12 категорий §7.1 + 8 smart lists §7.2 (три исходных +
// пять горизонтов планирования, E4) + настройки §7.3 + глобальный тред §7.3. Один раз на
// пользователя; повтор дублей не создаёт (§7).
//
// РЕШЕНИЕ 6 ПЛАНА: сид пишет НАПРЯМУЮ в tx под withIdentity, МИМО executor и журнала
// действий (§7.8). Обоснование: 15 audit-сообщений при регистрации — это шум в ленте
// чата, а не значимые для пользователя действия; сид — системная инициализация, не
// пользовательская правка. Данные при этом обязаны быть валидны по схемам реестра
// (тест сверяет каждую категорию с categoryAspectSchema).
//
// ИДЕМПОТЕНТНОСТЬ — два слоя:
//   1. Guard по существованию user_settings (SELECT … FOR UPDATE): повторный вызов
//      возвращает { seeded: false } без записей.
//   2. Детерминированные id категорий/списков (uuidv5) + ON CONFLICT DO NOTHING на всех
//      вставках — страховка от гонки двух устройств/вкладок поверх guard'а: конкурентная
//      вставка тем же PK блокируется на неподтверждённой строке и гасится конфликтом
//      (§5.4), дубль невозможен по построению.
import { ORBIS_NAMESPACE } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { ensureGlobalThread } from '../chat/threads';
import { entities, userSettings } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { SEED_CATEGORIES } from './categories';
import { SEED_HORIZON_LISTS, SEED_SMART_LISTS, type SeedSmartList } from './smart-lists';

// Формулы seed-слагов — серверная деталь (НЕ в shared): id порождается от owner_id
// (workspace-scoped при введении workspace'ов, D11) и стабильного слага. uuid-библиотека
// принимает (name, namespace) — обратный порядок к нотации PRD uuidv5(NS, name).
export function seedCategoryId(ownerId: string, slug: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:seed-category:${slug}`, ORBIS_NAMESPACE);
}

export function seedSmartListId(ownerId: string, slug: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:seed-smartlist:${slug}`, ORBIS_NAMESPACE);
}

// Первый устанавливаемый view (01-arch §4.4, 03-budget §1): вкладка Budget в web
// включается по наличию этого id в installedViews. Серверная деталь — не в shared.
export const BUDGET_VIEW_ID = 'orbis-budget';

// Единственный горизонт, попадающий в сайдбар (E4): остальные четыре ищутся в Browser
// по тегу smart-list. Закрепление не бесплатно — у каждой pinned-сущности web держит
// entity.get + entity.count, и count пересчитывается на КАЖДОЙ инвалидации графа.
const PINNED_HORIZON_SLUG = 'horizon-day';

export interface SeedResult {
  seeded: boolean; // false — уже было (одноразовость §7)
}

/**
 * Сидирование стартового набора владельца. Вызывается роутером user.seedOnboarding и
 * переиспользуется 1c при первом логине. clock инъектируется для детерминизма тестов;
 * created_at/updated_at сущностей и настроек — clock() (тред получает defaultNow БД).
 */
export async function seedOnboarding(
  tx: Tx,
  ownerId: string,
  clock: () => Date = () => new Date(),
): Promise<SeedResult> {
  const now = clock();

  // Слой 1: guard. FOR UPDATE блокирует существующую строку настроек (защита от гонки с
  // updateSettings); если строки нет — идём сидировать, конкуренцию закрывает слой 2.
  const guard = await tx.execute(
    sql`SELECT 1 FROM user_settings WHERE owner_id = ${ownerId} FOR UPDATE`,
  );
  if (guard.length > 0) {
    // Бэкфилл A9 (§4.4): пользователь, засиденный ДО слайса 2, мог не иметь orbis-budget.
    // Идемпотентно дописываем под уже взятой FOR UPDATE-блокировкой — array_append только
    // при отсутствии (NOT … = ANY): повтор не дублирует, кастомные значения не теряются,
    // прочие поля настроек не трогаются (updated_at сдвигается лишь при фактической правке,
    // чтобы web-синк LWW увидел новый view).
    await tx.execute(
      sql`UPDATE user_settings
          SET "installedViews" = array_append("installedViews", ${BUDGET_VIEW_ID}),
              updated_at = ${now.toISOString()}::timestamptz
          WHERE owner_id = ${ownerId}
            AND NOT (${BUDGET_VIEW_ID} = ANY("installedViews"))`,
    );
    await backfillHorizons(tx, ownerId, now);
    return { seeded: false };
  }

  // 12 категорий §7.1 — сущности с аспектом orbis/category; spend_class у доходных
  // ОТСУТСТВУЕТ (не null — иначе ajv-валидация упала бы при будущих правках, §3.6).
  const categoryRows = SEED_CATEGORIES.map((c) => ({
    id: seedCategoryId(ownerId, c.slug),
    ownerId,
    title: c.title,
    tags: ['category'],
    aspects: {
      'orbis/category': {
        icon: c.icon,
        color: c.color,
        aliases: [...c.aliases],
        ...(c.spendClass ? { spend_class: c.spendClass } : {}),
      },
    },
    createdAt: now,
    updatedAt: now,
  }));

  // 8 smart lists §7.2 — сущности с тегом smart-list и body-query-блоками (§3.3):
  // три исходных плюс пять горизонтов планирования (E4).
  const smartListRows = SEED_SMART_LISTS.map((s) => smartListRow(ownerId, s, now));

  // Одна вставка на все 20 сущностей: детерминированный порядок id снимает риск взаимной
  // блокировки конкурентных сидов (обе транзакции блокируются на первой общей строке).
  await tx
    .insert(entities)
    .values([...categoryRows, ...smartListRows])
    .onConflictDoNothing();

  // Настройки §7.3 — дефолты; pinnedEntities в порядке daily/upcoming/allTasks/«День»
  // (§7.2, §4.4). Из пяти горизонтов закреплён ТОЛЬКО «День»: закреплённая сущность
  // стоит entity.count на каждую инвалидацию графа (web, lib/invalidate.ts), а неделя/
  // месяц/год/жизнь открываются периодически — их находит Browser по тегу smart-list.
  await tx
    .insert(userSettings)
    .values({
      ownerId,
      plan: 'dev',
      timezone: 'Europe/Moscow',
      defaultCurrency: 'RUB',
      weekStartDay: 'monday',
      installedViews: [BUDGET_VIEW_ID], // §4.4: Budget — стартовый установленный view
      pinnedEntities: [
        { id: seedSmartListId(ownerId, 'daily-planning'), order: 0 },
        { id: seedSmartListId(ownerId, 'upcoming'), order: 1 },
        { id: seedSmartListId(ownerId, 'all-tasks'), order: 2 },
        { id: seedSmartListId(ownerId, PINNED_HORIZON_SLUG), order: 3 },
      ],
      updatedAt: now,
    })
    .onConflictDoNothing();

  // Глобальный тред §7.3 — детерминированный id, ensure идемпотентен (§4.5)
  await ensureGlobalThread(tx, ownerId);

  return { seeded: true };
}

/** Строка сущности smart list'а — одна форма для первого сида и для бэкфилла. */
function smartListRow(ownerId: string, list: SeedSmartList, now: Date) {
  return {
    id: seedSmartListId(ownerId, list.slug),
    ownerId,
    title: list.title,
    emoji: list.emoji,
    body: list.body,
    tags: ['smart-list'],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Бэкфилл E4 (§7.2): пользователь, засиденный ДО слайса 3, не имеет горизонтов
 * планирования. Guard-ветка выходит из сида ДО всех вставок, поэтому «просто повторить
 * сидирование» их не досеет — нужен явный бэкфилл, как у orbis-budget (A9).
 *
 * Идемпотентность: id горизонтов детерминированы (uuidv5 от слага), ON CONFLICT DO NOTHING
 * гасит повтор; закрепление «Дня» дописывается только при отсутствии его id в pinnedEntities
 * (jsonb-containment по одному ключу `id`, порядковый номер значения не важен), поэтому
 * повторные запуски не плодят ни сущностей, ни строк сайдбара, а кастомные закрепления
 * и прочие поля настроек остаются нетронутыми (updated_at сдвигается лишь при фактической
 * правке — иначе web-синк LWW дёргался бы на каждом старте сессии).
 *
 * Цена решения: удалённый пользователем горизонт следующий вызов сидирования воскресит —
 * ровно то же поведение, что у бэкфилла orbis-budget. Сидирование зовётся раз за сессию
 * (OnboardingGate), «удалить навсегда» здесь не выражается.
 */
async function backfillHorizons(tx: Tx, ownerId: string, now: Date): Promise<void> {
  await tx
    .insert(entities)
    .values(SEED_HORIZON_LISTS.map((list) => smartListRow(ownerId, list, now)))
    .onConflictDoNothing();

  const dayId = seedSmartListId(ownerId, PINNED_HORIZON_SLUG);
  await tx.execute(
    sql`UPDATE user_settings
        SET "pinnedEntities" = "pinnedEntities" || jsonb_build_array(
              jsonb_build_object('id', ${dayId}::text, 'order', jsonb_array_length("pinnedEntities"))
            ),
            updated_at = ${now.toISOString()}::timestamptz
        WHERE owner_id = ${ownerId}
          AND NOT ("pinnedEntities" @> jsonb_build_array(jsonb_build_object('id', ${dayId}::text)))`,
  );
}
