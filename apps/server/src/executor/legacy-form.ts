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
  propertyToLegacyField,
  type RelationRoleId,
} from '@orbis/shared';
import type { RegistrySnapshot } from '../registry/load';

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
      const field = propertyToLegacyField(ref.propertyId, aspectId);
      if (field === undefined) continue;
      fields[field] = state.props[ref.propertyId];
    }
    out[aspectId] = fields;
  }
  return out;
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
