// apps/server/src/registry/validator-golden.test.ts
// ПРИЁМКА §С8-1: golden-корпус «сущность → вердикт». Один и тот же вход прогоняется
// СТАРЫМ валидатором (zod `ASPECT_SCHEMAS`, форма аспектов) и НОВЫМ (`validateEntityProps`
// по реестру свойств через переходную карту) — вердикты обязаны совпасть везде, кроме
// перечисленных ниже расхождений.
//
// Корпус (`test/golden/validator-verdicts.json`) собран ДО нового валидатора и по чужим
// источникам: позитивные формы — из `schemas/aspects.test.ts`, `query/fixtures.ts`,
// `src/test/perf.ts` и сида категорий; вердикты выведены чтением старых zod-схем и §А8.
// Корпус, написанный ПОСЛЕ валидатора, подтверждал бы валидатор сам собой.
//
// Каждое НЕ перечисленное расхождение — дефект перевода. Список `EXPECTED_DIFFS` закрыт:
// расширять его можно только доказанным фактом (адрес в §А8 против адреса в
// `schemas/aspects.ts`), а не наблюдением «тест покраснел».
import { describe, expect, test } from 'bun:test';
import {
  ASPECT_SCHEMAS,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_ASPECT_IDS,
  BUILTIN_PROPERTY_META,
  legacyAspectsToProps,
  propertyToLegacyField,
} from '@orbis/shared';
import corpus from '../../test/golden/validator-verdicts.json';
import { type PropsRegistry, validateEntityProps } from './validate-props';

type Verdict = 'ok' | 'reject';
interface GoldenRecord {
  name: string;
  aspects: Record<string, Record<string, unknown>>;
  legacyVerdict: Verdict;
  newVerdict: Verdict;
  expectedDiff?: string;
}

/**
 * Законные расхождения вердиктов. Пять первых — ужесточения §А8, названные Р-17/РП-8 ещё
 * в плане; три последних найдены сборкой корпуса и доказаны спекой (см. отчёт задачи).
 *
 * `records` — СКОЛЬКО записей корпуса стоит на причине; число точное, а не «хотя бы одна»:
 * без него из трёх записей `MERGED_VALUE_CONFLICT` можно молча оставить одну (гейт-ревью 2).
 */
const EXPECTED_DIFFS: Record<string, { verdict: Verdict; records: number }> = {
  // §А8 orbis/category: `maxItems: 50` — в zod капа нет вовсе (`aspects.ts:107`).
  ALIASES_MAX_50: { verdict: 'reject', records: 1 },
  // §А8 orbis/repo: `format: url` — в zod только длина (`aspects.ts:160`).
  REPO_URL_FORMAT: { verdict: 'reject', records: 1 },
  // §А8 orbis/schedule: `format: iana-tz` — в zod голая строка (`aspects.ts:49`).
  TIMEZONE_IANA: { verdict: 'reject', records: 1 },
  // §А8 orbis/financial: `format: currency` = `^[A-Z]{3}$` — в zod только длина 3.
  CURRENCY_UPPER3: { verdict: 'reject', records: 1 },
  // §А8 orbis/agent-run: поле `project_id` УДАЛЕНО (замена — orbis/parent_project).
  PROJECT_ID_REMOVED: { verdict: 'reject', records: 1 },
  // В1 §А8: слитое свойство с РАЗНЫМИ значениями в двух аспектах невыразимо в плоской
  // модели — конфликт, а не «последний выиграл». Три слияния — три записи.
  MERGED_VALUE_CONFLICT: { verdict: 'reject', records: 3 },
  // §А7-3: decimal сравнивается ПО ЗНАЧЕНИЮ, и «-0» = «0» проходит нижнюю границу min:0.
  // Старый `nonNegativeDecimal` отвергал «-0» текстом. Единственное расхождение, где
  // новый валидатор МЯГЧЕ старого по значению.
  DECIMAL_SIGNED_ZERO: { verdict: 'ok', records: 1 },
  // §А5-2/Р12: `progress_source.query` сменил форму строка → Q-AST-объект. До канона
  // Q-AST (Задача 8) схема свойства принимает любой объект, поэтому пустой текст запроса
  // перестал отвергаться формой. Переходное послабление, закрывается Задачей 8.
  QUERY_AST_FORM: { verdict: 'ok', records: 1 },
  // Р-9b-5: календарная существуемость дня. Форму `^\\d{4}-\\d{2}-\\d{2}$` «2026-02-30»
  // проходит у обоих валидаторов — она невыразима в JSON Schema и не выражена в zod
  // (`aspects.ts:9` — голый регексп). Новый путь проверяет её спутником ajv (`date.ts`,
  // `hasValidCalendar`), потому что иначе значение записывалось бы молча, а падало позже
  // и в другом месте — на первом же `::date` в запросе (Postgres 22008).
  CALENDAR_DAY_EXISTS: { verdict: 'reject', records: 1 },
};

