// apps/server/src/budget/binding.ts
// Авто-привязка транзакции к конверту (03-budget §2.3) и уникальность конверта (§2.1).
// Селектор: период включает дату, валюта совпадает (coalesce с user_settings.defaultCurrency);
// tie-break byte-точный — (1) минимум календарных дней периода, (2) более поздний
// period_start, (3) меньший UUID. Вызывается executor'ом ПОСЛЕ применения породившей
// операции тем же tx: SQL видит фактическое состояние (включая операции того же batch),
// а дописанные операции входят в тот же action журнала → Undo откатывает целиком.
import { ROLE_ENVELOPE_BINDING } from '@orbis/shared';
import { eq, sql } from 'drizzle-orm';
import { userSettings } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import type { WireEntity } from '../executor/types';

/**
 * Id свойств, которые этот модуль читает в JS (§А1-1, таблица §А8).
 *
 * Константами, а не литералами по месту: чтение по НЕСУЩЕСТВУЮЩЕМУ id даёт `undefined`, а не
 * ошибку, и опечатка проявилась бы не отказом, а тихим «конверт не выбрался» — то есть
 * Unbudgeted вместо привязки. Компилятор литерал не стережёт, константу — стережёт.
 */
const PROP_CURRENCY = 'orbis/currency';
const PROP_FINANCE_CATEGORY = 'orbis/finance_category';
const PROP_OCCURRED_ON = 'orbis/occurred_on';
const PROP_PERIOD_START = 'orbis/period_start';
const PROP_PERIOD_END = 'orbis/period_end';
const PROP_RECURRENCE = 'orbis/recurrence';

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

/** Комбинация селектора §2.3: категория + валюта транзакции + её дата. */
export interface EnvelopeCombination {
  categoryRef: string;
  currency: string;
  occurredOn: string;
}

/** Строка батч-селектора: комбинация + ключ, под которым вызывающий ждёт ответ. */
export interface EnvelopeQuery extends EnvelopeCombination {
  key: string;
  /**
   * Запись, которая конвертом для этой комбинации быть не может, — сама привязываемая
   * транзакция (см. `targetBindingOps`). В общем случае не задаётся: комбинация одна на
   * множество транзакций, и кэш селектора ключуется именно ею.
   */
  excludeId?: string;
}

/**
 * Кандидаты-конверты для НАБОРА комбинаций одним запросом (§2.3) — единственный
 * источник истины выбора: одиночный selectEnvelope это набор из одного элемента.
 * По одному победителю на ключ; LATERAL повторяет тот же порядок выбора, что и
 * одиночный селектор: (1) минимум календарных дней периода, (2) более поздний
 * period_start, (3) меньший UUID. Ключ без конверта получает null (Unbudgeted).
 */
export async function selectEnvelopes(
  tx: Tx,
  args: {
    ownerId: string;
    /** Уже разрезолвленная дефолтная валюта ($defCur §2.3) — один читатель на набор. */
    defaultCurrency: string;
    rows: readonly EnvelopeQuery[];
  },
): Promise<Map<string, string | null>> {
  const picked = new Map<string, string | null>();
  const unique: EnvelopeQuery[] = [];
  for (const row of args.rows) {
    if (picked.has(row.key)) continue;
    picked.set(row.key, null);
    unique.push(row);
  }
  if (unique.length === 0) return picked;

  // Явные ::text — параметры VALUES без контекста типа PG вывести не может
  const values = unique.map(
    (r) =>
      sql`(${r.key}::text, ${r.categoryRef}::text, ${r.currency}::text, ${r.occurredOn}::text, ${r.excludeId ?? null}::uuid)`,
  );
  const rows = (await tx.execute(sql`
    SELECT q.k AS key, e.id AS id
    FROM (VALUES ${sql.join(values, sql`, `)})
      AS q(k, category_ref, currency, occurred_on, exclude_id)
    LEFT JOIN LATERAL (
      SELECT id FROM entities
      WHERE owner_id = ${args.ownerId} AND NOT archived
        AND (q.exclude_id IS NULL OR id <> q.exclude_id)
        AND 'orbis/budget' = ANY(aspects)
        AND props->>'orbis/finance_category' = q.category_ref
        AND coalesce(props->>'orbis/currency', ${args.defaultCurrency}) = q.currency
        AND (props->>'orbis/period_start') <= q.occurred_on
        AND (props->>'orbis/period_end')   >= q.occurred_on
      ORDER BY ((props->>'orbis/period_end')::date
              - (props->>'orbis/period_start')::date) ASC,
               (props->>'orbis/period_start') DESC,
               id ASC
      LIMIT 1
    ) e ON true
  `)) as unknown as Array<{ key: string; id: string | null }>;
  for (const row of rows) picked.set(row.key, row.id);
  return picked;
}

