// apps/server/src/query/compile.golden.test.ts
// Golden-тесты «текст запроса → Q-AST → SQL+params» (§6.2, §А5-7). Фикстуры — НЕ «что
// вышло», а посчитанный ВРУЧНУЮ эталон: каждая пара {sql, params} выведена из нормативной
// таблицы семантики PRD 01 §6.1 и перечня узлов §А5-7, а не снята с прогона. Порядок
// работы над файлом (он же защита от того, чтобы компилятор выписал себе справку):
// считать руками — сверить — дописывать, читая дифф. Записывать сюда вывод компилятора
// ЗАПРЕЩЕНО: эталон, снятый с реализации, подтверждает только то, что она не изменилась.
//
// ЭТУ ЗАЩИТУ НЕЛЬЗЯ ЗАМЕНИТЬ ТЕСТОМ, и делать вид, что можно, — вреднее, чем не делать.
// Здесь стоял блок «мутация эталона ломает сверку»: он портил оператор в `sql` эталона и
// требовал, чтобы вывод компилятора с испорченной строкой не совпал. Блок был ТАВТОЛОГИЧЕН
// и упасть не мог: соседний describe уже требует `вывод === g.sql`, а значит из
// `mutated !== g.sql` неравенство следует само (найдено предфильтром Задачи 9a; он же
// показал живьём: испорченный эталон #44 роняет сверку и НЕ роняет «мутационный» блок).
// Единственное, что такая проверка способна установить, — что подстановка вообще
// применилась, то есть утверждение о ФИКСТУРАХ, а не о компиляторе.
//
// Чем защищён этот файл на самом деле: (1) все эталоны посчитаны ВРУЧНУЮ по §6.1 и §А5-7 до
// первого прогона компилятора; (2) двенадцать эталонов семи классов пересчитаны НЕЗАВИСИМО
// на предфильтре — расхождений ноль; (3) поведение компилятора пиннится мутациями САМОГО
// компилятора (таблица в отчёте Задачи 9a), где мутация роняет именно этот файл.
//
// Проверяются ДВА перехода, потому что сломаться они могут порознь:
//   1. `query` → `ast` — парсер по реестру (`parseQueryAst`, Задача 8);
//   2. `ast` → `sql`/`params` — НОВЫЙ компилятор (`compile-ast.ts`, эта задача).
// Эталон с `query: null` — дерево, которое плоская грамматика v1 не выражает (§А5-3д):
// у него проверяется только второй переход.
//
// Юнит-тесты СТАРОГО компилятора `compile.ts` жили ниже по файлу и удалены вместе с ним
// (Задача 9b): потребителей у него не осталось ни одного.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
} from '@orbis/shared';
import {
  parseQueryAst,
  QUERY_TREE_DEPTH_CAP,
  type QueryAst,
  toParseRegistry,
} from '@orbis/shared/query';
import { PgDialect } from 'drizzle-orm/pg-core';
import goldens from '../../test/golden/query-sql.json';
import type { RegistrySnapshot } from '../registry/load';
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

test('самый глубокий эталон набора — 8 уровней, то есть много ниже капа глубины', () => {
  // Число живёт в докблоке `QUERY_TREE_DEPTH_CAP` («самый глубокий эталон — 8») и в тексте
  // отказа гейта; посчитанное здесь, оно перестанет быть правдой громко, а не молча.
  const depth = (v: unknown): number => {
    if (typeof v !== 'object' || v === null) return 0;
    let max = 0;
    for (const child of Array.isArray(v) ? v : Object.values(v)) max = Math.max(max, depth(child));
    return max + 1;
  };
  const deepest = Math.max(...GOLDENS.map((g) => depth(g.ast)));
  expect(deepest).toBe(8);
  expect(deepest).toBeLessThan(QUERY_TREE_DEPTH_CAP);
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
