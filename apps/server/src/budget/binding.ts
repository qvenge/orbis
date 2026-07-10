// apps/server/src/budget/binding.ts
// Авто-привязка транзакции к конверту (03-budget §2.3) и уникальность конверта (§2.1).
// Селектор: период включает дату, валюта совпадает (coalesce с user_settings.defaultCurrency);
// tie-break byte-точный — (1) минимум календарных дней периода, (2) более поздний
// period_start, (3) меньший UUID. Вызывается executor'ом ПОСЛЕ применения породившей
// операции тем же tx: SQL видит фактическое состояние (включая операции того же batch),
// а дописанные операции входят в тот же action журнала → Undo откатывает целиком.
import { eq, sql } from 'drizzle-orm';
import { userSettings } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import type { WireEntity } from '../executor/types';

/** Дефолт схемы user_settings.defaultCurrency — фолбэк, пока строки настроек нет. */
const FALLBACK_CURRENCY = 'RUB';

/** Дефолтная валюта владельца ($defCur селектора §2.3) — user_settings.defaultCurrency. */
export async function defaultCurrencyOf(tx: Tx, ownerId: string): Promise<string> {
  const rows = await tx
    .select({ currency: userSettings.defaultCurrency })
    .from(userSettings)
    .where(eq(userSettings.ownerId, ownerId));
  return rows[0]?.currency ?? FALLBACK_CURRENCY;
}

/**
 * Кандидат-конверт для транзакции по §2.3: период включает дату, валюта совпадает.
 * Tie-break byte-точный: (1) минимум календарных дней периода, (2) более поздний
 * period_start, (3) меньший UUID. Возвращает null, если конверта нет (Unbudgeted).
 */
export async function selectEnvelope(
  tx: Tx,
  args: {
    ownerId: string;
    categoryRef: string;
    currency: string;
    occurredOn: string;
    /** Уже разрезолвленная дефолтная валюта — чтобы не перечитывать user_settings в циклах. */
    defaultCurrency?: string;
  },
): Promise<string | null> {
  const defCur = args.defaultCurrency ?? (await defaultCurrencyOf(tx, args.ownerId));
  const rows = (await tx.execute(sql`
    SELECT id FROM entities
    WHERE owner_id = ${args.ownerId} AND NOT archived
      AND aspects->'orbis/budget'->>'category_ref' = ${args.categoryRef}
      AND coalesce(aspects->'orbis/budget'->>'currency', ${defCur}) = ${args.currency}
      AND (aspects->'orbis/budget'->>'period_start') <= ${args.occurredOn}
      AND (aspects->'orbis/budget'->>'period_end')   >= ${args.occurredOn}
    ORDER BY ((aspects->'orbis/budget'->>'period_end')::date
            - (aspects->'orbis/budget'->>'period_start')::date) ASC,
             (aspects->'orbis/budget'->>'period_start') DESC,
             id ASC
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}