/**
 * ТОЧНЫЙ состав корпуса: `[позитивных (оба вердикта ok), негативных (хотя бы один reject)]`
 * на каждый из тринадцати аспектов. Пин точный, а не «хотя бы по одной», ровно потому, что
 * приёмка §С8-1 гоняется постоянно до заморозки Задачей 23: с порогом «не меньше» любую
 * неудобную запись можно было бы молча удалить, и красным это не стало бы (гейт-ревью 2).
 * Санкционированное изменение корпуса обязано двигать и эту таблицу — видимым движением.
 * Суммы столбцов больше `CORPUS_SIZE`: многоаспектная запись считается у каждого аспекта.
 */
const COVERAGE: Record<string, readonly [number, number]> = {
  'orbis/schedule': [4, 7],
  'orbis/task': [3, 9],
  'orbis/financial': [6, 18],
  'orbis/note': [2, 2],
  'orbis/budget': [5, 10],
  'orbis/category': [3, 6],
  'orbis/memory': [2, 3],
  'orbis/goal': [2, 13],
  'orbis/project': [2, 3],
  'orbis/repo': [2, 6],
  'orbis/assignment': [3, 6],
  'orbis/agent-run': [4, 23],
  'orbis/routine': [2, 10],
};

/** Размер корпуса и его разбивка — все три числа точные. */
const CORPUS_SIZE = 149;
const POSITIVE_RECORDS = 35;
const NEGATIVE_RECORDS = 114;
const MULTI_ASPECT_RECORDS = 7;
/** Сколько порч «убран required» делает мутационный тест ниже — тоже точное число. */
const MUTATIONS_CHECKED = 90;

const REG: PropsRegistry = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
};

/** Старый путь: zod-схема на каждый аспект; неизвестный аспект — отказ. */
function legacyVerdict(aspects: GoldenRecord['aspects']): Verdict {
  for (const [aspectId, data] of Object.entries(aspects)) {
    const schema = ASPECT_SCHEMAS[aspectId as keyof typeof ASPECT_SCHEMAS];
    if (schema === undefined) return 'reject';
    if (!schema.safeParse(data).success) return 'reject';
  }
  return 'ok';
}

/** Новый путь: старая карта → props (В1-конфликт — отказ) → валидация по реестру. */
function newVerdict(aspects: GoldenRecord['aspects']): Verdict {
  const translated = legacyAspectsToProps(aspects);
  if (!translated.ok) return 'reject';
  const violations = validateEntityProps(REG, {
    props: translated.props,
    aspects: translated.aspects,
  });
  return violations.length === 0 ? 'ok' : 'reject';
}

// `as unknown` — не небрежность: TS выводит из литерального JSON союз объектов с
// `field?: undefined` у каждой записи, где поля нет, и такой союз не сравним с
// `Record<string, Record<string, unknown>>`. И форму, и СОСТАВ корпуса стережёт не
// компилятор, а тест состава ниже: точные размер, разбивка по аспектам, число записей на
// каждой причине расхождения и уникальность имён.
const records = corpus as unknown as GoldenRecord[];