/** Ключ единственной строки, когда селектор зовут на одну комбинацию. */
const SINGLE_KEY = 'single';

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
    /** Запись, которая конвертом быть не может (сама привязываемая транзакция). */
    excludeId?: string;
  },
): Promise<string | null> {
  const defCur = args.defaultCurrency ?? (await defaultCurrencyOf(tx, args.ownerId));
  const picked = await selectEnvelopes(tx, {
    ownerId: args.ownerId,
    defaultCurrency: defCur,
    rows: [
      {
        key: SINGLE_KEY,
        categoryRef: args.categoryRef,
        currency: args.currency,
        occurredOn: args.occurredOn,
        excludeId: args.excludeId,
      },
    ],
  });
  return picked.get(SINGLE_KEY) ?? null;
}

/**
 * Нормализация валюты конверта (бэклог A7, §2.1): отсутствующее/NULL свойство
 * `orbis/currency` заменяется явной user_settings.defaultCurrency — на СЕРВЕРЕ,
 * до проверки уникальности §2.1 и записи. Все пути записи конверта (UI, LLM/MCP,
 * rollover, будущий импорт) дают каноничную комбинацию с явной валютой, поэтому
 * «конверт без currency» и «конверт с явной defaultCurrency» — один дубль, а не
 * две разные комбинации (TOCTOU NULL-currency-преемника закрыт по построению).
 * Значения иных типов не трогаем — их отклонит валидация схемы (стадия 2).
 * Мутирует props.
 */
export async function normalizeEnvelopeCurrency(
  tx: Tx,
  ownerId: string,
  props: Record<string, unknown>,
): Promise<void> {
  if (props[PROP_CURRENCY] === undefined || props[PROP_CURRENCY] === null) {
    props[PROP_CURRENCY] = await defaultCurrencyOf(tx, ownerId);
  }
}

/**
 * Операция привязки, дописываемая executor'ом в тот же action (§2.3).
 *
 * `role` у СОЗДАНИЯ всегда `envelope-binding` — привязку ставит система. У УДАЛЕНИЯ роль
 * берётся из НАЙДЕННОЙ строки (`budgetParentsOfMany` возвращает её вместе с источником), а не
 * подставляется константой: удалять надо ровно ту строку, что есть, иначе `relation_delete`
 * не найдёт её и уронит операцию владельца. Сегодня, после 0017, обе роли совпадают —
 * `envelope-binding` и только он, — и поле остаётся ради этого правила, а не ради интервала.
 */
export interface BudgetOpDesc {
  tool: 'relation_create' | 'relation_delete';
  input: { source_id: string; target_id: string; role: string };
}

/** Живая связь «конверт → транзакция» так, как её видит хук: источник и РОЛЬ ребра. */
interface BudgetParentEdge {
  sourceId: string;
  role: string;
}

/** `orbis/recurrence` под приложенным `orbis/schedule` — признак шаблона повторения (§3.1). */
function hasScheduleRecurrence(entity: WireEntity): boolean {
  return entity.aspects.includes('orbis/schedule') && entity.props[PROP_RECURRENCE] !== undefined;
}

