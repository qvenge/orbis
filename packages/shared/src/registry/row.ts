/**
 * Таблица M14 v1 (§Б5-6 :560) — «элемент строки ← контракт» и единый порядок совмещения.
 * Правило живёт КОНСТАНТОЙ, а не строкой `subscription_definitions` (Р-К-1): потребитель строки —
 * web, а подписки клиенту не отдаются (Р3); сид одной строки, если понадобится, прочитает её же.
 * Функция ЧИСТАЯ и общая: её зовут обе строки web, `toSuggestion` и снимок поверхностей. Второй
 * копии правила быть не должно — ровно от неё лечится разъезд двух семантик «закрыто» (Р-К-14).
 */
import { type BindingIndex, bindingIndexOf, type ResolvedBinding } from './bindings';
import type { ContractDefinition } from './contract-type';
import type { AspectDefinition } from './property-type';

export type RowElementKind = 'checkbox' | 'title' | 'date' | 'amount' | 'progress' | 'badges';
/** `slots` — приоритет: выигрывает первый заполненный (у даты — `deadline`, иначе `moment`). */
export interface RowElementRule {
  element: RowElementKind;
  contract?: string;
  set?: string;
  slots?: readonly string[];
}

export const M14_ROW_ELEMENTS: readonly RowElementRule[] = [
  { element: 'checkbox', contract: 'orbis/completable', set: 'closed' },
  { element: 'title' },
  { element: 'date', contract: 'orbis/when', slots: ['deadline', 'moment'] },
  {
    element: 'amount',
    contract: 'orbis/money-movement',
    slots: ['amount', 'direction', 'currency'],
  },
  // Контракта `orbis/progress` в Б-1 нет (В-2): элемент объявлен и всегда пуст — полоса включается
  // Б-3 одной строкой сида, без правки этого файла.
  { element: 'progress', contract: 'orbis/progress' },
  { element: 'badges', contract: 'orbis/completable' },
];

/**
 * Важность — ОСОЗНАННОЕ отклонение M14 (§Б5-6: контракта «важность» в v1 нет), поэтому raw_value
 * по id свойства; читается только при аспекте-носителе на записи (Р9 — значение переживает снятие
 * аспекта, и без проверки точка висела бы на записи, задачей быть переставшей).
 */
const PRIORITY_PROPERTY = 'orbis/priority';
const PRIORITY_HIGH = 'high';

export type RowBadge = { kind: 'class'; contract: string; cls: string } | { kind: 'priority' };
export interface RowProjection {
  checkbox: { closed: boolean; cls: string } | null;
  date: { value: string; slot: 'deadline' | 'moment' } | null;
  amount: { amount: string; direction: 'outflow' | 'inflow'; currency: string | null } | null;
  /** Контракта прогресса в Б-1 нет — всегда `null` (Б-3). */
  progress: null;
  badges: readonly RowBadge[];
}
export interface RowEntity {
  aspects: readonly string[];
  props: Record<string, unknown>;
}
export interface RowRegistry {
  aspects: ReadonlyMap<string, AspectDefinition>;
  contracts: ReadonlyMap<string, ContractDefinition>;
}

/**
 * Индекс привязок — ОДИН на снимок, а не на строку: Browser рисует 50 строк подряд, и пересборка
 * стоила бы 50 обходов аспектов владельца. Ключ — сам объект снимка: и `RegistrySnapshot` сервера,
 * и снимок web живут по одной ссылке, пока не сменилась версия реестра.
 */
