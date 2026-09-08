// apps/server/src/budget/contour.ts
// Контур бюджет-хука (§Б5-4, §С8-18) — ЧИСТЫЙ разбор ДЕКЛАРАЦИИ подписки Budget в то, что
// пишущей половине нужно знать о строке: какие аспекты дают движение, какие — конверт, каким
// свойством КАЖДЫЙ из них выражает слот контракта, что считается шаблоном повторения и какой
// ролью связаны обе стороны.
//
// Ни одного id встроенного аспекта здесь нет и быть не может — это условие, а не стиль.
// Аспект владельца, объявивший тот же контракт денег, обязан получать привязку к конверту тем
// же хуком, что и встроенный: до Б-1 обе стороны были литералами, и ребро аспекту владельца
// клала рука фикстуры гейта. Литералы, которые здесь ЕСТЬ, — словарь КОНТРАКТОВ (имена слотов
// и id контракта шаблонности §1.4), а не имена аспектов: контракт — это и есть язык, на
// котором декларация разговаривает с движком.
//
// Модуль — ЛИСТ, и дом у него отдельный, а не внутри `binding.ts`, ровно из-за импортов:
// движок подписки (`subscriptions/budget.ts`) уже берёт `lockOwnerBudget` из `binding.ts`, и
// обратный импорт декларации замкнул бы цикл. Здесь нет ни одного запроса — только разбор и
// куски SQL-предикатов, которые собирает вызывающий.
import { type BudgetSubscription, bindingIndexOf, type ResolvedBinding } from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { RegistrySnapshot } from '../registry/load';

/** Слоты, которыми пишущая половина пользуется по имени (§1.4: деньги и конверт). */
export const SLOT_CATEGORY = 'category';
export const SLOT_DATE = 'date';
export const SLOT_CURRENCY = 'currency';
export const SLOT_PERIOD_START = 'period_start';
export const SLOT_PERIOD_END = 'period_end';
/** Контракт шаблонности (§3.1) и его слот: `orbis/schedule` вешает на него `orbis/recurrence`. */
const RECURRENCE_CONTRACT = 'orbis/recurrence';
const SLOT_TEMPLATE_MARKER = 'template_marker';

/** Одна сторона контура: контракт из декларации и привязки объявивших его аспектов. */
export interface ContourSide {
  contract: string;
  /** Порядок — порядок индекса привязок: от него зависят и выбор интерпретации, и текст SQL. */
  bindings: readonly ResolvedBinding[];
  aspects: ReadonlySet<string>;
}

export interface BudgetContour {
  movement: ContourSide;
  envelope: ContourSide;
  /** Привязки контракта `orbis/recurrence`, ОБЪЯВИВШИЕ слот `template_marker`. */
  templates: readonly ResolvedBinding[];
  /** Роль ребра привязки — `sources.envelope.binding_role` декларации (§Б5-4). */
  bindingRole: string;
  /** Бюджет-контур владельца (§2.3) — объединение аспектов обеих сторон. */
  aspects: ReadonlySet<string>;
}

const EMPTY_SIDE: ContourSide = { contract: '', bindings: [], aspects: new Set() };

/**
 * Контур ВЫКЛЮЧЕН: декларации подписки в снимке нет. Хук тогда не поднимается вовсе — ровно
 * как у владельца без модуля Финансы. Падать из-за отсутствующей декларации исполнитель не
 * должен: он пишет заметки и задачи и там, где бюджета нет.
 */
export const EMPTY_CONTOUR: BudgetContour = {
  movement: EMPTY_SIDE,
  envelope: EMPTY_SIDE,
  templates: [],
  bindingRole: '',
  aspects: new Set(),
};

export function budgetContourOf(def: BudgetSubscription, reg: RegistrySnapshot): BudgetContour {
  const idx = bindingIndexOf({ aspects: reg.aspects, contracts: reg.contracts });
  const sideOfContract = (contract: string): ContourSide => {
    const bindings = idx.byContract(contract);
    return { contract, bindings, aspects: new Set(bindings.map((b) => b.aspectId)) };
  };
  const movement = sideOfContract(def.sources.movement.contract);
  const envelope = sideOfContract(def.sources.envelope.contract);
  return {
    movement,
    envelope,
    // Привязка БЕЗ слота `template_marker` шаблонности не выражает: `orbis/financial`
    // объявляет тот же контракт одним `fixed.origin_role` (Р-К-30). Не отфильтруй мы её —
    // каждая транзакция считалась бы шаблоном и не привязывалась бы ни к одному конверту.
    templates: idx
      .byContract(RECURRENCE_CONTRACT)
      .filter((b) => b.bind[SLOT_TEMPLATE_MARKER] !== undefined),
    bindingRole: def.sources.envelope.binding_role,
    aspects: new Set([...movement.aspects, ...envelope.aspects]),
  };
}

/** Свойство, которым аспект выражает слот стороны; undefined — слот этим аспектом не привязан. */
export function propOfSlot(side: ContourSide, aspectId: string, slot: string): string | undefined {
  return side.bindings.find((b) => b.aspectId === aspectId)?.bind[slot];
}

/** Несёт ли строка хоть один аспект этой стороны. */
export function carriesSide(side: ContourSide, aspects: readonly string[]): boolean {
  return aspects.some((id) => side.aspects.has(id));
}

/**
 * Первая привязка стороны, чей аспект строка НЕСЁТ. Порядок — индекса привязок, а НЕ
 * `aspects[]` строки: две интерпретации одного контракта на одной сущности (§С8-21) обязаны
 * давать один и тот же ответ независимо от порядка навешивания. Отказом это не считается —
 * §С8-21 правило ЧТЕНИЯ, и уронить им запись владельца хук не вправе.
 */
export function bindingFor(
  side: ContourSide,
  aspects: readonly string[],
): ResolvedBinding | undefined {
  return side.bindings.find((b) => aspects.includes(b.aspectId));
}

/** `aspects && ARRAY[…]` — строка несёт хоть один аспект стороны; пустая сторона → FALSE. */
export function sideAspectsSql(side: ContourSide, row: SQL): SQL {
  if (side.aspects.size === 0) return sql`false`;
  const ids = sql.join(
    [...side.aspects].map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`${row}.aspects && ARRAY[${ids}]::text[]`;
}

/**
 * «Строка — шаблон повторения» (§3.1) в SQL. Условие ПАРНОЕ («аспект приложен И маркер
 * задан») ровно как было литералом в `rebindForEnvelope`: потерять вторую половину значит
 * считать шаблон вместе с его инстансами — двойной счёт, найденный финальным ревью фазы A.
 * Вызывающий обязан завернуть результат в скобки (`NOT (${templateSql(...)})`).
 */
export function templateSql(contour: BudgetContour, row: SQL): SQL {
  if (contour.templates.length === 0) return sql`false`;
  return sql.join(
    contour.templates.map(
      (b) => sql`(${row}.aspects @> ARRAY[${b.aspectId}]::text[]
        AND ${row}.props->${b.bind[SLOT_TEMPLATE_MARKER] as string} IS NOT NULL)`,
    ),
    sql` OR `,
  );
}

/** Тот же предикат по СНЯТОЙ строке: у хука сущность на руках, а не в БД. */
export function isTemplate(
  contour: BudgetContour,
  entity: { aspects: readonly string[]; props: Record<string, unknown> },
): boolean {
  return contour.templates.some(
    (b) =>
      entity.aspects.includes(b.aspectId) &&
      entity.props[b.bind[SLOT_TEMPLATE_MARKER] as string] !== undefined,
  );
}
