// apps/server/src/query/compile-ast.ts
// Компилятор канонического Q-AST (§А5-7) в PostgreSQL по НОВОЙ форме хранения:
// плоские `props` по id свойства, список `aspects[]`, роль ребра `relations.role` (§А1-1,
// §А4-3). Живёт РЯДОМ со старым `compile.ts` — переключение потребителей делает Задача 9b,
// старая грамматика умирает в Задаче 21 (РП-11).
//
// Инварианты (те же, что у старого компилятора, — они не про форму хранения):
// - owner-фильтр НЕ добавляется: изоляцию даёт RLS (§4.10), исполнение компилята допустимо
//   ТОЛЬКО под `withIdentity`;
// - все пользовательские значения — строго параметрами `${}`; `sql.raw` — только для того,
//   что пришло ИЗ РЕЕСТРА (id свойства, id аспекта, key варианта select) и для констант
//   кода (кап глубины, имена колонок);
// - `today` и `timeZone` инжектирует вызывающий — компиляция детерминирована.
//
// ЧТО ЗДЕСЬ ПРИНЦИПИАЛЬНО ИНАЧЕ ПРОТИВ `compile.ts`:
//  1. Тип значения берётся из РЕЕСТРА (`PropertyType`, §А2-2), а не угадывается по паттерну
//     JSON Schema. Из-за угадывания `time` в новом каталоге числится строкой, хотя парсер
//     считает его упорядоченным (долг гейта Задачи 8, п. 4): здесь такого расхождения быть
//     не может — и фильтр, и сортировка спрашивают один и тот же `prop.type.kind`.
//  2. Фильтр — ДЕРЕВО, а не плоский список, поэтому отрицание — один узел `not`, а не три
//     частных (`noneOf`, `excludeTags`, `excludeBlocked`).
//  3. Служебность аспекта читается из колонки `service` реестра (§А5-6/§А3-1), а не из
//     списка в коде.
//
// ТРЁХЗНАЧНАЯ ЛОГИКА И ПРАВИЛО «NULL ПРОХОДИТ». `{not: X}` компилируется в
// `NOT COALESCE(<X>, false)`, а не в голый `NOT (<X>)`. Разница наблюдаема: у сущности без
// свойства предикат равен NULL, голый `NOT NULL` — тоже NULL, и WHERE такую строку
// ВЫЧЁРКИВАЕТ. Сегодняшняя семантика §6.1 (решение 10 старого компилятора,
// `compile.ts:507`) обратная: `status=!done` обязан вернуть и записи, где статуса нет
// вовсе, — на этом стоит клиентский фильтр «Факт» (`planned=!true`) и отрицание по
// спискам. `COALESCE(<X>, false)` читается как «предикат ТОЧНО выполнен», и его отрицание
// — «не выполнен или неизвестен», то есть ровно правило §6.1. Одно место на всё дерево:
// у оператора `ne` СВОЕЙ SQL-ФОРМЫ нет — ветка `case 'ne'` в `scalarPropCond` есть, но она
// собирает предикат равенства и оборачивает его тем же `negated`.
import type { AspectDefinition, PropertyDefinition, PropertyType } from '@orbis/shared';
// Канон Q-AST — отдельным входом: в корневом барреле имена `QueryAst`/`QuerySortField`
// заняты СТАРОЙ грамматикой до Задачи 21 (см. докблок `packages/shared/src/index.ts`).
import {
  QUERY_DEPTH_CAP,
  type QueryAst,
  type QueryBound,
  type QueryDateToken,
  type QueryFilterNode,
  type QueryPropOp,
  type QueryRangeValue,
  type QueryRelPredicate,
  type QueryScalar,
  type QuerySortField,
} from '@orbis/shared/query';
import { type SQL, sql } from 'drizzle-orm';
import { ExecError } from '../errors';
import type { RegistrySnapshot } from '../registry/load';

/**
 * Контекст компиляции. Имена полей — из плана (на них ссылаются Задачи 9b, 10a/10b, 11, 13c).
 *
 * `ownerId` сам компилятор в SQL НЕ подставляет (изоляцию даёт RLS) — он в контексте
 * потому, что этим же контекстом ходят соседи по конвейеру: снимок реестра `reg` снят под
 * ОПРЕДЕЛЁННЫМ владельцем, и компилят, исполненный под чужой identity, молча собрался бы
 * из чужих свойств. Поле называет ту identity, под которой компилят обязан исполняться.
 *
 * `thisEntityId` в интерфейсе плана не назван, но без него узел `{rel: {of: 'this'}}` канона
 * не компилируется вовсе: §6.1 резолвит `this` контекстом ПОТРЕБИТЕЛЯ (detail-экран
 * передаёт id записи, Browser и диспатч тулов — нет). Поле необязательное: отсутствие
 * читается как «контекста нет», и `this` в таком запросе — честный отказ, а не пустота.
 */
export interface CompileCtx {
  ownerId: string;
  /** Сегодня в таймзоне владельца, YYYY-MM-DD. */
  today: string;
  /** IANA-таймзона владельца — по ней date-токены читают timestamp-свойства. */
  timeZone: string;
  reg: RegistrySnapshot;
  /** Сущность-хозяин query-блока (для `of: 'this'`); null/отсутствие — контекста нет. */
  thisEntityId?: string | null;
}

/** Дефолтный кап выдачи, когда `limit` не задан (§6.1, как у `compile.ts:60`). */
const DEFAULT_LIMIT = 500;

/**
 * Колонки полного SELECT — ровно те, из которых `toWireEntityFromSql` собирает wire-форму
 * (`wire.ts:70`). Список общий со старым компилятором по смыслу, но НЕ импортируется из
 * него: `compile.ts` удаляется в Задаче 9b, и импорт умер бы вместе с ним.
 */
const ENTITY_COLUMNS =
  'id, owner_id, title, emoji, body, body_refs, tags, meta, props, aspects, query_refs, aspects_legacy, created_at, updated_at, archived';

