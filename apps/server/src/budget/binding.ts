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

/** Операция привязки, дописываемая executor'ом в тот же action (§2.3). */
export interface BudgetOpDesc {
  tool: 'relation_create' | 'relation_delete';
  input: { source_id: string; target_id: string; relation_type: 'parent' };
}

/** orbis/schedule.recurrence на той же сущности — признак шаблона повторения (§3.1). */
function hasScheduleRecurrence(aspects: Record<string, Record<string, unknown>>): boolean {
  return aspects['orbis/schedule']?.recurrence !== undefined;
}

/** Живые budget-parent'ы транзакции (parent-связи от сущностей с orbis/budget, §4.2). */
async function budgetParentsOf(tx: Tx, txnId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT r.source_id FROM relations r
    JOIN entities e ON e.id = r.source_id
    WHERE r.target_id = ${txnId} AND r.relation_type = 'parent'
      AND e.aspects ? 'orbis/budget'
    ORDER BY r.source_id
  `)) as unknown as Array<{ source_id: string }>;
  return rows.map((r) => r.source_id);
}

/**
 * Diff привязки одной транзакции: желаемый конверт селектором против текущих
 * budget-parent'ов. Порядок ops — сначала delete устаревших связей, затем create новой
 * (инвариант «один budget-parent» §4.2 требует именно этой последовательности).
 */
async function diffBindingOps(
  tx: Tx,
  ownerId: string,
  defaultCurrency: string,
  txnId: string,
  fin: Record<string, unknown>,
): Promise<BudgetOpDesc[]> {
  if (typeof fin.category_ref !== 'string' || typeof fin.occurred_on !== 'string') return [];
  const currency = typeof fin.currency === 'string' ? fin.currency : defaultCurrency;
  const desired = await selectEnvelope(tx, {
    ownerId,
    categoryRef: fin.category_ref,
    currency,
    occurredOn: fin.occurred_on,
    defaultCurrency,
  });
  const current = await budgetParentsOf(tx, txnId);
  const ops: BudgetOpDesc[] = [];
  for (const src of current) {
    if (src !== desired) {
      ops.push({
        tool: 'relation_delete',
        input: { source_id: src, target_id: txnId, relation_type: 'parent' },
      });
    }
  }
  if (desired !== null && !current.includes(desired)) {
    ops.push({
      tool: 'relation_create',
      input: { source_id: desired, target_id: txnId, relation_type: 'parent' },
    });
  }
  return ops;
}

/**
 * Операции привязки для транзакции: удалить прежний budget-parent (если сменился),
 * создать новый. Пустой массив — привязка актуальна. Вызывается executor'ом внутри
 * того же batch, что породившая мутация (§2.3: «одним batch_execute»).
 * Шаблоны recurring (orbis/schedule.recurrence) и архивные сущности не привязываются;
 * шаблон, ставший таковым конверсией привязанной транзакции («пометить повторяющейся»,
 * attach orbis/schedule.recurrence), ОТВЯЗЫВАЕТСЯ — иначе spent считал бы шаблон
 * вместе с его инстансами (двойной счёт, финальное ревью фазы A).
 */
export async function bindingOps(
  tx: Tx,
  args: { ownerId: string; entity: WireEntity },
): Promise<BudgetOpDesc[]> {
  const { ownerId, entity } = args;
  const fin = entity.aspects['orbis/financial'];
  if (fin === undefined || entity.archived) return [];
  if (hasScheduleRecurrence(entity.aspects)) {
    const current = await budgetParentsOf(tx, entity.id);
    return current.map((src) => ({
      tool: 'relation_delete' as const,
      input: { source_id: src, target_id: entity.id, relation_type: 'parent' as const },
    }));
  }
  const defCur = await defaultCurrencyOf(tx, ownerId);
  return diffBindingOps(tx, ownerId, defCur, entity.id, fin);
}

/** Сторона окна ребиндинга: категория + период (старое или новое состояние конверта). */
interface RebindSide {
  categoryRef: string;
  periodStart: string;
  periodEnd: string;
}

function sideOf(entity: WireEntity | null): RebindSide | null {
  const budget = entity?.aspects['orbis/budget'];
  if (
    !budget ||
    typeof budget.category_ref !== 'string' ||
    typeof budget.period_start !== 'string' ||
    typeof budget.period_end !== 'string'
  ) {
    return null;
  }
  return {
    categoryRef: budget.category_ref,
    periodStart: budget.period_start,
    periodEnd: budget.period_end,
  };
}

/**
 * Ребиндинг всех затронутых транзакций при создании/правке/архивации конверта:
 * повторный прогон селектора для транзакций категории, чьи occurred_on попадают
 * в старый ИЛИ новый период (§2.3 последний абзац). Вызывается ПОСЛЕ применения
 * операции над конвертом тем же tx — селектор видит фактическое состояние
 * (новый период, archived, detach аспекта), результат зависит только от текущего
 * набора конвертов, а не от порядка их создания (03-budget §7.3).
 */
export async function rebindForEnvelope(
  tx: Tx,
  args: { ownerId: string; envelope: WireEntity; before: WireEntity | null },
): Promise<BudgetOpDesc[]> {
  const { ownerId, envelope, before } = args;
  const sides: RebindSide[] = [];
  for (const side of [sideOf(before), sideOf(envelope)]) {
    if (
      side !== null &&
      !sides.some(
        (s) =>
          s.categoryRef === side.categoryRef &&
          s.periodStart === side.periodStart &&
          s.periodEnd === side.periodEnd,
      )
    ) {
      sides.push(side);
    }
  }
  if (sides.length === 0) return [];

  // Затронутые транзакции: неархивные, с occurred_on (не шаблоны), категория и дата
  // в старом ИЛИ новом периоде. ORDER BY id — детерминированный порядок ops в action.
  const conds = sides.map(
    (s) => sql`(aspects->'orbis/financial'->>'category_ref' = ${s.categoryRef}
      AND aspects->'orbis/financial'->>'occurred_on' >= ${s.periodStart}
      AND aspects->'orbis/financial'->>'occurred_on' <= ${s.periodEnd})`,
  );
  const rows = (await tx.execute(sql`
    SELECT id, aspects->'orbis/financial' AS fin FROM entities
    WHERE owner_id = ${ownerId} AND NOT archived
      AND aspects->'orbis/financial'->>'occurred_on' IS NOT NULL
      AND aspects->'orbis/schedule'->'recurrence' IS NULL
      AND (${sql.join(conds, sql` OR `)})
    ORDER BY id
  `)) as unknown as Array<{ id: string; fin: Record<string, unknown> }>;
  if (rows.length === 0) return [];

  const defCur = await defaultCurrencyOf(tx, ownerId);
  const ops: BudgetOpDesc[] = [];
  for (const row of rows) {
    ops.push(...(await diffBindingOps(tx, ownerId, defCur, row.id, row.fin)));
  }
  return ops;
}

/** Минимальная форма строки сущности для проверки уникальности (виртуальные строки batch). */
interface EnvelopeRowLike {
  id: string;
  archived: boolean;
  aspects: unknown;
}

function envelopeCombinationMatches(
  aspects: unknown,
  key: { categoryRef: string; currency: string | null; periodStart: string; periodEnd: string },
): boolean {
  const budget = (aspects as Record<string, Record<string, unknown>> | null)?.['orbis/budget'];
  if (budget === undefined || budget === null) return false;
  const currency = typeof budget.currency === 'string' ? budget.currency : null;
  return (
    budget.category_ref === key.categoryRef &&
    currency === key.currency &&
    budget.period_start === key.periodStart &&
    budget.period_end === key.periodEnd
  );
}

/**
 * Уникальность конверта (03-budget §2.1): не более одного НЕАРХИВНОГО конверта на
 * точную комбинацию (category_ref, currency, period_start, period_end); currency
 * сравнивается как хранится (NULL и явная валюта — разные комбинации, §2.1 «точная»).
 * Вызывается стадией 4 (prepare) create/update/attach orbis/budget — до первой записи.
 *
 * Advisory-lock по владельцу сериализует конкурентные записи конвертов: без него две
 * транзакции, создающие одинаковую комбинацию, не видят незакоммиченные строки друг
 * друга (write-skew, как assertAcyclicBlocks). Лок реентерабелен для batch.
 *
 * virtualEntities — строки, созданные/изменённые предыдущими операциями того же batch
 * (§7.8): их эффекты ещё не в БД, но обязаны быть видимы; их же id исключаются из
 * SQL-результата (виртуальная версия строки авторитетна — могла архивироваться).
 */
export async function assertEnvelopeUnique(
  tx: Tx,
  args: {
    ownerId: string;
    entityId: string;
    budget: Record<string, unknown>;
    virtualEntities?: ReadonlyMap<string, EnvelopeRowLike>;
  },
): Promise<void> {
  const { ownerId, entityId, budget, virtualEntities } = args;
  if (
    typeof budget.category_ref !== 'string' ||
    typeof budget.period_start !== 'string' ||
    typeof budget.period_end !== 'string'
  ) {
    return; // структурно битые данные отклонит валидация схемы (стадия 2)
  }
  const key = {
    categoryRef: budget.category_ref,
    currency: typeof budget.currency === 'string' ? budget.currency : null,
    periodStart: budget.period_start,
    periodEnd: budget.period_end,
  };

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ownerId}:envelope_unique`}, 0))`,
  );

  const rows = (await tx.execute(sql`
    SELECT id FROM entities
    WHERE owner_id = ${ownerId} AND NOT archived AND id <> ${entityId}
      AND aspects->'orbis/budget'->>'category_ref' = ${key.categoryRef}
      AND (aspects->'orbis/budget'->>'currency') IS NOT DISTINCT FROM ${key.currency}
      AND aspects->'orbis/budget'->>'period_start' = ${key.periodStart}
      AND aspects->'orbis/budget'->>'period_end' = ${key.periodEnd}
    LIMIT 2
  `)) as unknown as Array<{ id: string }>;

  let existing = rows.map((r) => r.id).find((id) => !virtualEntities?.has(id));
  if (existing === undefined && virtualEntities !== undefined) {
    for (const row of virtualEntities.values()) {
      if (row.id !== entityId && !row.archived && envelopeCombinationMatches(row.aspects, key)) {
        existing = row.id;
        break;
      }
    }
  }
  if (existing !== undefined) {
    throw new ExecError(
      'INVARIANT',
      'конверт на эту точную комбинацию (категория, валюта, период) уже существует (03-budget §2.1); правьте существующий или архивируйте его',
      { invariant: 'duplicate_envelope', existingId: existing, ...key },
    );
  }
}
