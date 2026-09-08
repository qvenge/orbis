// apps/server/src/budget/categories.ts
// КАРТОЧКА КАТЕГОРИИ — общее чтение обоих движков Финансов: оракула `computeOverview`
// (`budget/aggregates.ts`) и движка подписки (`subscriptions/budget.ts`).
//
// Почему третий файл, а не экспорт из оракула. Во-первых, карточка категории (заголовок, иконка,
// цвет, класс траты) — величина, которую обе реализации обязаны читать ОДИНАКОВО: разойдись они
// иконкой, и сверка §С8-15 «ноль расхождений» ловила бы это как расхождение движков, хотя движки
// тут ни при чём. Во-вторых, прямой импорт `subscriptions/budget.ts` ← `budget/aggregates.ts`
// замкнул бы цикл: с переводом пяти обёрток оракул сам зовёт движок.
//
// Что здесь НЕ живёт: список категорий владельца — не ведомость подписки (контракта «категория» в
// Б-1 нет, В-2), поэтому запрос `ownerCategories` переехал сюда ЦЕЛИКОМ и дословно, а не был
// выражен декларацией.

import type { BudgetStatusResult } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

export interface CategoryInfo {
  id: string;
  title: string;
  icon: string | null;
  color: string | null;
  spendClass: 'fixed' | 'discretionary' | null;
}

/** Карточки категорий по id (включая архивные — конверт переживает архивацию категории). */
export async function categoriesById(tx: Tx, ids: string[]): Promise<Map<string, CategoryInfo>> {
  if (ids.length === 0) return new Map();
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    SELECT id, title, props, ('orbis/category' = ANY(aspects)) AS is_category FROM entities
    WHERE id IN (${list})
  `)) as unknown as Array<{
    id: string;
    title: string;
    props: Record<string, unknown>;
    is_category: boolean;
  }>;
  return new Map(
    rows.map((r) => {
      // Не категория — карточка пустая: ровно то, что давала старая карта без своего ключа.
      const c = r.is_category ? r.props : {};
      const spendClass = c['orbis/spend_class'];
      return [
        r.id,
        {
          id: r.id,
          title: r.title,
          icon: typeof c['orbis/icon'] === 'string' ? c['orbis/icon'] : null,
          color: typeof c['orbis/color'] === 'string' ? c['orbis/color'] : null,
          spendClass: spendClass === 'fixed' || spendClass === 'discretionary' ? spendClass : null,
        },
      ];
    }),
  );
}

/**
 * Классификация ВСЕХ категорий владельца для тула `budget_status` (§4.3/§4.5/§4.7): расчёт
 * «могу позволить?» требует классификацию, а некластифицированные категории модель обязана
 * называть явно, а не включать молча.
 */
export async function ownerCategories(
  tx: Tx,
  ownerId: string,
): Promise<BudgetStatusResult['categories']> {
  const rows = (await tx.execute(sql`
    SELECT id, title, props->>'orbis/spend_class' AS spend_class
    FROM entities
    WHERE owner_id = ${ownerId} AND NOT archived AND 'orbis/category' = ANY(aspects)
    ORDER BY title, id
  `)) as unknown as Array<{ id: string; title: string; spend_class: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    spendClass:
      r.spend_class === 'fixed' || r.spend_class === 'discretionary' ? r.spend_class : null,
  }));
}