describe('golden «сущность → вердикт» (приёмка §С8-1)', () => {
  test('старый валидатор (zod ASPECT_SCHEMAS) и новый (validateEntityProps через legacyAspectsToProps) дают одинаковые вердикты на всём корпусе, кроме перечисленных expectedDiff', () => {
    const wrong: string[] = [];
    for (const record of records) {
      const legacy = legacyVerdict(record.aspects);
      const fresh = newVerdict(record.aspects);
      // Вердикты запиннены АБСОЛЮТНО, а не только «совпадают»: иначе два одинаково
      // сломанных валидатора прошли бы приёмку вдвоём.
      if (legacy !== record.legacyVerdict) {
        wrong.push(`${record.name}: старый дал ${legacy}, в корпусе ${record.legacyVerdict}`);
      }
      if (fresh !== record.newVerdict) {
        wrong.push(`${record.name}: новый дал ${fresh}, в корпусе ${record.newVerdict}`);
      }
      if (legacy !== fresh && record.expectedDiff === undefined) {
        wrong.push(`${record.name}: расхождение вердиктов без expectedDiff (${legacy} → ${fresh})`);
      }
      if (legacy === fresh && record.expectedDiff !== undefined) {
        wrong.push(`${record.name}: expectedDiff «${record.expectedDiff}» при совпавших вердиктах`);
      }
      if (record.expectedDiff !== undefined) {
        const legal = EXPECTED_DIFFS[record.expectedDiff];
        if (legal === undefined) wrong.push(`${record.name}: причина вне списка законных`);
        else if (legal.verdict !== fresh) {
          wrong.push(
            `${record.name}: «${record.expectedDiff}» ожидает новый вердикт ${legal.verdict}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test('состав корпуса запиннен ТОЧНО: 13 аспектов, разбивка позитивных и негативных, причины расхождений', () => {
    // Пин на равенство, а не на порог: молча выкинутая запись обязана красить приёмку, а не
    // проходить её (гейт-ревью 2 — прогон «удалил целую запись, всё зелено»).
    const coverage: Record<string, readonly [number, number]> = {};
    for (const aspectId of BUILTIN_ASPECT_IDS) {
      const mine = records.filter((r) => Object.keys(r.aspects).includes(aspectId));
      coverage[aspectId] = [
        mine.filter((r) => r.legacyVerdict === 'ok' && r.newVerdict === 'ok').length,
        mine.filter((r) => r.legacyVerdict === 'reject' || r.newVerdict === 'reject').length,
      ];
    }
    expect(coverage).toEqual(COVERAGE);
    // Каждый аспект покрыт с обеих сторон — это отдельное утверждение, а не следствие
    // таблицы: таблицу правят, и правка «в ноль» обязана быть видна как нарушение смысла.
    for (const [aspectId, [positive, negative]] of Object.entries(COVERAGE)) {
      expect(`${aspectId}: ${positive > 0 && negative > 0}`).toBe(`${aspectId}: true`);
    }

    expect(records.length).toBe(CORPUS_SIZE);
    expect(records.filter((r) => r.legacyVerdict === 'ok' && r.newVerdict === 'ok')).toHaveLength(
      POSITIVE_RECORDS,
    );
    expect(
      records.filter((r) => r.legacyVerdict === 'reject' || r.newVerdict === 'reject'),
    ).toHaveLength(NEGATIVE_RECORDS);
    expect(records.filter((r) => Object.keys(r.aspects).length > 1)).toHaveLength(
      MULTI_ASPECT_RECORDS,
    );
    expect(new Set(records.map((r) => r.name)).size).toBe(records.length);

    // Причины расхождений: и набор кодов, и ЧИСЛО записей на каждом — точно.
    const perCode: Record<string, number> = {};
    for (const record of records) {
      if (record.expectedDiff === undefined) continue;
      perCode[record.expectedDiff] = (perCode[record.expectedDiff] ?? 0) + 1;
    }
    expect(perCode).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_DIFFS).map(([code, d]) => [code, d.records])),
    );
  });

  test('мутационная проверка: испорченная фикстура (required убран) меняет вердикт нового валидатора', () => {
    // Позитивные записи корпуса обязаны быть ЖИВЫМИ: если валидатор перестал смотреть на
    // обязательность, все они останутся зелёными и приёмка ничего не заметит.
    let checked = 0;
    for (const record of records) {
      if (record.newVerdict !== 'ok') continue;
      for (const [aspectId, data] of Object.entries(record.aspects)) {
        const aspect = BUILTIN_ASPECT_DEFS.find((a) => a.id === aspectId);
        if (!aspect) continue;
        for (const ref of aspect.properties.filter((p) => p.required)) {
          const field = propertyToLegacyField(ref.propertyId, aspectId);
          if (field === undefined || !(field in data)) continue;
          const damaged = {
            ...record.aspects,
            [aspectId]: Object.fromEntries(Object.entries(data).filter(([f]) => f !== field)),
          };
          // Слитое свойство (В1) второй аспект той же сущности приносит сам: убрать поле у
          // одного носителя — не значит убрать значение. Такая порча ничего не портит, и
          // требовать от неё отказа было бы требованием НЕВЕРНОГО поведения.
          const left = legacyAspectsToProps(damaged);
          if (left.ok && ref.propertyId in left.props) continue;
          expect(`${record.name}/${aspectId}.${field}: ${newVerdict(damaged)}`).toBe(
            `${record.name}/${aspectId}.${field}: reject`,
          );
          checked += 1;
        }
      }
    }
    // Точное число порч: с порогом «больше двадцати» удаление позитивных записей корпуса
    // тоже осталось бы незамеченным (гейт-ревью 2).
    expect(checked).toBe(MUTATIONS_CHECKED);
  });
});
