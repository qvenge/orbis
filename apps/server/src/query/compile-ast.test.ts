// apps/server/src/query/compile-ast.test.ts
// Юнит-тесты нового компилятора: то, чего НЕ видно в golden, — отказы и чтение реестра.
//
// Golden (`compile.golden.test.ts`) пиннит текст SQL на 48 деревьях; здесь проверяется
// другое: что компилятор ОТКАЗЫВАЕТ там, где семантики нет, и что списки служебных
// аспектов и иерархических ролей он берёт ИЗ СНИМКА РЕЕСТРА, а не из констант. Второе
// проверяется единственным способом, который что-то доказывает, — подменой снимка:
// на литерале в коде такой тест был бы зелёным при любой реализации.
import { describe, expect, test } from 'bun:test';
import {
  type AspectDefinition,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  type RelationRoleDefinition,
} from '@orbis/shared';
import { QUERY_DEPTH_CAP, type QueryAst, type QueryFilterNode } from '@orbis/shared/query';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ExecError } from '../errors';
import type { RegistrySnapshot } from '../registry/load';
import {
  type CompileCtx,
  compileCountAst,
  compileLatestAst,
  compileQueryAst,
  compileSumAst,
} from './compile-ast';

const dialect = new PgDialect();

function snapshot(over: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
  return {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
    ownerVersion: 0,
    systemVersion: 1,
    ...over,
  };
}

function ctxOf(over: Partial<CompileCtx> = {}): CompileCtx {
  return {
    ownerId: '00000000-0000-7000-8000-0000000000a1',
    today: '2026-07-03',
    timeZone: 'Europe/Moscow',
    reg: snapshot(),
    thisEntityId: '00000000-0000-7000-8000-0000000000f1',
    ...over,
  };
}

const CTX = ctxOf();

/** Плоский SQL запроса по одному узлу фильтра. */
function sqlOf(filter: QueryFilterNode | null, ctx: CompileCtx = CTX): string {
  return dialect.sqlToQuery(compileQueryAst({ filter }, ctx)).sql.replaceAll(/\s+/g, ' ').trim();
}

/** Отказ компилятора: код всегда VALIDATION, различает причина в details. */
function refusal(fn: () => unknown): { code: string; reason: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExecError) {
      return {
        code: e.code,
        reason: String((e.details as { reason?: unknown })?.reason),
        message: e.message,
      };
    }
    throw e;
  }
  throw new Error('ожидался отказ компиляции, а его не было');
}

