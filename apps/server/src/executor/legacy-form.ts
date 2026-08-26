// apps/server/src/executor/legacy-form.ts
//
// ПЕРЕХОДНЫЙ модуль; удаляется задачей «Пересев мира».
//
// Реформа разводит правду и её старую запись: правда сущности — плоские `props` по id
// свойства и список `aspects[]` (§А1-1), правда ребра — роль (§А4-3). Старые носители —
// карта `aspects_legacy` и колонка `relations.relation_type` — до contract-миграции живут
// рядом и заполняются ПРОЕКЦИЕЙ отсюда. Один модуль, а не «где как удобнее», ровно потому,
// что проекция обязана быть одна: два независимых перевода разъехались бы молча, и разницу
// увидели бы не тесты, а владелец в своих данных.
//
// Приёмка окончания реформы механическая: ноль импортов этого файла и ноль совпадений
// греп-гейта старой формы (`bun scripts/check-legacy-form.ts --gate`). Поэтому здесь нет
// ни кеша, ни обобщений — у кода есть дата смерти.
//
// Таблицы соответствий «поле старого аспекта ↔ свойство» здесь НЕТ: она одна на репозиторий
// и живёт в `@orbis/shared` (`registry/legacy-field-map.ts`), откуда её читает и golden
// приёмки валидатора. Вторая копия означала бы два перевода одного и того же.
import {
  type LegacyAspects,
  legacyAspectsToProps,
  legacyFieldToProperty,
  propertyToLegacyField,
  type RelationRoleId,
  translateLegacyValue,
  untranslateLegacyValue,
} from '@orbis/shared';
import type { RegistrySnapshot } from '../registry/load';
import { ExecError } from './errors';
import { type EntityState, type PropsPatch, resolvePropertyRef } from './props';

/** Значения сегодняшней колонки `relations.relation_type` плюс `ref` (её v1 ещё не знает). */
export type LegacyRelationType = 'parent' | 'blocks' | 'related_to' | 'derived_from' | 'ref';

/**
 * Одиннадцать ролей §А4-3 → четыре сегодняшних типа ребра.
 *
 * Проекция СХЛОПЫВАЮЩАЯ и невосстановимая: пять ролей отображаются в один `parent`, три —
 * в `related_to`. Это и есть причина реформы (сегодня «тикет проекта», «прогон» и «часть
 * внутри целого» различают догадкой по аспектам концов), и это же причина, по которой
 * обратной функции здесь нет и не будет.
 *
 * `satisfies Record<RelationRoleId, …>` — не украшение: одиннадцатая роль, добавленная в
 * реестр без строки здесь, обязана валить сборку, а не получать молчаливый `parent`.
 */
const RELATION_TYPE_BY_ROLE = {
  subitem: 'parent',
  ticket: 'parent',
  run: 'parent',
  'envelope-binding': 'parent',
  'category-parent': 'parent',
  dependency: 'blocks',
  mention: 'related_to',
  'instance-of': 'derived_from',
  ref: 'ref',
  'alternative-of': 'related_to',
  supersedes: 'related_to',
} as const satisfies Record<RelationRoleId, LegacyRelationType>;

/**
 * Роль ребра → значение старой колонки. ТОТАЛЬНА на встроенных ролях.
 *
 * Аргумент `string`, а не `RelationRoleId`, потому что роль приезжает из БД и из
 * пользовательского ввода, где её никто не сузил. Неизвестная роль — ОТКАЗ, а не `parent`
 * по умолчанию: молчаливая подстановка записала бы в граф ребро с чужим смыслом, и
 * обнаружилось бы это уже после «Пересева мира», когда старая колонка исчезнет и разбирать
 * будет нечего.
 */
export function projectLegacyRelationType(role: string): LegacyRelationType {
  const type = (RELATION_TYPE_BY_ROLE as Record<string, LegacyRelationType | undefined>)[role];
  if (type === undefined) {
    throw new Error(`projectLegacyRelationType: у роли «${role}» нет проекции в relation_type`);
  }
  return type;
}

