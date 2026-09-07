/**
 * Привязки аспектов к контрактам (§Б2): проверка НА ЗАПИСИ и индекс для движков.
 *
 * ПОЧЕМУ В SHARED. Привязку пишут двое — сид встроенных аспектов (`builtin-aspects.ts`) и тул
 * владельца (`registry/ops.ts`, задача 15). Правило «какое свойство встаёт в какой слот»
 * обязано быть ОДНО на обоих, иначе сид кладёт то, что тул запрещает. Функции ЧИСТЫЕ и ничего
 * не бросают: `ExecError` — понятие сервера, перевод замечаний в коды делает вызывающий.
 *
 * ПОЧЕМУ ТОЛЬКО НА ЗАПИСИ (Р-И-7). На чтении (`load.ts`, `applyDeltas`) форму проверяет zod и
 * ТОЛЬКО он: fail-closed на чтении запер бы владельца снаружи собственного реестра после
 * пересева, тронувшего контракт (довод докблока `load.ts`, пункт 4).
 */
import type { ContractDefinition, ContractSlot } from './contract-type';
import type { AspectDefinition, AspectImplements, PropertyDefinition } from './property-type';
import type { PropertyKind } from './types';

type SlotsContract = Extract<ContractDefinition, { kind: 'slots' }>;
type SlotType = ContractSlot['type'];

export interface ImplementsIssue {
  code:
    | 'BIND_TYPE'
    | 'VARIANT_UNMAPPED'
    | 'UNKNOWN_CONTRACT'
    | 'UNKNOWN_SLOT'
    | 'UNKNOWN_PROPERTY'
    | 'REQUIRED_SLOT_UNBOUND';
  details: Record<string, unknown>;
}

/** `any_of` берёт любой из перечисленных kind; `relation_role` — не свойство вовсе. */
function slotAccepts(type: SlotType, kind: PropertyKind): boolean {
  if (type.kind === 'relation_role') return false;
  if (type.kind === 'any_of') return type.kinds.includes(kind);
  return type.kind === kind;
}
/** Печать типа слота в `details`: читателем будет человек в карточке отказа. */
function slotTypeLabel(type: SlotType): string {
  return type.kind === 'any_of' ? `any_of[${type.kinds.join(',')}]` : type.kind;
}
/** Литерал `fixed` вместо свойства: роль и decimal/date — строкой, число — числом. */
function fixedFits(type: SlotType, value: string | number | boolean): boolean {
  if (type.kind === 'relation_role') return typeof value === 'string';
  const kinds = type.kind === 'any_of' ? type.kinds : [type.kind];
  return kinds.some((kind) =>
    kind === 'boolean'
      ? typeof value === 'boolean'
      : kind === 'number'
        ? typeof value === 'number'
        : typeof value === 'string',
  ); // decimal и date — СТРОКИ (§А2-2), не числа
}
/** Все имена слотов привязки — по одному разу, с местом первого упоминания. */
function namedSlots(binding: AspectImplements): Map<string, 'bind' | 'fixed' | 'value_map'> {
  const out = new Map<string, 'bind' | 'fixed' | 'value_map'>();
  for (const slot of Object.keys(binding.bind)) if (!out.has(slot)) out.set(slot, 'bind');
  for (const slot of Object.keys(binding.fixed)) if (!out.has(slot)) out.set(slot, 'fixed');
  for (const vm of binding.value_map) if (!out.has(vm.slot)) out.set(vm.slot, 'value_map');
  return out;
}