describe('отказы вместо тихой пустоты (§С8-3, §6.4)', () => {
  test('class — часть Б: CLASS_NOT_AVAILABLE, а не отбор «не того»', () => {
    const r = refusal(() => sqlOf({ class: { contract: 'orbis/completable', set: 'closed' } }));
    expect(r.code).toBe('VALIDATION');
    expect(r.reason).toBe('CLASS_NOT_AVAILABLE');
  });

  test('of не UUID — отказ ДО SQL (иначе Postgres ответил бы 22P02, а не полем)', () => {
    const r = refusal(() => sqlOf({ rel: { kind: 'children_of', of: 'banana' } }));
    expect(r.code).toBe('VALIDATION');
    expect(r.message).toContain('banana');
  });

  test('this без контекста сущности — отказ, а не подстановка чего-нибудь', () => {
    const r = refusal(() =>
      sqlOf({ rel: { kind: 'parents_of', of: 'this' } }, ctxOf({ thisEntityId: null })),
    );
    expect(r.reason).toBe('THIS_OUT_OF_CONTEXT');
    // Тот же узел с контекстом компилируется — отказ именно про контекст, а не про узел.
    expect(sqlOf({ rel: { kind: 'parents_of', of: 'this' } })).toContain('r.target_id = $2');
  });

  test('неизвестные id свойства, аспекта и роли — три разные причины', () => {
    expect(refusal(() => sqlOf({ prop: 'orbis/нетtакого', op: 'eq', value: 'x' })).reason).toBe(
      'UNKNOWN_FIELD',
    );
    expect(refusal(() => sqlOf({ aspect: 'orbis/нетtакого' })).reason).toBe('UNKNOWN_ASPECT');
    expect(refusal(() => sqlOf({ rel: { kind: 'has_relation', via: 'нетtакой' } })).reason).toBe(
      'UNKNOWN_ROLE',
    );
  });

  test('json-свойство: фильтровать нечем, но has(prop) по нему законен', () => {
    expect(
      refusal(() => sqlOf({ prop: 'orbis/recurrence', op: 'eq', value: 'weekly' })).reason,
    ).toBe('TYPE');
    expect(
      refusal(() =>
        compileQueryAst({ filter: null, sortBy: [{ field: 'orbis/recurrence', dir: 'asc' }] }, CTX),
      ).reason,
    ).toBe('TYPE');
    expect(sqlOf({ has: 'orbis/recurrence' })).toContain(`props ? 'orbis/recurrence'`);
  });

  test('сортировка по списочному свойству — отказ (линейного порядка у списка нет)', () => {
    const r = refusal(() =>
      compileQueryAst({ filter: null, sortBy: [{ field: 'orbis/aliases', dir: 'asc' }] }, CTX),
    );
    expect(r.reason).toBe('TYPE');
    expect(r.message).toContain('orbis/aliases');
  });

  test('значение не того типа, что объявил реестр, — отказ (вход ast: идёт мимо парсера)', () => {
    // decimal обязан быть СТРОКОЙ: число IEEE-754 теряет хвост копеек (§А7-3).
    expect(refusal(() => sqlOf({ prop: 'orbis/amount', op: 'eq', value: 1000 })).reason).toBe(
      'TYPE',
    );
    // Элемент списка тоже: `{"orbis/aliases":[5]}` не нашёл бы `["5"]` — тихий ноль.
    expect(refusal(() => sqlOf({ prop: 'orbis/aliases', op: 'contains', value: 5 })).reason).toBe(
      'TYPE',
    );
    expect(refusal(() => sqlOf({ prop: 'orbis/all_day', op: 'eq', value: 'true' })).reason).toBe(
      'TYPE',
    );
  });
});

describe('долг гейта Задачи 8: eq/ne на списке и contains на скаляре — отказ', () => {
  // Печать §А5-2 даёт `{op:'eq'}` и `{op:'contains'}` на списочном свойстве ОДИН текст
  // `p=v`. Придай мы `eq` какой-нибудь смысл — правка `eq`→`contains` в предложении стала
  // бы невидимой в диффе Ш1, который меряет правки именно key-печатью. Отказ убирает пару.
  test('eq и ne на списочном свойстве отвергаются с именем свойства', () => {
    for (const op of ['eq', 'ne', 'gt', 'lt'] as const) {
      const r = refusal(() => sqlOf({ prop: 'orbis/aliases', op, value: 'такси' }));
      expect(r.reason).toBe('TYPE');
      expect(r.message).toContain('orbis/aliases');
    }
    expect(
      refusal(() => sqlOf({ prop: 'orbis/aliases', op: 'range', value: { from: 'а' } })).reason,
    ).toBe('TYPE');
  });

  test('contains на скалярном свойстве отвергается и называет search= как замену', () => {
    const r = refusal(() => sqlOf({ prop: 'orbis/location', op: 'contains', value: 'дом' }));
    expect(r.reason).toBe('TYPE');
    expect(r.message).toContain('search=');
  });

  test('contains и in по списку — единственные законные, и оба компилируются', () => {
    expect(sqlOf({ prop: 'orbis/aliases', op: 'contains', value: 'такси' })).toContain(
      'props @> $2::jsonb',
    );
    expect(sqlOf({ prop: 'orbis/aliases', op: 'in', value: ['такси', 'метро'] })).toContain(
      '(props @> $2::jsonb OR props @> $3::jsonb)',
    );
  });
});