/**
 * Новая правда сущности → старая карта `{id аспекта: {поле: значение}}`.
 *
 * Обход идёт по АСПЕКТАМ сущности, а не по её свойствам: старая карта раскладывала значение
 * по носителю, и без списка свойств аспекта (реестр) плоское `props` в неё не разложить.
 * Отсюда же два умолчания, каждое — норматив, а не упрощение:
 *   • свойство, которого нет в переходной таблице §А8 (любое свойство кастомного аспекта,
 *     любое заведённое уже по-новому), в карту НЕ попадает — придуманное имя поля было бы
 *     полем, которого старая форма никогда не знала;
 *   • свойство, не объявленное ни одним из аспектов сущности, в карту тоже не попадает —
 *     в старой форме у него не было места по построению.
 * Аспект без единого перенесённого значения остаётся в карте ПУСТЫМ ключом: «аспект
 * приложен» — это факт, и в старой форме он выражался именно наличием ключа.
 */
export function projectLegacyAspects(
  reg: RegistrySnapshot,
  state: { props: Record<string, unknown>; aspects: string[] },
): LegacyAspects {
  const out: LegacyAspects = {};
  for (const aspectId of state.aspects) {
    const fields: Record<string, unknown> = {};
    for (const ref of reg.aspects.get(aspectId)?.properties ?? []) {
      if (!Object.hasOwn(state.props, ref.propertyId)) continue;
      fields[legacyFieldOfProperty(reg, aspectId, ref.propertyId)] = untranslateLegacyValue(
        ref.propertyId,
        state.props[ref.propertyId],
      );
    }
    out[aspectId] = fields;
  }
  return out;
}

/**
 * Имя поля, под которым свойство лежало в старой карте.
 *
 * Две ветки, и вторая — не догадка. Встроенные пары даёт переходная таблица §А8. У СВОЕГО
 * свойства владельца строки в ней нет и быть не может, и старым именем поля у него всегда
 * была локальная часть ключа (`user/sleep-log` + поле `hours` → свойство `user/hours`): так
 * его заводит конструктор аспекта, так его читает карточка тула
 * (`keyFieldsByAspect`, tools/dispatch.ts), так его писал старый путь записи. Придуманного
 * имени здесь нет — есть ровно то, которое старая форма и знала.
 *
 * ПОЧЕМУ ЭТО ИЗМЕНЕНИЕ ОТНОСИТЕЛЬНО ЗАДАЧИ 4a, где такое свойство в карту просто не
 * попадало: тогда `props` никто не писал, и проекция была вспомогательной. С этой задачи она
 * — ЕДИНСТВЕННЫЙ писатель `aspects_legacy`, а карту читают компилятор запросов (фильтр по
 * полю кастомного аспекта), карточка тула и web. Проекция, теряющая своё поле владельца,
 * молча выключила бы их все.
 */
function legacyFieldOfProperty(
  reg: RegistrySnapshot,
  aspectId: string,
  propertyId: string,
): string {
  const mapped = propertyToLegacyField(propertyId, aspectId);
  if (mapped !== undefined) return mapped;
  const key = reg.properties.get(propertyId)?.key ?? propertyId;
  return key.split('/').at(-1) ?? propertyId;
}

/**
 * Обратный резолв: имя поля старой карты → id свойства. Сначала по объявленным свойствам
 * аспекта (там же живут свои свойства владельца), затем по переходной таблице §А8, и лишь
 * потом — «свойство с таким именем в namespace orbis», то есть заведомо неизвестный id.
 *
 * Последняя ветка не подстраховка, а НОСИТЕЛЬ ОТКАЗА: `orbis/agent-run.project_id` §А8
 * удаляет, опечатка в имени поля тоже никуда не резолвится, и оба обязаны получить честный
 * `UNKNOWN_PROPERTY` от валидатора — единственного места, где отказ по свойству называется.
 * Своего отказа здесь нет намеренно: два разных кода на одну опечатку читались бы как два
 * разных правила.
 *
 * Экспортирована для снятия предусловий предложения и отложенной единицы (§А7-3,
 * `routines/propose.ts`): их адрес — id свойства, и второго резолва «поле старой карты →
 * свойство» в сервере быть не должно — разъехавшись, он дал бы предусловие не по тому
 * свойству, которое правит патч.
 */