/**
 * Живые конверты-родители НАБОРА транзакций одним запросом (§2.3). Порядок source_id внутри
 * транзакции — тот же ORDER BY, что и у одиночного чтения; транзакция без родителей получает
 * пустой массив.
 *
 * Отбор — по ОДНОЙ роли `envelope-binding`, ровно по тому множеству, которое считают
 * агрегаты (`spentByEnvelope`, unbudgeted) и карточка импорта. До 0017 множество было шире
 * (`LEGACY_PARENT_ROLES`) не по вкусу, а по механике: `rel_uniq` стоял на ПРОЕКЦИИ роли в
 * снятую колонку `relation_type`, и рядом с ребром роли ВЛАДЕЛЬЦА (`subitem`, `ticket`) от
 * конверта к транзакции своё `envelope-binding` уже не вставало — не считай хук такое ребро
 * привязкой, он бился бы об уникальность на КАЖДОЙ правке транзакции. С уникальностью по
 * `(source_id, target_id, role)` запрета нет: привязка ставится своей ролью всегда.
 *
 * Возвращается и РОЛЬ: удалять устаревшую привязку надо ровно той строкой, что есть.
 *
 * Join к аспектам источника (`'orbis/budget' = ANY(e.aspects)`) ОСТАЁТСЯ, хотя роль и так
 * системная. Он отсеивает состояние «конверт перестал быть конвертом (detach orbis/budget),
 * а его строки-привязки ещё живы»: ветка ребиндинга их снимает, но между операциями такое
 * состояние наблюдаемо, и без предиката хук считал бы родителем не-конверт. Снятие
 * предиката — отдельное решение о поведении, а не следствие contract-миграции.
 */
async function budgetParentsOfMany(
  tx: Tx,
  txnIds: readonly string[],
): Promise<Map<string, BudgetParentEdge[]>> {
  const parents = new Map<string, BudgetParentEdge[]>(txnIds.map((id) => [id, []]));
  const unique = [...parents.keys()];
  if (unique.length === 0) return parents;
  const rows = (await tx.execute(sql`
    SELECT r.target_id, r.source_id, r.role FROM relations r
    JOIN entities e ON e.id = r.source_id
    WHERE r.target_id IN (${sql.join(
      unique.map((id) => sql`${id}`),
      sql`, `,
    )}) AND r.role = ${ROLE_ENVELOPE_BINDING}
      AND 'orbis/budget' = ANY(e.aspects)
    ORDER BY r.target_id, r.source_id
  `)) as unknown as Array<{ target_id: string; source_id: string; role: string }>;
  for (const row of rows) {
    parents.get(row.target_id)?.push({ sourceId: row.source_id, role: row.role });
  }
  return parents;
}

/**
 * Транзакция под привязкой: `props` — её значения для селектора, null — принудительная
 * отвязка (шаблон recurring, §3.1). Общий вход и для расчёта операций, и для прогрева
 * кэша чтений: одно место решает, ЧТО именно будет прочитано.
 */
export interface BindingTarget {
  txnId: string;
  props: Record<string, unknown> | null;
}

/** Цель привязки для сущности (§2.3); null — привязка не применяется (не транзакция/архив). */
export function bindingTargetOf(entity: WireEntity): BindingTarget | null {
  if (!entity.aspects.includes('orbis/financial') || entity.archived) return null;
  if (hasScheduleRecurrence(entity)) return { txnId: entity.id, props: null };
  return { txnId: entity.id, props: entity.props };
}

/** Комбинация селектора из свойств транзакции; null — данных для выбора конверта нет. */
function combinationOf(
  props: Record<string, unknown>,
  defaultCurrency: string,
): EnvelopeCombination | null {
  const categoryRef = props[PROP_FINANCE_CATEGORY];
  const occurredOn = props[PROP_OCCURRED_ON];
  if (typeof categoryRef !== 'string' || typeof occurredOn !== 'string') return null;
  const currency = props[PROP_CURRENCY];
  return {
    categoryRef,
    currency: typeof currency === 'string' ? currency : defaultCurrency,
    occurredOn,
  };
}

function envelopeCacheKey(ownerId: string, c: EnvelopeCombination): string {
  return JSON.stringify([ownerId, c.categoryRef, c.currency, c.occurredOn]);
}

/**
 * Кэш чтений привязки в пределах ОДНОГО исполнения executor'а (одной транзакции):
 * дефолтная валюта владельца, победитель селектора по комбинации и живые
 * budget-parent'ы транзакции. Прогрев (prefetch) делает три запроса на ВЕСЬ набор
 * целей вместо трёх на каждую — это и снимает N+1 массового импорта.
 *
 * Кэш НЕ глобальный и НЕ процессный: user_settings и связи меняются между запросами,
 * объект живёт ровно столько, сколько исполнение. Кэш конвертов не инвалидируется —
 * дописанные операции привязки трогают только relations, набор конвертов в пределах
 * прохода неизменен. Кэш родителей ОБЯЗАН инвалидироваться той транзакцией, чью
 * parent-связь только что создали/удалили: следующий хук того же batch видит эффект
 * предыдущего (порядок чтений §2.3) — иначе он повторно удалял бы удалённую связь.
 */
