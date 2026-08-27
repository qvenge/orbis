// apps/server/src/query/compile.golden.test.ts
// Golden-тесты «текст запроса → Q-AST → SQL+params» (§6.2, §А5-7). Фикстуры — НЕ «что
// вышло», а посчитанный ВРУЧНУЮ эталон: каждая пара {sql, params} выведена из нормативной
// таблицы семантики PRD 01 §6.1 и перечня узлов §А5-7, а не снята с прогона. Порядок
// работы над файлом (он же защита от того, чтобы компилятор выписал себе справку):
// считать руками — сверить — дописывать, читая дифф. Записывать сюда вывод компилятора
// ЗАПРЕЩЕНО: эталон, снятый с реализации, подтверждает только то, что она не изменилась.
//
// Проверяются ДВА перехода, потому что сломаться они могут порознь:
//   1. `query` → `ast` — парсер по реестру (`parseQueryAst`, Задача 8);
//   2. `ast` → `sql`/`params` — НОВЫЙ компилятор (`compile-ast.ts`, эта задача).
// Эталон с `query: null` — дерево, которое плоская грамматика v1 не выражает (§А5-3д):
// у него проверяется только второй переход.
//
// НИЖЕ ПО ФАЙЛУ (после golden-блоков) живут юнит-тесты СТАРОГО компилятора `compile.ts`.
// Он не тронут этой задачей и работает до Задачи 9b — снимать с него покрытие в задаче,
// которая его не переключает, значило бы разменять проверенное поведение на аккуратность
// раскладки файлов.
import { describe, expect, test } from 'bun:test';
import {
  aspectJsonSchema,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_ASPECT_IDS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  buildFieldCatalog,
  parseQuery,
} from '@orbis/shared';
import { parseQueryAst, type QueryAst, toParseRegistry } from '@orbis/shared/query';
import { PgDialect } from 'drizzle-orm/pg-core';
import goldens from '../../test/golden/query-sql.json';
import type { RegistrySnapshot } from '../registry/load';
import {
  compileCount,
  compileLatest,
  compileQuery,
  compileSum,
  QueryCompileError,
  QueryFieldError,
} from './compile';
import { type CompileCtx, compileCountAst, compileQueryAst } from './compile-ast';

const dialect = new PgDialect();

/**
 * Снимок реестра из ВСТРОЕННЫХ словарей — без БД. Того же состава, что кладёт сид
 * (`scripts/seed-registries.ts` берёт те же три массива), поэтому эталон здесь и выдача на
 * живой базе (`compile.dataset.test.ts`) считаются по одному и тому же реестру.
 */
const REG: RegistrySnapshot = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
  roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
  ownerVersion: 0,
  systemVersion: 1,
};

const PARSE_REG = toParseRegistry(REG, 'ru');

const CTX: CompileCtx = {
  ownerId: '00000000-0000-7000-8000-0000000000a1',
  today: '2026-07-03',
  timeZone: 'Europe/Moscow',
  reg: REG,
  thisEntityId: '00000000-0000-7000-8000-0000000000f1',
};

interface Golden {
  name: string;
  /** Текст key-формы; null — дерево плоской грамматикой v1 не выражается (§А5-3д). */
  query: string | null;
  ast: QueryAst;
  sql: string;
  params: unknown[];
  /** Опционально: эталон `compileCountAst` для той же строки (бейджи 02 §3.2). */
  countSql?: string;
  countParams?: unknown[];
}

const GOLDENS = goldens as Golden[];

const flat = (text: string): string => text.replaceAll(/\s+/g, ' ').trim();

describe('golden: текст → Q-AST (парсер по реестру, §А5-3)', () => {
  for (const g of GOLDENS.filter((x) => x.query !== null)) {
    test(g.name, () => {
      const parsed = parseQueryAst(g.query as string, PARSE_REG);
      if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
      expect(parsed.ast).toEqual(g.ast);
    });
  }
});

describe('golden: Q-AST → SQL (новый компилятор, §А5-7)', () => {
  for (const g of GOLDENS) {
    test(g.name, () => {
      const q = dialect.sqlToQuery(compileQueryAst(g.ast, CTX));
      expect(flat(q.sql)).toBe(g.sql);
      expect(q.params).toEqual(g.params);
    });
  }
});

describe('golden: compileCountAst — COUNT(*) без limit/sortBy/капа (02 §3.2)', () => {
  const withCount = GOLDENS.filter(
    (x): x is Golden & { countSql: string; countParams: unknown[] } => x.countSql !== undefined,
  );
  test('эталоны count заведены не на один запрос', () => {
    expect(withCount.length).toBeGreaterThanOrEqual(3);
  });
  for (const g of withCount) {
    test(g.name, () => {
      const q = dialect.sqlToQuery(compileCountAst(g.ast, CTX));
      expect(flat(q.sql)).toBe(g.countSql);
      expect(q.params).toEqual(g.countParams);
    });
  }
});

