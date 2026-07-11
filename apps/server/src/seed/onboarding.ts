// apps/server/src/seed/onboarding.ts
// Онбординг-сидирование (02 §7): 12 категорий §7.1 + 3 smart lists §7.2 + настройки §7.3 +
// глобальный тред §7.3. Один раз на пользователя; повтор дублей не создаёт (§7).
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
import { SEED_SMART_LISTS } from './smart-lists';

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

  // 3 smart lists §7.2 — сущности с тегом smart-list и body-query-блоками (§3.3)
  const smartListRows = SEED_SMART_LISTS.map((s) => ({
    id: seedSmartListId(ownerId, s.slug),
    ownerId,
    title: s.title,
    emoji: s.emoji,
    body: s.body,
    tags: ['smart-list'],
    createdAt: now,
    updatedAt: now,
  }));

  // Одна вставка на все 15 сущностей: детерминированный порядок id снимает риск взаимной
  // блокировки конкурентных сидов (обе транзакции блокируются на первой общей строке).
  await tx
    .insert(entities)
    .values([...categoryRows, ...smartListRows])
    .onConflictDoNothing();

  // Настройки §7.3 — дефолты; pinnedEntities в порядке daily/upcoming/allTasks (§7.2, §4.4)
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
      ],
      updatedAt: now,
    })
    .onConflictDoNothing();

  // Глобальный тред §7.3 — детерминированный id, ensure идемпотентен (§4.5)
  await ensureGlobalThread(tx, ownerId);

  return { seeded: true };
}