export class BindingReads {
  private readonly currencies = new Map<string, string>();
  private readonly envelopes = new Map<string, string | null>();
  private readonly parents = new Map<string, BudgetParentEdge[]>();

  /** user_settings.defaultCurrency владельца — один раз за исполнение. */
  async defaultCurrency(tx: Tx, ownerId: string): Promise<string> {
    const cached = this.currencies.get(ownerId);
    if (cached !== undefined) return cached;
    const value = await defaultCurrencyOf(tx, ownerId);
    this.currencies.set(ownerId, value);
    return value;
  }

  /** Победитель селектора для комбинации (§2.3). */
  async envelopeOf(
    tx: Tx,
    args: { ownerId: string; defaultCurrency: string; combination: EnvelopeCombination },
  ): Promise<string | null> {
    await this.loadEnvelopes(tx, args.ownerId, args.defaultCurrency, [args.combination]);
    return this.envelopes.get(envelopeCacheKey(args.ownerId, args.combination)) ?? null;
  }

  /** Живые конверты-родители транзакции с ролями их рёбер (§4.2). */
  async parentsOf(tx: Tx, txnId: string): Promise<BudgetParentEdge[]> {
    await this.loadParents(tx, [txnId]);
    return this.parents.get(txnId) ?? [];
  }

  /** Прогрев на весь набор целей: ≤3 запроса независимо от размера набора. */
  async prefetch(
    tx: Tx,
    args: { ownerId: string; targets: readonly BindingTarget[] },
  ): Promise<void> {
    const combinations: EnvelopeCombination[] = [];
    const txnIds: string[] = [];
    let defCur: string | null = null;
    for (const target of args.targets) {
      if (target.props === null) {
        txnIds.push(target.txnId); // отвязка шаблона: нужны только родители
        continue;
      }
      defCur ??= await this.defaultCurrency(tx, args.ownerId);
      const combination = combinationOf(target.props, defCur);
      if (combination === null) continue; // привязка этой строки не считается — читать нечего
      combinations.push(combination);
      txnIds.push(target.txnId);
    }
    if (defCur !== null) await this.loadEnvelopes(tx, args.ownerId, defCur, combinations);
    await this.loadParents(tx, txnIds);
  }

  /** Родители транзакции изменились дописанной операцией — перечитать при следующем спросе. */
  invalidateParents(txnId: string): void {
    this.parents.delete(txnId);
  }

  private async loadEnvelopes(
    tx: Tx,
    ownerId: string,
    defaultCurrency: string,
    combinations: readonly EnvelopeCombination[],
  ): Promise<void> {
    const rows: EnvelopeQuery[] = [];
    for (const c of combinations) {
      const key = envelopeCacheKey(ownerId, c);
      if (!this.envelopes.has(key)) rows.push({ key, ...c });
    }
    if (rows.length === 0) return;
    for (const [key, id] of await selectEnvelopes(tx, { ownerId, defaultCurrency, rows })) {
      this.envelopes.set(key, id);
    }
  }

  private async loadParents(tx: Tx, txnIds: readonly string[]): Promise<void> {
    const missing = [...new Set(txnIds)].filter((id) => !this.parents.has(id));
    if (missing.length === 0) return;
    for (const [id, sources] of await budgetParentsOfMany(tx, missing)) {
      this.parents.set(id, sources);
    }
  }
}

/**
 * Diff привязки одной транзакции: желаемый конверт селектором против текущих
 * budget-parent'ов. Порядок ops — сначала delete устаревших связей, затем create новой
 * (инвариант «один budget-parent» §4.2 требует именно этой последовательности).
 * `props: null` (шаблон recurring) — безусловная отвязка всех budget-parent'ов.
 */