/**
 * Мутации эталона: порча ОДНОГО оператора обязана ломать сверку.
 *
 * Без этой проверки зелёный golden доказывал бы только то, что сверка выполнилась, — а не
 * то, что она различает. Порядок мутаций перебирается до первой применимой, и «ни одна не
 * подошла» — ОШИБКА, а не пропуск: эталон, который нечем испортить, сверяется вхолостую.
 */
const MUTATIONS: readonly (readonly [string, string])[] = [
  [' AND ', ' OR '],
  [' = ', ' <> '],
  [' > ', ' < '],
  [' < ', ' > '],
  ['NOT COALESCE', 'COALESCE'],
  ['NOT archived', 'archived'],
  ['@>', '&&'],
  ['?', '@?'],
];

describe('golden: мутация эталона ломает сверку', () => {
  for (const g of GOLDENS) {
    test(g.name, () => {
      const mutation = MUTATIONS.find(([from]) => g.sql.includes(from));
      if (!mutation) throw new Error(`эталон «${g.name}» нечем испортить: сверка вхолостую`);
      const [from, to] = mutation;
      const mutated = g.sql.replace(from, to);
      expect(mutated).not.toBe(g.sql);
      const actual = flat(dialect.sqlToQuery(compileQueryAst(g.ast, CTX)).sql);
      expect(actual).not.toBe(mutated);
    });
  }
});

// ─────────────────────── Юнит-тесты СТАРОГО компилятора (`compile.ts`) ───────────────────────
// Он жив до Задачи 9b и до неё же остаётся под своими проверками; каталог и контекст у него
// свои — старой формы (поля аспектов, а не id свойств).

const legacyCatalog = buildFieldCatalog(
  BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
);
const LEGACY_CTX = {
  catalog: legacyCatalog,
  thisEntityId: '00000000-0000-7000-8000-0000000000f1',
  today: '2026-07-03',
  timezone: 'Europe/Moscow',
} as const;

