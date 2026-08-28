// apps/server/src/executor/props.ts
// Внутренняя модель исполнителя после реформы (§А1-1): правда сущности — плоские `props`
// по id свойства и СПИСОК `aspects[]`. Здесь живут пять вещей, и все пять чистые:
// применение патча, множество затронутых свойств, резолв адреса свойства, гейт прав записи
// (§А2-5/§Б6) и равенство значений по типу свойства (§А7-3, предусловия CAS).
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
import { canonicalJson, type PropertyDefinition, type PropertyType } from '@orbis/shared';
import { decCmp } from '../budget/decimal';
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
  /** ЯВНОЕ снятие: `unset` новой формы и `{поле: null}` старой карты — намерение автора. */
  unset?: string[];
  /**
   * Снятие, порождённое ФОРМОЙ операции, а не намерением: тул `attach_<аспект>` подменяет
   * носитель целиком, и свойство, не пришедшее в его `data`, исчезает само собой.
   *
   * Производитель у поля РОВНО ОДИН — `replaceAspectProps` ниже, и зовёт её только
   * attach-путь (`prepareAttach`). Вторым был inverse журнала, и его здесь больше нет: с
   * §А7-4 нагрузка отката говорит свойствами и называет снятие ЯВНЫМ `unset` (поле выше),
   * носителя не подменяет вовсе — переключатель семантик у `fromLegacyInput` снят вместе с
   * веткой. То есть поле живёт ради `attach_*`, а не ради отката.
   *
   * Отдельным списком, потому что это разные вещи для ПРАВ записи. «Сотри отчёт прогона» —
   * такое же распоряжение, как «запиши отчёт прогона», и гейт §А2-5 обязан его видеть.
   * А «навесь на транзакцию аспект финансов» распоряжением о `orbis/bank_txn_id` не
   * является вовсе: автор о нём НЕ ГОВОРИЛ — поле просто отсутствует в его `data`.
   * (Сказать он его, к слову, может: схема `attach_*`-тула генерируется из ЭФФЕКТИВНОГО
   * НАБОРА аспекта (§А9-1), и служебные свойства в нём есть — вывод их из `attach_*` по
   * §А2-5 остаётся за реестром прав, а не за формой тула. Но названное поле доходит до
   * гейта и получает честный `COMPUTED_WRITE`; здесь речь ровно о НЕназванном.)
   * Слив их в один список, гейт либо пропускал бы стирание служебного значения, либо
   * отказывал бы в законном `attach_orbis_financial` на записи из выписки.
   */
  replaced?: string[];
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
 *  - снятие (`unset`/`replaced`) побеждает `set` на одном и том же свойстве. Такой патч
 *    противоречив по построению (см. отказ В1 в `legacyPatchToProps` — там противоречие
 *    ловится раньше и громче), и здесь важно не «что правильнее», а что исход ОДИН и тот же
 *    при любом порядке ключей во входе.
 *
 * `attach` применяется ПОСЛЕ `detach` по той же причине: `{attach:[X], detach:[X]}` обязан
 * иметь один исход, а не зависеть от порядка обхода.
 */