async function targetBindingOps(
  tx: Tx,
  reads: BindingReads,
  ownerId: string,
  target: BindingTarget,
  /** Уже разрезолвленная дефолтная валюта — чтобы не перечитывать user_settings в циклах. */
  defaultCurrency?: string,
): Promise<BudgetOpDesc[]> {
  const { txnId } = target;
  if (target.props === null) {
    const current = await reads.parentsOf(tx, txnId);
    return current.map((edge) => ({
      tool: 'relation_delete' as const,
      input: { source_id: edge.sourceId, target_id: txnId, role: edge.role },
    }));
  }
  const defCur = defaultCurrency ?? (await reads.defaultCurrency(tx, ownerId));
  const combination = combinationOf(target.props, defCur);
  if (combination === null) return [];
  let desired = await reads.envelopeOf(tx, { ownerId, defaultCurrency: defCur, combination });
  if (desired === txnId) {
    // Запись, которая ОДНОВРЕМЕННО транзакция и конверт, не считает сама себя: ребро в себя
    // запрещено по построению (`rel_no_self`), а «конверт» здесь — она же. Раньше это было
    // редкостью (нужно было вручную совпасть категорией), но с §А1-1 категория и валюта у
    // транзакции и конверта — ОДНО свойство (В1), и `attach_orbis_budget` на транзакции с
    // подходящим периодом попадал в себя ДЕТЕРМИНИРОВАННО: владелец получал
    // `INVARIANT self_relation` вместо привязки.
    //
    // Селектор перезапускается с исключением, а не отдаёт `null`: транзакция обязана
    // остаться в СВОЁМ конверте, если он есть, — иначе «пометил запись конвертом» тихо
    // выкидывало бы её сумму из чужого бюджета. Запрос идёт мимо кэша `reads` намеренно:
    // ключ кэша — комбинация, общая на множество транзакций, а исключение — своё у каждой.
    desired = await selectEnvelope(tx, {
      ownerId,
      ...combination,
      defaultCurrency: defCur,
      excludeId: txnId,
    });
  }
  const current = await reads.parentsOf(tx, txnId);
  const ops: BudgetOpDesc[] = [];
  for (const edge of current) {
    if (edge.sourceId !== desired) {
      ops.push({
        tool: 'relation_delete',
        input: { source_id: edge.sourceId, target_id: txnId, role: edge.role },
      });
    }
  }
  // Ребро от НУЖНОГО конверта уже есть — второго рядом хук не ставит. Множество, по которому
  // считается «уже есть», задаёт `budgetParentsOfMany`, и с 0017 это РОВНО роль
  // `envelope-binding` — та же, что у агрегатов и у инварианта `target_max_incoming`.
  if (desired !== null && !current.some((edge) => edge.sourceId === desired)) {
    ops.push({
      tool: 'relation_create',
      input: { source_id: desired, target_id: txnId, role: ROLE_ENVELOPE_BINDING },
    });
  }
  return ops;
}

/**
 * Операции привязки для транзакции: удалить прежний budget-parent (если сменился),
 * создать новый. Пустой массив — привязка актуальна. Вызывается executor'ом внутри
 * того же batch, что породившая мутация (§2.3: «одним batch_execute»).
 * Шаблоны recurring (свойство `orbis/recurrence` под аспектом `orbis/schedule`) и архивные
 * сущности не привязываются; шаблон, ставший таковым конверсией привязанной транзакции
 * («пометить повторяющейся» — attach `orbis/schedule` со свойством `orbis/recurrence`),
 * ОТВЯЗЫВАЕТСЯ: иначе spent считал бы шаблон вместе с его инстансами (двойной счёт,
 * финальное ревью фазы A).
 * reads — общий кэш чтений исполнения (executor прогревает его на все хуки batch).
 */
export async function bindingOps(
  tx: Tx,
  args: { ownerId: string; entity: WireEntity; reads?: BindingReads },
): Promise<BudgetOpDesc[]> {
  const target = bindingTargetOf(args.entity);
  if (target === null) return [];
  return targetBindingOps(tx, args.reads ?? new BindingReads(), args.ownerId, target);
}

/**
 * Снятие привязки: сущность перестала быть транзакцией (detach `orbis/financial`).
 * Переиспользует ветку принудительной отвязки `targetBindingOps` (`props: null`) — той же,
 * которой отвязывается ставший шаблоном recurring; нового SQL здесь нет.
 *
 * Зачем отдельная точка входа: `bindingOps` строит цель из АСПЕКТОВ сущности, а у
 * detach'нутой их уже нет — `bindingTargetOf` возвращает null, и снять устаревшую связь
 * было некому. Висящая parent-связь показывала не-financial ребёнка в `children_of`
 * конверта (на spent не влияет — SQL-агрегаты фильтруют по financial).
 */