export function checkImplements(
  aspect: Pick<AspectDefinition, 'id' | 'properties' | 'implements'>,
  reg: {
    properties: ReadonlyMap<string, PropertyDefinition>;
    contracts: ReadonlyMap<string, ContractDefinition>;
  },
): ImplementsIssue[] {
  const issues: ImplementsIssue[] = [];
  const carried = new Set(aspect.properties.map((p) => p.propertyId));
  const seen = new Set<string>();
  for (const binding of aspect.implements) {
    const contract = reg.contracts.get(binding.contract);
    if (contract === undefined || contract.kind === 'facts') {
      // Контракт фактов (`orbis/sensitivity`) аспект не реализует: слотов нет, `bind` не
      // существует по определению формы (§Б1-2). С точки зрения привязки такого контракта
      // нет — тот же код, что у снятого, с различающим `reason`.
      issues.push({
        code: 'UNKNOWN_CONTRACT',
        details: {
          aspect: aspect.id,
          contract: binding.contract,
          reason: contract === undefined ? 'absent' : 'facts',
        },
      });
      continue;
    }
    if (seen.has(contract.id)) {
      // ДВЕ привязки одного аспекта к одному контракту — противоречие, а не сложение: индекс
      // отвечает на них по-разному (`slotOf` берёт последнюю пару, `byContract` — обе), и
      // потребитель, спросивший «какое свойство стоит в слоте», получил бы два ответа.
      // Форма выразима и схемой строки (`superRefine` на `implements`), но дом проверки —
      // ЗДЕСЬ, на записи: `aspectDefinitionSchema` разбирается ещё и на ЧТЕНИИ снимка
      // (`load.ts`, fail-closed), и одна такая строка, попавшая в базу дельтой задачи 13,
      // заперла бы владельца снаружи собственного реестра целиком (Р-И-7) — вместо того чтобы
      // отказать в одной записи. Кода седьмого не заводим (Р-К-34): тот же `UNKNOWN_CONTRACT`
      // с различающим `reason`, что у снятого контракта и у формы фактов.
      issues.push({
        code: 'UNKNOWN_CONTRACT',
        details: { aspect: aspect.id, contract: contract.id, reason: 'duplicate' },
      });
      continue;
    }
    seen.add(contract.id);
    const base = { aspect: aspect.id, contract: contract.id };
    const slots = new Map(contract.slots.map((s) => [s.name, s]));
    for (const [slot, where] of namedSlots(binding)) {
      if (!slots.has(slot))
        issues.push({ code: 'UNKNOWN_SLOT', details: { ...base, slot, where } });
    }
    for (const [slot, propertyId] of Object.entries(binding.bind)) {
      const decl = slots.get(slot);
      if (decl === undefined) continue; // уже названо UNKNOWN_SLOT
      const prop = reg.properties.get(propertyId);
      if (prop === undefined) {
        issues.push({
          code: 'UNKNOWN_PROPERTY',
          details: { ...base, slot, propertyId, reason: 'absent' },
        });
        continue;
      }
      if (!carried.has(propertyId)) {
        issues.push({
          code: 'UNKNOWN_PROPERTY',
          details: { ...base, slot, propertyId, reason: 'not_carried' },
        });
      }
      if (!slotAccepts(decl.type, prop.type.kind)) {
        issues.push({
          code: 'BIND_TYPE',
          details: {
            ...base,
            slot,
            propertyId,
            slotType: slotTypeLabel(decl.type),
            propertyKind: prop.type.kind,
          },
        });
      }
    }
    for (const [slot, value] of Object.entries(binding.fixed)) {
      const decl = slots.get(slot);
      if (decl !== undefined && !fixedFits(decl.type, value)) {
        issues.push({
          code: 'BIND_TYPE',
          details: {
            ...base,
            slot,
            fixed: value,
            slotType: slotTypeLabel(decl.type),
            propertyKind: typeof value,
          },
        });
      }
    }
    for (const decl of contract.slots) {
      // §Б2-1: обязательный слот закрывается свойством ИЛИ константой. Пустое ЗНАЧЕНИЕ у
      // конкретной сущности привязку не ломает — членство динамическое (§Б2-3), и это забота
      // движка, а не гейта записи.
      if (
        decl.required &&
        binding.bind[decl.name] === undefined &&
        binding.fixed[decl.name] === undefined
      ) {
        issues.push({ code: 'REQUIRED_SLOT_UNBOUND', details: { ...base, slot: decl.name } });
      }
    }
    issues.push(...checkVariants(binding, contract, slots, reg, base));
  }
  return issues;
}

/**
 * Варианты слота-статуса (§Б2-2): отнесены ВСЕ, и только существующие. Р-К-3: у json-свойства
 * вариантов в значении нет — статус даёт САМО НАЛИЧИЕ (`orbis/recurrence` есть → шаблон), и
 * отнесение пишется маркерами `present`/`absent`; у boolean — литералы; у select — ключи.
 */
function variantsOf(prop: PropertyDefinition): readonly (string | boolean)[] | null {
  const t = prop.type;
  if (t.kind === 'select') return t.options.map((o) => o.key);
  if (t.kind === 'boolean') return [true, false];
  if (t.kind === 'json') return ['present', 'absent'];
  return null; // тип без вариантов на слоте-статусе — это BIND_TYPE, названный выше
}