export function applyPropsPatch(cur: EntityState, patch: PropsPatch): EntityState {
  const props = { ...cur.props };
  for (const [propertyId, value] of Object.entries(patch.set ?? {})) {
    props[propertyId] = value;
  }
  for (const propertyId of [...(patch.unset ?? []), ...(patch.replaced ?? [])]) {
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
 * Правка состояния в форме журнала (§А7-4): что изменилось между двумя состояниями.
 *
 * Ровно та форма, которую принимает вход исполнителя (`entityPropsPatch`), — и это не
 * совпадение: полезная нагрузка журнала обязана оставаться ИСПОЛНИМОЙ, потому что
 * `applyUndo` (undo.ts) строит из inverse туловый вызов и гонит его тем же конвейером.
 */
export interface StateDelta {
  props?: Record<string, unknown>;
  unset?: string[];
  aspects?: { attach?: string[]; detach?: string[] };
}

/**
 * Дельта двух состояний — единица журнала и единица отката (§А7-4).
 *
 * Считается по СОСТОЯНИЯМ, а не по патчу, и это существенно. Патч — то, что попросил автор;
 * состояние «после» — то, что записано, и между ними стоят доменные нормализации, пишущие
 * мимо патча: `applyTaskCompletion` дописывает `orbis/completed_at`, `dropStaleCarryover`
 * снимает перенос, подстановка умолчания валюты кладёт `orbis/currency`. Inverse, собранный
 * из патча, этих свойств не нёс бы — и откат оставлял бы в графе то, чего до операции не
 * было. Отсюда же обратимость «байт-в-байт» (§С7-13) получается по построению: inverse —
 * это `stateDelta(после, до)`, зеркало прямой дельты, а не второй, независимо написанный
 * расчёт, который разошёлся бы с ней при первой же правке.
 *
 * Сравнение значений — по КАНОНУ, а не по ссылке: `props` перекладываются между объектами
 * на каждом слиянии, и «другой объект с теми же полями» изменением не является — попади он
 * в дельту, журнал распухал бы записями «поменяли на то же самое», а `entityUpdatePreviewDiff`
 * показывал бы владельцу правку, которой не было. Канон здесь дешёвый и тотальный
 * (`canonicalJson`), а не сравнение по типу свойства (`comparePropertyValue`): последнее
 * отвечает на вопрос предусловий «то же ли это ЗНАЧЕНИЕ по правилам типа» и, например,
 * объявило бы `"10.0"` и `"10.00"` одним и тем же — для CAS это верно, а для журнала было
 * бы потерей факта: в колонку легло не то, что лежало.
 *
 * Списки отсортированы, а пустые части опущены: запись журнала сравнивается побайтно
 * (пины формы, containment-пробы), и порядок, зависящий от обхода патча, делал бы её
 * невоспроизводимой.
 */
export function stateDelta(from: EntityState, to: EntityState): StateDelta {
  const props: Record<string, unknown> = {};
  for (const [propertyId, value] of Object.entries(to.props)) {
    if (
      Object.hasOwn(from.props, propertyId) &&
      canonicalJson(from.props[propertyId]) === canonicalJson(value)
    ) {
      continue;
    }
    props[propertyId] = value;
  }
  const unset = Object.keys(from.props)
    .filter((propertyId) => !Object.hasOwn(to.props, propertyId))
    .sort();

  const had = new Set(from.aspects);
  const has = new Set(to.aspects);
  const attach = to.aspects.filter((id) => !had.has(id)).sort();
  const detach = from.aspects.filter((id) => !has.has(id)).sort();

  const delta: StateDelta = {};
  if (Object.keys(props).length > 0) delta.props = props;
  if (unset.length > 0) delta.unset = unset;
  if (attach.length > 0 || detach.length > 0) {
    delta.aspects = {
      ...(attach.length > 0 && { attach }),
      ...(detach.length > 0 && { detach }),
    };
  }
  return delta;
}

/**
 * Свойства, которых патч КАСАЕТСЯ: и записанные, и снятые. По ним считается, какие аспекты
 * затронуты — вход доменных проверок и запрета по объекту (V1.10), которым по-прежнему
 * нужен АСПЕКТ («тронул ли патч прогон», «появился ли конверт»). Единица журнала и отката
 * с §А7-4 — свойство, и считает её `stateDelta` выше, по состояниям, а не по патчу.
 * Снятие считается наравне с записью: патч, стирающий поле, трогает аспект ровно так же,
 * как патч, его пишущий.
 */
export function touchedProperties(patch: PropsPatch): Set<string> {
  const touched = new Set<string>(Object.keys(patch.set ?? {}));
  for (const propertyId of [...(patch.unset ?? []), ...(patch.replaced ?? [])]) {
    touched.add(propertyId);
  }
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
 * Патч тула `attach_<аспект>` (§А9-1): значения из `data` плюс СНЯТИЕ всего, что аспект
 * объявляет, а вызывающий не назвал.
 *
 * «Не назвал — значит снять» и есть смысл операции: attach ставит носитель ЦЕЛИКОМ. В
 * старой карте это выходило само собой (ключ аспекта подменялся), в плоской модели снятие
 * приходится назвать явно — и оно едет в `replaced`, а не в `unset`, потому что порождено
 * ФОРМОЙ операции, а не намерением автора (разбор — в докблоке `PropsPatch`).
 *
 * НЕ снимаются свойства, объявленные ДРУГИМ аспектом, который на записи остаётся: слитое
 * свойство (В1: `orbis/finance_category` носят и финансы, и бюджет) принадлежит обоим, и
 * снять его вместе с одним носителем значило бы стереть данные второго.
 *
 * Ключи `data` — `key` свойства или его id: резолв один и тот же на всех границах входа
 * (`resolvePropertyRef`). Неизвестный адрес уезжает КАК ПРИШЁЛ — отказ по свойству называет
 * валидатор записи (`UNKNOWN_PROPERTY`), и подменять здесь имя значило бы прятать опечатку.
 */
export function replaceAspectProps(
  reg: RegistrySnapshot,
  cur: EntityState,
  aspectId: string,
  data: Record<string, unknown>,
): PropsPatch {
  const set: Record<string, unknown> = {};
  for (const [keyOrId, value] of Object.entries(data)) {
    set[resolvePropertyRef(reg, keyOrId)?.id ?? keyOrId] = value;
  }
  const remaining = new Set([...cur.aspects, aspectId]);
  const replaced: string[] = [];
  for (const ref of reg.aspects.get(aspectId)?.properties ?? []) {
    if (Object.hasOwn(set, ref.propertyId)) continue;
    const sharedWithOther = [...remaining].some(
      (other) =>
        other !== aspectId &&
        (reg.aspects.get(other)?.properties ?? []).some((r) => r.propertyId === ref.propertyId),
    );
    if (sharedWithOther) continue;
    replaced.push(ref.propertyId);
  }
  return { set, unset: [], replaced, attach: [aspectId], detach: [] };
}

/**
 * Аспекты-НОСИТЕЛИ свойства: кто его объявляет (§А3-1). Пусто — свойство свободное (§А1-2).
 *
 * ОДНА функция на всех серверных потребителей: каталог свойств (`usage.aspects`) и запрет
 * по объекту в предложении рутины (аспект, названный не именем, а своим полем). Второй
 * обход тех же ссылок разошёлся бы с первым молча — ровно тот класс, из-за которого список
 * служебных аспектов до реформы лежал в трёх копиях (inv §3).
 *
 * Порядок — `rank` аспекта: снимок собран запросом с `ORDER BY owner_id`, то есть порядок
 * строк БД внутри половины реестра не гарантирован, и выдача плавала бы между вызовами.
 */
export function carrierAspects(reg: RegistrySnapshot, propertyId: string): string[] {
  return [...reg.aspects.values()]
    .filter((a) => a.properties.some((r) => r.propertyId === propertyId))
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key))
    .map((a) => a.id);
}

/**
 * Расстояние Левенштейна с потолком: за `cap` не считаем — результат всё равно не подойдёт,
 * а без потолка обход всех ключей реестра стоил бы квадрата на каждой опечатке.
 */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      row.push(value);
      if (value < best) best = value;
    }
    if (best > cap) return cap + 1; // вся строка уже дальше потолка — дальше не считаем
    prev = row;
  }
  return prev[b.length] as number;
}

