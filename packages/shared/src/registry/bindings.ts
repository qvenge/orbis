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
  for (const vm of binding.value_map) {
    if (!slots.has(vm.slot)) continue; // уже названо UNKNOWN_SLOT
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
    perSlot.set(String(vm.variant), vm.class);
    mapped.set(vm.slot, perSlot);
  }
  for (const decl of contract.slots) {
    if (!decl.status) continue;
    const known = mapped.get(decl.name) ?? new Map<string, string>();
    const propertyId = binding.bind[decl.name];
    if (propertyId === undefined) {
      const fixed = binding.fixed[decl.name];
      if (fixed !== undefined && !known.has(String(fixed))) {
        out.push({
          code: 'VARIANT_UNMAPPED',
          details: { ...base, slot: decl.name, variant: fixed, reason: 'unmapped' },
        });
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