function checkVariants(
  binding: AspectImplements,
  contract: SlotsContract,
  slots: ReadonlyMap<string, ContractSlot>,
  reg: { properties: ReadonlyMap<string, PropertyDefinition> },
  base: { aspect: string; contract: string },
): ImplementsIssue[] {
  const out: ImplementsIssue[] = [];
  const classKeys = new Set(contract.classes.map((c) => c.key));
  const mapped = new Map<string, Map<string, string>>();
  const notStatus = new Set<string>();
  for (const vm of binding.value_map) {
    const decl = slots.get(vm.slot);
    if (decl === undefined) continue; // уже названо UNKNOWN_SLOT
    if (!decl.status) {
      // Классы контракта считаются ПО СЛОТУ-СТАТУСУ (§Б2-2). Карта на прочем слоте не просто
      // бесполезна: она уезжает в `variantsOfClass`, и компилятор набора (задача 4) сложил бы
      // из неё предикат по сумме или дате. Замечание — одно на слот, как у `UNKNOWN_SLOT`:
      // виноват слот, а не каждая строка карты.
      if (!notStatus.has(vm.slot)) {
        notStatus.add(vm.slot);
        out.push({
          code: 'VARIANT_UNMAPPED',
          details: { ...base, slot: vm.slot, reason: 'not_status' },
        });
      }
      continue;
    }
    if (!classKeys.has(vm.class)) {
      out.push({
        code: 'VARIANT_UNMAPPED',
        details: {
          ...base,
          slot: vm.slot,
          variant: vm.variant,
          class: vm.class,
          reason: 'unknown_class',
        },
      });
      // Отнесение в несуществующий класс НЕ считается отнесением: набор контракта такого
      // класса не увидит, и вариант останется вне всех классов — второе замечание
      // (`unmapped`) на том же варианте не дублирует первое, а называет последствие.
      continue;
    }
    // Ключ карты — ТЕКСТ варианта: из props значение читается строкой (`props->>`) и у boolean
    // тоже, и второй карты для этого заводить нельзя.
    const perSlot = mapped.get(vm.slot) ?? new Map<string, string>();
    const already = perSlot.get(String(vm.variant));
    if (already !== undefined) {
      // Один вариант в двух классах — противоречие, которое индекс молча разрешает по-разному:
      // `classOfVariant` оставит последний класс, а `variantsOfClass` положит вариант в ОБА, и
      // сущность окажется членом двух взаимоисключающих наборов сразу. Повтор ОДНОГО И ТОГО ЖЕ
      // отнесения карту не меняет и замечанием не считается.
      if (already !== vm.class) {
        out.push({
          code: 'VARIANT_UNMAPPED',
          details: {
            ...base,
            slot: vm.slot,
            variant: vm.variant,
            class: vm.class,
            reason: 'duplicate',
          },
        });
      }
      continue;
    }
    perSlot.set(String(vm.variant), vm.class);
    mapped.set(vm.slot, perSlot);
  }
  for (const decl of contract.slots) {
    if (!decl.status) continue;
    const known = mapped.get(decl.name) ?? new Map<string, string>();
    const propertyId = binding.bind[decl.name];
    if (propertyId === undefined) {
      const fixed = binding.fixed[decl.name];
      if (fixed !== undefined) {
        if (!known.has(String(fixed))) {
          out.push({
            code: 'VARIANT_UNMAPPED',
            details: { ...base, slot: decl.name, variant: fixed, reason: 'unmapped' },
          });
        }
        // У постоянного значения вариант РОВНО один: всё прочее в карте в данных не встретится
        // никогда, а класс из-за такой строки выглядел бы достижимым.
        for (const variant of known.keys()) {
          if (variant !== String(fixed)) {
            out.push({
              code: 'VARIANT_UNMAPPED',
              details: { ...base, slot: decl.name, variant, reason: 'fixed_slot' },
            });
          }
        }
      }
      continue;
    }
    const prop = reg.properties.get(propertyId);
    const variants = prop === undefined ? null : variantsOf(prop);
    if (variants === null) continue;
    const domain = new Set(variants.map(String));
    for (const variant of variants) {
      if (!known.has(String(variant))) {
        out.push({
          code: 'VARIANT_UNMAPPED',
          details: { ...base, slot: decl.name, propertyId, variant, reason: 'unmapped' },
        });
      }
    }
    for (const variant of known.keys()) {
      if (!domain.has(variant)) {
        out.push({
          code: 'VARIANT_UNMAPPED',
          details: { ...base, slot: decl.name, propertyId, variant, reason: 'unknown_variant' },
        });
      }
    }
  }
  return out;
}

export interface ResolvedBinding {
  aspectId: string;
  contract: string;
  bind: Readonly<Record<string, string>>;
  fixed: Readonly<Record<string, string | number | boolean>>;
  /** слот → ТЕКСТ варианта → класс (`props->>` отдаёт текст и у boolean). */
  classOfVariant: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** слот → класс → варианты ЛИТЕРАЛАМИ (компилятору набора нужен литерал, не текст). */
  variantsOfClass: ReadonlyMap<string, ReadonlyMap<string, readonly (string | boolean)[]>>;
  /** Обязательные слоты, значение которых берётся у сущности (§Б2-3). */
  requiredSlots: readonly string[];
}
export interface BindingIndex {
  byContract(contract: string): readonly ResolvedBinding[];
  byAspect(aspectId: string): readonly ResolvedBinding[];
  slotOf(
    aspectId: string,
    contract: string,
    slot: string,
  ): { prop: string } | { fixed: string | number | boolean } | undefined;
}

