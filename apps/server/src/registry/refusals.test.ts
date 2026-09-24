// apps/server/src/registry/refusals.test.ts
// КОРПУС 21 КАНОНИЧЕСКОГО ОТКАЗА (§С1-2, приёмка §С8-24): вердикты объявлены ДАННЫМИ
// (`test/fixtures/refusals.ts`), здесь только прогон и пины — образец разделения `EXPR_FIXTURES`.
// ВСЕ походы — в `beforeAll`, тела тестов СИНХРОННЫ: Bun 1.2.7 игнорирует пометку ожидаемого
// провала, если тест вышел в макрозадачу (ОВ-Б1-1), и ломаются обе половины гарантии.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  closeRefusals,
  prepareRefusals,
  REFUSAL_ROWS,
  slotAmbiguityDetails,
} from '../../test/fixtures/refusals';
import { requireEnv } from '../../test/helpers';

requireEnv();
type Cell = { positive: unknown; refuse: unknown; spoils: unknown[] };
const collected = new Map<number, Cell>();
let slotDetails: unknown;
beforeAll(async () => {
  await prepareRefusals();
  const take = async (fn: () => Promise<unknown>) => {
    try {
      return { ok: await fn() };
    } catch (e) {
      return { err: e };
    }
  };
  for (const r of REFUSAL_ROWS) {
    // Порядок внутри строки — позитив, отказ, порчи: строка 10 втягивает запись в окно `refuse`-ом.
    const cell: Cell = {
      positive: await take(() => r.positive()),
      refuse: await take(() => r.refuse()),
      spoils: [],
    };
    for (const s of r.spoils) cell.spoils.push(await take(() => s.run()));
    collected.set(r.row, cell);
  }
  // После строк: проба возвращает запись строки 10 в окно сама, порядок строк ей не важен.
  slotDetails = await take(() => slotAmbiguityDetails());
});
afterAll(async () => {
  await closeRefusals();
});

/**
 * Сколько порч гоняет корпус — ТОЧНЫЙ литерал, а не порог. С порогом «не меньше двадцати одной»
 * удаление порч у половины строк прошло бы незамеченным (урок гейт-ревью 2 Б-1; тот же приём —
 * `MUTATIONS_CHECKED` в `validator-golden.test.ts`). Число складывается из порч по строкам; при
 * добавлении порчи литерал правится тем же коммитом и в докблоке называется, какая строка выросла.
 * 39 = 35 до задачи 17 + строка 3 (+1: подмена tool) + строка 11 (−1: снят дубль отказа) + строка 19
 * (+2: другой носитель, двойник ухода) + строка 20 (+1: deref в глубине when) + строка 21 (+1: без даты).
 */
const SPOILS_CHECKED = 39;

/** Развернуть собранное СИНХРОННО; ошибку перебрасывает КАК ЕСТЬ (образец `gate-c8-18.test.ts:203`). */
const taken = (v: unknown): unknown => {
  if (v !== null && typeof v === 'object' && 'err' in (v as object))
    throw (v as { err: unknown }).err;
  return (v as { ok: unknown }).ok;
};

