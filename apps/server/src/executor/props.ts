// apps/server/src/executor/props.ts
// Внутренняя модель исполнителя после реформы (§А1-1): правда сущности — плоские `props`
// по id свойства и СПИСОК `aspects[]`. Здесь живут четыре вещи, и все четыре чистые:
// применение патча, множество затронутых свойств, резолв адреса свойства и гейт прав записи
// (§А2-5/§Б6).
//
// Почему отдельный файл, а не функции в executor.ts: слияние состояния — то место, где
// реформа меняет СМЫСЛ операции, и его обязано быть видно без базы. `mergeAspects`
// (normalize.ts) жил ровно так же и ровно поэтому проверялся дёшево; наследник обязан
// сохранить это свойство.
//
// Гейт прав ЗДЕСЬ, а не в валидаторе значений (`registry/validate-props.ts`), намеренно:
// валидатор отвечает на вопрос «годится ли значение», а флаги — на вопрос «вправе ли ЭТОТ
// источник его записать». Смешать их значило бы поселить право в двух домах (см. докблок
// `validateEntityProps`).
import type { PropertyDefinition } from '@orbis/shared';
import type { RegistrySnapshot } from '../registry/load';
import { ExecError } from './errors';
import type { MutationMechanism } from './types';

/** Состояние сущности в новой форме: значения по id свойства + список интерпретаций. */
export interface EntityState {
  props: Record<string, unknown>;
  aspects: string[];
}

/**
 * Патч состояния — уже РАЗРЕШЁННЫЙ: ключи `set`/`unset` это id свойств, элементы
 * `attach`/`detach` — id аспектов. Резолв имён (key ↔ id, старая карта → свойства) делает
 * граница входа (`legacy-form.ts`), чтобы внутрь конвейера попадала одна форма.
 */
export type PropsPatch = {
  set?: Record<string, unknown>;
  unset?: string[];
  attach?: string[];
  detach?: string[];
};

/**
 * Применение патча к состоянию. Чистая функция: возвращает НОВОЕ состояние, вход не мутирует
 * (в batch то же самое состояние читают проверки следующих операций).
 *
 * Два правила, каждое — норматив, а не удобство реализации:
 *  - `detach` аспекта НЕ снимает значения свойств (Р9). Аспект — интерпретация, а не
 *    владелец поля: снятие «это транзакция» не делает сумму неправдой. Снимает значение
 *    только явный `unset`;
 *  - `unset` побеждает `set` на одном и том же свойстве. Такой патч противоречив по
 *    построению (см. отказ В1 в `legacyPatchToProps` — там противоречие ловится раньше и
 *    громче), и здесь важно не «что правильнее», а что исход ОДИН и тот же при любом порядке
 *    ключей во входе.
 *
 * `attach` применяется ПОСЛЕ `detach` по той же причине: `{attach:[X], detach:[X]}` обязан
 * иметь один исход, а не зависеть от порядка обхода.
 */
export function applyPropsPatch(cur: EntityState, patch: PropsPatch): EntityState {
  const props = { ...cur.props };
  for (const [propertyId, value] of Object.entries(patch.set ?? {})) {
    props[propertyId] = value;
  }
  for (const propertyId of patch.unset ?? []) {
    delete props[propertyId];
  }

  const detached = new Set(patch.detach ?? []);
  const aspects = cur.aspects.filter((id) => !detached.has(id));
  for (const aspectId of patch.attach ?? []) {
    if (!aspects.includes(aspectId)) aspects.push(aspectId);
  }
  return { props, aspects };
}

/**
 * Свойства, которых патч КАСАЕТСЯ: и записанные, и снятые. По ним считается, какие аспекты
 * затронуты (единица журнала и инвариантов в срезе А — по-прежнему аспект-ключ, §А7-4
 * переводит её в Задаче 6), поэтому снятие обязано считаться наравне с записью: патч,
 * стирающий поле, трогает аспект ровно так же, как патч, его пишущий.
 */
export function touchedProperties(patch: PropsPatch): Set<string> {
  const touched = new Set<string>(Object.keys(patch.set ?? {}));
  for (const propertyId of patch.unset ?? []) touched.add(propertyId);
  return touched;
}

/**
 * Аспекты, затронутые патчем: навешенные, снятые и все те, что ОБЪЯВЛЯЮТ хоть одно
 * затронутое свойство — и в состоянии до, и в состоянии после.
 *
 * Последнее — не перестраховка, а прямое следствие слияния свойств (В1): `orbis/финансы` и
 * `orbis/бюджет` делят `orbis/finance_category`, и правка категории у транзакции меняет
 * старую карту ОБОИХ аспектов. Считай мы затронутым только тот аспект, через который правка
 * пришла, — проекция в `aspects_legacy` разъехалась бы с журналом, и undo вернул бы половину.
 */