/**
 * Ближайший по написанию `key` реестра — подсказка к отказу «такого свойства нет» (§А9-1).
 *
 * Зачем она вообще. Модель адресует свойство ИМЕНЕМ, и её типичная ошибка — не выдумка, а
 * промах на символ (`orbis/amout`, `orbis/task_state`). Отказ, который повторяет ей её же
 * опечатку, самокоррекции не даёт: следующий вызов будет с тем же именем.
 *
 * Потолок расстояния — четверть длины и не меньше единицы. Он и есть граница между
 * «опечатка» и «другое слово»: без потолка на `user/сон` нашёлся бы `orbis/amount`, и
 * подсказка уводила бы в сторону увереннее, чем молчание. Из равных побеждает первый в
 * ПОРЯДКЕ РЕЕСТРА (rank объявления) — иначе подсказка плавала бы между вызовами.
 */
export function nearestPropertyKey(reg: RegistrySnapshot, keyOrId: string): string | undefined {
  const cap = Math.max(1, Math.floor(keyOrId.length / 4));
  let best: { key: string; distance: number } | undefined;
  for (const def of reg.properties.values()) {
    const distance = editDistance(keyOrId.toLowerCase(), def.key.toLowerCase(), cap);
    if (distance > cap) continue;
    if (best === undefined || distance < best.distance) best = { key: def.key, distance };
  }
  return best?.key;
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

/** Причина отказа, если механизму нельзя трогать это свойство; `undefined` — можно. */
function writeDenial(
  def: PropertyDefinition,
  mechanism: MutationMechanism,
): 'model_writable' | 'system_writable' | undefined {
  if (def.flags.model_writable === false && !COMPUTED_WRITE_MECHANISMS.has(mechanism)) {
    return 'model_writable';
  }
  if (def.flags.system_writable === true && !SYSTEM_WRITABLE_MECHANISMS.has(mechanism)) {
    return 'system_writable';
  }
  return undefined;
}

/**
 * Гейт прав записи (§А2-5/§Б6): вправе ли ЭТОТ механизм РАСПОРЯЖАТЬСЯ значениями этих
 * свойств — и ставить, и снимать.
 *
 * Снятие проверяется наравне с записью, и это не педантизм: «сотри отчёт прогона» — такое же
 * распоряжение служебным значением, как «запиши отчёт прогона», и гейт, слепой к нему,
 * закрывал бы дверь, оставив окно (проверено пробой: `unset` и `{поле: null}` от лица `user`
 * стирали `orbis/run_report` и `orbis/current_value`).
 *
 * Не проверяется РОВНО ОДНО — снятие, порождённое заменой носителя (`patch.replaced`): оно
 * не распоряжение автора, а форма операции `attach_<аспект>` (единственного, кто это поле
 * порождает). Их разводит уже граница входа (см. `PropsPatch.replaced`), а сами такие снятия
 * отсекает `writableOnly` ниже, чтобы замена носителя не стирала того, что автор и записать
 * бы не смог.
 *
 * Откат в этом исключении НЕ участвует: с §А7-4 inverse снимает свойства явным `unset`, то
 * есть проходит цикл ниже наравне с любым другим входом, — а не спрашивают его вовсе потому,
 * что внутренний режим undo пропускает весь гейт целиком (см. `InternalUndoMode`).
 *
 * Неизвестное свойство здесь пропускается молча: его отказ — дело валидатора
 * (`UNKNOWN_PROPERTY`), и два разных кода на одну опечатку читались бы как два разных правила.
 */
export function assertPropsWritable(
  reg: RegistrySnapshot,
  mechanism: MutationMechanism,
  patch: PropsPatch,
): void {
  for (const propertyId of [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])]) {
    const def = reg.properties.get(propertyId);
    if (def === undefined) continue;
    const denial = writeDenial(def, mechanism);
    if (denial === 'model_writable') {
      throw new ExecError(
        'COMPUTED_WRITE',
        `свойство «${propertyId}» вычисляется сервером — распоряжаться им нельзя (§А2-5)`,
        { property: propertyId, mechanism, reason: 'model_writable' },
      );
    }
    if (denial === 'system_writable') {
      throw new ExecError(
        'COMPUTED_WRITE',
        `свойство «${propertyId}» пишет только сервер — механизму «${mechanism}» распоряжаться им запрещено (§А2-5)`,
        { property: propertyId, mechanism, reason: 'system_writable' },
      );
    }
  }
}

