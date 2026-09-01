// apps/server/src/registry/validator-golden.test.ts
// ПРИЁМКА §С8-1: golden-корпус «сущность → вердикт». Корпус хранит сущность в форме
// реформы (`props` по id свойства + `aspects` списком) и прогоняет её НОВЫМ валидатором
// (`validateEntityProps` по реестру свойств); вердикт старого валидатора лежит рядом
// ЗАМОРОЖЕННЫМ литералом `legacyVerdict`.
//
// ПОЧЕМУ ЗАМОРОЖЕН (Задача 23a). Старый вердикт вычисляли zod-схемы `ASPECT_SCHEMAS` по
// СТАРОЙ карте `{аспект: {поле: значение}}`, а перевод карты в свойства делала
// `legacyAspectsToProps`. Обе умирают вместе со старой формой (Задача 23b), и тест,
// продолжавший их звать, умер бы с ними — унеся приёмку §С8-1 целиком. Поэтому старый
// вердикт посчитан ОДИН раз, до перевода корпуса, и записан числом: он остаётся
// историческим свидетелем («так решала форма до реформы»), а живым остаётся ровно один
// вычисляемый вердикт — новый. Пересчитать `legacyVerdict` больше нечем, и это намеренно:
// значение, которое нельзя пересчитать, нельзя и молча подогнать под новый результат.
//
// КАК ПЕРЕГЕНЕРИРОВАТЬ КОРПУС при смене реестра свойств/аспектов. `legacyVerdict` НЕ
// трогается ни при каких правках реестра — он про мёртвую форму. Меняется только
// `newVerdict`: посчитать его новым валидатором (`validateEntityProps` со снимком
// `BUILTIN_PROPERTY_META`/`BUILTIN_ASPECT_DEFS`), вписать в JSON и ОБЪЯСНИТЬ каждое
// изменение — либо строкой §А8, либо новым кодом в `EXPECTED_DIFFS`. Три числа состава
// (`CORPUS_SIZE`, `POSITIVE_RECORDS`, `NEGATIVE_RECORDS`), таблица `COVERAGE` и
// `MUTATIONS_CHECKED` двигаются тем же коммитом: молчаливое расхождение с ними и есть
// сигнал «корпус изменили, не заметив».
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
import { BUILTIN_ASPECT_DEFS, BUILTIN_ASPECT_IDS, BUILTIN_PROPERTY_META } from '@orbis/shared';
import corpus from '../../test/golden/validator-verdicts.json';
import { type PropsRegistry, validateEntityProps } from './validate-props';

type Verdict = 'ok' | 'reject';
interface GoldenRecord {
  name: string;
  props: Record<string, unknown>;
  aspects: string[];
  legacyVerdict: Verdict;
  newVerdict: Verdict;
  expectedDiff?: string;
}

