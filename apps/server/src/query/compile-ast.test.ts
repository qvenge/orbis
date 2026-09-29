// apps/server/src/query/compile-ast.test.ts
// Юнит-тесты нового компилятора: то, чего НЕ видно в golden, — отказы и чтение реестра.
//
// Golden (`compile.golden.test.ts`) пиннит текст SQL на всех эталонах набора; здесь
// проверяется
// другое: что компилятор ОТКАЗЫВАЕТ там, где семантики нет, и что списки служебных
// аспектов и иерархических ролей он берёт ИЗ СНИМКА РЕЕСТРА, а не из констант. Второе
// проверяется единственным способом, который что-то доказывает, — подменой снимка:
// на литерале в коде такой тест был бы зелёным при любой реализации.
import { describe, expect, test } from 'bun:test';
import {
  type AspectDefinition,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  type RelationRoleDefinition,
} from '@orbis/shared';
import { QUERY_DEPTH_CAP, type QueryAst, type QueryFilterNode } from '@orbis/shared/query';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ExecError } from '../errors';
import { parseGraphId } from '../identity';
import type { RegistrySnapshot } from '../registry/load';
import {
  type CompileCtx,
  compileCountAst,
  compileLatestAst,
  compileQueryAst,
  compileSumAst,
  compileSumByCurrencyAst,
  ENTITY_SELECT_COLUMNS,
  moneyCurrencyExpr,
} from './compile-ast';

const dialect = new PgDialect();

function snapshot(over: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
  return {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
    subscriptions: new Map(),
    actions: new Map(),
    ownerVersion: 0,
    systemVersion: 1,
    ...over,
  };
}

function ctxOf(over: Partial<CompileCtx> = {}): CompileCtx {
  return {
    graphId: parseGraphId('00000000-0000-7000-8000-0000000000a1'),
    today: '2026-07-03',
    timeZone: 'Europe/Moscow',
    weekStart: 'monday',
    ownerCurrency: 'RUB',
    reg: snapshot(),
    thisEntityId: '00000000-0000-7000-8000-0000000000f1',
    ...over,
  };
}

const CTX = ctxOf();

