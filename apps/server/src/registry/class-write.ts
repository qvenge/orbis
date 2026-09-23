// apps/server/src/registry/class-write.ts
// ЗАПИСЬ КЛАССОМ (Р-И-39, решение владельца 20.09). Код знает КЛАССЫ контракта; какой вариант свойства
// им соответствует, решает привязка аспекта — строка реестра в базе. Литерал значения в коде требует
// коммита и выкатки, а значение меняется данными, и между «состоянием, о котором думает код» и
// «значением, которое лежит в базе» остаётся ровно одна точка перевода — эта.
import {
  type BindingIndex,
  bindingIndexOf,
  entityClassOf,
  propertyOfSlot,
  variantOfClass,
} from '@orbis/shared';
import type { RegistrySnapshot } from './load';

/** Имя слота-статуса — норматив §Б1-1: классы вешаются на него и только на него. */
const STATUS_SLOT = 'status';

/**
 * Индекс привязок — МЕМО ПО СНИМКУ (образец и довод — `bindingsOf` в `subscriptions/budget.ts`):
 * очередь исполнителя спрашивает класс на каждый тикет, а `bindingIndexOf` пересобирает индекс с
 * нуля. Ключ — сам снимок: `effectiveRegistry` отдаёт кешированный объект, новая версия реестра —
 * новый объект.
 *
 * Своя копия, а не импорт `bindingsOf` (им уже пользуются `rules/engine.ts` и
 * `executor/relations.ts`): помощник слоя реестра, импортируя движок ведомостей, тянул бы в глаголы
 * исполнителя весь бюджет ради одной `WeakMap`. Копий этого мемо теперь ЧЕТЫРЕ — shared
 * `registry/row.ts` (`INDEX_BY_REGISTRY`), `subscriptions/budget.ts` (`bindingsOf`), `expr/eval.ts`
 * (`INDEX_BY_REG`) и эта; сведение в одну — именованный остаток для задачи 18.
 */
const INDEX_BY_SNAPSHOT = new WeakMap<object, BindingIndex>();
export function bindingsOfSnapshot(reg: RegistrySnapshot): BindingIndex {
  const cached = INDEX_BY_SNAPSHOT.get(reg);
  if (cached !== undefined) return cached;
  const built = bindingIndexOf({ aspects: reg.aspects, contracts: reg.contracts });
  INDEX_BY_SNAPSHOT.set(reg, built);
  return built;
}

/**
 * Класс записи под контрактом (§Б2-2) — обёртка над `entityClassOf` ради ОДНОГО ответа на «в каком
 * порядке перебирать аспекты»: ранг берётся из того же снимка, и три потребителя не повторяют его
 * каждый по-своему. `null` — контракт не реализован либо значение ни одному классу не отнесено: это
 * ОТСУТСТВИЕ (§Б2-3), а не отказ.
 */
export function classOfEntity(
  reg: RegistrySnapshot,
  entity: { aspects: readonly string[]; props: Record<string, unknown> },
  contract: string,
): string | null {
  return entityClassOf(
    bindingsOfSnapshot(reg),
    entity,
    contract,
    (aspectId) => reg.aspects.get(aspectId)?.rank ?? Number.MAX_SAFE_INTEGER,
  );
}

/**
 * Патч «поставь класс» — `{ свойство слота-статуса: единственный вариант класса }`. Ровно одна пара:
 * слот-статус у контракта один, и патч не вправе трогать соседние свойства — иначе «перевести тикет в
 * ожидание» молча переписывало бы и «чего ждём».
 */
export function statusPatch(
  reg: RegistrySnapshot,
  aspectId: string,
  contract: string,
  cls: string,
): Record<string, string | boolean> {
  const idx = bindingsOfSnapshot(reg);
  return {
    [propertyOfSlot(idx, aspectId, contract, STATUS_SLOT)]: variantOfClass(
      idx,
      aspectId,
      contract,
      cls,
    ),
  };
}

/**
 * CAS-предусловие «запись всё ещё в одном из этих классов» в форме, которую понимает executor
 * (`entityUpdatePreconditionItem`): пункт по ЗНАЧЕНИЮ, а не по классу, — executor сравнивает `props`
 * под замком строки и о контрактах не знает. Перевод классов в значения происходит здесь, на сборке
 * операции, и в этом весь смысл: предусловие остаётся точным и после переименования варианта.
 */
export function classPrecondition(
  reg: RegistrySnapshot,
  aspectId: string,
  contract: string,
  classes: readonly string[],
): { property: string; in: (string | boolean)[] } {
  const idx = bindingsOfSnapshot(reg);
  return {
    property: propertyOfSlot(idx, aspectId, contract, STATUS_SLOT),
    in: classes.map((cls) => variantOfClass(idx, aspectId, contract, cls)),
  };
}