export function propertyOfLegacyField(
  reg: RegistrySnapshot,
  aspectId: string,
  field: string,
): string {
  for (const ref of reg.aspects.get(aspectId)?.properties ?? []) {
    if (legacyFieldOfProperty(reg, aspectId, ref.propertyId) === field) return ref.propertyId;
  }
  return legacyFieldToProperty(aspectId, field) ?? `orbis/${field}`;
}

/** Снятие значения в патче — отличается от любого записываемого значения (включая null). */
const UNSET = Symbol('unset');

/**
 * Старая карта ПАТЧА (`{аспект: {поле: значение|null} | null}`) → патч свойств.
 *
 * Дословный перевод сегодняшней семантики `mergeAspects` (§9.2) в новую модель:
 *  - `{аспект: null}` — detach аспекта. Значения при этом ОСТАЮТСЯ (Р9): в старой форме их
 *    носителем был ключ карты, в новой носителя у них нет вовсе, и терять факт владельца
 *    из-за смены интерпретации незачем;
 *  - `{аспект: {поле: null}}` — снятие свойства (в старой форме «поле со значением null
 *    удаляется»);
 *  - `{аспект: {поле: значение}}` — запись свойства и навешивание аспекта (в старой форме
 *    ключ карты появлялся сам собой).
 *
 * Слитое свойство (§А8/В1), получившее в ОДНОМ патче два разных значения, — отказ, а не
 * «последний выиграл»: `financial.category_ref` и `budget.category_ref` это одно свойство,
 * и молча выбранное значение — потерянный факт владельца.
 */
export function legacyPatchToProps(
  reg: RegistrySnapshot,
  patch: Record<string, Record<string, unknown> | null>,
): PropsPatch {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const attach: string[] = [];
  const detach: string[] = [];
  /** propertyId → каноническая запись намерения: текст значения либо UNSET. */
  const intent = new Map<string, string | typeof UNSET>();

  const remember = (propertyId: string, next: string | typeof UNSET, value: unknown): void => {
    const prev = intent.get(propertyId);
    if (prev !== undefined && prev !== next) {
      throw new ExecError(
        'VALIDATION',
        `свойство ${propertyId} получило в одном патче два разных значения — в плоской модели это невыразимо (В1)`,
        { reason: 'merged_property_conflict', property: propertyId, value },
      );
    }
    intent.set(propertyId, next);
  };

  for (const [aspectId, value] of Object.entries(patch)) {
    if (value === null) {
      detach.push(aspectId);
      continue;
    }
    attach.push(aspectId);
    for (const [field, raw] of Object.entries(value)) {
      const propertyId = propertyOfLegacyField(reg, aspectId, field);
      if (raw === null) {
        remember(propertyId, UNSET, null);
        unset.push(propertyId);
        continue;
      }
      const translated = translateLegacyValue(propertyId, raw);
      remember(propertyId, JSON.stringify(translated) ?? 'undefined', translated);
      set[propertyId] = translated;
    }
  }
  return { set, unset, attach, detach };
}

/**
 * Тот же перевод, но с семантикой ЗАМЕНЫ ключа целиком — форма inverse-операций журнала
 * (§7.8) и тула `attach_<аспект>`.
 *
 * Разница с `legacyPatchToProps` ровно одна и она существенная: свойство аспекта, которого
 * в значении НЕТ, снимается. В старой форме это выходило само собой (ключ карты
 * подменялся целиком), в плоской модели снятие приходится назвать. Без него откат
 * «действие дописало поле» оставлял бы дописанное значение в `props`: старая карта его уже
 * не показывала бы (проекция идёт по свойствам аспекта), а следующее навешивание того же
 * аспекта воскресило бы — расхождение, которое нашлось бы у владельца, а не в тестах.
 *
 * `{аспект: null}` (аспекта до действия не было) снимает и значения его свойств — по той же
 * причине. Не снимаются лишь те, что объявлены ДРУГИМ аспектом, остающимся на сущности:
 * слитое свойство (В1) принадлежит обоим, и снимать его вместе с одним из носителей значило
 * бы стирать данные второго.
 *
 * Порождённые заменой снятия едут в `replaced`, а не в `unset`, и это существенно для ПРАВ:
 * `unset` — распоряжение автора («сотри отчёт»), `replaced` — форма операции («навесь
 * аспект»). Гейт §А2-5 обязан видеть первое и не должен видеть второе (см. `PropsPatch`).
 */
