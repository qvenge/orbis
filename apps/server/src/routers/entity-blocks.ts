// apps/server/src/routers/entity-blocks.ts
// Исполнение пачки блоков страницы (`entity.blocks`, срез 1а, спека §6.3). Процедура в
// `routers/entity.ts` — только трансляция; вся механика пачки — здесь.
import {
  BLOCK_ROWS_CAP,
  type BlockError,
  type BlockResult,
  type DayGroupField,
  type DayGroupInputRow,
  type EntityBlocksInput,
  type EntityBlocksResult,
  layoutDayGroups,
  type RowRegistry,
} from '@orbis/shared';
// Листовой сабпат, не баррель `@orbis/shared/doc`: нужна одна строка, а не редактор документа.
import { type PageNode, paramDeclsOf, parsePageText } from '@orbis/shared/doc/page-grammar';
import { EMPTY_QUERY_MESSAGE } from '@orbis/shared/doc/placement';
import {
  fieldRefKey,
  isContractAddress,
  type QueryAst,
  type QueryBound,
  type QueryFieldRef,
  tokenEdges,
} from '@orbis/shared/query';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import type { Identity } from '../identity';
import {
  type CompileCtx,
  compileBlockRowsAst,
  compileCountAst,
  compileLatestAst,
  compileSumByCurrencyAst,
  sumsOf,
  topLevelConds,
} from '../query/compile-ast';
import { queryContext } from '../query/context';
import { DAY_RE } from '../query/contract-sql';
import { substituteParams } from '../query/params';
import { parseQueryText } from '../query/parse-text';
import { materializationWindow, materializeInstances } from '../recurring/materialize';
import { materializeRuleOf } from '../rules/carriers';
import { toWireEntityFromSql } from '../wire';

/**
 * Текст отказа исполнения блока — ОДИН на все падения базы. Сообщение Postgres наружу не идёт:
 * оно про колонки, касты и параметры запроса (`invalid input syntax for type numeric…`), то есть
 * про устройство хранения, а не про то, что владелец может поправить. Подробности — в журнале
 * сервера (`console.error` ниже).
 */
export const EXECUTION_FAILED_MESSAGE =
  'запрос блока не выполнился в базе — вероятно, у части записей значение свойства не той формы';

type Window = { from: string; to: string };

type Period = { start: string; end: string };

/** Скомпилированный блок: SQL готов ДО первого обращения к базе. */
type Plan =
  | { kind: 'rows'; sql: SQL; limit: number }
  | {
      kind: 'groups';
      sql: SQL;
      limit: number;
      /** Раскладка по дням (§5.2): поле, период блока, пояс владельца и снимок для привязок «когда». */
      field: DayGroupField;
      period: Period | null;
      timeZone: string;
      reg: RowRegistry;
    }
  | { kind: 'count'; sql: SQL }
  | { kind: 'sum'; sql: SQL; ownerCurrency: string }
  | { kind: 'latest'; sql: SQL };

/** `settled` — ответ блока известен без SQL: отказ разбора или бейдж страницы без блоков. */
type Prepared =
  | { key: string; kind: 'settled'; result: BlockResult }
  | { key: string; kind: 'planned'; plan: Plan; window: Window | null };

type TextItem = Extract<EntityBlocksInput['blocks'][number], { text: string }>;

/**
 * Отказ разбора/компиляции → ошибка блока в той же форме, что `queryErrorToTRPC` кладёт в
 * `cause` у `entity.query`: код причины из `details.reason`, позиция — где она есть. Не
 * `ExecError('VALIDATION')` — программная ошибка, и глотать её в «ошибку блока» нельзя.
 */
function compileFailure(e: unknown): BlockError {
  if (!(e instanceof ExecError) || e.code !== 'VALIDATION') throw e;
  const d = (e.details ?? {}) as { reason?: unknown; position?: unknown };
  return {
    code: typeof d.reason === 'string' ? d.reason : e.code,
    message: e.message,
    ...(typeof d.position === 'number' && { position: d.position }),
  };
}

