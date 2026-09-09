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
import type { PropertyKind, SelectOption } from './types';

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

/** Одно отнесение карты классов: «вариант свойства = класс контракта в этом слоте» (§Б2-2). */
export interface ClassMapEntry {
  contract: string;
  slot: string;
  variant: string | boolean;
  class: string;
}

/**
 * Форма дельты, которую видит проверка, — ровно два её поля. `AspectDelta` живёт на сервере
 * (`apps/server/src/registry/deltas.ts`), а проверка — здесь, рядом с `checkImplements`: правило
 * «вариант без класса» одно на встроенные привязки и на дельты, и двумя экземплярами оно
 * разъехалось бы на первом же новом контракте. Импорт серверного типа в shared невозможен —
 * форма объявлена структурно, `AspectDelta` ей удовлетворяет по построению.
 */
export interface AspectDeltaVariants {
  selectOptions?: Record<string, { add?: readonly SelectOption[] }>;
  classMap?: Record<string, readonly ClassMapEntry[]>;
}

/**
 * (контракт, слот), где свойство работает СЛОТОМ-СТАТУСОМ хоть у одного аспекта реестра.
 *
 * НОСИМОСТЬ ПРОВЕРЯЕТСЯ ЗДЕСЬ ТОЖЕ — одна истина на оба чекера (Ф-Б1-54а). `checkImplements`
 * отвергает привязку к свойству, которого аспект не несёт (`UNKNOWN_PROPERTY/not_carried`:
 * `carried` — это состав аспекта), а этот обход смотрел только на `bind` — и на одной и той же
 * строке два чекера отвечали по-разному: «карта законна» ≠ «привязка законна». Расходились они
 * ровно на строках, посеянных МИМО тулов (фикстуры, прямой сид): у встроенных и у всего, что
 * пишут тулы задачи 15, аспект носит биндуемое по построению. Молчаливое расхождение хуже
 * отказа: карта классов на такую пару принималась и уезжала в `value_map` привязки, которую
 * писатель привязок отверг бы.
 */