/**
 * Законные расхождения вердиктов. Пять первых — ужесточения §А8, названные Р-17/РП-8 ещё
 * в плане; два последних найдены сборкой корпуса и доказаны спекой (см. отчёт задачи).
 *
 * Расхождение `QUERY_AST_FORM` СНЯТО Задачей 10b: схема `orbis/progress_source` получила
 * канон Q-AST (`queryAstJsonSchema`) и ветку неразобранного блока `{text}` с `minLength: 1`,
 * поэтому пустой текст запроса снова отвергается ФОРМОЙ — как и у старого валидатора.
 *
 * Расхождение `MERGED_VALUE_CONFLICT` СНЯТО Задачей 23a вместе с переводом корпуса в
 * `props`/`aspects[]`. Конфликт слитого свойства (В1) — свойство формы ВХОДА, а не
 * сущности: карта `{financial: {category_ref: A}, budget: {category_ref: B}}` называла одно
 * свойство дважды, а плоский `props` такого просто не выражает. ОТКАЗ на противоречивом
 * входе остался там, где он и происходит, — на границе исполнителя:
 * `executor/props.test.ts` («financial+budget с разной category_ref в одном create →
 * VALIDATION (В1)») и `executor/legacy-form.test.ts`.
 *
 * Из трёх записей этой причины в корпусе осталась ОДНА («financial + budget делят одну
 * категорию»): переведённые в общее значение две другие («…одну валюту», «…один грант»)
 * оказались байт-в-байт равны уже существовавшим позитивным записям («…с ОДНОЙ категорией и
 * валютой», «…с ОДНИМ грантом») — и удалены. Дубль по входу не добавляет корпусу ни одной
 * проверки, зато завышает каждое число состава и заставляет мутационный тест гонять одну и
 * ту же порчу дважды. Придумывать им различимый вход было бы сочинением записи, а корпус
 * собран по чужим источникам и сочинения не допускает (см. шапку файла). Повтор теперь
 * запрещён пином уникальности по `{props, aspects}` — тест состава ниже.
 *
 * `records` — СКОЛЬКО записей корпуса стоит на причине; число точное, а не «хотя бы одна»:
 * без него из трёх записей можно молча оставить одну (гейт-ревью 2).
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
  // §А7-3: decimal сравнивается ПО ЗНАЧЕНИЮ, и «-0» = «0» проходит нижнюю границу min:0.
  // Старый `nonNegativeDecimal` отвергал «-0» текстом. Единственное расхождение, где
  // новый валидатор МЯГЧЕ старого по значению.
  DECIMAL_SIGNED_ZERO: { verdict: 'ok', records: 1 },
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
 * приёмка §С8-1 гоняется постоянно: с порогом «не меньше» любую неудобную запись можно было
 * бы молча удалить, и красным это не стало бы (гейт-ревью 2).
 * Санкционированное изменение корпуса обязано двигать и эту таблицу — видимым движением.
 * Суммы столбцов больше `CORPUS_SIZE`: многоаспектная запись считается у каждого аспекта.
 */
const COVERAGE: Record<string, readonly [number, number]> = {
  'orbis/schedule': [4, 7],
  'orbis/task': [3, 9],
  'orbis/financial': [7, 16],
  'orbis/note': [2, 2],
  'orbis/budget': [6, 8],
  'orbis/category': [3, 6],
  'orbis/memory': [2, 3],
  'orbis/goal': [2, 13],
  'orbis/project': [2, 3],
  'orbis/repo': [2, 6],
  'orbis/assignment': [3, 5],
  'orbis/agent-run': [4, 22],
  'orbis/routine': [2, 10],
};

/**
 * Размер корпуса и его разбивка — все три числа точные. Задача 23a: размер 147 (было 149 —
 * две записи удалены как дубли по входу), позитивных 36 (было 35 — прибавилась одна
 * оставшаяся запись В1), негативных 111 (было 114 — три записи В1 перестали быть отказом).
 * Все три движения объяснены в докблоке `EXPECTED_DIFFS`.
 */
const CORPUS_SIZE = 147;
const POSITIVE_RECORDS = 36;
const NEGATIVE_RECORDS = 111;
const MULTI_ASPECT_RECORDS = 5;
/**
 * Сколько порч «убран required» делает мутационный тест ниже — тоже точное число.
 *
 * Было 90 до Задачи 10b: две порчи давала запись «query пустой строкой», которую новый
 * валидатор тогда ПРИНИМАЛ (схема свойства брала любой объект). С каноном Q-AST она стала
 * отказом у обоих валидаторов и из множества «новый сказал ok» ушла вместе со своими двумя
 * обязательными полями аспекта цели.
 *
 * Стало 97 в Задаче 23a, и обе половины прироста — следствие перевода корпуса, а не новой
 * строгости валидатора. Единица порчи была ПОЛЕМ одного аспекта, а стала СВОЙСТВОМ
 * сущности: 90 порч дают прежние 146 записей (было 88 — две порчи раньше пропускались как
 * «поле убрали у одного носителя, значение принёс второй»: в плоской модели такого
 * пропуска нет), и ещё 7 приносит единственная оставшаяся запись В1, ставшая позитивной.
 */
const MUTATIONS_CHECKED = 97;

const REG: PropsRegistry = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
};

/** Новый путь — единственный вычисляемый: свойства сущности против реестра. */
function newVerdict(entity: { props: Record<string, unknown>; aspects: string[] }): Verdict {
  return validateEntityProps(REG, entity).length === 0 ? 'ok' : 'reject';
}