/**
 * Разбор и компиляция одного текста запроса — чисто, без SQL. Любой отказ остаётся отказом ЭТОГО
 * блока. `compile` решает вид ответа: блок — по проекции (`compileBlock`), бейдж — всегда число.
 *
 * Пустой текст отсекается ДО разбора (Р-21-8): грамматика принимает его законным пустым
 * фильтром, а сервер такой фильтр не отсекает — блок «не настроен» вернул бы все записи
 * владельца. Текст ОБРЕЗАЕТСЯ по краям перед разбором — так же, как у плашки тела
 * (`doc/placement.ts`) и блока в web: иначе позиция ошибки разошлась бы с их позицией.
 *
 * Параметр страницы (1в §5.1, РП-6): блок пачки — блок тела страницы, разбор идёт с местом `page`
 * (`$`-ссылка законна), затем `substituteParams` ставит значения `values` на место ссылок — ДО окна
 * материализации и компиляции: оба читают токен, а ссылки не знают. Нет значения или оно не токен —
 * отказ этого блока, как любой отказ разбора.
 */
// ОБХОДЧИК-Q: entity-blocks
function prepareQuery(
  key: string,
  rawText: string,
  thisEntityId: string | null,
  values: Readonly<Record<string, string>>,
  base: CompileCtx,
  params: Parameters<typeof materializationWindow>[2],
  compile: (ast: QueryAst, cctx: CompileCtx) => Plan,
): Prepared {
  const text = rawText.trim();
  if (text === '') {
    return {
      key,
      kind: 'settled',
      result: { ok: false, error: { code: 'EMPTY', message: EMPTY_QUERY_MESSAGE } },
    };
  }
  const cctx: CompileCtx = { ...base, thisEntityId };
  try {
    const ast = substituteParams(parseQueryText(text, cctx, { place: 'page' }), values);
    return {
      key,
      kind: 'planned',
      plan: compile(ast, cctx),
      // Реестр — тот же снимок, что разбирал блок: окно от адреса контракта считается по его
      // привязкам (1в §3.4).
      window: materializationWindow(ast, cctx.today, params, cctx.reg, cctx.weekStart),
    };
  } catch (e) {
    return { key, kind: 'settled', result: { ok: false, error: compileFailure(e) } };
  }
}

function prepareBlock(
  block: TextItem,
  base: CompileCtx,
  params: Parameters<typeof materializationWindow>[2],
): Prepared {
  return prepareQuery(
    block.key,
    block.text,
    block.thisEntityId ?? null,
    block.params ?? {},
    base,
    params,
    (ast, c) => compileBlock(ast, c, block.limit),
  );
}

/**
 * Текст ПЕРВОГО блока данных (`{{query:…}}`) страницы в порядке документа — обход в глубину, как у
 * `bodyIssues` (`doc/placement.ts`): блок во вкладке или колонке, стоящий выше, первее блока ниже на
 * верхнем уровне. Сломанный контейнер (`broken`) внутрь не обходится — он не рисуется, и бейдж не
 * считает то, чего владелец на странице не видит. `null` — блоков данных нет.
 */