export function legacyReplaceToProps(
  reg: RegistrySnapshot,
  cur: EntityState,
  patch: Record<string, Record<string, unknown> | null>,
): PropsPatch {
  const base = legacyPatchToProps(reg, patch);
  const detached = new Set(base.detach ?? []);
  const remaining = new Set([
    ...cur.aspects.filter((id) => !detached.has(id)),
    ...(base.attach ?? []),
  ]);
  const unset = new Set(base.unset ?? []);
  const replaced = new Set<string>();
  const set = base.set ?? {};

  for (const [aspectId, value] of Object.entries(patch)) {
    for (const ref of reg.aspects.get(aspectId)?.properties ?? []) {
      if (Object.hasOwn(set, ref.propertyId) || unset.has(ref.propertyId)) continue;
      // Свойство, которое объявляет другой оставшийся аспект, — не наше, чтобы его снимать.
      const sharedWithOther = [...remaining].some(
        (other) =>
          other !== aspectId &&
          (reg.aspects.get(other)?.properties ?? []).some((r) => r.propertyId === ref.propertyId),
      );
      if (sharedWithOther) continue;
      if (
        value === null ||
        !Object.hasOwn(value, legacyFieldOfProperty(reg, aspectId, ref.propertyId))
      ) {
        replaced.add(ref.propertyId);
      }
    }
  }
  return {
    set,
    unset: [...unset],
    replaced: [...replaced],
    attach: base.attach,
    detach: base.detach,
  };
}

/** Вход исполнителя в любой из двух форм — то, что разбирают exec-надмножества контрактов. */
export interface ExecPropsInput {
  props?: Record<string, unknown>;
  unset?: string[];
  aspects?:
    | Record<string, Record<string, unknown> | null>
    | { attach?: string[]; detach?: string[] }
    | string[];
}

/** true, если вход вообще несёт правку свойств (иначе стадии слияния не запускаются). */
export function hasPropsInput(input: ExecPropsInput): boolean {
  return input.props !== undefined || input.unset !== undefined || input.aspects !== undefined;
}

/**
 * Нормализация ОБЕИХ форм входа в один патч свойств.
 *
 * Формы две и они сосуществуют до конца среза (Ф-16/РП-3): тулы, web и ещё не переведённые
 * серверные пути шлют старую карту, переведённые — новую. Различаются по типу значения
 * `aspects`: список строк (навесить) и объект `{attach, detach}` — новая форма, карта
 * объектов/`null` — старая. Смесь законна: `props` новой формы поверх старой карты — ровно
 * то, что нужно пути, который переводится по частям.
 *
 * Порядок наложения: сначала старая карта, потом явные `props`/`unset`. На ЗАПИСИ значения
 * это и означает «явное сильнее выведенного»: `props` перетирают то, что вывелось из карты,
 * — иначе перевод пути по частям начинался бы с необъяснимого «моё значение не записалось».
 *
 * НО НЕ НА СНЯТИИ, и это честно надо назвать. Патч, где одна форма свойство снимает, а
 * другая пишет (`{aspects:{a:{f:null}}, props:{f:v}}`), кладёт в результат и `set`, и
 * `unset`, а побеждает снятие — так решает `applyPropsPatch`, и решает одинаково при любом
 * порядке ключей во входе. Правило «явное сильнее» тут не работает: обе половины явные,
 * просто сказаны разными формами, и патч попросту противоречив. Детерминированный исход
 * важнее выдуманного старшинства; вход экзотический — смесь форм в одном патче.
 *
 * @param replaceKeys семантика ЗАМЕНЫ ключа для старой карты (attach-тул, inverse журнала).
 */