/** Текст готового выражения (не запроса): `sqlOf` ниже собирает запрос ПО УЗЛУ фильтра. */
function rawSql(fragment: SQL): string {
  return dialect.sqlToQuery(fragment).sql;
}

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
  test('class — предикат членства по привязкам, а не отказ части Б', () => {
    const sql = sqlOf({ class: { contract: 'orbis/completable', set: 'open' } });
    // Норма §Б2-2: набор → классы → варианты привязки. Единственная привязка completable —
    // orbis/task; open = [active] = четыре варианта в порядке value_map.
    expect(sql).toContain(
      `(e.aspects @> ARRAY['orbis/task'] AND e.props->>'orbis/task_status' IN ('inbox', 'planned', 'in_progress', 'waiting'))`,
    );
    // Варианты — ЛИТЕРАЛЫ реестра, а не параметры: их источник — value_map, а не вызывающий.
    const q = dialect.sqlToQuery(
      compileQueryAst({ filter: { class: { contract: 'orbis/completable', set: 'open' } } }, CTX),
    );
    expect(q.params).toEqual(['orbis/agent-run', 500]);
  });

  test('неизвестный контракт и неизвестный набор — две разные причины, а не пустота', () => {
    expect(
      refusal(() => sqlOf({ class: { contract: 'orbis/нетtакого', set: 'closed' } })).reason,
    ).toBe('UNKNOWN_CONTRACT');
    expect(
      refusal(() => sqlOf({ class: { contract: 'orbis/completable', set: 'нетtакого' } })).reason,
    ).toBe('UNKNOWN_SET');
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

  // Долг гейта Задачи 9a, п. 1: гейт времени сверял ВИД свойства, но не ФОРМУ литерала, и
  // `orbis/due_date='банан'` уезжал в `'банан'::date` — data exception Postgres вместо
  // структурного отказа с именем свойства. Форма приходит из схемы ЗАПИСИ значения
  // (`propertyLiteralJsonSchema`), второй правды о том, что такое дата, нет.
  test('форма литерала: дата, момент, время и вариант select проверяются ДО SQL', () => {
    const bad = (node: QueryFilterNode) => refusal(() => sqlOf(node));
    expect(bad({ prop: 'orbis/due_date', op: 'eq', value: 'банан' }).reason).toBe('TYPE');
    // Календарь — не форма: `2026-13-40` проходит паттерн схемы и падал бы уже в Postgres.
    expect(bad({ prop: 'orbis/due_date', op: 'eq', value: '2026-13-40' }).reason).toBe('TYPE');
    expect(bad({ prop: 'orbis/due_date', op: 'eq', value: '2026-02-30' }).message).toContain(
      'календаре',
    );
    // Високосный контроль и здесь: без него проверка могла бы оказаться грубее календаря
    // («в феврале всегда 28») и осталась бы зелёной на всех примерах выше.
    expect(bad({ prop: 'orbis/due_date', op: 'eq', value: '2029-02-29' }).reason).toBe('TYPE');
    expect(sqlOf({ prop: 'orbis/due_date', op: 'eq', value: '2028-02-29' })).toContain('::date');
    // Нулевого года не бывает: форму он проходит, а Postgres отвечает 22008 (I-5 гейта).
    expect(bad({ prop: 'orbis/due_date', op: 'eq', value: '0000-01-01' }).reason).toBe('TYPE');
    expect(
      bad({ prop: 'orbis/completed_at', op: 'eq', value: '0000-06-15T12:00:00Z' }).reason,
    ).toBe('TYPE');
    // У момента «существует» — это и время суток, и смещение зоны: форму `\d{2}:\d{2}:\d{2}`
    // проходят и 25 часов, и `+23:00`, а Postgres отвечает на них 22008 (I-1 предфильтра).
    expect(
      bad({ prop: 'orbis/completed_at', op: 'eq', value: '2026-08-27T25:00:00Z' }).reason,
    ).toBe('TYPE');
    expect(
      bad({ prop: 'orbis/completed_at', op: 'eq', value: '2026-08-27T12:00:00+23:00' }).reason,
    ).toBe('TYPE');
    expect(
      sqlOf({ prop: 'orbis/completed_at', op: 'eq', value: '2026-08-27T23:59:59+15:59' }),
    ).toContain('::timestamptz');
    expect(bad({ prop: 'orbis/start_at', op: 'gt', value: '2026-07-03' }).reason).toBe('TYPE');
    expect(bad({ prop: 'orbis/routine_at', op: 'eq', value: '25:00' }).reason).toBe('TYPE');
    expect(bad({ prop: 'orbis/task_status', op: 'eq', value: 'готово' }).reason).toBe('TYPE');
    expect(bad({ prop: 'orbis/amount', op: 'eq', value: '1 000' }).reason).toBe('TYPE');
    // Границы range идут тем же гейтом — иначе форма проверялась бы у половины предикатов.
    expect(bad({ prop: 'orbis/due_date', op: 'range', value: { to: 'банан' } }).reason).toBe(
      'TYPE',
    );
    expect(bad({ prop: 'orbis/task_status', op: 'in', value: ['inbox', 'готово'] }).reason).toBe(
      'TYPE',
    );
    // Отказ называет свойство: без имени человек ищет ошибку не там.
    expect(bad({ prop: 'orbis/due_date', op: 'eq', value: 'банан' }).message).toContain(
      'orbis/due_date',
    );
  });

  test('форма — не границы: значение вне min/max/maxLength компилируется (законный запрос)', () => {
    // §А7-1 границы — правило ЗАПИСИ. Фильтр по значению вне границ обязан вернуть пусто, а
    // не отказать: то же решение и теми же словами записано в парсере (`parseScalar`).
    // Свойства берутся из словаря по НАЛИЧИЮ границы: подставленный литерал перестал бы
    // проверять правило, как только границу из словаря убрали бы.
    const withBound = (has: (t: Record<string, unknown>) => boolean) => {
      const def = BUILTIN_PROPERTY_META.find(
        (p) => p.storage !== 'core' && has(p.type as unknown as Record<string, unknown>),
      );
      if (def === undefined) throw new Error('в словаре нет свойства с такой границей');
      return def;
    };
    const num = withBound((t) => t.kind === 'number' && t.min !== undefined);
    expect(sqlOf({ prop: num.id, op: 'lt', value: -1 })).toContain('::numeric');
    const dec = withBound((t) => t.kind === 'decimal' && t.min !== undefined);
    expect(sqlOf({ prop: dec.id, op: 'gt', value: '-1' })).toContain('::numeric');
    // Без `format`/`pattern`: иначе длинная строка нарушила бы ФОРМУ, и тест доказывал бы
    // не то, о чём написан (проверено пробой на `orbis/currency`).
    const txt = withBound(
      (t) =>
        t.kind === 'text' &&
        t.maxLength !== undefined &&
        t.format === undefined &&
        t.pattern === undefined,
    );
    const long = 'я'.repeat(((txt.type as { maxLength: number }).maxLength ?? 0) + 1);
    expect(sqlOf({ prop: txt.id, op: 'eq', value: long })).toContain('props->>');
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

describe('состояние дальнего конца (sourceNotIn): набор контракта, а не свойство', () => {
  const rel = (set: string) =>
    ({
      rel: {
        kind: 'has_relation' as const,
        via: 'dependency',
        sourceNotIn: { contract: 'orbis/completable', set },
      },
    }) satisfies QueryFilterNode;

  test('соединение с источником и тотальное отрицание членства', () => {
    const sql = sqlOf(rel('closed'));
    expect(sql).toContain('JOIN entities b ON b.id = r.source_id');
    expect(sql).toContain(
      `NOT COALESCE((b.aspects @> ARRAY['orbis/task'] AND b.props->>'orbis/task_status' IN ('done', 'cancelled')), false)`,
    );
  });

  test('неизвестный контракт и набор дальнего конца — отказ с именем, а не тихая пустота', () => {
    const bad = {
      rel: {
        kind: 'has_relation' as const,
        via: 'dependency',
        sourceNotIn: { contract: 'orbis/нетtакого', set: 'closed' },
      },
    };
    expect(refusal(() => sqlOf(bad)).reason).toBe('UNKNOWN_CONTRACT');
    expect(refusal(() => sqlOf(rel('нетtакого'))).reason).toBe('UNKNOWN_SET');
  });

  test('без sourceNotIn узел компилируется ровно как раньше — без соединения', () => {
    const plain = sqlOf({ rel: { kind: 'has_relation', via: 'dependency' } });
    expect(plain).toContain('EXISTS (SELECT 1 FROM relations r WHERE r.target_id = e.id');
    expect(plain).not.toContain('JOIN entities b');
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

  test('has по свойству служебного аспекта — такое же упоминание, как prop', () => {
    // Правило 2 §А5-6 сформулировано про ПРЕДИКАТ ПО СВОЙСТВУ, а `has` — тот же предикат,
    // только про наличие значения. Считай сигналом один `prop`, и `has=orbis/run_outcome`
    // компилировался бы в противоречие «исключить прогоны И взять с полем прогона» —
    // молчаливый ноль строк, худший из отказов (§6.4). Для `prop` пин стоял выше, для
    // `has` — не стоял ни один.
    expect(sqlOf({ has: 'orbis/run_outcome' })).not.toContain('NOT (aspects &&');
    // Общее свойство сигналом не становится и здесь — правило одно на обе формы.
    expect(sqlOf({ has: 'orbis/grant' })).toContain('NOT (aspects &&');
    // `sortBy` по тому же свойству упоминанием НЕ считается (порядок выдачи не описывает
    // её цель) — граница правила пиннится рядом, иначе её снимут заодно.
    const sorted = dialect
      .sqlToQuery(
        compileQueryAst(
          { filter: { tag: 'дом' }, sortBy: [{ field: 'orbis/run_outcome', dir: 'desc' }] },
          CTX,
        ),
      )
      .sql.replaceAll(/\s+/g, ' ');
    expect(sorted).toContain('NOT (aspects &&');
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
    if (priority?.type.kind !== 'select') throw new Error('фикстура устарела');
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

describe('core-проекции: карта колонок и высказывание об архивности', () => {
  test('карта CORE_COLUMN покрывает ВСЕ core-свойства реестра', () => {
    // Пятое core-свойство, заведённое в реестре без строки в карте, иначе дало бы
    // `UNKNOWN_FIELD` в рантайме на первом же запросе — то есть красный прод вместо
    // красного теста. Проверка идёт от РЕЕСТРА к карте, а не наоборот.
    const core = BUILTIN_PROPERTY_META.filter((p) => p.storage === 'core').map((p) => p.id);
    expect(core.length).toBeGreaterThan(0);
    for (const id of core) {
      // Компиляция предиката по core-свойству обязана пройти без отказа резолва.
      expect(() => sqlOf({ has: id })).not.toThrow();
    }
    // И обратно: свойство `storage:'props'` в карту не попадает — иначе значение читалось бы
    // из несуществующей колонки.
    expect(() => sqlOf({ has: 'orbis/amount' })).not.toThrow();
    expect(sqlOf({ has: 'orbis/amount' })).toContain(`props ? 'orbis/amount'`);
  });

  test('предикат по orbis/archived снимает умолчание, has(orbis/archived) — нет', () => {
    // Без первого правила запрос компилировался бы в `NOT archived AND archived` — тихий
    // ноль на любых данных (находка предфильтра).
    const eqTrue = sqlOf({ prop: 'orbis/archived', op: 'eq', value: true });
    expect(eqTrue).toContain('archived = $2::boolean');
    expect(eqTrue).not.toContain('NOT archived');
    // Отрицание — тоже высказывание о значении.
    expect(sqlOf({ not: { prop: 'orbis/archived', op: 'eq', value: true } })).not.toContain(
      'AND NOT archived AND',
    );
    // А `has` не выбирает между архивными и неархивными — умолчание остаётся.
    expect(sqlOf({ has: 'orbis/archived' })).toContain('NOT archived');
    // Прочие core-свойства умолчания не трогают.
    expect(sqlOf({ prop: 'orbis/title', op: 'eq', value: 'Проект' })).toContain('NOT archived');
  });
});

describe('гейт времени: токен и граница по дате — только у date/timestamp (долг 5, класс)', () => {
  // Все пять форм — схемно ЛЕГАЛЬНЫЕ деревья: канон объявляет ограничение словами, но не
  // сужает схемой (тип свойства знает реестр, а не узел). Через текст их не построить —
  // парсер сверяет тип; вход `ast:` тула идёт мимо парсера и с Задачи 9b становится боевым.
  const cases: ReadonlyArray<readonly [string, QueryFilterNode, string]> = [
    [
      'eq-токен на boolean-core: было (archived AT TIME ZONE $2)::date — ошибка на любых данных',
      { prop: 'orbis/archived', op: 'eq', value: { token: 'today' } },
      'boolean',
    ],
    [
      'gt-токен на select: было (props->>…)::timestamptz — 22007 на первой строке',
      { prop: 'orbis/task_status', op: 'gt', value: { token: 'today' } },
      'select',
    ],
    [
      'lt-токен на decimal',
      { prop: 'orbis/amount', op: 'lt', value: { token: 'overdue' } },
      'decimal',
    ],
    [
      'ne-токен на text (идёт тем же путём, что eq, но под отрицанием)',
      { prop: 'orbis/location', op: 'ne', value: { token: 'today' } },
      'text',
    ],
    [
      'from-токен на нетемпоральном свойстве',
      { prop: 'orbis/amount', op: 'range', value: { from: { token: 'today' } } },
      'decimal',
    ],
  ];

  for (const [name, node, kind] of cases) {
    test(`отказ, а не SQL: ${name}`, () => {
      const r = refusal(() => sqlOf(node));
      expect(r.code).toBe('VALIDATION');
      expect(r.reason).toBe('TYPE');
      // Отказ обязан назвать И свойство, И его вид — иначе он не отличим от общего «тип не тот».
      expect(r.message).toContain((node as { prop: string }).prop);
      expect(r.message).toContain(kind);
    });
  }

  test('литеральная граница рядом с токеном сверяется по реестру, а не уезжает в ::date', () => {
    // `{from: 5, to: {token}}` на date-свойстве компилировалось в `5::date`.
    const r = refusal(() =>
      sqlOf({ prop: 'orbis/due_date', op: 'range', value: { from: 5, to: { token: 'today' } } }),
    );
    expect(r.reason).toBe('TYPE');
    expect(r.message).toContain('orbis/due_date');
    // Зеркально: скаляр не того типа во ВТОРОЙ границе.
    expect(
      refusal(() =>
        sqlOf({ prop: 'orbis/due_date', op: 'range', value: { from: { token: 'today' }, to: 5 } }),
      ).reason,
    ).toBe('TYPE');
  });

  test('на date/timestamp те же формы компилируются — гейт не запрещает законное', () => {
    expect(sqlOf({ prop: 'orbis/due_date', op: 'eq', value: { token: 'today' } })).toContain(
      `(props->>'orbis/due_date')::date BETWEEN $2::date AND $3::date`,
    );
    expect(sqlOf({ prop: 'orbis/start_at', op: 'gt', value: { token: 'today' } })).toContain(
      'AT TIME ZONE $2',
    );
    // core-проекции времени тоже законны: kind у них timestamp.
    expect(sqlOf({ prop: 'orbis/updated_at', op: 'eq', value: { token: 'today' } })).toContain(
      '(updated_at AT TIME ZONE $2)::date',
    );
  });
});

describe('токен в роли ГРАНИЦЫ: два края (спека 1в §3.4)', () => {
  // Правило одно для всех восьми токенов: `=T` — [начало; конец], `<T` — раньше начала, `>=T` —
  // не раньше начала, `>T` — позже конца, `<=T` — не позже конца. Края — ДНИ, посчитанные
  // `tokenEdges` по «сегодня» контекста (2026-07-03, пятница), и едут параметрами.
  const q = (filter: QueryFilterNode, ctx: CompileCtx = CTX) => {
    const out = dialect.sqlToQuery(compileQueryAst({ filter }, ctx));
    return { sql: out.sql.replaceAll(/\s+/g, ' '), params: out.params };
  };
  const due = `(props->>'orbis/due_date')::date`;
  const node = (op: 'eq' | 'lt' | 'gt', token: string): QueryFilterNode =>
    ({ prop: 'orbis/due_date', op, value: { token } }) as QueryFilterNode;
  const range = (edge: 'from' | 'to', token: string): QueryFilterNode =>
    ({ prop: 'orbis/due_date', op: 'range', value: { [edge]: { token } } }) as QueryFilterNode;

  test('`<` и `>=` (from) читают НАЧАЛО: next_7d — сегодня, after_7d — сегодня+8', () => {
    expect(q(node('lt', 'next_7d'))).toMatchObject({
      sql: expect.stringContaining(`${due} < $2::date`),
      params: ['orbis/agent-run', '2026-07-03', 500],
    });
    expect(q(range('from', 'next_7d')).params).toEqual(['orbis/agent-run', '2026-07-03', 500]);
    expect(q(range('from', 'after_7d'))).toMatchObject({
      sql: expect.stringContaining(`${due} >= $2::date`),
      params: ['orbis/agent-run', '2026-07-11', 500],
    });
    expect(q(node('lt', 'after_7d')).params).toEqual(['orbis/agent-run', '2026-07-11', 500]);
  });

  test('`>` и `<=` (to) читают КОНЕЦ: next_7d — сегодня+7, overdue — вчера', () => {
    expect(q(node('gt', 'next_7d'))).toMatchObject({
      sql: expect.stringContaining(`${due} > $2::date`),
      params: ['orbis/agent-run', '2026-07-10', 500],
    });
    expect(q(range('to', 'overdue'))).toMatchObject({
      sql: expect.stringContaining(`${due} <= $2::date`),
      params: ['orbis/agent-run', '2026-07-02', 500],
    });
    expect(q(node('gt', 'overdue')).params).toEqual(['orbis/agent-run', '2026-07-02', 500]);
  });

  test('`=` — оба края; открытый край — одностороннее сравнение', () => {
    expect(q(node('eq', 'next_7d'))).toMatchObject({
      sql: expect.stringContaining(`${due} BETWEEN $2::date AND $3::date`),
      params: ['orbis/agent-run', '2026-07-03', '2026-07-10', 500],
    });
    expect(q(node('eq', 'overdue'))).toMatchObject({
      sql: expect.stringContaining(`${due} <= $2::date`),
      params: ['orbis/agent-run', '2026-07-02', 500],
    });
    expect(q(node('eq', 'after_7d'))).toMatchObject({
      sql: expect.stringContaining(`${due} >= $2::date`),
      params: ['orbis/agent-run', '2026-07-11', 500],
    });
    expect(q(node('eq', 'last_month')).params).toEqual([
      'orbis/agent-run',
      '2026-06-01',
      '2026-06-30',
      500,
    ]);
  });

  test('начало недели — из контекста компиляции (В-1): понедельник и воскресенье', () => {
    expect(q(node('eq', 'this_week')).params).toEqual([
      'orbis/agent-run',
      '2026-06-29',
      '2026-07-05',
      500,
    ]);
    expect(q(node('eq', 'this_week'), ctxOf({ weekStart: 'sunday' })).params).toEqual([
      'orbis/agent-run',
      '2026-06-28',
      '2026-07-04',
      500,
    ]);
  });

  test('несуществующий край — отказ TOKEN_EDGE, а не молчаливый край', () => {
    for (const filter of [
      node('lt', 'overdue'),
      range('from', 'overdue'),
      node('gt', 'after_7d'),
      range('to', 'after_7d'),
    ]) {
      const r = refusal(() => sqlOf(filter));
      expect(r.code, JSON.stringify(filter)).toBe('VALIDATION');
      expect(r.reason, JSON.stringify(filter)).toBe('TOKEN_EDGE');
      expect(r.message, JSON.stringify(filter)).toContain('у токена');
    }
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

describe('адрес слота с моментом: литералы одного условия — одного вида (перенос гейта 1, Minor-1)', () => {
  const moment = { contract: 'orbis/when', slot: 'moment' };
  test('день рядом с моментом в range — отказ TYPE, а не «день BETWEEN date AND timestamptz»', () => {
    for (const filter of [
      { prop: moment, op: 'range', value: { from: '2026-07-16', to: '2026-07-17T12:00:00+07:00' } },
      { prop: moment, op: 'range', value: { from: '2026-07-16T09:00:00+07:00', to: '2026-07-17' } },
    ] as QueryFilterNode[]) {
      const r = refusal(() => sqlOf(filter));
      expect(r.reason, JSON.stringify(filter)).toBe('TYPE');
      expect(r.message, JSON.stringify(filter)).toContain('одного вида');
    }
  });

  // Перенос ревью задачи 2: у `in` левой стороны одной на все литералы нет — это «хоть одно из», и
  // каждый литерал сравнивается в своей форме, как у текста `a|b` (разбор даёт `or` из `eq`). Отказ
  // `TYPE` здесь был бы разночтением дерева и текста одного и того же запроса.
  test('in с днём и моментом — поэлементно: день по дню, момент по моменту', () => {
    const got = dialect.sqlToQuery(
      compileQueryAst(
        {
          filter: {
            prop: moment,
            op: 'in',
            value: ['2026-07-16', '2026-07-17T09:00:00+07:00'],
          } as QueryFilterNode,
        },
        CTX,
      ),
    );
    const flat = got.sql.replaceAll(/\s+/g, ' ');
    expect(flat).toMatch(/\(sv\.day IN \(\$\d+::date\) OR sv\.at IN \(\$\d+::timestamptz\)\)/);
    expect(got.params).toContain('2026-07-16');
    expect(got.params).toContain('2026-07-17T09:00:00+07:00');
    // Одного вида — одна форма `IN (…)`, как до переноса.
    expect(
      sqlOf({ prop: moment, op: 'in', value: ['2026-07-16', '2026-07-17'] } as QueryFilterNode),
    ).toMatch(/sv\.day IN \(\$\d+::date, \$\d+::date\)/);
  });

  test('оба дня — по дню, оба момента — по моменту', () => {
    expect(
      sqlOf({
        prop: moment,
        op: 'range',
        value: { from: '2026-07-16', to: '2026-07-17' },
      } as QueryFilterNode),
    ).toContain('sv.day BETWEEN $');
    expect(
      sqlOf({
        prop: moment,
        op: 'range',
        value: { from: '2026-07-16T09:00:00+07:00', to: '2026-07-17T12:00:00+07:00' },
      } as QueryFilterNode),
    ).toContain('sv.at BETWEEN $');
  });

  test('дерево мимо разбора: контракт без значения — NO_CONTRACT_VALUE со слотами, как у разбора (Minor-1 ревью Fable)', () => {
    const r = refusal(() =>
      sqlOf({
        prop: { contract: 'orbis/completable' },
        op: 'eq',
        value: 'open',
      } as QueryFilterNode),
    );
    expect(r.reason).toBe('NO_CONTRACT_VALUE');
    // Тот же текст, что у разбора (`parse-ast.test.ts`): подсказка — слоты, а не имя контракта.
    expect(r.message).toContain(
      'у контракта нет значения — адресуйте слот: orbis/completable.status',
    );
  });

  test('отказ у адреса называет «адрес слота» (М-2 финального ревью A; прежде — перенос ревью 1, M-1)', () => {
    const r = refusal(() =>
      sqlOf({
        prop: { contract: 'orbis/money-movement', slot: 'amount' },
        op: 'eq',
        value: { token: 'today' },
      } as QueryFilterNode),
    );
    expect(r.reason).toBe('TYPE');
    expect(r.message).toContain(
      "только к адресам с датой (date/timestamp); адрес слота 'orbis/money-movement.amount'",
    );
    expect(r.message).not.toMatch(/(^|[^а-яё])пол(е|я|ю|ям|ей)([^а-яё]|$)/i);
    expect(r.message).not.toContain('свойств');
  });
});

// Перенос ревью задачи 2: край `overdue` у значения «когда» (К-2: условие, предфильтр и ключ
// сортировки) читается из ОДНОЙ таблицы краёв (`tokenEdges`: конец — вчера), а не записан рядом
// руками как «< сегодня». Вторая копия правила краёв разошлась бы с таблицей на первой её правке.
describe('overdue значения «когда» — край из таблицы краёв (перенос ревью 2)', () => {
  test('условие, предфильтр и ключ сортировки читают конец overdue (вчера), а не «сегодня»', () => {
    const got = dialect.sqlToQuery(
      compileQueryAst(
        {
          filter: { prop: { contract: 'orbis/when' }, op: 'eq', value: { token: 'overdue' } },
          sortBy: [{ field: { contract: 'orbis/when' }, dir: 'asc' }],
        } as QueryAst,
        CTX,
      ),
    );
    // CTX.today = 2026-07-03: края overdue — [—; 2026-07-02].
    expect(got.params).toContain('2026-07-02');
    expect(got.params).not.toContain('2026-07-03');
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

  test('sum одним числом — SQL прогресса цели дословно (В-5); по валютам — отдельный компилятор', () => {
    // Пин ТОЧНЫЙ, а не `toContain`: сумма одним числом осталась ОДНОМУ вызывающему — прогрессу цели
    // (В-5: цель сравнивает сумму с одним числом). Плитка и `user_query` считают по валютам
    // (`compileSumByCurrencyAst`), и валюта, протёкшая сюда, прошла бы незамеченной: эталон
    // `test/golden/query-sql.json` агрегатов не покрывает.
    const legacy = dialect.sqlToQuery(compileSumAst(ast, 'orbis/amount', CTX));
    expect(legacy.sql).toBe(
      "SELECT count(*) AS count, sum((props->>'orbis/amount')::numeric)::text AS sum FROM entities e WHERE true AND NOT archived AND NOT (aspects && ARRAY[$1]::text[]) AND aspects @> ARRAY['orbis/financial']",
    );
    const byCurrency = dialect.sqlToQuery(compileSumByCurrencyAst(ast, 'orbis/amount', CTX));
    // Валюта — по привязке «движения денег» аспекта НА ЗАПИСИ; нет значения — валюта владельца.
    expect(byCurrency.sql).toContain(
      `CASE WHEN aspects @> ARRAY['orbis/financial'] THEN COALESCE(NULLIF(props->>'orbis/currency', ''), $1) ELSE NULL END`,
    );
    expect(byCurrency.params[0]).toBe('RUB');
    expect(byCurrency.sql).toMatch(/ GROUP BY 1$/);
    // Не денежное свойство — валюты нет вовсе (а не валюта владельца).
    expect(moneyCurrencyExpr('orbis/counterparty', CTX)).toBeNull();
    expect(rawSql(compileSumByCurrencyAst(ast, 'orbis/step_count', ctxOf()))).toContain(
      'NULL::text AS currency',
    );
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

// Оба имени экспортированы ради ОДНОГО потребителя — движков подписок (§Б5-6): им нужны не
// предикат и не готовый SELECT, а кирпичи — список колонок под свою обёртку и дата значения
// свойства под BETWEEN окна. Копии рядом разошлись бы с запросами молча, и здесь пиннится
// именно совпадение, а не сам факт экспорта.
describe('экспорты для движков подписок (§Б5-6)', () => {
  test('ENTITY_SELECT_COLUMNS — те же колонки, что собирает toWireEntityFromSql', () => {
    expect(ENTITY_SELECT_COLUMNS.split(', ')).toEqual([
      'id',
      'graph_id',
      'title',
      'emoji',
      'body',
      'body_refs',
      'tags',
      'props',
      'aspects',
      'query_refs',
      'created_at',
      'updated_at',
      'archived',
    ]);
  });
});

/**
 * ФОРМА SQL ЗНАЧЕНИЯ «КОГДА» (M-2 финального ревью B2b). Время языка контрактов держит только локальный
 * `perf/graph.test.ts` (в CI его нет), паритет форм (`when.dataset.test.ts`) сверяет выдачу, а не путь;
 * эталона `query-sql.json` с `orbis/when` нет — его SQL (≈2 КБ) по правилу файла выводится руками, и
 * снять его с компилятора нельзя. Поэтому здесь пиннится ФОРМА — ровно два решения перфа, которые иначе
 * CI не заметил бы: даты «когда» считаются одним `LEFT JOIN LATERAL` на запись (R-21), а не
 * коррелированными подзапросами у каждого читателя, и положительная форма идёт с предфильтром по сырым
 * свойствам (`valuePrefilter`) ДО `EXISTS` по датам.
 */
describe('форма SQL значения «когда»: LATERAL и предфильтр (M-2 финального ревью B2b)', () => {
  const text = dialect
    .sqlToQuery(
      compileQueryAst(
        {
          filter: { prop: { contract: 'orbis/when' }, op: 'eq', value: { token: 'next_7d' } },
          sortBy: [{ field: { contract: 'orbis/when' }, dir: 'asc' }],
        },
        CTX,
      ),
    )
    .sql.replaceAll(/\s+/g, ' ');
  const where = text.slice(text.indexOf(' WHERE true '), text.indexOf(' ORDER BY '));
  const orderBy = text.slice(text.indexOf(' ORDER BY '));

  test('даты — один LEFT JOIN LATERAL в FROM; условие и ключ читают его массив, VALUES в них нет', () => {
    const lateral =
      'LEFT JOIN LATERAL (SELECT array_agg(ROW(d.slot, d.at, d.day, d.aspect)) AS wd FROM';
    expect(text.split(lateral)).toHaveLength(2);
    expect(text.indexOf(lateral)).toBeLessThan(text.indexOf(' WHERE true '));
    expect(where).not.toContain('(VALUES');
    expect(orderBy).not.toContain('(VALUES');
    expect(where).toContain('FROM unnest(__wd0.wd)');
    expect(orderBy).toContain('FROM unnest(__wd0.wd)');
  });

  test('положительная форма — предфильтр по сырым свойствам слотов с ролью, затем EXISTS по датам', () => {
    const exists = where.indexOf('EXISTS (SELECT 1 FROM (SELECT u.slot');
    expect(exists).toBeGreaterThan(0);
    const pre = where.slice(0, exists);
    for (const property of ['orbis/completed_at', 'orbis/due_date', 'orbis/start_at']) {
      expect([property, pre.includes(`props->>'${property}'`)]).toEqual([property, true]);
    }
    expect(pre).toMatch(/BETWEEN \$\d+::date AND \$\d+::date\) AND $/);
  });
});