describe('списки берутся ИЗ СНИМКА РЕЕСТРА, а не из констант кода', () => {
  test('служебный аспект — колонка service: подменили колонку, изменился WHERE', () => {
    // orbis/task объявлен служебным, orbis/agent-run — обычным: если бы список был
    // литералом в коде, оба условия остались бы прежними.
    const flipped = new Map<string, AspectDefinition>();
    for (const a of BUILTIN_ASPECT_DEFS) {
      flipped.set(a.id, { ...a, service: a.id === 'orbis/task' });
    }
    const ctx = ctxOf({ reg: snapshot({ aspects: flipped }) });
    const sql = sqlOf({ tag: 'дом' }, ctx);
    expect(sql).toContain('NOT (aspects && ARRAY[$1]::text[])');
    expect(dialect.sqlToQuery(compileQueryAst({ filter: { tag: 'дом' } }, ctx)).params[0]).toBe(
      'orbis/task',
    );
    // Запрос, назвавший НОВЫЙ служебный аспект, прячущего условия не получает.
    expect(sqlOf({ aspect: 'orbis/task' }, ctx)).not.toContain('NOT (aspects &&');
    // А старый служебный больше не прячется — и его аспект в запросе ничего не снимает.
    expect(sqlOf({ aspect: 'orbis/agent-run' }, ctx)).toContain('NOT (aspects && ARRAY[$1]');
  });

  test('свойство служебного аспекта считается упоминанием, а общее с обычным — нет', () => {
    // orbis/run_outcome объявлен ТОЛЬКО прогоном — упоминание.
    expect(sqlOf({ prop: 'orbis/run_outcome', op: 'eq', value: 'running' })).not.toContain(
      'NOT (aspects &&',
    );
    // orbis/grant объявлен и назначением, и прогоном — по нему нельзя сказать, спрашивали
    // ли про прогоны, поэтому прячущее условие остаётся.
    expect(
      sqlOf({ prop: 'orbis/grant', op: 'eq', value: '019eb2f4-1a00-7b6e-9c01-5d2f8a3b4c10' }),
    ).toContain('NOT (aspects &&');
  });

  test('семейство иерархии — признак hierarchical реестра, а не HIERARCHICAL_ROLE_IDS', () => {
    const roles = new Map<string, RelationRoleDefinition>();
    for (const r of BUILTIN_RELATION_ROLE_META) {
      roles.set(r.id, { ...r, hierarchical: r.id === 'mention' });
    }
    const q = dialect.sqlToQuery(
      compileQueryAst(
        { filter: { rel: { kind: 'has_children' } } },
        ctxOf({ reg: snapshot({ roles }) }),
      ),
    );
    expect(q.params).toContain('mention');
    expect(q.params).not.toContain('subitem');
  });

  test('реестр без единой иерархической роли: «детей» нет ни у кого, а не у всех', () => {
    const roles = new Map<string, RelationRoleDefinition>();
    for (const r of BUILTIN_RELATION_ROLE_META) roles.set(r.id, { ...r, hierarchical: false });
    const sql = sqlOf({ rel: { kind: 'has_children' } }, ctxOf({ reg: snapshot({ roles }) }));
    expect(sql).toContain('WHERE r.source_id = e.id AND false');
  });

  test('порядок вариантов select в сортировке — rank реестра, а не позиция в массиве', () => {
    const props = new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p]));
    const priority = props.get('orbis/priority');
    if (!priority || priority.type.kind !== 'select') throw new Error('фикстура устарела');
    props.set('orbis/priority', {
      ...priority,
      type: {
        ...priority.type,
        options: priority.type.options.map((o) => ({ ...o, rank: o.rank + 10 })),
      },
    });
    const sql = dialect
      .sqlToQuery(
        compileQueryAst(
          { filter: null, sortBy: [{ field: 'orbis/priority', dir: 'desc' }] },
          ctxOf({ reg: snapshot({ properties: props }) }),
        ),
      )
      .sql.replaceAll(/\s+/g, ' ');
    expect(sql).toContain(`WHEN 'low' THEN 11 WHEN 'medium' THEN 12 WHEN 'high' THEN 13`);
  });
});