export function fromLegacyInput(
  reg: RegistrySnapshot,
  cur: EntityState,
  input: ExecPropsInput,
  replaceKeys = false,
): PropsPatch {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const replaced: string[] = [];
  const attach: string[] = [];
  const detach: string[] = [];

  const aspects = input.aspects;
  if (Array.isArray(aspects)) {
    attach.push(...aspects);
  } else if (aspects !== undefined && isAspectsPatch(aspects)) {
    attach.push(...(aspects.attach ?? []));
    detach.push(...(aspects.detach ?? []));
  } else if (aspects !== undefined) {
    const legacy = replaceKeys
      ? legacyReplaceToProps(reg, cur, aspects)
      : legacyPatchToProps(reg, aspects);
    Object.assign(set, legacy.set);
    unset.push(...(legacy.unset ?? []));
    replaced.push(...(legacy.replaced ?? []));
    attach.push(...(legacy.attach ?? []));
    detach.push(...(legacy.detach ?? []));
  }

  for (const [keyOrId, value] of Object.entries(input.props ?? {})) {
    const def = resolvePropertyRef(reg, keyOrId);
    // Неизвестный адрес уезжает В ТОМ ЖЕ ВИДЕ, что пришёл: отказ по свойству называет
    // валидатор (`UNKNOWN_PROPERTY`), и подменять здесь имя значило бы прятать опечатку.
    set[def?.id ?? keyOrId] = value;
  }
  for (const keyOrId of input.unset ?? []) {
    unset.push(resolvePropertyRef(reg, keyOrId)?.id ?? keyOrId);
  }

  return { set, unset, replaced, attach, detach };
}

/** Новая форма `aspects` отличается от старой карты тем, что у неё нет чужих ключей. */
function isAspectsPatch(value: object): value is { attach?: string[]; detach?: string[] } {
  return Object.keys(value).every((k) => k === 'attach' || k === 'detach');
}

/** Три колонки строки `entities`, которые реформа держит согласованными. */
export interface LegacyRow {
  props: Record<string, unknown>;
  aspects: string[];
  aspectsLegacy: LegacyAspects;
}

/**
 * Старая карта → ТРИ колонки строки: для фикстур и сидов, которые пишут в `entities` минуя
 * исполнителя.
 *
 * Почему три, а не одна переименованная: писатели `props`/`aspects[]` появляются следующей
 * задачей, и фикстура, положившая только старую карту, разъехалась бы с ними молча — на
 * фикстурах не падает валидация, они не проходят исполнитель, и заметить расхождение можно
 * было бы только по чужому красному тесту через несколько задач.
 *
 * Круговой перевод ПРОВЕРЯЕТСЯ, и расхождение — отказ. В срезе А истина фикстуры это
 * по-прежнему старая карта: её читают компилятор запросов, доменные модули и web. Значит
 * перевод, который что-то из неё теряет (поле без строки в §А8) или переписывает (формы,
 * которые реформа поменяла ВНУТРИ, — `progress_source.query` стал Q-AST), меняет поведение
 * сьюта — ровно то, чего эта задача обязана не делать. Такая фикстура должна получить
 * громкий отказ и переехать на новую форму руками, а не тихо поменять смысл.
 */
export function rowFromLegacy(reg: RegistrySnapshot, legacyMap: LegacyAspects): LegacyRow {
  const translated = legacyAspectsToProps(legacyMap);
  if (!translated.ok) {
    const { propertyId, values } = translated.conflict;
    throw new Error(
      `rowFromLegacy: свойство ${propertyId} получило разные значения из двух аспектов ` +
        `(${values.map((v) => JSON.stringify(v)).join(' и ')}) — в плоской модели это невыразимо (В1)`,
    );
  }
  const { props, aspects } = translated;
  const aspectsLegacy = projectLegacyAspects(reg, { props, aspects });
  for (const aspectId of aspects) {
    if (canonicalJson(aspectsLegacy[aspectId]) !== canonicalJson(legacyMap[aspectId])) {
      throw new Error(
        `rowFromLegacy: аспект ${aspectId} не пережил круговой перевод — ` +
          `было ${JSON.stringify(legacyMap[aspectId])}, стало ${JSON.stringify(aspectsLegacy[aspectId])}`,
      );
    }
  }
  return { props, aspects, aspectsLegacy };
}

/**
 * JSON с рекурсивно отсортированными ключами. Нужен ровно проверке кругового перевода:
 * порядок полей в карте задаёт автор фикстуры, а в проекции — порядок свойств в реестре,
 * и сравнение обычным `JSON.stringify` краснело бы на перестановке, то есть там, где ничего
 * не изменилось.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