const INDEX_BY_REGISTRY = new WeakMap<object, BindingIndex>();
function indexOf(reg: RowRegistry): BindingIndex {
  const hit = INDEX_BY_REGISTRY.get(reg);
  if (hit !== undefined) return hit;
  const built = bindingIndexOf(reg);
  INDEX_BY_REGISTRY.set(reg, built);
  return built;
}
function ruleOf(element: RowElementKind): RowElementRule {
  const rule = M14_ROW_ELEMENTS.find((r) => r.element === element);
  if (rule === undefined) throw new Error(`M14: правила элемента ${element} нет`);
  return rule;
}
/** Классы набора. Предикатный набор (§Б1-1) чистой функцией не вычисляется — пусто. */
function setClasses(reg: RowRegistry, contract: string, set: string): readonly string[] {
  const sets = reg.contracts.get(contract)?.sets;
  const value = sets == null ? undefined : sets[set];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/**
 * Привязки контракта, стоящие на записи, в порядке `rank` аспекта. Порядок задан ЯВНО, а не унаследован
 * от индекса: у двух привязок одного слота строка обязана выбирать одну и ту же всегда. `SLOT_AMBIGUOUS`
 * здесь не бросается намеренно — строка не подписка, отказ вместо строки списка был бы пустым экраном.
 */
function bindingsOn(
  idx: BindingIndex,
  entity: RowEntity,
  reg: RowRegistry,
  contract: string,
): readonly ResolvedBinding[] {
  const on = new Set(entity.aspects);
  const rank = (id: string) => reg.aspects.get(id)?.rank ?? Number.MAX_SAFE_INTEGER;
  return idx
    .byContract(contract)
    .filter((b) => on.has(b.aspectId))
    .slice()
    .sort((a, b) => rank(a.aspectId) - rank(b.aspectId) || (a.aspectId < b.aspectId ? -1 : 1));
}
/** Значение слота: свойство по `bind` либо литерал `fixed` (§Б2-1). */
function slotValue(b: ResolvedBinding, entity: RowEntity, slot: string): unknown {
  const prop = b.bind[slot];
  return prop === undefined ? b.fixed[slot] : entity.props[prop];
}
/**
 * Класс записи под привязкой — по status-слоту (§Б2-2). Варианты `present`/`absent` json-слотов
 * (Р-К-3) сюда не попадают: их контракт (`orbis/recurrence`) в таблице M14 не участвует.
 */
function classOf(b: ResolvedBinding, entity: RowEntity): string | null {
  for (const [slot, byVariant] of b.classOfVariant) {
    const value = slotValue(b, entity, slot);
    if (value === undefined || value === null) continue;
    const cls = byVariant.get(String(value));
    if (cls !== undefined) return cls;
  }
  return null;
}
/** Несёт ли свойство хоть один аспект, СТОЯЩИЙ на записи (Р9). */
function carried(entity: RowEntity, reg: RowRegistry, propertyId: string): boolean {
  return entity.aspects.some((id) =>
    (reg.aspects.get(id)?.properties ?? []).some((p) => p.propertyId === propertyId),
  );
}

export function rowProjectionOf(entity: RowEntity, reg: RowRegistry): RowProjection {
  const idx = indexOf(reg);
  const checkboxRule = ruleOf('checkbox');
  const closedSet = setClasses(reg, checkboxRule.contract ?? '', checkboxRule.set ?? '');

  let checkbox: RowProjection['checkbox'] = null;
  for (const b of bindingsOn(idx, entity, reg, checkboxRule.contract ?? '')) {
    const cls = classOf(b, entity);
    if (cls === null) continue;
    checkbox = { closed: closedSet.includes(cls), cls };
    break;
  }

  const dateRule = ruleOf('date');
  let date: RowProjection['date'] = null;
  for (const slot of dateRule.slots ?? []) {
    for (const b of bindingsOn(idx, entity, reg, dateRule.contract ?? '')) {
      const value = slotValue(b, entity, slot);
      if (typeof value !== 'string' || value === '') continue;
      date = { value, slot: slot as 'deadline' | 'moment' };
      break;
    }
    if (date !== null) break;
  }

  const amountRule = ruleOf('amount');
  let amount: RowProjection['amount'] = null;
  for (const b of bindingsOn(idx, entity, reg, amountRule.contract ?? '')) {
    const raw = slotValue(b, entity, 'amount');
    if (typeof raw !== 'string' || raw === '') continue;
    const currency = slotValue(b, entity, 'currency');
    amount = {
      amount: raw,
      // Направление — КЛАСС money-movement; промах (значения нет, вариант не отнесён) читается как
      // расход: тот же дефолт, что стоял в строке до реформы (`?? 'expense'`).
      direction: classOf(b, entity) === 'inflow' ? 'inflow' : 'outflow',
      currency: typeof currency === 'string' && currency !== '' ? currency : null,
    };
    break;
  }

  const badges: RowBadge[] = [];
  // РЧ-7-1: чекбокс показывает членство в наборе, а не сам класс. Первый класс набора — то, что он и
  // означает; остальные закрытые состояния он не различает, и их называет бейдж («отменено», Р4/В-3).
  if (checkbox !== null && closedSet.indexOf(checkbox.cls) > 0) {
    badges.push({ kind: 'class', contract: ruleOf('badges').contract ?? '', cls: checkbox.cls });
  }
  if (
    checkbox?.closed !== true &&
    entity.props[PRIORITY_PROPERTY] === PRIORITY_HIGH &&
    carried(entity, reg, PRIORITY_PROPERTY)
  ) {
    badges.push({ kind: 'priority' });
  }
  return { checkbox, date, amount, progress: null, badges };
}