describe('корпус §С1-2: состав', () => {
  test('21 строка, 24 имени кода, жанры 17/4, порч ≥ 1 на строку', () => {
    // Точные литералы, а не пороги: с «не меньше двадцати» удаление строки прошло бы незаметно
    // (урок гейт-ревью 2 Б-1; тот же приём — `validator-golden.test.ts:130-133`).
    expect(REFUSAL_ROWS.length).toBe(21);
    expect(REFUSAL_ROWS.map((r) => r.row)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(new Set(REFUSAL_ROWS.flatMap((r) => r.codes)).size).toBe(24);
    expect(REFUSAL_ROWS.filter((r) => r.genre === 'declaration').length).toBe(17);
    expect(REFUSAL_ROWS.filter((r) => r.genre === 'data').map((r) => r.row)).toEqual([
      2, 10, 13, 21,
    ]);
    expect(REFUSAL_ROWS.filter((r) => r.spoils.length === 0).map((r) => r.row)).toEqual([]);
  });

  test('красных строк не осталось: 21/21 закрыты валидаторами среза (§С8-24)', () => {
    // Имена строк, а не число: «ноль» без перечня не сказал бы, КАКАЯ строка осталась красной.
    // Последние шесть закрыли задачи 1 (11/19/20) и 6 (3/15/18) тем же коммитом, что положил валидатор.
    expect(REFUSAL_ROWS.filter((r) => r.red === true).map((r) => r.row)).toEqual([]);
  });

  test('мутационная проверка §С8-24: порч ровно SPOILS_CHECKED, у каждой строки — минимум одна', () => {
    expect(REFUSAL_ROWS.reduce((n, r) => n + r.spoils.length, 0)).toBe(SPOILS_CHECKED);
    expect(REFUSAL_ROWS.filter((r) => r.spoils.length === 0).map((r) => r.row)).toEqual([]);
  });

  test('все 24 имени кода достижимы отказом или порчей — ни одно не объявлено вхолостую', () => {
    const seen = new Set<string>();
    for (const r of REFUSAL_ROWS) {
      const cell = collected.get(r.row);
      seen.add(String(taken(cell?.refuse)));
      for (const s of cell?.spoils ?? []) seen.add(String(taken(s)));
    }
    const declared = new Set(REFUSAL_ROWS.flatMap((r) => r.codes.map(String)));
    expect([...declared].filter((c) => !seen.has(c)).sort()).toEqual([]);
    expect(declared.size).toBe(24);
  });
});

// Вехи I–III перенесли доменные инварианты в данные, и движок правил встал на все три пути записи:
// дверь строки жанра «данные» могла сместиться — отказ перехватило бы правило раньше. Проверка —
// прогоном, а не пересказом: 2 (запись пользователем, пока `nearest_ancestor` пишет механизмом
// `rule`), 10 (движок Повестки), 13 (`created_by` роли — ограничение роли, а не метка
// `target_max_incoming`), 21 (гейт модуля до C-правил; порча «без даты» ловит смещение).
describe('жанр «данные» после переезда инвариантов (вехи I–III)', () => {
  test('жанр «данные»: четыре строки — и каждая по-прежнему отказ СВОЕГО кода, а не правила', () => {
    const data = REFUSAL_ROWS.filter((r) => r.genre === 'data');
    expect(data.map((r) => r.row)).toEqual([2, 10, 13, 21]);
    for (const r of data) {
      const got = taken(collected.get(r.row)?.refuse);
      // Имя строки в ожидании — чтобы провал назывался строкой, а не «expected X to be Y».
      expect(`${r.row}: ${String(got)}`).toBe(`${r.row}: ${r.codes[0]}`);
    }
  });

  test('строка 10: отказ движка — полной формы: subscription, contract, slot, entityId, aspects', () => {
    // Без `aspects` движок снова мог бы выбирать первую попавшуюся привязку молча — отказ, не
    // называющий обеих, владельцу ничего не объясняет.
    const { got, want } = taken(slotDetails) as { got: unknown; want: unknown };
    expect(got).toEqual(want);
  });
});

for (const r of REFUSAL_ROWS) {
  const mark = r.red === true ? test.failing : test;
  const expected = (got: string) => (r.codes.includes(got as never) ? got : r.codes.join('/'));
  describe(`строка ${r.row} (${r.codes.join('/')}, ${r.genre})`, () => {
    mark('позитив проходит — валидатор отвергает не всё подряд', () => {
      taken(collected.get(r.row)?.positive);
    });
    mark('канонический отказ даёт код строки', () => {
      const got = String(taken(collected.get(r.row)?.refuse));
      expect(`${r.row}: ${got}`).toBe(`${r.row}: ${expected(got)}`);
    });
    mark('каждая порча меняет вердикт на код строки', () => {
      const cell = collected.get(r.row);
      expect(cell?.spoils.length).toBe(r.spoils.length);
      for (const [i, raw] of (cell?.spoils ?? []).entries()) {
        const got = String(taken(raw));
        const name = r.spoils[i]?.name ?? '';
        expect(`${name}: ${got}`).toBe(`${name}: ${expected(got)}`);
      }
    });
    mark('все имена кодов строки достижимы (отказ ∪ порчи)', () => {
      const cell = collected.get(r.row);
      const seen = new Set([
        String(taken(cell?.refuse)),
        ...(cell?.spoils ?? []).map((s) => String(taken(s))),
      ]);
      expect([...r.codes].filter((c) => !seen.has(String(c)))).toEqual([]);
    });
  });
}