const NO_BINDINGS: readonly ResolvedBinding[] = [];
const pairKey = (aspectId: string, contract: string): string => `${aspectId} ${contract}`;
function push(into: Map<string, ResolvedBinding[]>, key: string, value: ResolvedBinding): void {
  const list = into.get(key);
  if (list === undefined) into.set(key, [value]);
  else list.push(value);
}

function resolveBinding(
  aspectId: string,
  binding: AspectImplements,
  contract: SlotsContract,
): ResolvedBinding {
  const classOfVariant = new Map<string, Map<string, string>>();
  const variantsOfClass = new Map<string, Map<string, (string | boolean)[]>>();
  for (const vm of binding.value_map) {
    const perVariant = classOfVariant.get(vm.slot) ?? new Map<string, string>();
    perVariant.set(String(vm.variant), vm.class);
    classOfVariant.set(vm.slot, perVariant);
    const perClass = variantsOfClass.get(vm.slot) ?? new Map<string, (string | boolean)[]>();
    const list = perClass.get(vm.class);
    if (list === undefined) perClass.set(vm.class, [vm.variant]);
    else list.push(vm.variant);
    variantsOfClass.set(vm.slot, perClass);
  }
  // Обязательные слоты, значение которых берётся У СУЩНОСТИ (§Б2-3): из списка выпадает только
  // слот, закрытый КОНСТАНТОЙ (проверять на сущности нечего). Несвязанный обязательный слот —
  // случай пересева, добавившего контракту слот поверх старой привязки, — обязан остаться в
  // списке: иначе ветка потребителя «слот без привязки → не член» недостижима, и сущность
  // считалась бы членом контракта с NULL в обязательном слоте.
  const requiredSlots = contract.slots
    .filter((s) => s.required && binding.fixed[s.name] === undefined)
    .map((s) => s.name);
  return {
    aspectId,
    contract: contract.id,
    bind: binding.bind,
    fixed: binding.fixed,
    classOfVariant,
    variantsOfClass,
    requiredSlots,
  };
}

/**
 * Индекс привязок снимка реестра. Порядок внутри контракта — РАНГ аспекта: потребители,
 * которым нужен один ответ на слот (`rowProjectionOf`, §Б5-1), берут первую привязку, и
 * «первая» обязана быть одной и той же в каждом процессе — потому порядок задаётся здесь, а не
 * полагается на порядок словаря.
 *
 * Битую привязку (контракт снят, форма фактов) индекс ПРОПУСКАЕТ — и это не умолчание, а
 * разделение постов: называет её гейт записи `checkImplements`, а движок обязан работать на
 * том, что понимает, иначе один несогласованный пересев уронил бы Agenda и Budget целиком.
 * Следа в индексе такая привязка не оставляет намеренно: потребителю нечего с ней делать.
 */
export function bindingIndexOf(reg: {
  aspects: ReadonlyMap<string, AspectDefinition>;
  contracts: ReadonlyMap<string, ContractDefinition>;
}): BindingIndex {
  const byContract = new Map<string, ResolvedBinding[]>();
  const byAspect = new Map<string, ResolvedBinding[]>();
  const byPair = new Map<string, ResolvedBinding>();
  const ordered = [...reg.aspects.values()].sort(
    (a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1),
  );
  for (const aspect of ordered) {
    for (const binding of aspect.implements) {
      const contract = reg.contracts.get(binding.contract);
      if (contract === undefined || contract.kind === 'facts') continue;
      const resolved = resolveBinding(aspect.id, binding, contract);
      push(byContract, contract.id, resolved);
      push(byAspect, aspect.id, resolved);
      byPair.set(pairKey(aspect.id, contract.id), resolved);
    }
  }
  return {
    byContract: (contract) => byContract.get(contract) ?? NO_BINDINGS,
    byAspect: (aspectId) => byAspect.get(aspectId) ?? NO_BINDINGS,
    slotOf: (aspectId, contract, slot) => {
      const b = byPair.get(pairKey(aspectId, contract));
      if (b === undefined) return undefined;
      const prop = b.bind[slot];
      if (prop !== undefined) return { prop };
      const fixed = b.fixed[slot];
      return fixed === undefined ? undefined : { fixed };
    },
  };
}
