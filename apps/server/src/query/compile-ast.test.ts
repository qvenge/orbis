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

describe('состояние дальнего конца (sourceNotIn): что оно умеет и где отказывает', () => {
  const rel = (prop: string) =>
    ({
      rel: {
        kind: 'has_relation' as const,
        via: 'dependency',
        sourceNotIn: { prop, values: ['done'] },
      },
    }) satisfies QueryFilterNode;

  test('скалярное свойство — соединение с источником и COALESCE(…, "")', () => {
    const sql = sqlOf(rel('orbis/task_status'));
    expect(sql).toContain('JOIN entities b ON b.id = r.source_id');
    // COALESCE — смысл, а не украшение: источник без значения обязан считаться НЕ закрытым,
    // иначе `NULL NOT IN (…)` выбросил бы ребро и заметка-блокер перестала бы блокировать.
    expect(sql).toContain(`COALESCE(b.props->>'orbis/task_status', '') NOT IN ($3)`);
  });

  test('список, вложенный объект и core-проекция — три отказа, а не тихая пустота', () => {
    // Списочное свойство: скалярного значения у него нет, сравнивать нечего.
    const list = refusal(() => sqlOf(rel('orbis/aliases')));
    expect(list.reason).toBe('TYPE');
    expect(list.message).toContain('orbis/aliases');
    // json: `->>` отдал бы текст сериализации — то самое сравнение «текста всего значения».
    expect(refusal(() => sqlOf(rel('orbis/recurrence'))).reason).toBe('TYPE');
    // core-проекция: значение лежит колонкой, а не в `props` дальнего конца.
    const core = refusal(() => sqlOf(rel('orbis/archived')));
    expect(core.reason).toBe('TYPE');
    expect(core.message).toContain('orbis/archived');
    // И неизвестный id — своей причиной, а не общей.
    expect(refusal(() => sqlOf(rel('orbis/нетtакого'))).reason).toBe('UNKNOWN_FIELD');
  });

  test('без sourceNotIn узел компилируется ровно как раньше — без соединения', () => {
    const plain = sqlOf({ rel: { kind: 'has_relation', via: 'dependency' } });
    expect(plain).toContain('EXISTS (SELECT 1 FROM relations r WHERE r.target_id = e.id');
    expect(plain).not.toContain('JOIN entities b');
  });

  // С Задачи 9b вход `ast:` боевой, и узел приезжает с ЛЮБЫМИ prop/values: докблок
  // `sourceNotInCond` больше не вправе обосновывать отсутствие каста тем, что «значения
  // приходят из сахара». Условие, которым он обоснован теперь, проверяемо — вот оно.
  test('текстом читаются РОВНО те типы, которым castedExpr не нужен каст', () => {
    const uuid = '019eb2f4-1a00-7b6e-9c01-5d2f8a3b4c10';
    // По свойству на каждый скалярный тип словаря, значение — заведомо правильной ФОРМЫ:
    // иначе отказ пришёл бы от гейта формы, а не от того правила, которое здесь проверяется.
    const textual: Array<[string, string]> = [
      ['orbis/location', 'дом'],
      ['orbis/routine_at', '07:00'],
      ['orbis/task_status', 'done'],
      ['orbis/rule_target', uuid],
      ['orbis/grant', uuid],
      ['orbis/rule_scope', 'orbis/money-movement'],
    ];
    const casted: Array<[string, string | number | boolean]> = [
      ['orbis/duration_min', 30],
      ['orbis/amount', '100.00'],
      ['orbis/due_date', '2026-07-03'],
      ['orbis/start_at', '2026-07-03T09:00:00Z'],
      ['orbis/planned', true],
    ];
    for (const [prop, value] of textual) {
      const node = {
        rel: {
          kind: 'has_relation' as const,
          via: 'dependency',
          sourceNotIn: { prop, values: [value] },
        },
      };
      expect(`${prop}: ${sqlOf(node).includes('JOIN entities b')}`).toBe(`${prop}: true`);
    }
    for (const [prop, value] of casted) {
      const node = {
        rel: {
          kind: 'has_relation' as const,
          via: 'dependency',
          sourceNotIn: { prop, values: [value] },
        },
      };
      const r = refusal(() => sqlOf(node));
      expect(`${prop}: ${r.reason}`).toBe(`${prop}: TYPE`);
      expect(r.message).toContain('форма хранения');
    }
    // Перечисленные типы обязаны покрывать ВЕСЬ скалярный словарь: новый тип, добавленный в
    // §А2-2 и забытый здесь, роняет этот тест, а не проезжает молча.
    const covered = new Set(
      [...textual, ...casted].map(([prop]) => {
        const def = BUILTIN_PROPERTY_META.find((p) => p.id === prop);
        if (def === undefined) throw new Error(`нет свойства ${prop}`);
        return def.type.kind;
      }),
    );
    for (const p of BUILTIN_PROPERTY_META) {
      const type = p.type;
      const listy = 'cardinality' in type && type.cardinality === 'many';
      if (p.storage === 'core' || listy || type.kind === 'json') continue;
      expect(`${type.kind} покрыт: ${covered.has(type.kind)}`).toBe(`${type.kind} покрыт: true`);
    }
  });

  test('значения sourceNotIn проверяются формой: не тот вариант select — отказ, а не ложь', () => {
    const node = {
      rel: {
        kind: 'has_relation' as const,
        via: 'dependency',
        sourceNotIn: { prop: 'orbis/task_status', values: ['готово'] },
      },
    } satisfies QueryFilterNode;
    expect(refusal(() => sqlOf(node)).reason).toBe('TYPE');
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
      `(props->>'orbis/due_date')::date = $2::date`,
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