/** UUID сущности — та же форма, что у `REL_TARGET_PATTERN` канона (§А5-7). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Отказ компиляции. Код всегда VALIDATION, причина — в `details.reason` (§9.2). */
function fail(reason: string, message: string, extra?: Record<string, unknown>): never {
  throw new ExecError('VALIDATION', message, { reason, ...extra });
}

/**
 * SQL-литерал ТОЛЬКО для значений из реестра (id свойства, id аспекта, key варианта
 * select). Экранирование одинарных кавычек — защита в глубину: все три источника уже
 * прошли схему реестра, но литерал в тексте запроса не должен зависеть от неё.
 */
function lit(value: string): SQL {
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

/** `ARRAY[$1, $2]::text[]` — каждый элемент параметром. */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

// ─────────────────────────── Резолв имён по реестру ───────────────────────────

/** Свойство после резолва: определение, выражение доступа и признаки формы значения. */
interface PropRef {
  def: PropertyDefinition;
  /** Текстовая проекция значения (или сама колонка ядра) — база всех прочих форм. */
  text: SQL;
  /** Значение — список скаляров (§А2-2: `cardinality: many`). */
  list: boolean;
  /** Хранение — колонка ядра (§А1-3), а не `props`. */
  core: boolean;
}

/**
 * Колонка ядра для core-свойства (§А1-3). `satisfies` не поставить (id — строка из
 * реестра, а не литеральный union), поэтому неизвестное core-свойство — ОТКАЗ: молча
 * подставленное `props->>` вернуло бы NULL там, где значение лежит в колонке, и весь
 * запрос стал бы тихо пустым.
 */
const ARCHIVED_COLUMN = 'archived';

const CORE_COLUMN: Readonly<Record<string, string>> = {
  'orbis/archived': ARCHIVED_COLUMN,
  'orbis/title': 'title',
  'orbis/created_at': 'created_at',
  'orbis/updated_at': 'updated_at',
};

/** Значение свойства — список скаляров (§А2-2; у `json` признак массива — `maxItems`). */
function isListType(type: PropertyType): boolean {
  if (type.kind === 'json') return type.maxItems !== undefined;
  return 'cardinality' in type && type.cardinality === 'many';
}

function propertyOrFail(propertyId: string, ctx: CompileCtx): PropertyDefinition {
  const def = ctx.reg.properties.get(propertyId);
  if (!def) {
    return fail(
      'UNKNOWN_FIELD',
      `неизвестное свойство '${propertyId}': такого id нет в реестре владельца`,
      { property: propertyId },
    );
  }
  return def;
}

/**
 * Выражение доступа к значению свойства.
 *
 * Каст выбирается по `kind` РЕЕСТРА, а не по виду данных: `decimal` сравнивается через
 * `numeric` (§3.3 — хвост копеек), `date`/`timestamp` — через свои типы, а не
 * лексикографически, как это делал старый компилятор для date-полей аспектов
 * (`compile.ts:555`). `time` остаётся текстом — у 'ЧЧ:ММ' лексикографический порядок и
 * есть хронологический, и это ЕДИНСТВЕННОЕ место, где такое допущение сделано.
 */
function propRef(propertyId: string, ctx: CompileCtx): PropRef {
  const def = propertyOrFail(propertyId, ctx);
  const type = def.type;
  const list = isListType(type);
  if (def.storage === 'core') {
    const column = CORE_COLUMN[def.id];
    if (column === undefined) {
      return fail(
        'UNKNOWN_FIELD',
        `свойство '${def.id}' объявлено core-проекцией, но колонки под него нет`,
        { property: def.id },
      );
    }
    return { def, text: sql.raw(column), list, core: true };
  }
  return { def, text: sql`props->>${lit(def.id)}`, list, core: false };
}

/**
 * Сравнимое выражение значения — текстовая проекция под кастом по kind (§А2-2).
 *
 * Отдельной функцией, а не полем `PropRef`, ровно потому, что для двух типов каста НЕТ:
 * у `json` его быть не может (см. ниже), у списка сравнение идёт containment'ом. Считай
 * мы каст сразу при резолве — предикат `has(orbis/recurrence)`, которому значение вообще
 * не нужно, падал бы отказом по типу.
 */
function comparable(ref: PropRef): SQL {
  if (ref.core) return ref.text;
  if (ref.list) {
    return fail(
      'TYPE',
      `у списочного свойства '${ref.def.id}' нет скалярного значения для сравнения`,
      { property: ref.def.id },
    );
  }
  return castedExpr(ref.text, ref.def.type);
}

/** Каст текстовой проекции `props->>` к типу свойства (§А2-2). */
function castedExpr(text: SQL, type: PropertyType): SQL {
  switch (type.kind) {
    case 'number':
    case 'decimal':
      return sql`(${text})::numeric`;
    case 'date':
      return sql`(${text})::date`;
    case 'timestamp':
      return sql`(${text})::timestamptz`;
    case 'boolean':
      // РП-9: `default` — семантика ЧТЕНИЯ. Умолчание берётся ИЗ РЕЕСТРА, а не
      // подставляется `false` всем булевым подряд: у `orbis/planned` оно объявлено
      // (отсутствие = «факт»), у `orbis/all_day` — нет, и приписать ему `false` значило бы
      // выдать «поля нет» за «выключено» там, где реестр ничего такого не обещал.
      return type.default === undefined
        ? sql`(${text})::boolean`
        : sql`COALESCE((${text})::boolean, ${sql.raw(String(type.default))})`;
    case 'json':
      // Вложенный объект скалярного сравнения не имеет: `->>` отдал бы текст сериализации,
      // то есть тихий ноль на равенстве и всю таблицу на отрицании (§6.4).
      return fail(
        'TYPE',
        `по свойству типа json фильтровать и сортировать нечем: значение — вложенный объект`,
      );
    default:
      // text, time, select, ref, grant, registry_ref — текстовая проекция значения.
      return text;
  }
}

function aspectOrFail(aspectId: string, ctx: CompileCtx): AspectDefinition {
  const def = ctx.reg.aspects.get(aspectId);
  if (!def) {
    return fail('UNKNOWN_ASPECT', `неизвестный аспект '${aspectId}'`, { aspect: aspectId });
  }
  return def;
}

function roleOrFail(roleId: string, ctx: CompileCtx): string {
  const def = ctx.reg.roles.get(roleId);
  if (!def) {
    return fail('UNKNOWN_ROLE', `неизвестная роль ребра '${roleId}'`, { role: roleId });
  }
  return def.id;
}

/**
 * Роли семейства иерархии из снимка реестра (§А4-3) — для реляционных предикатов без
 * `via=`. Список СОРТИРУЕТСЯ: порядок ключей Map зависит от порядка строк в БД, а от него
 * не должен зависеть ни текст запроса (golden), ни план (порядок элементов `ANY`).
 * Пустой список законен (реестр без иерархии) и означает предикат, истинный ни для кого, —
 * см. `relCond`.
 */
function hierarchicalRoleIds(ctx: CompileCtx): string[] {
  return [...ctx.reg.roles.values()]
    .filter((r) => r.hierarchical)
    .map((r) => r.id)
    .sort();
}

// ─────────────────────────── Значения ───────────────────────────

/** Значение — относительное время, а не литерал. */
function isToken(value: unknown): value is { token: QueryDateToken } {
  return typeof value === 'object' && value !== null && 'token' in value;
}

/**
 * Соответствие JS-типа значения типу свойства из реестра.
 *
 * Проверка нужна ровно потому, что вход `ast:` тула (§А5-4) идёт МИМО парсера: там
 * `{prop:'orbis/aliases', op:'contains', value: 5}` пройдёт схему канона (значение —
 * скаляр) и без этой ветки уехал бы в `props @> '{"orbis/aliases":[5]}'`, который в
 * jsonb строго типизирован и не найдёт `["5"]`. То есть — тихий ноль ровно того класса,
 * против которого §А5-3ж и §С8-3.
 *
 * `decimal` требует именно СТРОКУ: число IEEE-754 в границе теряет хвост копеек там же,
 * где его и сравнивают (§А7-3).
 */
function assertScalarType(def: PropertyDefinition, value: QueryScalar): void {
  const kind = def.type.kind;
  const actual = typeof value;
  const expected =
    kind === 'number' ? 'number' : kind === 'boolean' ? 'boolean' : ('string' as const);
  if (actual === expected) return;
  fail(
    'TYPE',
    `свойство '${def.id}' (${kind}) ожидает значение типа ${expected}, получено ${actual}`,
    { property: def.id, value },
  );
}

/** Параметр-литерал с кастом по типу свойства — правая сторона сравнения. */
function scalarParam(def: PropertyDefinition, value: QueryScalar): SQL {
  assertScalarType(def, value);
  switch (def.type.kind) {
    case 'number':
    case 'decimal':
      return sql`${value}::numeric`;
    case 'date':
      return sql`${value}::date`;
    case 'timestamp':
      return sql`${value}::timestamptz`;
    case 'boolean':
      return sql`${value}::boolean`;
    default:
      return sql`${value}`;
  }
}

/**
 * ГЕЙТ ВРЕМЕНИ: сравнение по календарной дате допустимо только у date/timestamp-свойств.
 *
 * Канон объявляет это словами («токен — только у date/timestamp», §А5-7), но НЕ сужает
 * схемой: `{prop, op, value: {token}}` разбирается для любого `prop`, потому что тип
 * свойства знает реестр, а не узел. Через текст такое дерево не построить (парсер сверяет
 * тип, `parse-ast.ts` `parseBound`), но вход `ast:` тула (§А5-4) идёт мимо парсера — а с
 * Задачи 9b он становится боевым.
 *
 * Без этой проверки компилировались схемно-легальные деревья, падавшие уже в Postgres:
 * `orbis/archived=today` давал `(archived AT TIME ZONE $2)::date` (ошибка на любых данных),
 * `orbis/task_status>today` — `(props->>…)::timestamptz` и 22007 на первой же строке. Это
 * ровно класс долга 5 гейта Задачи 8 — «валидация ДО SQL, иначе код ошибки Postgres вместо
 * структурного отказа с именем поля», закрытый там для `of`-uuid, здесь для времени.
 *
 * ЧТО ЭТА ПРОВЕРКА НЕ ДЕЛАЕТ, названо прямо: она сверяет ВИД свойства, а не ФОРМУ литерала.
 * `orbis/due_date=«банан»` со входа `ast:` по-прежнему доедет до Postgres и вернётся
 * data exception, потому что разбор формы значения живёт в парсере (`parseScalar`), а
 * второй его копией в компиляторе завелась бы вторая правда о том, что такое дата.
 */
function assertTemporal(ref: PropRef): void {
  const kind = ref.def.type.kind;
  if (kind === 'date' || kind === 'timestamp') return;
  fail(
    'TYPE',
    `относительное время и сравнение по дате применимы только к свойствам date/timestamp; ` +
      `'${ref.def.id}' — ${kind}`,
    { property: ref.def.id, kind },
  );
}

/**
 * Календарная дата значения в таймзоне владельца — левая сторона любого сравнения с
 * относительным временем (§6.1).
 */
function dateExpr(ref: PropRef, ctx: CompileCtx): SQL {
  assertTemporal(ref);
  if (ref.def.type.kind === 'date') return sql`(${ref.text})::date`;
  if (ref.core) return sql`(${ref.text} AT TIME ZONE ${ctx.timeZone})::date`;
  return sql`((${ref.text})::timestamptz AT TIME ZONE ${ctx.timeZone})::date`;
}

/**
 * Условие относительного времени (§6.1, нормативная таблица) — форма ровно та же, что у
 * старого компилятора: `next_7d` включает обе границы, `after_7d` строго дальше.
 */
function tokenCond(ref: PropRef, token: QueryDateToken, ctx: CompileCtx): SQL {
  const d = dateExpr(ref, ctx);
  switch (token) {
    case 'today':
      return sql`${d} = ${ctx.today}::date`;
    case 'overdue':
      return sql`${d} < ${ctx.today}::date`;
    case 'next_7d':
      return sql`${d} BETWEEN ${ctx.today}::date AND ${ctx.today}::date + 7`;
    case 'after_7d':
      return sql`${d} > ${ctx.today}::date + 7`;
  }
}

/**
 * Токен В РОЛИ ГРАНИЦЫ (`>`, `<`, `range`) — это ДЕНЬ, вокруг которого токен определён:
 * `today`/`overdue` — сегодня, `next_7d`/`after_7d` — сегодня+7. Направление задаёт сам
 * оператор, поэтому у границы смысл один и от направления не зависит: `"срок"<=today` —
 * «не позже сегодня», `"срок">=today` — «не раньше сегодня».
 *
 * Правило названо здесь потому, что канон его не даёт: §А5-7 разрешает токен в любой
 * границе `range`, а §6.1 описывает токены как готовые УСЛОВИЯ (`today` = «= сегодня»).
 * Растащить эти два смысла молча — значит получить `"срок"<=next_7d`, который у одного
 * читателя «не позже конца недели», а у другого «не позже сегодня».
 */
function tokenAnchor(token: QueryDateToken, ctx: CompileCtx): SQL {
  return token === 'next_7d' || token === 'after_7d'
    ? sql`${ctx.today}::date + 7`
    : sql`${ctx.today}::date`;
}

// ─────────────────────────── Предикаты свойства ───────────────────────────

/** Предикат «список содержит элемент»: containment от КОРНЯ `props` — он индексируется GIN. */
function listContains(ref: PropRef, value: QueryScalar): SQL {
  assertScalarType(ref.def, value);
  // Путь строится от корня колонки, а не поверх `props->'<id>'`: GIN по `props`
  // (jsonb_ops) покрывает `@>` самой колонки, а подпутевые формы (`props->'x' ?| …`) —
  // нет. Кодировка элемента ОДНА и известна из реестра: у `text`-списка элемент строка,
  // у `number`-списка — число. Старому компилятору приходилось перебирать обе кодировки
  // через OR (`compile.ts:389`) ровно потому, что типа он не знал.
  return sql`props @> ${JSON.stringify({ [ref.def.id]: [value] })}::jsonb`;
}

/** `NOT COALESCE(x, false)` — тотальное отрицание, «не выполнено или неизвестно». */
function negated(cond: SQL): SQL {
  return sql`NOT COALESCE(${cond}, false)`;
}

function propCond(propertyId: string, op: QueryPropOp, value: unknown, ctx: CompileCtx): SQL {
  const ref = propRef(propertyId, ctx);
  if (ref.list) return listPropCond(ref, op, value);
  return scalarPropCond(ref, op, value, ctx);
}

/**
 * Предикат по СПИСОЧНОМУ свойству. Определены ровно два оператора — `contains` и `in`;
 * остальные ОТКАЗ, и это решение задачи, а не пропуск.
 *
 * ДОЛГ ГЕЙТА ЗАДАЧИ 8, П. 1 (`eq` на списке каноном не определён) закрывается ОТКАЗОМ, а
 * не выдуманной семантикой. Причина: печать §А5-2 даёт `{op:'eq'}` и `{op:'contains'}` на
 * списочном свойстве ОДИН И ТОТ ЖЕ текст `p=v`, поэтому любое значение, приданное `eq`,
 * осталось бы неотличимым от `contains` в тексте — а дифф предложений Ш1 меряет правки
 * именно key-печатью, и правка `eq`→`contains` стала бы невидимой. Отказ убирает саму
 * пару: законное дерево у текста `p=v` на списке ровно одно.
 *
 * Относительного времени здесь нет и не может быть: токены §А5-7 применимы только к
 * date/timestamp-свойствам, а списочных date-свойств во встроенном словаре нет — ветка
 * появится вместе с первым таким свойством, а не заранее.
 */
function listPropCond(ref: PropRef, op: QueryPropOp, value: unknown): SQL {
  switch (op) {
    case 'contains':
      return listContains(ref, value as QueryScalar);
    case 'in': {
      // «Содержит хотя бы одно из» — то же, чем текст `p=a|b` уже является для списка
      // (парсер даёт `{or:[contains a, contains b]}`); `in` — его AST-форма.
      const parts = (value as QueryScalar[]).map((v) => listContains(ref, v));
      const only = parts[0] as SQL;
      return parts.length === 1 ? only : sql`(${sql.join(parts, sql` OR `)})`;
    }
    default:
      return fail(
        'TYPE',
        `оператор '${op}' не определён для списочного свойства '${ref.def.id}': ` +
          `у списка есть вхождение элемента (contains/in), но нет ни равенства, ни порядка`,
        { property: ref.def.id, op },
      );
  }
}

function scalarPropCond(ref: PropRef, op: QueryPropOp, value: unknown, ctx: CompileCtx): SQL {
  switch (op) {
    case 'eq':
      return boundCond(ref, '=', value as QueryBound, ctx);
    case 'ne':
      // `ne` и `{not:{eq}}` — ОДНА семантика намеренно. §6.1 знает единственное «не равно»
      // (решение 10: значения нет — проходит), а канон даёт для него две формы: оператор и
      // узел `not`. Разведи их по смыслу — и `p!=v` начало бы означать не то же, что `p=!v`,
      // при том что различие нигде не описано.
      return negated(boundCond(ref, '=', value as QueryBound, ctx));
    case 'gt':
      return boundCond(ref, '>', value as QueryBound, ctx);
    case 'lt':
      return boundCond(ref, '<', value as QueryBound, ctx);
    case 'range':
      return rangeCond(ref, value as QueryRangeValue, ctx);
    case 'in': {
      const values = value as QueryScalar[];
      const params = values.map((v) => scalarParam(ref.def, v));
      return sql`${comparable(ref)} IN (${sql.join(params, sql`, `)})`;
    }
    case 'contains':
      // Зеркало долга п. 1: `contains` на скаляре печатается тем же `p=v`, что и `eq`, и
      // «содержит» у текста читалось бы как подстрока — смысл, которого §А5-7 не даёт.
      // Подстрока в языке уже есть и называется `search=`.
      return fail(
        'TYPE',
        `оператор 'contains' не определён для скалярного свойства '${ref.def.id}': ` +
          `вхождение элемента бывает у списка, а поиск подстроки — это search=`,
        { property: ref.def.id, op },
      );
  }
}

/** Сравнение со скаляром ИЛИ с относительным временем (§6.1). */
function boundCond(ref: PropRef, op: '=' | '>' | '<', bound: QueryBound, ctx: CompileCtx): SQL {
  if (isToken(bound)) {
    if (op === '=') return tokenCond(ref, bound.token, ctx);
    return sql`${dateExpr(ref, ctx)} ${sql.raw(op)} ${tokenAnchor(bound.token, ctx)}`;
  }
  return sql`${comparable(ref)} ${sql.raw(op)} ${scalarParam(ref.def, bound)}`;
}

/**
 * `range` — границы ВКЛЮЧАЮЩИЕ (§А5-7). Он же несёт `<=`/`>=`: отдельных операторов у
 * канона нет, одна граница просто отсутствует.
 *
 * Если хотя бы одна граница — токен, сравнение идёт по КАЛЕНДАРНОЙ ДАТЕ (обе стороны),
 * иначе — по типу свойства. Смешивать нельзя: `timestamptz` слева и `date` справа сравнимы,
 * но означали бы не то, что просил автор запроса (полночь вместо всего дня).
 */
function rangeCond(ref: PropRef, value: QueryRangeValue, ctx: CompileCtx): SQL {
  const { from, to } = value;
  if (from === undefined && to === undefined) {
    return fail('SYNTAX', `range без границ у свойства '${ref.def.id}'`, { property: ref.def.id });
  }
  const byDate = isToken(from) || isToken(to);
  const left = byDate ? dateExpr(ref, ctx) : comparable(ref);
  const side = (b: QueryBound): SQL => {
    if (isToken(b)) return tokenAnchor(b.token, ctx);
    if (!byDate) return scalarParam(ref.def, b);
    // Литеральная граница РЯДОМ с токеном: слева стоит календарная дата, значит и справа
    // обязана быть она. Тип литерала сверяется по реестру тем же гейтом, что и у обычных
    // сравнений, — иначе `{from: 5, to: {token:'today'}}` уехало бы в `5::date`.
    assertScalarType(ref.def, b);
    return sql`${b}::date`;
  };
  if (from !== undefined && to !== undefined) {
    return sql`${left} BETWEEN ${side(from)} AND ${side(to)}`;
  }
  if (from !== undefined) return sql`${left} >= ${side(from)}`;
  return sql`${left} <= ${side(to as QueryBound)}`;
}

// ─────────────────────────── Реляционные предикаты ───────────────────────────

/** UUID второго конца; `this` резолвится контекстом потребителя (§6.1). */
function relTarget(of: string, ctx: CompileCtx): string {
  if (of === 'this') {
    const id = ctx.thisEntityId ?? null;
    if (id === null) {
      return fail(
        'THIS_OUT_OF_CONTEXT',
        'this вне контекста сущности: запрос вынесен из тела записи, подставлять нечего',
      );
    }
    return id;
  }
  // Проверка ДО SQL: без неё `of: 'банан'` доехал бы до Postgres и вернулся ошибкой каста
  // 22P02 — то есть 500 вместо структурного отказа с именем поля (долг гейта Задачи 8, п. 5).
  if (!UUID_RE.test(of)) {
    return fail('SYNTAX', `реляционный предикат ожидает UUID или this, получено '${of}'`, {
      of,
    });
  }
  return of;
}

/** Условие по роли ребра внутри подзапроса: `r.role = $v` либо семейство иерархии. */
function roleCond(via: string | undefined, ctx: CompileCtx): SQL {
  if (via !== undefined) return sql`r.role = ${roleOrFail(via, ctx)}`;
  const roles = hierarchicalRoleIds(ctx);
  if (roles.length === 0) {
    // Реестр без единой иерархической роли — законное состояние (§А4-3), и «детей» в нём
    // нет ни у кого. `false` честнее пустого условия: пустое вернуло бы ВСЕ рёбра.
    return sql`false`;
  }
  return sql`r.role = ANY(${textArray(roles)})`;
}

/**
 * Рекурсивный обход по одной роли (§А5-1): `descendants_of` — вниз по `(source_id, role)`,
 * `ancestors_of` — вверх по `(target_id, role)`. Кап глубины — константа компилятора
 * `QUERY_DEPTH_CAP`, а не поле узла: глубина — свойство исполнения, и заказать обход на
 * 10 000 уровней отдельным запросом нельзя.
 *
 * Форма `e.id IN (WITH RECURSIVE …)`, а не коррелированный `EXISTS`: подзапрос НЕ зависит
 * от строки, поэтому обход считается один раз на запрос. Коррелированная форма исполняла
 * бы весь обход на КАЖДУЮ строку выборки — на 50k сущностей это разница не в проценты.
 *
 * `UNION`, а не `UNION ALL`, и это не косметика. Иерархия ролью НЕ обязана быть деревом:
 * `subitem` не объявлен ацикличным (§А4-2 ставит `acyclic` только `category-parent` и
 * `dependency`), и у узла законно несколько родителей. На `UNION ALL` каждый ромб множит
 * пути, и обход графа с тремя родителями на узел и глубиной 8 стоит 3^8 проходов вместо
 * одного — то есть кап 32 спасал бы от бесконечности, но не от взрыва. `UNION` схлопывает
 * повтор пары `(id, depth)`, оставляя работу в границах «узлы × кап»; ровно так же считает
 * предков движок `recomputeProjectAncestors` (`executor/ancestors.ts`).
 */
function walkCond(
  pred: Extract<QueryRelPredicate, { kind: 'descendants_of' | 'ancestors_of' }>,
  ctx: CompileCtx,
): SQL {
  const of = relTarget(pred.of, ctx);
  const role = roleOrFail(pred.via, ctx);
  const down = pred.kind === 'descendants_of';
  const seedFrom = down ? sql.raw('r.source_id') : sql.raw('r.target_id');
  const seedTake = down ? sql.raw('r.target_id') : sql.raw('r.source_id');
  const stepJoin = down ? sql.raw('r.source_id') : sql.raw('r.target_id');
  const cap = sql.raw(String(QUERY_DEPTH_CAP));
  return sql`e.id IN (WITH RECURSIVE walk(id, depth) AS (
      SELECT ${seedTake}, 1 FROM relations r WHERE ${seedFrom} = ${of} AND r.role = ${role}
    UNION
      SELECT ${seedTake}, w.depth + 1 FROM walk w JOIN relations r ON ${stepJoin} = w.id AND r.role = ${role} WHERE w.depth < ${cap}
  ) SELECT id FROM walk)`;
}

/**
 * Состояние ВТОРОГО конца ребра (`QueryRelSourceNotIn`): ребро считается, только если у
 * ИСТОЧНИКА свойство не имеет ни одного из перечисленных значений.
 *
 * `COALESCE(…, '')` — не украшение, а СМЫСЛ: у источника значения может не быть вовсе
 * (блокер без аспекта задачи), и такой источник обязан считаться НЕ закрытым, иначе
 * `NULL NOT IN (…)` дал бы NULL, ребро выпало бы из EXISTS, и заметка-блокер перестала бы
 * блокировать. Форма дословно та же, что у сегодняшнего компилятора (`compile.ts:272`),
 * только по `props` вместо старой карты, — потому что менять наблюдаемое поведение реформа
 * не имеет права.
 *
 * Сравнение ТЕКСТОВОЕ и по проекции `->>`: набор «закрытых» задаёт разбор ключами вариантов
 * select (`done`, `cancelled`), а `->>` отдаёт ровно их. Каст по типу свойства здесь был бы
 * лишним звеном: значения приходят не от пользователя, а из сахара.
 */
function sourceNotInCond(
  spec: { prop: string; values: readonly QueryScalar[] },
  ctx: CompileCtx,
): SQL {
  const def = propertyOrFail(spec.prop, ctx);
  if (isListType(def.type) || def.type.kind === 'json') {
    return fail(
      'TYPE',
      `состояние дальнего конца по свойству '${def.id}' невыразимо: у списка и вложенного объекта нет скалярного значения`,
      { property: def.id },
    );
  }
  if (def.storage === 'core') {
    return fail(
      'TYPE',
      `состояние дальнего конца по core-проекции '${def.id}' не поддержано: значение лежит колонкой`,
      { property: def.id },
    );
  }
  const values = spec.values.map((v) => sql`${String(v)}`);
  return sql`COALESCE(b.props->>${lit(def.id)}, '') NOT IN (${sql.join(values, sql`, `)})`;
}

/**
 * Реляционный предикат §А5-7. Каким КОНЦОМ ребра стоит сама сущность — норматив
 * `QUERY_REL_ANCHOR` (`@orbis/shared`, `query/ast.ts`); здесь он исполняется.
 *
 * `has_relation` — ТОЛЬКО ВХОДЯЩЕЕ ребро (рулинг координатора при предразборе Задачи 8):
 * несущий индекс — `(target_id, role)`, и на этом же направлении держится сегодняшний
 * `excludeBlocked` (`compile.ts:262`): «оба направления» начали бы вычёркивать и сами
 * блокирующие работы.
 */
function relCond(pred: QueryRelPredicate, ctx: CompileCtx): SQL {
  switch (pred.kind) {
    case 'children_of':
      return sql`EXISTS (SELECT 1 FROM relations r WHERE r.target_id = e.id AND r.source_id = ${relTarget(pred.of, ctx)} AND ${roleCond(pred.via, ctx)})`;
    case 'parents_of':
      return sql`EXISTS (SELECT 1 FROM relations r WHERE r.source_id = e.id AND r.target_id = ${relTarget(pred.of, ctx)} AND ${roleCond(pred.via, ctx)})`;
    case 'has_relation':
      return pred.sourceNotIn === undefined
        ? sql`EXISTS (SELECT 1 FROM relations r WHERE r.target_id = e.id AND ${roleCond(pred.via, ctx)})`
        : sql`EXISTS (SELECT 1 FROM relations r JOIN entities b ON b.id = r.source_id WHERE r.target_id = e.id AND ${roleCond(pred.via, ctx)} AND ${sourceNotInCond(pred.sourceNotIn, ctx)})`;
    case 'has_children':
      return sql`EXISTS (SELECT 1 FROM relations r WHERE r.source_id = e.id AND ${roleCond(pred.via, ctx)})`;
    case 'descendants_of':
    case 'ancestors_of':
      return walkCond(pred, ctx);
  }
}

// ─────────────────────────── Дерево фильтра ───────────────────────────

function compileNode(node: QueryFilterNode, ctx: CompileCtx): SQL {
  if ('and' in node) return joinNodes(node.and, 'AND', ctx);
  if ('or' in node) return joinNodes(node.or, 'OR', ctx);
  if ('not' in node) return negated(compileNode(node.not, ctx));
  if ('prop' in node) return propCond(node.prop, node.op, node.value, ctx);
  if ('has' in node) {
    const ref = propRef(node.has, ctx);
    // У core-свойства значение лежит в колонке, и ключа в `props` у него нет по построению:
    // `props ? 'orbis/title'` был бы ложью для каждой строки.
    return ref.core ? sql`${ref.text} IS NOT NULL` : sql`props ? ${lit(ref.def.id)}`;
  }
  if ('aspect' in node) return sql`aspects @> ARRAY[${lit(aspectOrFail(node.aspect, ctx).id)}]`;
  if ('tag' in node) return sql`tags @> ${textArray([node.tag])}`;
  if ('search' in node) {
    return sql`(to_tsvector('simple', title) @@ plainto_tsquery('simple', ${node.search}) OR to_tsvector('simple', body) @@ plainto_tsquery('simple', ${node.search}))`;
  }
  if ('rel' in node) return relCond(node.rel, ctx);
  if ('archived' in node) {
    // `'any'` — предикат, истинный для всех: «архивные И неархивные». Именно предикат, а не
    // пустое место, потому что канон допускает `{not: {archived:'any'}}` (текст `!archived=any`
    // разбирается) — и у отрицания обязан быть определённый ответ. Он определённый: «ни те
    // ни другие», то есть пусто. Само же снятие умолчания «только неархивные» делает не это
    // выражение, а высказывание запроса об архивности (см. `decidesArchived`).
    return node.archived === 'any' ? sql`true` : sql`archived`;
  }
  // Часть Б: контрактов в срезе А нет, и молчаливое игнорирование дало бы запрос, который
  // «работает» и отбирает не то.
  return fail('CLASS_NOT_AVAILABLE', 'предикат class появится с контрактами (часть Б реформы)', {
    contract: node.class.contract,
    set: node.class.set,
  });
}

function joinNodes(nodes: QueryFilterNode[], op: 'AND' | 'OR', ctx: CompileCtx): SQL {
  const parts = nodes.map((n) => compileNode(n, ctx));
  const only = parts[0] as SQL;
  if (parts.length === 1) return only;
  return sql`(${sql.join(parts, sql.raw(` ${op} `))})`;
}

/** Обход дерева: `fn` вызывается на каждом узле, включая корень. */
function walkNodes(node: QueryFilterNode, fn: (n: QueryFilterNode) => void): void {
  fn(node);
  if ('and' in node) for (const child of node.and) walkNodes(child, fn);
  else if ('or' in node) for (const child of node.or) walkNodes(child, fn);
  else if ('not' in node) walkNodes(node.not, fn);
}

/**
 * ВЫСКАЗАЛСЯ ЛИ ЗАПРОС ОБ АРХИВНОСТИ — только тогда снимается умолчание «только неархивные».
 *
 * Способов высказаться ДВА, и второй не менее законен первого: слово грамматики `archived=`
 * и предикат по core-свойству `orbis/archived` (§А1-3 завёл ему запись в реестре ровно
 * затем, чтобы у колонки был единый адрес для Q-AST). Считать высказыванием только первый —
 * значит компилировать `orbis/archived=true` в противоречие `NOT archived AND archived`,
 * то есть в ноль строк на любых данных и без единой ошибки. Это ровно тот тихий ноль,
 * против которого §6.4 и §С8-3, и найден он был на этом самом свойстве.
 *
 * `has(orbis/archived)` высказыванием НЕ считается, и это не придирка: у core-колонки ключ
 * есть всегда, поэтому `has` не говорит о ЗНАЧЕНИИ архивности ничего — он не выбирает между
 * архивными и неархивными, а значит и умолчание снимать ему нечем.
 *
 * Свойство опознаётся по РЕЕСТРУ (`storage: 'core'`) и по карте колонок, а не по литералу
 * id: переименуют свойство в реестре — карта поедет вместе с ним, а литерал молча перестал
 * бы совпадать.
 */
function decidesArchived(ast: QueryAst, ctx: CompileCtx): boolean {
  if (ast.filter === null) return false;
  let found = false;
  walkNodes(ast.filter, (n) => {
    if ('archived' in n) found = true;
    if (!('prop' in n)) return;
    const def = ctx.reg.properties.get(n.prop);
    if (def?.storage === 'core' && CORE_COLUMN[def.id] === ARCHIVED_COLUMN) found = true;
  });
  return found;
}

/** id служебных аспектов реестра (§А3-1, колонка `service`), отсортированные. */
function serviceAspectIds(ctx: CompileCtx): string[] {
  return [...ctx.reg.aspects.values()]
    .filter((a) => a.service)
    .map((a) => a.id)
    .sort();
}

/**
 * Назвал ли ЗАПРОС служебный аспект (§А5-6). Два способа, и второй не менее важен первого:
 *
 *  1. узел `{aspect: <служебный>}` где угодно в дереве — прямое упоминание;
 *  2. предикат по свойству, ВСЕ носители которого служебные (`orbis/run_outcome` объявлен
 *     единственным аспектом `orbis/agent-run`). Без этого правила `orbis/run_outcome=running`
 *     компилировался бы в противоречие — «исключить прогоны И взять с полем прогона» — и
 *     молча отдавал бы ноль строк, худший из отказов (§6.4).
 *
 * Свойство, которое носит и служебный, и обычный аспект (`orbis/grant` — и назначение, и
 * прогон), сигналом НЕ становится: по нему нельзя сказать, спрашивали ли про прогоны.
 *
 * `sortBy` не считается намеренно (как и в `compile.ts:203`): порядок выдачи описывает не
 * её цель, и `sortBy=orbis/step_count:desc` поверх обычного списка не должен втягивать в
 * него прогоны.
 */
function namesServiceAspect(ast: QueryAst, ctx: CompileCtx, service: readonly string[]): boolean {
  if (ast.filter === null || service.length === 0) return false;
  const serviceSet = new Set(service);
  const carriers = new Map<string, string[]>();
  for (const aspect of ctx.reg.aspects.values()) {
    for (const ref of aspect.properties) {
      const list = carriers.get(ref.propertyId);
      if (list) list.push(aspect.id);
      else carriers.set(ref.propertyId, [aspect.id]);
    }
  }
  let named = false;
  walkNodes(ast.filter, (n) => {
    if ('aspect' in n && serviceSet.has(n.aspect)) named = true;
    const propertyId = 'prop' in n ? n.prop : 'has' in n ? n.has : null;
    if (propertyId === null) return;
    const owners = carriers.get(propertyId) ?? [];
    if (owners.length > 0 && owners.every((id) => serviceSet.has(id))) named = true;
  });
  return named;
}

/**
 * WHERE целиком: умолчание архивности, скрытие служебных аспектов, само дерево.
 * Порядок частей — как в псевдо-SQL §6.1, чтобы эталон читался рядом с нормативом.
 */
function compileWhere(ast: QueryAst, ctx: CompileCtx): SQL {
  const conds: SQL[] = [sql`true`];
  if (!decidesArchived(ast, ctx)) conds.push(sql`NOT archived`);
  const service = serviceAspectIds(ctx);
  if (service.length > 0 && !namesServiceAspect(ast, ctx, service)) {
    // Индексом не ускоряется (GIN отрицание не покрывает) — это построчный фильтр поверх
    // остальной выборки: одна проверка пересечения двух коротких массивов.
    conds.push(sql`NOT (aspects && ${textArray(service)})`);
  }
  if (ast.filter !== null) conds.push(compileNode(ast.filter, ctx));
  return sql.join(conds, sql` AND `);
}

// ─────────────────────────── ORDER BY ───────────────────────────

function sortItem(field: QuerySortField, ctx: CompileCtx): SQL {
  const ref = propRef(field.field, ctx);
  const dir = sql.raw(field.dir === 'desc' ? 'DESC' : 'ASC');
  if (ref.list) {
    return fail(
      'TYPE',
      `сортировать по списочному свойству '${ref.def.id}' нельзя — у списка нет линейного порядка`,
      { property: ref.def.id },
    );
  }
  if (ref.def.type.kind === 'select') {
    // Порядок вариантов — `rank` ОБЪЯВЛЕНИЯ из реестра (§А2-2), а не алфавит и не позиция
    // в массиве: `rank` и есть то число, которым владелец переставляет варианты.
    const whens = [...ref.def.type.options]
      .sort((a, b) => a.rank - b.rank)
      .map((o) => `WHEN '${o.key.replaceAll("'", "''")}' THEN ${o.rank}`)
      .join(' ');
    return sql`CASE ${ref.text} ${sql.raw(whens)} END ${dir} NULLS LAST`;
  }
  // NULLS LAST — §6.1 («NULL всегда в конце, независимо от направления»); для NOT NULL
  // core-колонок безвреден.
  return sql`${comparable(ref)} ${dir} NULLS LAST`;
}

function compileOrderBy(ast: QueryAst, ctx: CompileCtx): SQL | null {
  if (!ast.sortBy || ast.sortBy.length === 0) return null;
  return sql.join(
    ast.sortBy.map((s) => sortItem(s, ctx)),
    sql`, `,
  );
}

// ─────────────────────────── Точки входа ───────────────────────────

/** Полный SELECT: WHERE + ORDER BY + LIMIT (кап 500 без `limit`). */
export function compileQueryAst(ast: QueryAst, ctx: CompileCtx): SQL {
  let q = sql`SELECT ${sql.raw(ENTITY_COLUMNS)} FROM entities e WHERE ${compileWhere(ast, ctx)}`;
  const order = compileOrderBy(ast, ctx);
  if (order) q = sql`${q} ORDER BY ${order}`;
  return sql`${q} LIMIT ${ast.limit ?? DEFAULT_LIMIT}`;
}

/** COUNT(*) для бейджей (02 §3.2): те же условия, но без `limit`/`sortBy`/капа. */
export function compileCountAst(ast: QueryAst, ctx: CompileCtx): SQL {
  return sql`SELECT count(*) FROM entities e WHERE ${compileWhere(ast, ctx)}`;
}

/**
 * Числовое свойство агрегата: `sum`/`latest` осмысленны только над числом. Отказ здесь
 * отличается от отказа по запросу (`reason: 'FIELD'`): цель §11.3 обязана различать
 * «сломано поле» и «сломан запрос» — у неё на это разные ярлыки fail-soft.
 */
function numericRef(propertyId: string, ctx: CompileCtx, op: 'sum' | 'latest'): PropRef {
  const ref = propRef(propertyId, ctx);
  const kind = ref.def.type.kind;
  if (ref.list || ref.core || (kind !== 'number' && kind !== 'decimal')) {
    return fail('FIELD', `${op} по свойству '${propertyId}' невозможен: тип ${kind} не числовой`, {
      property: propertyId,
    });
  }
  return ref;
}

/**
 * Агрегация `user_query` (§9.2) и `aggregate: "sum"` целей (§11.3): count + sum одним
 * SELECT по той же выборке, что `compileQueryAst`, но БЕЗ limit. Сумма считается
 * `numeric` и отдаётся текстом — точность decimal-строк не теряется во float (§3.3).
 */
export function compileSumAst(ast: QueryAst, propertyId: string, ctx: CompileCtx): SQL {
  const ref = numericRef(propertyId, ctx, 'sum');
  return sql`SELECT count(*) AS count, sum(${comparable(ref)})::text AS sum FROM entities e WHERE ${compileWhere(ast, ctx)}`;
}

/**
 * `latest` целей (§11.3): значение числового свойства у ПОСЛЕДНЕЙ сущности той же выборки.
 * «Последняя» = максимум `updated_at` (единственный индексированный core-порядок), ничья
 * снимается `id DESC`. Строки без значения в кандидаты не попадают: правка соседней записи
 * не должна обнулять «последнее измерение» цели.
 */
export function compileLatestAst(ast: QueryAst, propertyId: string, ctx: CompileCtx): SQL {
  const ref = numericRef(propertyId, ctx, 'latest');
  return sql`SELECT ${comparable(ref)}::text AS value FROM entities e WHERE ${compileWhere(ast, ctx)} AND ${ref.text} IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 1`;
}