export function touchedAspects(
  reg: RegistrySnapshot,
  before: EntityState,
  after: EntityState,
  patch: PropsPatch,
): string[] {
  const touchedProps = touchedProperties(patch);
  const out = new Set<string>([...(patch.attach ?? []), ...(patch.detach ?? [])]);
  for (const aspectId of new Set([...before.aspects, ...after.aspects])) {
    const refs = reg.aspects.get(aspectId)?.properties ?? [];
    if (refs.some((ref) => touchedProps.has(ref.propertyId))) out.add(aspectId);
  }
  return [...out];
}

/**
 * Адрес свойства во входе: сначала `key` среди системных ∪ своих, затем id.
 *
 * Порядок именно такой, потому что писать владелец будет ИМЕНЕМ («user/часы-сна» — то, что
 * он сам и завёл), а внутренние пути — id. У встроенных свойств id и key совпадают, поэтому
 * разница видна только на своих: там своя строка обязана перекрывать системную с тем же
 * ключом — ровно как это делает `loadRegistry` при коллизии id.
 *
 * Обход линейный и без кеша: снимок реестра живёт одну транзакцию, а ключей в патче единицы.
 * Кеш здесь стоил бы инвалидации на каждой правке реестра — цена больше пользы.
 */
export function resolvePropertyRef(
  reg: RegistrySnapshot,
  keyOrId: string,
): PropertyDefinition | undefined {
  let byKey: PropertyDefinition | undefined;
  for (const def of reg.properties.values()) {
    if (def.key !== keyOrId) continue;
    // Своя строка перекрывает системную: builtin приходит первым (ORDER BY owner_id
    // NULLS FIRST), поэтому заменяем только его.
    if (byKey === undefined || (byKey.ownerId === null && def.ownerId !== null)) byKey = def;
  }
  return byKey ?? reg.properties.get(keyOrId);
}

/**
 * Механизмы, которым разрешена запись свойства с `system_writable: true` (§А2-5, перечень
 * §А4-4). Гейт определён против ИСТОЧНИКА, а не против актора (В3 ревью): `carryover` пишет
 * правило rollover, `bank_txn_id` — импорт, свойства прогона — глаголы исполнителя, и всем
 * троим за спиной стоит тот же владелец, что сидит в чате.
 */
const SYSTEM_WRITABLE_MECHANISMS: ReadonlySet<MutationMechanism> = new Set<MutationMechanism>([
  'hook',
  'rule',
  'materialize',
  'seed',
  'action-seed',
  'verb',
  'import',
]);

/**
 * Механизмы, которым разрешена запись свойства с `model_writable: false`. Это КЭШ вычисления
 * (правило 3 §10): его пересчитывает правило каталога либо материализация, и больше никто —
 * ни тул, ни UI, ни MCP, ни серверный глагол.
 */
const COMPUTED_WRITE_MECHANISMS: ReadonlySet<MutationMechanism> = new Set<MutationMechanism>([
  'rule',
  'materialize',
]);

/**
 * Гейт прав записи (§А2-5/§Б6): вправе ли ЭТОТ механизм ставить значения этих свойств.
 *
 * Проверяются только ЗАПИСИ значений (`set`), не снятия. Причина не в снисходительности к
 * снятию, а в форме `attach_<аспект>`: он заменяет носитель ЦЕЛИКОМ, то есть в патче у него
 * `unset` на каждое не переданное свойство аспекта. Гейт по `unset` отказывал бы владельцу в
 * законном `attach_orbis_financial` на транзакции, приехавшей из выписки (у неё есть
 * `orbis/bank_txn_id`, а во входе тула его нет и быть не может). Снятие служебного значения
 * пользовательским путём остаётся возможным ровно как сегодня — это НЕ регресс, но и не
 * закрытая дыра; её закрывает единица отката «свойство» (§А7-4, Задача 6), где снятие
 * перестаёт быть побочным эффектом замены ключа.
 *
 * Неизвестное свойство здесь пропускается молча: его отказ — дело валидатора
 * (`UNKNOWN_PROPERTY`), и два разных кода на одну опечатку читались бы как два разных правила.
 */
export function assertPropsWritable(
  reg: RegistrySnapshot,
  mechanism: MutationMechanism,
  patch: PropsPatch,
): void {
  for (const propertyId of Object.keys(patch.set ?? {})) {
    const def = reg.properties.get(propertyId);
    if (def === undefined) continue;
    if (def.flags.model_writable === false && !COMPUTED_WRITE_MECHANISMS.has(mechanism)) {
      throw new ExecError(
        'COMPUTED_WRITE',
        `свойство «${propertyId}» вычисляется сервером — записывать его нельзя (§А2-5)`,
        { property: propertyId, mechanism, reason: 'model_writable' },
      );
    }
    if (def.flags.system_writable === true && !SYSTEM_WRITABLE_MECHANISMS.has(mechanism)) {
      throw new ExecError(
        'COMPUTED_WRITE',
        `свойство «${propertyId}» пишет только сервер — механизму «${mechanism}» запись запрещена (§А2-5)`,
        { property: propertyId, mechanism, reason: 'system_writable' },
      );
    }
  }
}
