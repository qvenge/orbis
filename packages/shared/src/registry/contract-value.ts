/**
 * ЗНАЧЕНИЕ КОНТРАКТА (§3.2 спеки 1в) и ВИД АДРЕСА (§3.1) — для разбора, печати и компиляции.
 *
 * Контракт МОЖЕТ объявить значение из своих слотов — тогда он адресуется целиком
 * (`orbis/when=today`); остальные адресуются только слотами (`orbis/money-movement.amount>1000`).
 * Объявление — ДАННЫЕ контракта: роль слота `value_role` внутри `slots` (`contract-type.ts`).
 * Что значение ЗНАЧИТ — КОД: правило значения — закрытый набор здесь, и в 1в правило одно,
 * «даты» (§3.2 п. 1–3):
 *   1. есть значение хотя бы у одного слота-факта — даты записи: только факты;
 *   2. иначе запись в наборе `closed` ядровой «завершаемости» — дат нет («закрытое без времени
 *      закрытия — вне времени»);
 *   3. иначе — непустые слоты-планы.
 *
 * ПОЧЕМУ ПРАВИЛО В КОДЕ, А НЕ ВЫРАЖЕНИЕМ ЯЗЫКА E (К-1, принцип владельца 14.09): правило читает
 * набор ЧУЖОГО контракта (`orbis/completable`, `closed`) и выбирает между слотами по наличию
 * значений — выразить это в E значило бы расширить язык ради одного потребителя. Связь с
 * завершаемостью — часть ПРАВИЛА, не данных: контракт «когда» не называет «завершаемость» ни в
 * одной строке реестра, и контракт владельца с ролями получает то же правило без новой связи.
 *
 * Правило здесь только НАЗВАНО; исполняет его компилятор сервера (`apps/server/src/query/
 * contract-sql.ts`, `whenDatesSql`) — SQL по привязкам аспектов записи.
 *
 * Модуль реестра, а не запроса: вход — определение контракта, и читают его и разбор запроса
 * (`query/parse-ast.ts`), и сторож ключей поставки (`builtin.test.ts`), и сервер. Импорт
 * односторонний — отсюда в `contract-type.ts` и `types.ts`, обратно никогда (Р-К-51).
 */
import type { ContractDefinition, ContractValueRole } from './contract-type';
import type { PropertyKind } from './types';

/** Правила значения контракта — закрытый набор кода (§3.2 спеки 1в). В 1в правило одно. */
export type ContractValueRule = 'dates';

/**
 * Набор, который читает правило «даты» (п. 2): закрытое без времени закрытия — вне времени (К-1).
 * Контракт ядровой (`module: null`) — правило не зависит ни от одного расширения.
 */
export const COMPLETABLE_CLOSED = { contract: 'orbis/completable', set: 'closed' } as const;

/**
 * Правило значения контракта: `'dates'`, если хотя бы у одного слота есть роль; иначе `null` —
 * контракт значения не объявляет и целиком не адресуется (`NO_CONTRACT_VALUE` разбора).
 *
 * Роль бывает только у слота с датой (проверяет схема контракта), поэтому «есть роль» и есть
 * «правило „даты“»: второго правила, которому роли понадобились бы иначе, в 1в нет.
 */
export function contractValueRuleOf(c: ContractDefinition): ContractValueRule | null {
  if (c.kind !== 'slots') return null;
  return c.slots.some((s) => s.value_role !== undefined) ? 'dates' : null;
}

/** Имена слотов с данной ролью — в порядке объявления контракта. */
export function slotsWithRole(c: ContractDefinition, role: ContractValueRole): readonly string[] {
  if (c.kind !== 'slots') return [];
  return c.slots.filter((s) => s.value_role === role).map((s) => s.name);
}

/**
 * Вид адреса — для разбора значения-границы и компиляции (§3.1, §3.3):
 *  - `slot` — адрес слота; `kinds` — виды его типа (`any_of` раскрыт);
 *  - `dates` — значение контракта по правилу «даты» (сравнивается по ДНЯМ записи).
 */
export type AddressKind = { kind: 'slot'; kinds: readonly PropertyKind[] } | { kind: 'dates' };

/**
 * Вид адреса контракта или `null`, если адресовать нечего: контракта нет в реестре, у него нет
 * такого слота, слот — роль ребра (`relation_role`: значение даёт `fixed` привязки, свойства под
 * ним нет), либо у контракта нет значения (адрес без слота).
 *
 * `a.contract` — id контракта (так его кладёт разбор, §А5-2); ключ резолвит нормализация раньше.
 */
export function addressKindOf(
  a: { contract: string; slot?: string },
  reg: { contracts: ReadonlyMap<string, ContractDefinition> },
): AddressKind | null {
  const c = reg.contracts.get(a.contract);
  if (c === undefined || c.kind !== 'slots') return null;
  if (a.slot === undefined) {
    return contractValueRuleOf(c) === 'dates' ? { kind: 'dates' } : null;
  }
  const slot = c.slots.find((s) => s.name === a.slot);
  if (slot === undefined) return null;
  const type = slot.type;
  if (type.kind === 'relation_role') return null;
  return { kind: 'slot', kinds: type.kind === 'any_of' ? type.kinds : [type.kind] };
}
