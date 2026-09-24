// apps/server/src/registry/refusals.test.ts
// КОРПУС 21 КАНОНИЧЕСКОГО ОТКАЗА (§С1-2, приёмка §С8-24): вердикты объявлены ДАННЫМИ
// (`test/fixtures/refusals.ts`), здесь только прогон и пины — образец разделения `EXPR_FIXTURES`.
// ВСЕ походы — в `beforeAll`, тела тестов СИНХРОННЫ: Bun 1.2.7 игнорирует пометку ожидаемого
// провала, если тест вышел в макрозадачу (ОВ-Б1-1), и ломаются обе половины гарантии.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeRefusals, prepareRefusals, REFUSAL_ROWS } from '../../test/fixtures/refusals';
import { requireEnv } from '../../test/helpers';

requireEnv();
type Cell = { positive: unknown; refuse: unknown; spoils: unknown[] };
const collected = new Map<number, Cell>();
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
});
afterAll(async () => {
  await closeRefusals();
});

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