// `as unknown` — не небрежность: TS выводит из литерального JSON союз объектов с
// `field?: undefined` у каждой записи, где поля нет, и такой союз не сравним с
// объявленной формой записи. И форму, и СОСТАВ корпуса стережёт не компилятор, а тест
// состава ниже: точные размер, разбивка по аспектам, число записей на каждой причине
// расхождения и уникальность имён.
const records = corpus as unknown as GoldenRecord[];

describe('golden «сущность → вердикт» (приёмка §С8-1)', () => {
  test('новый валидатор (validateEntityProps по реестру свойств) даёт на всём корпусе вердикт, записанный в корпусе; расхождения с замороженным вердиктом старой формы — только перечисленные expectedDiff', () => {
    const wrong: string[] = [];
    for (const record of records) {
      const fresh = newVerdict(record);
      // Вердикт запиннен АБСОЛЮТНО, а не «совпадает со старым»: иначе два одинаково
      // сломанных валидатора прошли бы приёмку вдвоём.
      if (fresh !== record.newVerdict) {
        wrong.push(`${record.name}: новый дал ${fresh}, в корпусе ${record.newVerdict}`);
      }
      // `legacyVerdict` — замороженный литерал (см. шапку файла); пересчитать его нечем,
      // и сравнение с ним стережёт ровно то, ради чего корпус и заведён: реформа обязана
      // менять вердикт ТОЛЬКО там, где она что-то решила, и с названной причиной.
      if (record.legacyVerdict !== fresh && record.expectedDiff === undefined) {
        wrong.push(
          `${record.name}: расхождение вердиктов без expectedDiff (${record.legacyVerdict} → ${fresh})`,
        );
      }
      if (record.legacyVerdict === fresh && record.expectedDiff !== undefined) {
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
      const mine = records.filter((r) => r.aspects.includes(aspectId));
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
    expect(records.filter((r) => r.aspects.length > 1)).toHaveLength(MULTI_ASPECT_RECORDS);
    expect(new Set(records.map((r) => r.name)).size).toBe(records.length);
    // …и по ВХОДУ, а не только по имени. Запись, повторяющая чужие `props`+`aspects`, ничего
    // не проверяет, но считается в каждом числе состава и заставляет мутационный тест гонять
    // одну и ту же порчу дважды — ровно это и случилось при переводе трёх записей В1 в общее
    // значение (гейт-ревью 23a, находка 2). Аспекты сравниваются как МНОЖЕСТВО: их порядок —
    // не факт о сущности.
    const byInput = records.map((r) =>
      JSON.stringify({ props: r.props, aspects: [...r.aspects].sort() }),
    );
    expect(new Set(byInput).size).toBe(records.length);

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
    //
    // Единица порчи — СВОЙСТВО сущности, а не поле одного аспекта: после реформы носитель
    // не владеет значением (§А8/В1), и «убрать поле у одного из двух аспектов» перестало
    // быть выразимым. Поэтому у слитого свойства порча теперь настоящая — и обязана
    // отвергаться обоими носителями сразу.
    let checked = 0;
    for (const record of records) {
      if (record.newVerdict !== 'ok') continue;
      for (const aspectId of record.aspects) {
        const aspect = BUILTIN_ASPECT_DEFS.find((a) => a.id === aspectId);
        if (!aspect) continue;
        for (const ref of aspect.properties.filter((p) => p.required)) {
          if (!(ref.propertyId in record.props)) continue;
          const damaged = Object.fromEntries(
            Object.entries(record.props).filter(([propertyId]) => propertyId !== ref.propertyId),
          );
          expect(
            `${record.name}/${aspectId}.${ref.propertyId}: ${newVerdict({ props: damaged, aspects: record.aspects })}`,
          ).toBe(`${record.name}/${aspectId}.${ref.propertyId}: reject`);
          checked += 1;
        }
      }
    }
    // Точное число порч: с порогом «больше двадцати» удаление позитивных записей корпуса
    // тоже осталось бы незамеченным (гейт-ревью 2).
    expect(checked).toBe(MUTATIONS_CHECKED);
  });
});