export async function unbindOps(
  tx: Tx,
  args: { ownerId: string; entityId: string; reads?: BindingReads },
): Promise<BudgetOpDesc[]> {
  return targetBindingOps(tx, args.reads ?? new BindingReads(), args.ownerId, {
    txnId: args.entityId,
    props: null,
  });
}

/** Сторона окна ребиндинга: категория + период (старое или новое состояние конверта). */
interface RebindSide {
  categoryRef: string;
  periodStart: string;
  periodEnd: string;
}

function sideOf(entity: WireEntity | null): RebindSide | null {
  if (entity === null || !entity.aspects.includes('orbis/budget')) return null;
  const categoryRef = entity.props[PROP_FINANCE_CATEGORY];
  const periodStart = entity.props[PROP_PERIOD_START];
  const periodEnd = entity.props[PROP_PERIOD_END];
  if (
    typeof categoryRef !== 'string' ||
    typeof periodStart !== 'string' ||
    typeof periodEnd !== 'string'
  ) {
    return null;
  }
  return { categoryRef, periodStart, periodEnd };
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
  args: {
    ownerId: string;
    envelope: WireEntity;
    before: WireEntity | null;
    /** Общий кэш чтений исполнения; без него — свой, живущий только этот вызов. */
    reads?: BindingReads;
  },
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
    (s) => sql`(props->>'orbis/finance_category' = ${s.categoryRef}
      AND props->>'orbis/occurred_on' >= ${s.periodStart}
      AND props->>'orbis/occurred_on' <= ${s.periodEnd})`,
  );
  // «Не шаблон повторения» (§2.8) в WHERE ниже — ПАРА условий («аспект приложен И свойство
  // задано»), близнец помощника `notRecurringTemplateSql` из `aggregates.ts`; общего дома у
  // них нет, потому что импорт идёт оттуда сюда. Потерять вторую половину — считать шаблон
  // операцией вместе с его инстансами.
  const rows = (await tx.execute(sql`
    SELECT id, props FROM entities
    WHERE owner_id = ${ownerId} AND NOT archived
      AND 'orbis/financial' = ANY(aspects)
      AND props->>'orbis/occurred_on' IS NOT NULL
      AND NOT ('orbis/schedule' = ANY(aspects) AND props->'orbis/recurrence' IS NOT NULL)
      AND (${sql.join(conds, sql` OR `)})
    ORDER BY id
  `)) as unknown as Array<{ id: string; props: Record<string, unknown> }>;
  if (rows.length === 0) return [];

  // Прогрев на все затронутые строки: один запрос на конверты и один на родителей
  // вместо двух на строку (N+1, названный в бэклоге фазы A).
  const reads = args.reads ?? new BindingReads();
  const targets: BindingTarget[] = rows.map((row) => ({ txnId: row.id, props: row.props }));
  await reads.prefetch(tx, { ownerId, targets });
  const defCur = await reads.defaultCurrency(tx, ownerId);
  const ops: BudgetOpDesc[] = [];
  for (const target of targets) {
    ops.push(...(await targetBindingOps(tx, reads, ownerId, target, defCur)));
  }
  return ops;
}

/**
 * Минимальная форма строки сущности для проверки уникальности (виртуальные строки batch).
 *
 * Имена полей обязаны совпадать с колонками `EntityRow`: сюда приезжают ВИРТУАЛЬНЫЕ строки
 * batch'а как есть, и поле под чужим именем молча приехало бы `undefined` — предикат вернул
 * бы false на каждой строке, а компилятор бы промолчал.
 */
interface EnvelopeRowLike {
  id: string;
  archived: boolean;
  /** Список интерпретаций (§А1-1): без `orbis/budget` строка конвертом не считается. */
  aspects: string[];
  /** Значения по id свойства (§А1-1). */
  props: unknown;
}

