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
 */
const EXPECTED_DIFFS: Record<string, string> = {
  // §А8 orbis/category: `maxItems: 50` — в zod капа нет вовсе (`aspects.ts:107`).
  ALIASES_MAX_50: 'reject',
  // §А8 orbis/repo: `format: url` — в zod только длина (`aspects.ts:160`).
  REPO_URL_FORMAT: 'reject',
  // §А8 orbis/schedule: `format: iana-tz` — в zod голая строка (`aspects.ts:49`).
  TIMEZONE_IANA: 'reject',
  // §А8 orbis/financial: `format: currency` = `^[A-Z]{3}$` — в zod только длина 3.
  CURRENCY_UPPER3: 'reject',
  // §А8 orbis/agent-run: поле `project_id` УДАЛЕНО (замена — orbis/parent_project).
  PROJECT_ID_REMOVED: 'reject',
  // В1 §А8: слитое свойство с РАЗНЫМИ значениями в двух аспектах невыразимо в плоской
  // модели — конфликт, а не «последний выиграл».
  MERGED_VALUE_CONFLICT: 'reject',
  // §А7-3: decimal сравнивается ПО ЗНАЧЕНИЮ, и «-0» = «0» проходит нижнюю границу min:0.
  // Старый `nonNegativeDecimal` отвергал «-0» текстом. Единственное расхождение, где
  // новый валидатор МЯГЧЕ старого по значению.
  DECIMAL_SIGNED_ZERO: 'ok',
  // §А5-2/Р12: `progress_source.query` сменил форму строка → Q-AST-объект. До канона
  // Q-AST (Задача 8) схема свойства принимает любой объект, поэтому пустой текст запроса
  // перестал отвергаться формой. Переходное послабление, закрывается Задачей 8.
  QUERY_AST_FORM: 'ok',
};

const REG: PropsRegistry = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
};

/** Старый путь: zod-схема на каждый аспект; неизвестный аспект — отказ (`validateAspectData`). */
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
// `Record<string, Record<string, unknown>>`. Форму корпуса стережёт не компилятор, а тест
// покрытия ниже (13 аспектов, причины расхождений, уникальность имён).
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
        const direction = EXPECTED_DIFFS[record.expectedDiff];
        if (direction === undefined) wrong.push(`${record.name}: причина вне списка законных`);
        else if (direction !== fresh) {
          wrong.push(`${record.name}: «${record.expectedDiff}» ожидает новый вердикт ${direction}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test('корпус покрывает все 13 аспектов позитивно и негативно, и каждую законную причину расхождения', () => {
    for (const aspectId of BUILTIN_ASPECT_IDS) {
      const mine = records.filter((r) => Object.keys(r.aspects).includes(aspectId));
      const positive = mine.filter((r) => r.legacyVerdict === 'ok' && r.newVerdict === 'ok');
      const negative = mine.filter(
        (r) => r.legacyVerdict === 'reject' || r.newVerdict === 'reject',
      );
      expect(`${aspectId}: позитивных ${positive.length > 0}`).toBe(`${aspectId}: позитивных true`);
      expect(`${aspectId}: негативных ${negative.length > 0}`).toBe(`${aspectId}: негативных true`);
    }
    const used = new Set(records.map((r) => r.expectedDiff).filter((d) => d !== undefined));
    expect([...used].sort()).toEqual(Object.keys(EXPECTED_DIFFS).sort());
    // Корпус не должен усыхать незаметно: приёмка §С8-1 стоит на его объёме.
    expect(records.length).toBeGreaterThanOrEqual(140);
    expect(new Set(records.map((r) => r.name)).size).toBe(records.length);
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
    expect(checked).toBeGreaterThan(20);
  });
});