describe('golden: compileLatest — последнее значение поля (§11.3, цели)', () => {
  test('та же WHERE-выборка, свой порядок, LIMIT 1; sortBy/limit запроса игнорируются', () => {
    // sortBy/limit в строке запроса намеренно другие: агрегат считается по ВСЕЙ выборке
    // и в своём порядке — ровно как compileCount игнорирует limit (02 §3.2).
    const parsed = parseQuery(
      'aspect=orbis/financial, tags=savings, sortBy=amount:desc, limit=5',
      legacyCatalog,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const q = dialect.sqlToQuery(compileLatest(parsed.ast, LEGACY_CTX, 'amount'));
    expect(q.sql.replaceAll(/\s+/g, ' ').trim()).toBe(
      "SELECT (aspects_legacy->'orbis/financial'->>'amount')::numeric::text AS value FROM entities " +
        'WHERE true AND NOT archived AND NOT (aspects_legacy ?| ARRAY[$1]::text[]) ' +
        'AND aspects_legacy ? $2 AND tags && ARRAY[$3]::text[] ' +
        "AND aspects_legacy->'orbis/financial'->>'amount' IS NOT NULL " +
        'ORDER BY updated_at DESC, id DESC LIMIT 1',
    );
    expect(q.params).toEqual(['orbis/agent-run', 'orbis/financial', 'savings']);
  });

  test('нечисловое и неизвестное поле — QueryFieldError (и он же QueryCompileError)', () => {
    const parsed = parseQuery('aspect=orbis/financial', legacyCatalog);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Подкласс обязан оставаться ловимым старыми catch-ами по QueryCompileError:
    // на этом держатся маппинги в BAD_REQUEST (роутер) и VALIDATION (диспатч тулов).
    expect(() => compileLatest(parsed.ast, LEGACY_CTX, 'counterparty')).toThrow(QueryFieldError);
    expect(() => compileLatest(parsed.ast, LEGACY_CTX, 'counterparty')).toThrow(QueryCompileError);
    expect(() => compileLatest(parsed.ast, LEGACY_CTX, 'нетtакого')).toThrow(QueryFieldError);
    expect(() => compileSum(parsed.ast, LEGACY_CTX, 'counterparty')).toThrow(QueryFieldError);
    // Ошибка запроса (а не поля) подклассом НЕ является — иначе цель не отличила бы
    // сломанный запрос от сломанного поля (§11.3, fail-soft прогресса).
    const noThis = { ...LEGACY_CTX, thisEntityId: null };
    const self = parseQuery('children_of=this', legacyCatalog);
    expect(self.ok).toBe(true);
    if (!self.ok) return;
    expect(() => compileCount(self.ast, noThis)).not.toThrow(QueryFieldError);
    expect(() => compileCount(self.ast, noThis)).toThrow(QueryCompileError);
  });
});

// Поле-массив внутри аспекта (orbis/category.aliases). До этой задачи каталог выдавал
// его за строку, и `aspects_legacy->'A'->>'aliases' IN ($1)` сравнивал ТЕКСТ всего массива:
// `aliases=такси` давал тихий ноль, `aliases=!такси` возвращал все 12 категорий подряд.
describe('поле-массив: containment вместо текстового равенства', () => {
  const compileFor = (query: string) => {
    const parsed = parseQuery(query, legacyCatalog);
    if (!parsed.ok) throw new Error(`невалидный запрос в тесте: ${parsed.error.message}`);
    return dialect.sqlToQuery(compileQuery(parsed.ast, LEGACY_CTX));
  };

  test('фильтр по полю-массиву компилируется в containment, а не в текстовое равенство', () => {
    const c = compileFor('aspect=orbis/category, aliases=такси');
    expect(c.sql).toContain('aspects_legacy @> jsonb_build_object');
    expect(c.sql).not.toContain(`->>'aliases'`);
    expect(c.params).toContain('такси');
    // Путь строится параметрами от корня aspects — то, что делает предикат индексным.
    expect(c.params).toContain('orbis/category');
    expect(c.params).toContain('aliases');
  });

  test('несколько значений массива — OR по containment', () => {
    const c = compileFor('aspect=orbis/category, aliases=такси|метро');
    expect(c.sql.match(/jsonb_build_object/g)?.length).toBeGreaterThanOrEqual(4);
    expect(c.sql).toContain(' OR ');
    expect(c.params).toContain('такси');
    expect(c.params).toContain('метро');
  });

  test('отрицание по массиву — NOT containment (сущности без аспекта проходят)', () => {
    const c = compileFor('aspect=orbis/category, aliases=!такси');
    expect(c.sql).toContain('NOT (aspects_legacy @> jsonb_build_object');
    // Ветки `IS NULL` тут нет намеренно: NOT (@>) истинно и без аспекта вовсе.
    expect(c.sql).not.toContain('IS NULL');
  });

  test('несколько отрицаний — AND по NOT containment', () => {
    const c = compileFor('aspect=orbis/category, aliases=!такси&!метро');
    expect(c.sql.match(/NOT \(aspects_legacy @> jsonb_build_object/g)?.length).toBe(2);
  });

  test('числовой на вид литерал ищется в обеих кодировках jsonb: "5" и 5', () => {
    // Containment строго типизирован — `@> '["5"]'` не находит `[5]`. Тип элемента
    // каталог не несёт, поэтому компилятор перебирает обе кодировки; ложных
    // срабатываний нет — «чужая» ветка не совпадает никогда (проверено на живой базе).
    const numeric = buildFieldCatalog([
      {
        id: 'x/probe',
        schema: { properties: { nums: { type: 'array', items: { type: 'integer' } } } },
      },
    ]);
    const parsed = parseQuery('aspect=x/probe, nums=5', numeric);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const c = dialect.sqlToQuery(compileQuery(parsed.ast, { ...LEGACY_CTX, catalog: numeric }));
    expect(c.sql).toContain('jsonb_build_array($5::text)');
    expect(c.sql).toContain('jsonb_build_array($8::numeric)');
    // Нечисловой литерал лишней ветки не получает — обычный путь не дорожает.
    const plain = compileFor('aspect=orbis/category, aliases=такси');
    expect(plain.sql).not.toContain('::numeric');
  });

  test('литерал вне области определения numeric числовой ветки не получает', () => {
    // Без ограничения длины `::numeric` отвечал бы «value overflows numeric format» —
    // ошибка исполнения там, где до задачи была честная пустая выдача. Граница —
    // ровно область определения numeric (16383 знака после точки, 131072 до),
    // поэтому ни одна находка не теряется: числа jsonb хранятся как numeric.
    const numeric = buildFieldCatalog([
      {
        id: 'x/probe',
        schema: { properties: { nums: { type: 'array', items: { type: 'integer' } } } },
      },
    ]);
    const sqlFor = (literal: string) => {
      const parsed = parseQuery(`aspect=x/probe, nums=${literal}`, numeric);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return dialect.sqlToQuery(compileQuery(parsed.ast, { ...LEGACY_CTX, catalog: numeric }));
    };
    // На границе — ветка есть (такое значение numeric принимает, проверено на живой базе)
    expect(sqlFor(`0.${'1'.repeat(16383)}`).sql).toContain('::numeric');
    expect(sqlFor('1'.repeat(131072)).sql).toContain('::numeric');
    // На знак дальше — ветки нет, литерал уезжает только текстом и находит ноль строк
    const tooLongFrac = sqlFor(`0.${'1'.repeat(16384)}`);
    expect(tooLongFrac.sql).not.toContain('::numeric');
    expect(tooLongFrac.params).toContain(`0.${'1'.repeat(16384)}`);
    expect(sqlFor('1'.repeat(131073)).sql).not.toContain('::numeric');
  });

  test('сортировка по массиву недостижима парсером, но компилятор не молчит', () => {
    // Раньше default sortCast сортировал бы по тексту JSON — по порядку сериализации.
    const parsed = parseQuery('aspect=orbis/category, sortBy=title:asc', legacyCatalog);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const broken = { ...parsed.ast, sortBy: [{ field: 'aliases', direction: 'asc' as const }] };
    expect(() => compileQuery(broken, LEGACY_CTX)).toThrow(QueryCompileError);
    // Внутреннее имя типа наружу не выпускается — как и в отказах парсера.
    expect(() => compileQuery(broken, LEGACY_CTX)).toThrow(/типа 'массив'/);
  });

  test('фильтр по нефильтруемому полю недостижим парсером, но компилятор не молчит', () => {
    // Симметрично сортировке и по той же причине: ветка скаляра сравнила бы `->>` —
    // текст сериализации всего объекта, то есть тихий ноль на равенстве и вся таблица
    // на отрицании. Ровно тот дефект, который чинила эта ветка, только этажом ниже.
    const parsed = parseQuery('aspect=orbis/schedule', legacyCatalog);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const broken = {
      ...parsed.ast,
      filters: [
        ...parsed.ast.filters,
        {
          kind: 'field' as const,
          field: 'recurrence',
          condition: {
            kind: 'anyOf' as const,
            values: [{ kind: 'literal' as const, value: 'weekly' }],
          },
        },
      ],
    };
    expect(() => compileQuery(broken, LEGACY_CTX)).toThrow(QueryCompileError);
    expect(() => compileQuery(broken, LEGACY_CTX)).toThrow(/типа 'не скаляр'/);
  });

  test('агрегат по полю-массиву отказывает человеческим именем типа', () => {
    const parsed = parseQuery('aspect=orbis/category', legacyCatalog);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(() => compileSum(parsed.ast, LEGACY_CTX, 'aliases')).toThrow(/тип 'массив' не числовой/);
    const sched = parseQuery('aspect=orbis/schedule', legacyCatalog);
    expect(sched.ok).toBe(true);
    if (!sched.ok) return;
    expect(() => compileSum(sched.ast, LEGACY_CTX, 'recurrence')).toThrow(
      /тип 'не скаляр' не числовой/,
    );
  });

  test('enum с числовыми значениями сортируется, а не падает TypeError', () => {
    // Каталог клал в enumValues ЧИСЛА при объявленном типе string[], и CASE-ветка
    // sortItem звала .replaceAll на числе — 500 на ровном месте.
    const numeric = buildFieldCatalog([
      { id: 'x/probe', schema: { properties: { level: { type: 'integer', enum: [3, 1, 2] } } } },
    ]);
    const parsed = parseQuery('aspect=x/probe, sortBy=level:asc', numeric);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const c = dialect.sqlToQuery(compileQuery(parsed.ast, { ...LEGACY_CTX, catalog: numeric }));
    expect(c.sql).toContain(`WHEN '3' THEN 0 WHEN '1' THEN 1 WHEN '2' THEN 2`);
  });
});

describe('this вне контекста сущности — структурная ошибка компиляции', () => {
  const noThis = { ...LEGACY_CTX, thisEntityId: null };
  test('children_of=this при thisEntityId=null', () => {
    const parsed = parseQuery('children_of=this', legacyCatalog);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(() => compileQuery(parsed.ast, noThis)).toThrow(QueryCompileError);
    expect(() => compileQuery(parsed.ast, noThis)).toThrow(/this вне контекста сущности/);
  });
  test('parents_of=this при thisEntityId=null — и в compileCount тоже', () => {
    const parsed = parseQuery('parents_of=this', legacyCatalog);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(() => compileCount(parsed.ast, noThis)).toThrow(/this вне контекста сущности/);
  });
});