/**
 * Из снятий, порождённых заменой носителя, оставить те, которыми механизм вправе
 * распоряжаться.
 *
 * Правило: замена носителя снимает ровно то, что вызывающий вправе был бы и записать.
 * `attach_orbis_financial` на транзакции из выписки НЕ НАЗЫВАЕТ `orbis/bank_txn_id` (его нет
 * в `data`), и молча стирать импортное тождество из-за навешивания аспекта означало бы
 * терять факт владельца там, где он ни о чём таком не просил. Отказывать тоже нельзя: автор
 * не сделал ничего запретного. Назови он поле явно — дошло бы до гейта и получило
 * `COMPUTED_WRITE`; фильтр здесь только про НЕназванное.
 *
 * НЕ применяется во внутреннем режиме undo: тот восстанавливает зафиксированное состояние
 * дословно, и «сохранить лишнее» там было бы не бережностью, а расхождением с журналом.
 */
export function writableOnly(
  reg: RegistrySnapshot,
  mechanism: MutationMechanism,
  propertyIds: readonly string[] | undefined,
): string[] {
  return (propertyIds ?? []).filter((propertyId) => {
    const def = reg.properties.get(propertyId);
    return def === undefined || writeDenial(def, mechanism) === undefined;
  });
}

/**
 * Одно скалярное значение по правилам ТИПА свойства (§А7-3). Внутренность
 * `comparePropertyValue`; список (`cardinality: 'many'`) разбирает она сама.
 */