function firstQueryText(nodes: readonly PageNode[]): string | null {
  for (const node of nodes) {
    if (node.kind === 'query') return node.text;
    const parts =
      node.kind === 'columns'
        ? node.parts
        : node.kind === 'tabs'
          ? node.parts.map((t) => t.children)
          : [];
    for (const part of parts) {
      const found = firstQueryText(part);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Отказ бейджа: страницы нет или она чужая — RLS их не различает, и ответ один. */
const BADGE_NOT_FOUND: BlockResult = {
  ok: false,
  error: { code: 'NOT_FOUND', message: 'страница раздела не найдена' },
};

/**
 * Бейджи раздела (срез 1б §9.3, РП-8): тела страниц — ОДНИМ чтением на пачку, под той же
 * идентичностью (чужая страница под RLS не видна — отказ, а не чужое число). Число — счёт первого
 * блока данных (`compileCountAst`), что бы ни стояло в его проекции: бейдж — число записей раздела,
 * а не плитка суммы. `thisEntityId` — сама страница: `this` в её блоке значит её, как на экране.
 *
 * Параметр страницы (1в §5.1): бейдж считает первый блок данных ПО УМОЛЧАНИЯМ — `default` из
 * объявлений `{{param}}` того же тела (`paramDeclsOf`; сам `{{param}}` блоком данных не является и
 * «первым» не бывает). Значения экрана бейдж не знает и знать не должен: число раздела в навигации
 * одно на все открытия страницы. Ссылка на имя без объявления или на параметр с ошибкой блока —
 * отказ бейджа `UNKNOWN_PARAM`, как у блока.
 */
async function prepareBadges(
  tx: Tx,
  identity: Identity,
  items: ReadonlyArray<{ key: string; badgeOf: string }>,
  base: CompileCtx,
  params: Parameters<typeof materializationWindow>[2],
): Promise<Map<string, Prepared>> {
  const out = new Map<string, Prepared>();
  if (items.length === 0) return out;
  const ids = [...new Set(items.map((b) => b.badgeOf.toLowerCase()))];
  const rows = await tx
    .select({ id: entities.id, body: entities.body })
    .from(entities)
    .where(and(eq(entities.graphId, identity.graph), inArray(entities.id, ids)));
  const bodies = new Map(rows.map((r) => [r.id, r.body]));
  for (const item of items) {
    const body = bodies.get(item.badgeOf.toLowerCase());
    if (body === undefined) {
      out.set(item.key, { key: item.key, kind: 'settled', result: BADGE_NOT_FOUND });
      continue;
    }
    const nodes = parsePageText(body ?? '');
    const text = firstQueryText(nodes);
    const defaults = Object.fromEntries(
      [...paramDeclsOf(nodes)].map(([name, decl]) => [name, decl.default]),
    );
    out.set(
      item.key,
      text === null
        ? { key: item.key, kind: 'settled', result: { ok: true, kind: 'none' } }
        : prepareQuery(item.key, text, item.badgeOf, defaults, base, params, (ast, c) => ({
            kind: 'count',
            sql: compileCountAst(ast, c),
          })),
    );
  }
  return out;
}

/**
 * ПЕРИОД БЛОКА для пустых дней (§5.2) — ПЕРЕСЕЧЕНИЕ интервалов всех условий `=T` на ТОМ ЖЕ поле, что
 * группировка, среди детей верхнего `and` (параметры уже подставлены): токен — его края (`tokenEdges`,
 * §3.4), литерал дня — этот день, `range` — края обеих границ (токен `from` — его начало, `to` — конец).
 * Пересечение, а не первое условие (М-2 ревью B1): ключ дня — дата, удовлетворяющая ВСЕМ условиям на
 * адресе (`addressSortKey`), и `=this_month, =today` с периодом месяца нарисовал бы 30 «свободных» дней,
 * которых блок показать не может. Открытый край одного условия (`overdue` — без начала, `after_7d` — без
 * конца) берёт край у другого; края нет ни у одного, граница-момент, пустое пересечение или условия нет —
 * `null`: рисуются только непустые дни.
 */
function groupPeriod(ast: QueryAst, field: QueryFieldRef, cctx: CompileCtx): Period | null {
  const key = fieldRefKey(field);
  const dayOf = (b: QueryBound | undefined, edge: 'start' | 'end'): string | null => {
    if (typeof b === 'string') return DAY_RE.test(b) ? b : null;
    if (typeof b === 'object' && b !== null && 'token' in b) {
      return tokenEdges(b.token, cctx.today, cctx.weekStart)[edge];
    }
    return null;
  };
  let start: string | null = null;
  let end: string | null = null;
  for (const n of topLevelConds(ast)) {
    if (!('prop' in n) || fieldRefKey(n.prop) !== key) continue;
    if (isContractAddress(n.prop) !== isContractAddress(field)) continue;
    const range =
      n.op === 'eq'
        ? { start: dayOf(n.value as QueryBound, 'start'), end: dayOf(n.value as QueryBound, 'end') }
        : n.op === 'range'
          ? {
              start: dayOf((n.value as { from?: QueryBound }).from, 'start'),
              end: dayOf((n.value as { to?: QueryBound }).to, 'end'),
            }
          : null;
    if (range === null) continue;
    if (range.start !== null && (start === null || range.start > start)) start = range.start;
    if (range.end !== null && (end === null || range.end < end)) end = range.end;
  }
  return start !== null && end !== null && start <= end ? { start, end } : null;
}

/** Поле группы для раскладки: значение контракта, адрес слота или свойство. */
function dayGroupField(field: QueryFieldRef): DayGroupField {
  if (!isContractAddress(field)) return { kind: 'property', propertyId: field };
  return field.slot === undefined
    ? { kind: 'value', contract: field.contract }
    : { kind: 'slot', contract: field.contract, slot: field.slot };
}

/**
 * Вид ответа — по проекции (§5.4): плитка → агрегат, `group=day:<поле>` → группы по дням (1в §5.2),
 * иначе строки. Компилятор проекцию не читает, поэтому развилка стоит здесь.
 *
 * Строки и группы: `limit` блока, иначе `limit` текста, иначе потолок; всё клампится до
 * `BLOCK_ROWS_CAP` (схема канона `limit` сверху не ограничивает). Выборка — `limit + 1`: лишняя
 * строка и есть признак «ещё N», а само N — колонка `__total` той же выборки (`count(*) OVER ()`,
 * `shownRows`); второго запроса счётчика нет.
 */
function compileBlock(ast: QueryAst, cctx: CompileCtx, blockLimit: number | undefined): Plan {
  if (ast.display === 'tile' && ast.aggregate !== undefined) {
    const agg = ast.aggregate;
    if (agg.fn === 'count') return { kind: 'count', sql: compileCountAst(ast, cctx) };
    if (agg.fn === 'sum') {
      // По валютам (спека 1в §3.6): денежность и валюта — по привязке «движения денег» аспекта на
      // записи, а не литерал свойства валюты (до 1в запись без валюты терялась из списка валют).
      return {
        kind: 'sum',
        sql: compileSumByCurrencyAst(ast, agg.field, cctx),
        ownerCurrency: cctx.ownerCurrency,
      };
    }
    return { kind: 'latest', sql: compileLatestAst(ast, agg.field, cctx) };
  }
  const limit = Math.min(blockLimit ?? ast.limit ?? BLOCK_ROWS_CAP, BLOCK_ROWS_CAP);
  const sql = compileBlockRowsAst({ ...ast, limit: limit + 1 }, cctx);
  if (ast.group === undefined) return { kind: 'rows', sql, limit };
  return {
    kind: 'groups',
    sql,
    limit,
    field: dayGroupField(ast.group.field),
    period: groupPeriod(ast, ast.group.field, cctx),
    timeZone: cctx.timeZone,
    reg: cctx.reg,
  };
}

/**
 * Строки блока и «ещё N»: выборка `limit + 1`, «ещё N» — у переполненного блока из колонки `__total`
 * той же выборки (`count(*) OVER ()`, `compileBlockRowsAst`): один проход, один снимок, и лишняя
 * увиденная строка уже гарантирует `__total > limit`. Второго statement счётчика нет — у Повестки он
 * стоил трети пачки (задача 10 1в, `agenda:page`). `Math.max(1, …)` — страховка формы, а не снимка.
 */
async function shownRows(
  sp: Tx,
  plan: { sql: SQL; limit: number },
): Promise<{ rows: Record<string, unknown>[]; more: number }> {
  const raw = [...(await sp.execute(plan.sql))] as Record<string, unknown>[];
  if (raw.length <= plan.limit) return { rows: raw, more: 0 };
  return {
    rows: raw.slice(0, plan.limit),
    more: Math.max(1, Number(raw[0]?.__total) - plan.limit),
  };
}

/** `closedIds` (РП-12): показанные записи в наборе `closed` завершаемости — колонка `__closed`. */
function closedIdsOf(rows: readonly Record<string, unknown>[]): string[] {
  return rows.filter((r) => r.__closed === true).map((r) => String(r.id));
}

/** Момент колонки `timestamptz` ISO-строкой: драйвер отдаёт `Date` (или текст — у сырого SQL). */
function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

/** Объединение окон 'YYYY-MM-DD' (строки такой формы сравниваются как даты). */
function unionWindow(a: Window | null, b: Window | null): Window | null {
  if (a === null) return b;
  if (b === null) return a;
  return { from: b.from < a.from ? b.from : a.from, to: b.to > a.to ? b.to : a.to };
}

async function executePlan(sp: Tx, plan: Plan): Promise<BlockResult> {
  switch (plan.kind) {
    case 'rows': {
      const { rows, more } = await shownRows(sp, plan);
      return {
        ok: true,
        kind: 'rows',
        rows: rows.map(toWireEntityFromSql),
        more,
        closedIds: closedIdsOf(rows),
      };
    }
    case 'groups': {
      const { rows, more } = await shownRows(sp, plan);
      const input: DayGroupInputRow[] = rows.map((r) => ({
        entity: toWireEntityFromSql(r),
        keyAt: isoOrNull(r.__key_at),
        dates: (r.__when_dates as DayGroupInputRow['dates'] | null) ?? [],
      }));
      const { groups } = layoutDayGroups({
        rows: input,
        more,
        timeZone: plan.timeZone,
        period: plan.period,
        reg: plan.reg,
        field: plan.field,
      });
      return { ok: true, kind: 'groups', groups, more, closedIds: closedIdsOf(rows) };
    }
    case 'count': {
      const rows = await sp.execute(plan.sql);
      return { ok: true, kind: 'count', count: Number(rows[0]?.count) };
    }
    case 'sum': {
      // Пустая выборка — ни одной строки группировки: `sums: []`, плитка показывает ноль, не отказ.
      const rows = [...(await sp.execute(plan.sql))] as Record<string, unknown>[];
      return { ok: true, kind: 'sum', ...sumsOf(rows, plan.ownerCurrency) };
    }
    case 'latest': {
      const row = (await sp.execute(plan.sql))[0] as Record<string, unknown> | undefined;
      return {
        ok: true,
        kind: 'latest',
        value: (row?.value as string | null | undefined) ?? null,
        currency: (row?.currency as string | null | undefined) ?? null,
      };
    }
  }
}

/**
 * Исполнение всех скомпилированных блоков ОДНОЙ транзакцией, каждый — под своим SAVEPOINT.
 *
 * SAVEPOINT, а не голый try/catch (изоляция §6.3, прецедент — `goals/progress.ts`): упавший
 * statement переводит всю транзакцию PostgreSQL в aborted, и пойманная в JS ошибка всё равно
 * погубила бы каждый следующий блок пачки. `tx.transaction` на postgres-js — именно savepoint
 * на том же соединении; цена — два statement на блок.
 */
async function executeAll(tx: Tx, prepared: Prepared[]): Promise<EntityBlocksResult['results']> {
  const entries: [string, BlockResult][] = [];
  for (const p of prepared) {
    if (p.kind === 'settled') {
      entries.push([p.key, p.result]);
      continue;
    }
    try {
      entries.push([p.key, await tx.transaction((sp) => executePlan(sp, p.plan))]);
    } catch (e) {
      // Молча гасить нельзя (конвенция fail-soft сервера): без строки в журнале отказ
      // исполнения в проде недиагностируем. Наружу — без текста базы: он про колонки и касты,
      // а не про то, что владелец может поправить.
      console.error(`[entity.blocks] блок '${p.key}' не выполнился в базе`, e);
      entries.push([
        p.key,
        {
          ok: false,
          error: {
            code: 'EXECUTION',
            message: EXECUTION_FAILED_MESSAGE,
          },
        },
      ]);
    }
  }
  // fromEntries, а не присваивание в литерал: ключ клиента `__proto__` станет своим полем
  // ответа, а не прототипом объекта.
  return Object.fromEntries(entries);
}

/**
 * Пачка блоков страницы (§6.3): до `BLOCKS_BATCH_CAP` блоков по ТЕКСТУ запроса и бейджей разделов
 * (`badgeOf`, срез 1б §9.3) — бейдж читает тело страницы в той же фазе 1 и дальше живёт как блок.
 *
 * Фаза 1 — ОДНА транзакция под идентичностью владельца: контекст (реестр, таймзона) снимается
 * один раз, каждый блок разбирается и компилируется в свой try/catch (отказ — результат блока
 * без SQL), окна материализации собираются. Нет окон — все блоки исполняются той же
 * транзакцией. Есть — ОДНА материализация по объединению окон (от наименьшего `from` до
 * наибольшего `to`; окна пересекаются почти всегда, а лишние дни стоят меньше второго прохода
 * по шаблонам), затем фаза 2 — одна транзакция исполнения на все блоки.
 *
 * Материализация — МЕЖДУ транзакциями, как у `entity.query` (Э-4, `with-materialization.ts`):
 * исполнитель открывает собственные транзакции, и вложенность в живую держала бы второе
 * соединение пула. «Одна транзакция» спеки — одна транзакция ИСПОЛНЕНИЯ.
 *
 * `now` — часы пачки (по умолчанию настоящие): «сегодня» считается от них в поясе владельца. Вход —
 * ради сверки групп по дням на фиксированном «сегодня» мира (`day-groups.dataset.test.ts`); роутер его
 * не передаёт.
 */
export async function runBlocks(
  db: Db,
  identity: Identity,
  blocks: EntityBlocksInput['blocks'],
  now: Date = new Date(),
): Promise<EntityBlocksResult> {
  type Phase1 =
    | { kind: 'done'; result: EntityBlocksResult }
    | {
        kind: 'materialize';
        window: Window;
        prepared: Prepared[];
        today: string;
        timeZone: string;
      };
  const phase1 = await withIdentity(db, identity, async (tx): Promise<Phase1> => {
    const base = await queryContext(tx, identity.graph, null, now);
    // Триггеры и горизонт — из того же снимка, по которому блоки разобраны и исполнятся.
    const params = materializeRuleOf(base.reg).rule.params;
    const badges = await prepareBadges(
      tx,
      identity,
      blocks.flatMap((b) => ('badgeOf' in b ? [b] : [])),
      base,
      params,
    );
    // Порядок пачки сохраняется: ответ собирается в порядке входа, бейджи — на своих местах.
    const prepared = blocks.map((b) =>
      'badgeOf' in b ? (badges.get(b.key) as Prepared) : prepareBlock(b, base, params),
    );
    const window = prepared.reduce<Window | null>(
      (acc, p) => (p.kind === 'planned' ? unionWindow(acc, p.window) : acc),
      null,
    );
    // Верх ответа (§5.2) — «сегодня» и пояс ТОГО ЖЕ контекста, по которому разрешены токены и
    // разложены группы: клиент подписывает дни в поясе ответа, а не браузера.
    const top = { today: base.today, timeZone: base.timeZone };
    if (window === null) {
      return { kind: 'done', result: { results: await executeAll(tx, prepared), ...top } };
    }
    return { kind: 'materialize', window, prepared, ...top };
  });
  if (phase1.kind === 'done') return phase1.result;
  await materializeInstances({
    db,
    identity,
    from: phase1.window.from,
    to: phase1.window.to,
    today: phase1.today,
  });
  const results = await withIdentity(db, identity, (tx) => executeAll(tx, phase1.prepared));
  return { results, today: phase1.today, timeZone: phase1.timeZone };
}