describe('токен в роли ГРАНИЦЫ: якорь — день, вокруг которого токен определён', () => {
  // Канон разрешает токен в любой границе `range`, а §6.1 описывает токены как готовые
  // УСЛОВИЯ. Правило разведения названо в докблоке `tokenAnchor` и пиннится здесь: без пина
  // `>=next_7d` мог бы молча означать «не раньше сегодня» у одного читателя и «не раньше чем
  // через неделю» у другого.
  test('today/overdue дают сегодня, next_7d/after_7d — сегодня+7', () => {
    const bound = (from: 'today' | 'overdue' | 'next_7d' | 'after_7d') =>
      sqlOf({ prop: 'orbis/due_date', op: 'range', value: { from: { token: from } } });
    expect(bound('today')).toContain(`(props->>'orbis/due_date')::date >= $2::date`);
    expect(bound('overdue')).toContain(`(props->>'orbis/due_date')::date >= $2::date`);
    expect(bound('next_7d')).toContain(`(props->>'orbis/due_date')::date >= $2::date + 7`);
    expect(bound('after_7d')).toContain(`(props->>'orbis/due_date')::date >= $2::date + 7`);
    // А тот же токен в роли РАВЕНСТВА остаётся условием §6.1, а не якорем.
    expect(sqlOf({ prop: 'orbis/due_date', op: 'eq', value: { token: 'next_7d' } })).toContain(
      `(props->>'orbis/due_date')::date BETWEEN $2::date AND $3::date + 7`,
    );
  });

  test('смешанная граница: литерал рядом с токеном сравнивается тоже по дате', () => {
    // Иначе слева стоял бы timestamptz, а справа date, и «весь день» превратилось бы в полночь.
    expect(
      sqlOf({
        prop: 'orbis/start_at',
        op: 'range',
        value: { from: { token: 'today' }, to: '2026-07-10T00:00:00Z' },
      }),
    ).toContain(
      `((props->>'orbis/start_at')::timestamptz AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`,
    );
  });
});

describe('рекурсивный обход: кап глубины — константа компилятора', () => {
  test('кап в SQL совпадает с QUERY_DEPTH_CAP канона (§А5-7)', () => {
    const sql = sqlOf({
      rel: {
        kind: 'descendants_of',
        via: 'subitem',
        of: '019eb2f4-1a00-7b6e-9c01-5d2f8a3b4c10',
      },
    });
    expect(sql).toContain(`w.depth < ${QUERY_DEPTH_CAP}`);
    // Обход НЕ коррелирован со строкой выборки: иначе он считался бы на каждую из них.
    expect(sql).toContain('e.id IN (WITH RECURSIVE walk(id, depth)');
    expect(sql).not.toContain('EXISTS (WITH RECURSIVE');
  });
});

describe('агрегаты: тип свойства решает, можно ли считать', () => {
  const ast: QueryAst = { filter: { aspect: 'orbis/financial' } };

  test('sum и latest по decimal идут через numeric и отдают текст (§3.3)', () => {
    const sum = dialect.sqlToQuery(compileSumAst(ast, 'orbis/amount', CTX)).sql;
    expect(sum).toContain(`sum((props->>'orbis/amount')::numeric)::text AS sum`);
    const latest = dialect.sqlToQuery(compileLatestAst(ast, 'orbis/amount', CTX)).sql;
    expect(latest).toContain('ORDER BY updated_at DESC, id DESC LIMIT 1');
    expect(latest).toContain(`props->>'orbis/amount' IS NOT NULL`);
  });

  test('нечисловое свойство, core-проекция и неизвестный id — отказ с причиной FIELD', () => {
    expect(refusal(() => compileSumAst(ast, 'orbis/counterparty', CTX)).reason).toBe('FIELD');
    expect(refusal(() => compileLatestAst(ast, 'orbis/aliases', CTX)).reason).toBe('FIELD');
    expect(refusal(() => compileSumAst(ast, 'orbis/updated_at', CTX)).reason).toBe('FIELD');
    expect(refusal(() => compileSumAst(ast, 'orbis/нетtакого', CTX)).reason).toBe('UNKNOWN_FIELD');
  });

  test('count идёт по той же WHERE, что и выдача, но без limit и порядка', () => {
    const full = dialect.sqlToQuery(
      compileQueryAst({ ...ast, limit: 5, sortBy: [{ field: 'orbis/amount', dir: 'asc' }] }, CTX),
    );
    const count = dialect.sqlToQuery(compileCountAst({ ...ast, limit: 5 }, CTX));
    expect(count.sql).not.toContain('LIMIT');
    expect(count.sql).not.toContain('ORDER BY');
    const where = (s: string) => s.slice(s.indexOf(' WHERE '), s.length);
    expect(where(count.sql)).toBe(where(full.sql.slice(0, full.sql.indexOf(' ORDER BY '))));
  });
});