function compareScalar(type: PropertyType, a: unknown, b: unknown): boolean {
  if (type.kind === 'decimal') {
    // Деньги сравниваются ЧИСЛЕННО: `"10.0"` и `"10.00"` — одна и та же сумма, а
    // `JSON.stringify` объявлял их разными и ронял предусловие на пустом месте (inv §6 п.7).
    // Не-строка и мусор в строке — `false`, а не бросок: сравнение обязано быть тотальным,
    // потому что оно стоит на пути записи, и отказ здесь означал бы 500 вместо CONFLICT.
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    try {
      return decCmp(a, b) === 0;
    } catch {
      // fail-closed: невыразимое число не совпадает ни с чем, включая само себя
      return false;
    }
  }
  if (type.kind === 'json') {
    // Значение — объект или массив, и `===` сравнивал бы ССЫЛКИ. Канон, а не голый
    // `JSON.stringify`: jsonb не хранит порядок ключей, и прочитанное из базы значение
    // иначе не совпадало бы с собой же, собранным в JS (см. `orbis/run_proposal`).
    return canonicalJson(a) === canonicalJson(b);
  }
  if (type.kind === 'date' || type.kind === 'timestamp') {
    // Одна и та же отметка времени записывается разными строками (`…T10:00:00Z` и
    // `…T10:00:00.000Z`) — разными их считает только текстовое сравнение. Нормализуем обе
    // стороны; неразбираемая строка остаётся собой, и тогда работает строгое равенство.
    return normalizeIso(a) === normalizeIso(b);
  }
  return a === b;
}

/** ISO-строка в канонической форме; всё, что не разобралось, возвращается как есть. */
function normalizeIso(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toISOString();
}

/**
 * Равенство значений свойства ПО ЕГО ТИПУ (§А7-3) — единственное правило сравнения в
 * предусловиях CAS.
 *
 * До реформы сравнение шло по `JSON.stringify` обеих сторон, и это врало сразу в двух
 * местах: сумма `"10.0"` не совпадала с той же суммой `"10.00"` (у денег форма записи не
 * значение), а объект, прочитанный из jsonb, не совпадал с собой же, собранным в JS
 * (PostgreSQL не хранит порядок ключей). Оба случая давали не отказ валидации, а
 * ЛОЖНЫЙ CONFLICT — «кто-то опередил» там, где не опередил никто.
 *
 * Список (`cardinality: 'many'`) сравнивается ПОЭЛЕМЕНТНО и по порядку: у списка скаляров
 * порядок — часть значения (`orbis/routine_days`, `orbis/allowed_tools`), и объявить
 * перестановку тем же значением значило бы разрешить правку поверх чужой перестановки.
 * Длина сверяется первой — иначе `['a']` совпадал бы с началом `['a','b']`.
 *
 * Тотальна по построению: любая пара значений даёт `true` либо `false`. Бросок отсюда стал
 * бы 500 на пути записи там, где домен ждёт честный CONFLICT.
 */
export function comparePropertyValue(type: PropertyType, a: unknown, b: unknown): boolean {
  const many = 'cardinality' in type && (type as { cardinality?: string }).cardinality === 'many';
  if (!many) return compareScalar(type, a, b);
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((item, index) => compareScalar(type, item, b[index]));
}