function statusSlotsOf(
  propertyId: string,
  reg: {
    contracts: ReadonlyMap<string, ContractDefinition>;
    aspects: ReadonlyMap<string, AspectDefinition>;
  },
): Array<{ contract: string; slot: string }> {
  const out: Array<{ contract: string; slot: string }> = [];
  const seen = new Set<string>();
  for (const aspect of reg.aspects.values()) {
    const carried = new Set(aspect.properties.map((p) => p.propertyId));
    for (const binding of aspect.implements) {
      const contract = reg.contracts.get(binding.contract);
      if (contract === undefined || contract.kind !== 'slots') continue;
      for (const [slot, bound] of Object.entries(binding.bind)) {
        if (bound !== propertyId) continue;
        // Привязка к не носимому свойству — не привязка (`checkImplements`, `not_carried`).
        if (!carried.has(propertyId)) continue;
        // Классы вешаются только на слот-статус (§Б1-1): у прочих слотов классов нет.
        if (contract.slots.find((s) => s.name === slot)?.status !== true) continue;
        const key = `${binding.contract} ${slot}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ contract: binding.contract, slot });
      }
    }
  }
  return out;
}

/**
 * Варианты, которые карта ВПРАВЕ отнести: добавляемые этой же дельтой плюс собственные варианты
 * свойства. Второе — не послабление: свой вариант владелец мог завести прошлой дельтой, а класс
 * назначить сегодня, и требовать повторного `selectOptions.add` значило бы отказ на законном жесте.
 */
function variantDomainOf(
  propertyId: string,
  delta: AspectDeltaVariants,
  reg: { properties: ReadonlyMap<string, PropertyDefinition> },
): Set<string> {
  const out = new Set<string>();
  for (const option of delta.selectOptions?.[propertyId]?.add ?? []) out.add(option.key);
  const prop = reg.properties.get(propertyId);
  for (const variant of (prop === undefined ? null : variantsOf(prop)) ?? []) {
    out.add(String(variant));
  }
  return out;
}

/**
 * ПОЛНОТА ОТНЕСЕНИЯ ВАРИАНТОВ ДЕЛЬТЫ (§Б2-2, fail-closed): вариант, добавленный дельтой к
 * свойству-слоту-статусу, принимается ТОЛЬКО вместе с отнесением к классу КАЖДОГО контракта, где
 * этот слот участвует.
 *
 * Почему «каждого контракта», а не «контракта аспекта-цели»: `selectOptions` адресует СВОЙСТВО, и
 * вариант приезжает в его тип — то есть ко всем носителям сразу. Проверка по одному аспекту
 * оставила бы запись, которую `class=` находит через один аспект и теряет через другой; поэтому
 * словарь аспектов входит в `reg`.
 *
 * Зовётся НА ЗАПИСИ (`registry/ops.ts`, `setAspectDelta`), не на чтении: `applyDeltas` fail-closed
 * на каждом чтении реестра, и отказ там запер бы владельца снаружи собственного графа после
 * пересева, изменившего контракт. Единственный зватель — `setAspectDelta`; слияние свойств
 * (`ops.ts`, `mergeProperty`) карту лишь ПЕРЕИМЕНОВЫВАЕТ прямым UPDATE и сюда не заходит, поэтому
 * строгость этой проверки перенос ключа не задевает.
 *
 * ЧТО ИМЕННО ОТВЕРГАЕТСЯ — две половины, и обе fail-closed (Ф-Б1-49):
 *  1. добавленный вариант БЕЗ класса (или с классом не из контракта) — `VARIANT_UNMAPPED`;
 *  2. отнесение, которому не к чему прицепиться, — `UNKNOWN_CONTRACT`/`UNKNOWN_SLOT`, а вариант
 *     не из области свойства — `VARIANT_UNMAPPED`/`unknown_variant`.
 * Вторая половина не «на всякий случай»: строка карты доезжает до `value_map` привязки, то есть
 * до индекса, которым живут все читатели членства.
 */
export function checkClassMap(
  delta: AspectDeltaVariants,
  aspect: AspectDefinition,
  reg: {
    properties: ReadonlyMap<string, PropertyDefinition>;
    contracts: ReadonlyMap<string, ContractDefinition>;
    aspects: ReadonlyMap<string, AspectDefinition>;
  },
): ImplementsIssue[] {
  const issues: ImplementsIssue[] = [];
  for (const [propertyId, patch] of Object.entries(delta.selectOptions ?? {})) {
    const added = patch.add ?? [];
    if (added.length === 0) continue;
    if (!reg.properties.has(propertyId)) {
      issues.push({ code: 'UNKNOWN_PROPERTY', details: { aspect: aspect.id, propertyId } });
      continue;
    }
    const entries = delta.classMap?.[propertyId] ?? [];
    for (const { contract, slot } of statusSlotsOf(propertyId, reg)) {
      const def = reg.contracts.get(contract);
      const classes = new Set(def?.kind === 'slots' ? def.classes.map((c) => c.key) : []);
      for (const option of added) {
        const hit = entries.find(
          (e) => e.contract === contract && e.slot === slot && String(e.variant) === option.key,
        );
        // Отнесение к классу, которого у контракта нет, — то же «вариант не отнесён»: фильтры
        // набора его не найдут, а владелец уверен, что назначил.
        if (hit === undefined || !classes.has(hit.class)) {
          issues.push({
            code: 'VARIANT_UNMAPPED',
            details: {
              propertyId,
              variant: option.key,
              contract,
              slot,
              ...(hit !== undefined && { class: hit.class }),
              // Тот же словарь, что у `checkImplements` (Ф-Б1-18/Ф-Б1-51): «не отнесён вовсе»
              // и «отнесён в класс, которого у контракта нет» — разные починки у владельца.
              reason: hit === undefined ? 'unmapped' : 'unknown_class',
            },
          });
        }
      }
    }
  }
  // ОТНЕСЕНИЯ, КОТОРЫМ НЕ К ЧЕМУ ПРИЦЕПИТЬСЯ. Принять их молча — это владелец, уверенный, что
  // вариант отнесён, и фильтр, который его не видит. Проверяются ВСЕ, включая карту на свойстве,
  // которое нигде не работает слотом-статусом: «инертной» такая строка не является — `applyDeltas`
  // дописывает её в `value_map` привязки, стоит свойству оказаться связанным с НЕстатусным слотом
  // (`orbis/due_date` → `orbis/when.deadline`), а это ровно форма, которую `checkImplements`
  // отвергает `reason: 'not_status'`. Разница в причине, а не в наличии отказа:
  //  - `absent`     — у контракта нет такого слота (или самого контракта);
  //  - `facts`      — контракт-словарь фактов, слотов и классов у него нет по форме;
  //  - `not_status` — слот есть, но классов у него нет (§Б1-1: классы только у слота-статуса);
  //  - `not_bound`  — слот-статус есть, но это свойство в нём не стоит ни у одного аспекта.
  for (const [propertyId, entries] of Object.entries(delta.classMap ?? {})) {
    const slots = statusSlotsOf(propertyId, reg);
    const domain = variantDomainOf(propertyId, delta, reg);
    for (const entry of entries) {
      const contract = reg.contracts.get(entry.contract);
      if (contract === undefined || contract.kind === 'facts') {
        issues.push({
          code: 'UNKNOWN_CONTRACT',
          details: {
            propertyId,
            contract: entry.contract,
            reason: contract === undefined ? 'absent' : 'facts',
          },
        });
        continue;
      }
      if (!slots.some((s) => s.contract === entry.contract && s.slot === entry.slot)) {
        const decl = contract.slots.find((s) => s.name === entry.slot);
        issues.push({
          code: 'UNKNOWN_SLOT',
          details: {
            propertyId,
            contract: entry.contract,
            slot: entry.slot,
            reason:
              decl === undefined ? 'absent' : decl.status === true ? 'not_bound' : 'not_status',
          },
        });
        continue;
      }
      // ВАРИАНТ, КОТОРОГО НЕТ. Отнести можно только то, что у свойства есть или что дельта ему
      // добавляет: опечатка в ключе (`in_reveiw`) значений не соберёт никогда, а строка уедет в
      // `value_map` и будет шуметь в индексе привязок. Тот же смысл у `unknown_variant`
      // `checkImplements`.
      if (!domain.has(String(entry.variant))) {
        issues.push({
          code: 'VARIANT_UNMAPPED',
          details: {
            propertyId,
            contract: entry.contract,
            slot: entry.slot,
            variant: entry.variant,
            reason: 'unknown_variant',
          },
        });
      }
    }
  }
  return issues;
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
  /**
   * Обязательные слоты БЕЗ константы `fixed` (§Б2-3): и связанные `bind` (значение берётся у сущности), и
   * несвязанные вовсе — у последних `bind[slot]` даст `undefined`, и потребитель обязан считать слот пустым
   * (задача 3: «слот без привязки → false»). Исключаются только слоты, закрытые `fixed` (Ф-Б1-17).
   */
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