function envelopeCombinationMatches(
  row: EnvelopeRowLike,
  key: { categoryRef: string; currency: string | null; periodStart: string; periodEnd: string },
): boolean {
  if (!row.aspects.includes('orbis/budget')) return false;
  const props = row.props as Record<string, unknown> | null;
  if (props === null || props === undefined) return false;
  const currency = typeof props[PROP_CURRENCY] === 'string' ? props[PROP_CURRENCY] : null;
  return (
    props[PROP_FINANCE_CATEGORY] === key.categoryRef &&
    currency === key.currency &&
    props[PROP_PERIOD_START] === key.periodStart &&
    props[PROP_PERIOD_END] === key.periodEnd
  );
}

/**
 * Транзакционный замок бюджета владельца — ОДИН ключ на два инварианта (уборочная фаза,
 * E9). Держали его только записи конвертов (`assertEnvelopeUnique`), а привязка транзакции
 * к конверту шла без замка: конкурентные «create транзакции ∥ create конверта» дают
 * write-skew — селектор §2.3 одной транзакции не видит незакоммиченный конверт другой,
 * и запись остаётся Unbudgeted, хотя конверт «уже есть».
 *
 * Тот же ключ, что у уникальности, — намеренно: оба инварианта про набор конвертов
 * владельца, и разные ключи развели бы их по разным очередям, оставив ту же щель.
 * Лок реентерабелен (повторный захват в той же транзакции бесплатен), поэтому batch,
 * который и привязывает, и создаёт конверты, берёт его один раз.
 *
 * Имя ключа — СВОЙ литерал, а не id роли `envelope-binding`, и это не небрежность.
 * `assertAcyclic` (`executor/relations.ts`) занимает под свои замки ровно пространство имён
 * `<владелец>:<роль>`; ключ из id роли попал бы в него и слил бы две несвязанные очереди
 * ровно в тот день, когда роли привязки припишут `acyclic` (или владелец заведёт свою роль
 * с таким же id — Задача 15). Сегодня замок берут два места, и оба зовут эту функцию.
 */
export async function lockOwnerBudget(tx: Tx, ownerId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ownerId}:envelope_unique`}, 0))`,
  );
}

/**
 * Уникальность конверта (03-budget §2.1): не более одного НЕАРХИВНОГО конверта на
 * точную комбинацию (category_ref, currency, period_start, period_end); currency
 * сравнивается как хранится (NULL и явная валюта — разные комбинации, §2.1 «точная»),
 * но новые записи NULL не несут: normalizeEnvelopeCurrency (бэклог A7) подставляет
 * явную defaultCurrency ДО этой проверки; NULL возможен только в legacy-строках.
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
    props: Record<string, unknown>;
    virtualEntities?: ReadonlyMap<string, EnvelopeRowLike>;
  },
): Promise<void> {
  const { ownerId, entityId, props, virtualEntities } = args;
  const categoryRef = props[PROP_FINANCE_CATEGORY];
  const periodStart = props[PROP_PERIOD_START];
  const periodEnd = props[PROP_PERIOD_END];
  if (
    typeof categoryRef !== 'string' ||
    typeof periodStart !== 'string' ||
    typeof periodEnd !== 'string'
  ) {
    return; // структурно битые данные отклонит валидация схемы (стадия 2)
  }
  const key = {
    categoryRef,
    currency: typeof props[PROP_CURRENCY] === 'string' ? (props[PROP_CURRENCY] as string) : null,
    periodStart,
    periodEnd,
  };

  await lockOwnerBudget(tx, ownerId);

  const rows = (await tx.execute(sql`
    SELECT id FROM entities
    WHERE owner_id = ${ownerId} AND NOT archived AND id <> ${entityId}
      AND 'orbis/budget' = ANY(aspects)
      AND props->>'orbis/finance_category' = ${key.categoryRef}
      AND (props->>'orbis/currency') IS NOT DISTINCT FROM ${key.currency}
      AND props->>'orbis/period_start' = ${key.periodStart}
      AND props->>'orbis/period_end' = ${key.periodEnd}
    LIMIT 2
  `)) as unknown as Array<{ id: string }>;

  let existing = rows.map((r) => r.id).find((id) => !virtualEntities?.has(id));
  if (existing === undefined && virtualEntities !== undefined) {
    for (const row of virtualEntities.values()) {
      if (row.id !== entityId && !row.archived && envelopeCombinationMatches(row, key)) {
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
