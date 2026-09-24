// apps/server/src/registry/ops.ts
//
// ОПЕРАЦИИ РЕЕСТРА ВЛАДЕЛЬЦА (§А10-2): завести своё свойство, поправить его, слить два в
// одно, поставить и снять дельту аспекта. До этой задачи в реестр писал ОДИН сид; здесь
// появляются писатели, которых зовут владелец и модель, — и вместе с ними три обязательства,
// которых у сида не было.
//
//  1. ВЕРСИЯ РЕЕСТРА — ТОЙ ЖЕ ТРАНЗАКЦИЕЙ (§А10-1). Кеш эффективных определений
//     (`registry/cache.ts`) не имеет сброса вовсе: версия — единственный механизм
//     инвалидации. Операция, закоммитившая строку без `bumpOwnerRegistryVersion`, оставляет
//     процесс на прежнем снимке НАВСЕГДА, и молча. Поэтому инкремент стоит в КАЖДОЙ функции
//     этого файла, последним действием, и ни одна из них не «пишет и возвращает» без него.
//  2. ГЕЙТ ГЛУБИНЫ ДЕРЕВА НА ЗАПИСИ — четвёртый вход дерева канона; разбор и пометка,
//     которую считает греп, живут у `assertRegistryQuery` ниже (номер здесь не ставится
//     нарочно: греп считает МЕСТА гейтов, а не ссылки на них).
//  3. ФОРМА ДЕЛЬТЫ ПРОВЕРЯЕТСЯ ДО ЗАПИСИ. `applyDeltas` отказывает fail-closed на КАЖДОМ
//     чтении реестра, поэтому неприменимая дельта — это не «настройка не сработала», а
//     нечитаемый реестр владельца до ручной правки базы. `setAspectDelta` складывает
//     будущий снимок целиком и отказывает ДО INSERT'а (см. её докблок).
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Правки СИСТЕМНОЙ строки: системное определение неизменяемо и
// версионировано (§А3-2), его подпись и состав меняет дельта. Попытка позвать
// `updateProperty` на встроенном свойстве — честный отказ с указанием на дельту, а не тихая
// запись, которую следующий пересев объявил бы дрейфом (`db/registry-drift.ts`) и затёр.
// По той же причине источником слияния может быть только СВОЯ строка (см. `mergeProperty`).
//
// ЗАМОК. Все функции рассчитывают, что транзакция УЖЕ держит замок реестра владельца
// (`lockOwnerRegistry`, `executor/executor.ts` — первым statement'ом, до бюджетного).
// Своего замка они не берут: два места, знающие порядок захвата, — это и есть дедлок.
import {
  type ActionDefinition,
  type AspectDefinition,
  type AspectImplements,
  type AspectPropertyRef,
  aspectDefinitionSchema,
  assertPatternRegular,
  attachToolName,
  BUILTIN_RULE_REQUIRES,
  canonicalJson,
  checkClassMap,
  checkImplements,
  exclusiveClassIssues,
  type GraphId,
  type ImplementsIssue,
  type LocalizedText,
  newId,
  PATTERN_NOT_REGULAR,
  PatternNotRegularError,
  type PropertyDefinition,
  type PropertyType,
  propertyDefinitionSchema,
  ROLE_REF,
  type RuleCarrier,
  type RuleDefinition,
  type RuleDefinitionInput,
  ruleDefinitionSchema,
  type SubscriptionDefinition,
} from '@orbis/shared';
import {
  type BodyDoc,
  bindQueryBlocks,
  bodyRefsFromDoc,
  parseBody,
  queryRefsFromDoc,
  readBodyDoc,
  serializeBody,
} from '@orbis/shared/doc';
import {
  type ExprNode,
  type ExprNormalizeRegistry,
  normalizeExpr,
  propertyNamesInExpr,
  touchedAddressOf,
} from '@orbis/shared/expr';
import {
  assertStaticQuery,
  maskQuotedValues,
  normalizeQueryAst,
  QUERY_TREE_DEPTH_CAP,
  type QueryAst,
  type QueryFilterNode,
  queryAstSchema,
  queryTreeExceedsDepth,
  ScopeNotStaticError,
} from '@orbis/shared/query';
import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
// Цикла нет: `executor/props` читает из `registry/{cache,load}` и в `registry/ops` не заходит.
// Резолвер адреса свойства — ОДИН на исполнитель и на реестр: второй экземпляр правила «своя
// строка перекрывает встроенную» разъехался бы с первым ровно там, где владелец завёл свою.
import { resolvePropertyRef } from '../executor/props';
// Цикла нет: `rules/carriers` берёт из реестра только `rules.ts` и тип снимка.
import { assertEngineCarriersKept } from '../rules/carriers';
// Цикла нет: валидатор берёт из `registry/load` только тип строки.
import { assertSubscription, normalizeSubscriptionExprs } from '../subscriptions/registry';
// Только тип: вход операции `setOwnAction` — вход тула (эррата реестра §1.10); рантайм-ребра нет.
import type { ActionSetInput } from '../tools/registry-tools';
// Цикла нет (перенос задачи 6, риск «actions → confirmation → registry-tools → … → actions»):
// `actions.ts` тянет `policy/confirmation` → `tools/registry-tools` → `registry/deltas`, и ни один из
// них в `registry/ops` не заходит; `registry-tools` импортирует отсюда только тип.
import { assertAction } from './actions';
import { parseRegistryOfSnapshot } from './cache';
import {
  type AspectDelta,
  applyDeltas,
  aspectDeltaAfterRemove,
  aspectDeltaSchema,
  type ContractDelta,
  contractDeltaSchema,
  type PropertyDelta,
  type RegistryDelta,
  type RegistryDeltaTargetKind,
  type SubscriptionDelta,
  subscriptionDeltaSchema,
} from './deltas';
import { assertAcyclicGraph, dependencyGraph } from './deps-graph';
import {
  loadRegistryDeltas,
  loadRegistryRows,
  type RegistryDictionaries,
  type RegistrySnapshot,
  type SubscriptionRow,
} from './load';
import { assertRule, ruleConflictsOf, rulesOf } from './rules';
// Стадия 2 исполнителя — та же функция на двери `action_set` (литералы шагов, перенос задачи 6).
import { validateEntityProps } from './validate-props';
import { bumpOwnerRegistryVersion, readRegistryVersions } from './version';

/**
 * Кап неподтверждённых предложений на владельца (§А2-7). 21-е — отказ `REGISTRY_LIMIT` с
 * подсказкой «разберите пачку»: смысл капа не в экономии строк, а в том, что несведённые
 * дубли — это порог провала П4, и разбирать их обязан человек, а не следующий `proposed`.
 */
export const PROPOSED_CAP = 20;

/**
 * Эффективный реестр ВНУТРИ пишущей транзакции — своим чтением, а не `effectiveRegistry`.
 *
 * Кеш (`registry/cache.ts`) пишущую транзакцию обходит стороной (`txHasWritten`), то есть
 * зовущий его получил бы тот же четвёрочный SELECT, только через лишний слой. А главное —
 * операции реестра идут пачкой: свойство, заведённое операцией N той же транзакции, обязано
 * быть видно операции N+1, и снимок, снятый исполнителем ДО стадий, этого не показывает.
 */
async function currentRegistry(tx: Tx, graphId: GraphId): Promise<RegistrySnapshot> {
  const rows = await loadRegistryRows(tx, graphId);
  const deltas = await loadRegistryDeltas(tx, graphId);
  const versions = await readRegistryVersions(tx, graphId);
  return applyDeltas(
    { ...rows, ownerVersion: versions.ownerVersion, systemVersion: versions.systemVersion },
    deltas,
  );
}

/**
 * ВХОД-ДЕРЕВА 4 (ГЕЙТ ЗАПИСИ). `scope` и `type.target` строки `property_definitions` — это
 * Q-AST, который `registry/load.ts` разбирает рекурсивной `propertyDefinitionSchema` на
 * КАЖДОМ построении снимка реестра. До этой задачи гейта здесь не было, и основание было
 * честным: снаружи в реестр не писал никто, строки клали сид и админский DSN. Основание
 * снял этот файл — `createProperty`/`updateProperty` кладут `scope` и `target` по запросу
 * владельца и модели.
 *
 * ПОРЯДОК ВНУТРИ ФУНКЦИИ — СУТЬ, А НЕ СТИЛЬ: глубина меряется ПЕРВОЙ, до `assertStaticQuery`
 * (тот обходит дерево рекурсией `walk` и на достаточно глубоком входе исчерпал бы стек
 * раньше любого вердикта) и до `propertyDefinitionSchema` (та рекурсивна через `z.lazy`,
 * и `safeParse` не ловит `RangeError`). Тот же порядок и по той же причине стоит на трёх
 * остальных входах — см. шапку `queryFilterNodeSchema` (`@orbis/shared`, `query/ast.ts`).
 *
 * Кап ОДИН на все четыре входа (`QUERY_TREE_DEPTH_CAP`); второй константы здесь не
 * заводится намеренно — обоснование числа целиком в её докблоке.
 */
function assertRegistryQuery(where: string, ast: unknown): void {
  if (queryTreeExceedsDepth(ast, QUERY_TREE_DEPTH_CAP)) {
    throw new ExecError(
      'VALIDATION',
      `${where}: дерево вложено глубже ${QUERY_TREE_DEPTH_CAP} уровней — ` +
        `такое определение разворачивалось бы на каждом чтении реестра`,
      { reason: 'QUERY_TOO_DEEP', where, cap: QUERY_TREE_DEPTH_CAP },
    );
  }
  // ФОРМА ПРОВЕРЯЕТСЯ ЗДЕСЬ, а не «схемой конверта»: у `property_create`/`property_update`
  // поле `scope` объявлено `z.unknown()`, а `type` — `z.record(z.unknown())`, то есть до
  // этой строки дерево ни разу не встречалось со схемой канона. Без проверки обход
  // (`assertStaticQuery` ниже, а с реформой ещё и `normalizeDeclaration`) шёл бы по
  // произвольному JSON и на `{"filter":"aspect=orbis/task"}` бросал бы `TypeError` — то есть
  // внутреннюю ошибку вместо структурного отказа, из которого модель умеет выправиться.
  // Замерено: до этой строки такой вход давал `TypeError: node is not an Object`.
  const parsed = queryAstSchema.safeParse(ast);
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `${where}: значение не является запросом канона §А5-7`, {
      reason: 'QUERY_SHAPE',
      where,
      issues: parsed.error.issues.slice(0, 5),
    });
  }
  try {
    assertStaticQuery(parsed.data);
  } catch (e) {
    if (e instanceof ScopeNotStaticError) {
      throw new ExecError('SCOPE_NOT_STATIC', `${where}: ${e.message}`, {
        where,
        reason: e.reason,
      });
    }
    throw e;
  }
}

/**
 * `scope` v1 наполняется ТОЛЬКО формами `aspect=`/`tags=` (№24 заметок): «показывать это
 * свойство колонкой на всех записях с таким аспектом (или тегом)».
 *
 * Почему запрет, а не «пусть пишут что хотят». `scope` читает `scopeNamesAspect`
 * (`registry/deltas.ts`) — он ищет в дереве узел `aspect` и на всём остальном отвечает
 * «не называет». То есть `scope` вида `orbis/task_status=done` УЖЕ сегодня означал бы
 * «свойство показывается по условию, которого ни один читатель реестра не проверяет».
 * Запрет снимается вместе с читателем, умеющим считать произвольное множество.
 */
function assertScopeShape(node: QueryFilterNode | null): void {
  if (node === null) return;
  const stack: QueryFilterNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop() as QueryFilterNode;
    if ('and' in cur) stack.push(...cur.and);
    else if ('or' in cur) stack.push(...cur.or);
    else if ('not' in cur) stack.push(cur.not);
    else if (!('aspect' in cur) && !('tag' in cur)) {
      throw new ExecError(
        'VALIDATION',
        'scope свойства в срезе А выражается только формами aspect= и tags= (№24)',
        { reason: 'SCOPE_SHAPE', node: Object.keys(cur)[0] },
      );
    }
  }
}

/**
 * Имена в деревьях ОБЪЯВЛЕНИЯ (`scope` и `ref.target`) — к id (§А5-2), тем же резолвом, что
 * у входа `ast` тула и у значения `progress_source`.
 *
 * Оба дерева ХРАНЯТСЯ, поэтому key внутри них — тихий отказ навсегда: колонка своего
 * свойства не показывается, а пикер ссылочного свойства пуст, и ни одна из двух поверхностей
 * не говорит почему. Нормализуется ДО записи, а не при чтении: §А5-2 обещает, что в
 * хранимом дереве лежат id, и второй формы у него быть не должно.
 */
function normalizeDeclaration(
  reg: RegistrySnapshot,
  type: PropertyType,
  scope: QueryAst | null,
): { type: PropertyType; scope: QueryAst | null } {
  const parseReg = parseRegistryOfSnapshot(reg);
  const nextScope = scope === null ? null : normalizeQueryAst(scope, parseReg);
  if (type.kind !== 'ref' || type.target === undefined) return { type, scope: nextScope };
  const target = Array.isArray(type.target)
    ? type.target.map((t) => normalizeQueryAst(t, parseReg))
    : normalizeQueryAst(type.target, parseReg);
  return { type: { ...type, target }, scope: nextScope };
}

/** Q-AST'ы, которые несёт тип свойства: у `ref` цель бывает одна либо список (§А6-1). */
function targetsOf(type: PropertyType): QueryAst[] {
  if (type.kind !== 'ref' || type.target === undefined) return [];
  return Array.isArray(type.target) ? type.target : [type.target];
}

/**
 * Гейты ОБЪЯВЛЕНИЯ свойства — всё, что проверяется до записи строки, в одном месте: и
 * `createProperty`, и `updateProperty` обязаны спрашивать одно и то же, иначе правкой можно
 * было бы завести то, что не пропускает создание.
 */
function assertDeclaration(type: PropertyType, scope: QueryAst | null): void {
  if (type.kind === 'text' && type.pattern !== undefined) {
    // `assertPatternRegular` живёт в shared и про сервер не знает: он бросает СВОЙ класс
    // (`PatternNotRegularError`), а `execute` ловит только `ExecError` — без перевода отказ
    // владельцу приезжал бы не структурированной ошибкой §9.2, а пятисоткой. Код тот же,
    // константа общая (`errors.ts` импортирует её из shared), меняется только обёртка.
    try {
      assertPatternRegular(type.pattern);
    } catch (e) {
      if (e instanceof PatternNotRegularError) {
        throw new ExecError(PATTERN_NOT_REGULAR, e.message, {
          pattern: e.pattern,
          construct: e.construct,
        });
      }
      throw e;
    }
  }
  for (const target of targetsOf(type)) assertRegistryQuery('ref.target', target);
  if (scope !== null) {
    assertRegistryQuery('scope', scope);
    assertScopeShape(scope.filter);
  }
}

// ---------------------------------------------------------------------------
// Строка реестра как она лежит — снимок для inverse
// ---------------------------------------------------------------------------

/**
 * ПОЛНАЯ строка `property_definitions` владельца в форме, которую можно положить в журнал и
 * вернуть обратно (§7.8). Не `PropertyDefinition`: у той нет `createdAt`, а inverse обязан
 * вернуть строку такой, какой она была, — включая момент заведения.
 */
export interface PropertyRow {
  id: string;
  key: string;
  label: LocalizedText;
  description: LocalizedText;
  type: PropertyType;
  status: 'active' | 'proposed' | 'deprecated';
  storage: 'props' | 'core';
  scope: QueryAst | null;
  mergedInto: string | null;
  module: string | null;
  rank: number;
  flags: Record<string, unknown>;
  /**
   * Правила каталога на строке (§Б4-1, колонка 0022) — ради ОДНОГО пути: откат, заново вставляющий
   * удалённую строку (отклонённое `proposed`, §А10-3), без поля положил бы `rules = '[]'` и молча стёр
   * правила, заведённые `rule_set` (перенос П-1 задачи 2). Необязательное: журнал append-only, и строки,
   * записанные в inverse до задачи 16, поля не несут (правил тогда не писал никто — `[]` и был ответ).
   * При upsert'е поверх ЖИВОЙ строки колонка НЕ перезаписывается (`insertRow`): правило меняет только
   * `rule_set`/`rule_remove` со своим inverse, и откат `property_update` не вправе откатить чужую правку.
   */
  rules?: RuleDefinition[];
  createdAt: string;
}

interface RawRow {
  [column: string]: unknown;
}

function toPropertyRow(r: RawRow): PropertyRow {
  return {
    id: r.id as string,
    key: r.key as string,
    label: r.label as LocalizedText,
    description: r.description as LocalizedText,
    type: r.type as PropertyType,
    status: r.status as PropertyRow['status'],
    storage: r.storage as PropertyRow['storage'],
    scope: (r.scope ?? null) as QueryAst | null,
    mergedInto: (r.merged_into ?? null) as string | null,
    module: (r.module ?? null) as string | null,
    rank: Number(r.rank),
    flags: (r.flags ?? {}) as Record<string, unknown>,
    rules: (r.rules ?? []) as RuleDefinition[],
    createdAt:
      (r.created_at as Date | string) instanceof Date
        ? (r.created_at as Date).toISOString()
        : String(r.created_at),
  };
}

const ROW_COLUMNS = sql`id, key, label, description, type, status, storage, scope,
                        merged_into, module, rank, flags, rules, created_at`;

/**
 * СВОЯ строка свойства владельца — вход всех правок. `graph_id = …` в запросе стоит рядом с
 * RLS не для скоупа (её и так даёт политика), а ради РАЗЛИЧЕНИЯ: встроенное свойство под
 * RLS видно, и без этого условия «правлю системное» отвечало бы «не найдено» вместо
 * подсказки про дельту.
 */
export async function readOwnProperty(
  tx: Tx,
  graphId: GraphId,
  idOrKey: string,
): Promise<PropertyRow | undefined> {
  // АДРЕС РЕЗОЛВИТСЯ ЗДЕСЬ, ЗАПРОСОМ В ТРАНЗАКЦИИ, а не по снимку реестра. Снимок
  // исполнитель снимает ДО стадий, и свойство, заведённое предыдущей операцией той же
  // пачки, в нём отсутствует — резолв по снимку отвечал бы `NOT_FOUND` на ключ, который
  // владелец только что и завёл. `id = $1 OR key = $1` неоднозначности не даёт: и то и
  // другое уникально среди строк владельца (`property_definitions_custom_uniq`,
  // `…_custom_key`), а пересечение id одного свойства с key другого требовало бы key в
  // форме uuid — `NAMESPACED_KEY_RE` такого не принимает (слэш обязателен).
  const rows = (await tx.execute(sql`
    SELECT ${ROW_COLUMNS} FROM property_definitions
    WHERE graph_id = ${graphId}::uuid AND (id = ${idOrKey} OR key = ${idOrKey})`)) as unknown as RawRow[];
  const row = rows[0];
  return row === undefined ? undefined : toPropertyRow(row);
}

/**
 * Восстановление строки реестра из журнала (§7.8) — ЕДИНСТВЕННАЯ обратная операция для
 * `property_create` и `property_update` сразу.
 *
 * Почему одна, а не две. Отмена создания — это «строки не было», отмена правки — «строка
 * была вот такой», а отмена ОТКЛОНЕНИЯ `proposed` (§А10-3 удаляет её физически) — снова
 * «строка была вот такой». Три случая различаются одним: есть ли что возвращать. Значение
 * `null` и есть ответ «не было», и удалять строку в этом случае законно ровно потому, что
 * её создало отменяемое действие.
 */
export async function restorePropertyRow(
  tx: Tx,
  graphId: GraphId,
  id: string,
  row: PropertyRow | null,
): Promise<void> {
  if (row === null) {
    // Строку удаляем — значит нужен её `key`: ссылка на неё в теле записана ключом, и без
    // него проба «на ней ничего не держится» слепа ровно на текстовых держателей.
    const existing = await readOwnProperty(tx, graphId, id);
    if (existing === undefined) return; // строки уже нет — откат идемпотентен
    // Страховка, а не логика: строку создало отменяемое действие, и значений у неё быть не
    // может. Если они появились ПОСЛЕ (кто-то успел записать), физическое удаление осиротило
    // бы их — отказываем fail-closed, откат целиком не применяется.
    const used = await propertyUsage(tx, graphId, id, existing.key);
    if (used.values > 0 || used.refs > 0) {
      throw new ExecError(
        'INVARIANT',
        `свойство ${id} нельзя удалить откатом: значений на записях — ${used.values}, ` +
          `ссылок в запросах — ${used.refs}`,
        { property: id, values: used.values, refs: used.refs },
      );
    }
    // Адресуем `existing.id`, а не входной `id`. Сегодня они совпадают всегда (операция
    // внутренняя, идентификатор приезжает из журнала уже резолвленным), то есть это не
    // починка бага, а дисциплина: `readOwnProperty` принимает и key, и первый же
    // вызывающий, передавший ключ, получил бы `WHERE id = <key>` — промах по нулю строк
    // молча, без единой ошибки.
    await assertRegistryStaysReadable(tx, graphId, existing.id, null);
    await tx.execute(sql`
      DELETE FROM property_definitions WHERE graph_id = ${graphId}::uuid AND id = ${existing.id}`);
    await bumpOwnerRegistryVersion(tx, graphId);
    return;
  }
  // ОТКАТ ТОЖЕ ПРОХОДИТ ПРОБУ, хотя возвращает состояние, которое когда-то было читаемым.
  // Между записью и откатом мир двигался: `scope` сняли, а освободившееся место заняла
  // дельта аспекта — и возврат `scope` замкнул бы §А3-4 (`SCOPE_DUPLICATE`). Из двух
  // исходов выбран громкий: неприменимый откат — это отказ, который владелец видит и
  // разбирает, а нечитаемый реестр — это замок снаружи всего графа.
  await assertRegistryStaysReadable(tx, graphId, id, row);
  await insertRow(tx, graphId, row, { restore: true });
  await bumpOwnerRegistryVersion(tx, graphId);
}

/**
 * Строка → ОПРЕДЕЛЕНИЕ, каким его увидит читатель реестра, со строгим разбором.
 *
 * Отказ здесь — это отказ ДО записи: реестр, который сам не разбирается собственной схемой,
 * до валидации данных доезжать не должен (тот же fail-closed, что в `load.ts`). Проверяется
 * собранная строка ЦЕЛИКОМ, а не отдельные поля: дефекты вроде «select без вариантов» видны
 * только на ней. `createdAt` в схему определения не входит (её форма — то, что читает
 * реестр, а не то, что лежит в колонках), поэтому разбор идёт по строке БЕЗ него.
 */
function definitionOf(row: PropertyRow, graphId: GraphId): PropertyDefinition {
  const { createdAt: _createdAt, ...definition } = row;
  const parsed = propertyDefinitionSchema.safeParse({ ...definition, graphId });
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `определение свойства ${row.id} не разбирается схемой`, {
      property: row.id,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

/**
 * БУДЕТ ЛИ РЕЕСТР ЧИТАЕМ ПОСЛЕ ЭТОЙ ПРАВКИ — проба будущего снимка, ДО записи.
 *
 * ЗАЧЕМ ОНА НУЖНА ОБЕИМ СТОРОНАМ. §А3-4 разводит два механизма «где показывается свойство»:
 * дельта аспекта ИЛИ `scope`, называющий тот же аспект. Двойное объявление `applyDeltas`
 * считает ошибкой и отказывает FAIL-CLOSED НА КАЖДОМ ЧТЕНИИ реестра (`SCOPE_DUPLICATE`), а
 * читают реестр все: `execute()` берёт снимок ПЕРВЫМ делом, до стадий, — значит после такой
 * записи у владельца перестают работать и правка, и снятие дельты, и ДАЖЕ ОТКАТ. Дверей в
 * эту комнату две — со стороны дельты (`setAspectDelta`) и со стороны `scope`
 * (`createProperty`/`updateProperty`/откат правки), и закрытая одна означает незакрытую
 * комнату. Поэтому проба ОБЩАЯ и стоит на обеих.
 *
 * Складывается ровно то, что сложит читатель: сырые строки владельца с подставленной сюда
 * правкой, плюс его живые дельты, через тот же `applyDeltas`. Второго правила «что считать
 * противоречием» не заводится — оно одно, и живёт у читателя.
 *
 * `next: null` — правка УДАЛЯЕТ строку (отклонение `proposed` §А10-3, откат создания).
 */
async function assertRegistryStaysReadable(
  tx: Tx,
  graphId: GraphId,
  id: string,
  next: PropertyRow | null,
): Promise<void> {
  const rows = await loadRegistryRows(tx, graphId);
  const deltas = await loadRegistryDeltas(tx, graphId);
  const versions = await readRegistryVersions(tx, graphId);
  const properties = new Map(rows.properties);
  if (next === null) properties.delete(id);
  else properties.set(next.id, definitionOf(next, graphId));
  applyDeltas(
    {
      // Спредом, а не перечислением словарей: складывается РОВНО то, что сложит читатель
      // (докблок выше), и шестой словарь снимка не должен требовать правки этого места.
      ...rows,
      properties,
      ownerVersion: versions.ownerVersion,
      systemVersion: versions.systemVersion,
    },
    deltas,
  );
}

async function insertRow(
  tx: Tx,
  graphId: GraphId,
  row: PropertyRow,
  opts: { restore?: boolean } = {},
): Promise<void> {
  definitionOf(row, graphId);
  // ON CONFLICT нужен только откату (строку могли не удалить, а изменить); создание идёт по
  // пустому месту, и конфликт там означал бы занятый id — о нём молчать нельзя.
  const conflict = opts.restore
    ? sql`ON CONFLICT (graph_id, id) WHERE graph_id IS NOT NULL DO UPDATE SET
            key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
            type = EXCLUDED.type, status = EXCLUDED.status, storage = EXCLUDED.storage,
            scope = EXCLUDED.scope, merged_into = EXCLUDED.merged_into,
            module = EXCLUDED.module, rank = EXCLUDED.rank, flags = EXCLUDED.flags`
    : sql``;
  // `rules` едет в INSERT (повторная вставка удалённой строки возвращает её правила), но НЕ в
  // `DO UPDATE SET` выше: у живой строки правила правит только `rule_set`/`rule_remove` (докблок поля).
  await tx.execute(sql`
    INSERT INTO property_definitions
      (id, graph_id, key, label, description, type, status, storage, scope, merged_into,
       module, rank, flags, rules, created_at)
    VALUES (${row.id}, ${graphId}::uuid, ${row.key}, ${JSON.stringify(row.label)}::jsonb,
            ${JSON.stringify(row.description)}::jsonb, ${JSON.stringify(row.type)}::jsonb,
            ${row.status}, ${row.storage},
            ${row.scope === null ? null : JSON.stringify(row.scope)}::jsonb,
            ${row.mergedInto}, ${row.module}, ${row.rank},
            ${JSON.stringify(row.flags)}::jsonb, ${JSON.stringify(row.rules ?? [])}::jsonb,
            ${row.createdAt}::timestamptz)
    ${conflict}`);
}

// ---------------------------------------------------------------------------
// key: транслитерация и разведение коллизий (§А2-4)
// ---------------------------------------------------------------------------

/**
 * Русские буквы → ASCII. Таблица своя и НАМЕРЕННО простая: key — машинная ручка, а не текст
 * для человека (подпись живёт в `label`), и «идеальная» транслитерация тут не нужна — нужна
 * повторяемая. Ставки низкие по построению: key изменяем (Р3), а коллизии разводит суффикс.
 */
const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** Слаг из подписи: транслит, нижний регистр, всё лишнее — в дефис. */
export function slugFromLabel(label: LocalizedText): string {
  const source = label.en ?? label.ru ?? Object.values(label)[0] ?? '';
  const latin = [...source.toLowerCase()].map((ch) => CYRILLIC[ch] ?? ch).join('');
  const slug = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // Пустой слаг даёт key вида `user/`, который не пройдёт `NAMESPACED_KEY_RE`: подпись из
  // одних эмодзи — законный вход, и падать на нём нельзя. `prop` + суффикс разведения.
  return slug === '' || !/^[a-z]/.test(slug) ? `prop-${slug}`.replace(/-+$/, '') : slug;
}

/**
 * Свободный key в пространстве ВИДИМОГО владельцу (встроенные ∪ свои, §А2-4).
 *
 * Уникальность БД проверяет две половины по отдельности (`property_definitions_builtin_key`
 * и `…_custom_key`), и пересечение между ними индексом не выражается — то есть своя строка
 * с ключом встроенного легла бы молча, а `resolvePropertyRef` начал бы отдавать по одному
 * имени два разных свойства. Правило здесь — «уникален среди ВИДИМОГО», и оно шире, чем то,
 * что сегодня достижимо: гейт namespace (`createProperty` выше) закрыл явную форму, а
 * автослаг и так кладёт в `user/`, поэтому пересечение со встроенными сейчас недостижимо, и
 * на практике функция разводит СВОИ строки между собой. Проверка остаётся полной намеренно:
 * она выражает правило, а не сегодняшнее совпадение namespace'ов.
 */
function freeKey(reg: RegistrySnapshot, wanted: string): string {
  const taken = new Set([...reg.properties.values()].map((d) => d.key));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// createProperty (§А2-4, §А2-7)
// ---------------------------------------------------------------------------

export interface CreatePropertyInput {
  /** Явный key (`user/effort`); нет — собирается транслитом подписи. */
  key?: string;
  label: LocalizedText;
  description: LocalizedText;
  type: PropertyType;
  status: 'active' | 'proposed';
  scope?: QueryAst | null;
  /** Модуль-владелец. У пользовательского свойства его нет и быть не может (§Б8). */
  module?: null;
}

/**
 * Своё свойство владельца (§А2-4). id — uuid (Р3): читаемая строка есть только у встроенных,
 * а у пользовательского адресом остаётся `key`, и он изменяем.
 *
 * `status: 'proposed'` — предложение AI (Р14): в промпт такие не входят, живут в каталоге
 * (§А9-3) и ждут разбора. Кап на них — `PROPOSED_CAP`; 21-е отказывается ДО всякой записи.
 *
 * Заведение свойства с reserved-словом грамматики (`limit`, `search`) РАЗРЕШЕНО (§А2-4):
 * коллизия невозможна по построению — имя свойства в тексте запроса пишется namespaced
 * ключом (§А5-3а), а голое `limit=` разбирается как параметр запроса и свойством быть не
 * может. Отдельной проверки поэтому нет; на её отсутствие стоит тест.
 */
export async function createProperty(
  tx: Tx,
  graphId: GraphId,
  input: CreatePropertyInput,
): Promise<{ id: string; key: string }> {
  assertDeclaration(input.type, input.scope ?? null);

  const reg = await currentRegistry(tx, graphId);
  // Имена в `scope`/`ref.target` — к id: снимок реестра появляется только здесь, а форму
  // деревьев `assertDeclaration` проверил выше (она от имён не зависит).
  const { type, scope } = normalizeDeclaration(reg, input.type, input.scope ?? null);

  if (input.status === 'proposed') {
    const proposed = [...reg.properties.values()].filter(
      (d) => d.graphId !== null && d.status === 'proposed',
    ).length;
    if (proposed >= PROPOSED_CAP) {
      throw new ExecError(
        'REGISTRY_LIMIT',
        `неразобранных предложенных свойств уже ${proposed} (кап ${PROPOSED_CAP}) — ` +
          `разберите пачку: примите нужные, отклоните лишние`,
        { reason: 'PROPOSED_CAP', cap: PROPOSED_CAP, proposed },
      );
    }
  }

  // ЯВНЫЙ KEY — ТОЛЬКО В `user/` (§А2-1: «слаг в namespace автора»; автор здесь владелец).
  //
  // Форма входа шире по построению — она же описывает и системные строки, — и без гейта
  // модель, глядя на каталог из `orbis/*`, завела бы `orbis/priority` как своё. Сегодня это
  // прошло бы (ключ ещё не занят), а следующий релиз посеял бы встроенный `orbis/priority` —
  // и по правилу «своя строка перекрывает системную» (`ORDER BY graph_id NULLS FIRST`,
  // `registry/load.ts`) свойство владельца МОЛЧА подменило бы встроенное во всех запросах,
  // промптах и `attach_*`-данных, возможно с другим типом. Отказ на занятом ключе от этого
  // не спасает: он смотрит на то, что занято СЕГОДНЯ.
  //
  // Условие расширения названо, чтобы следующий читатель не гадал: namespace приложения
  // (`<app>/`, §А3-3) появится вместе с самими приложениями — тогда сюда приедет проверка
  // «автор = владелец ∨ автор = это приложение», а не снятие гейта.
  if (input.key !== undefined && !input.key.startsWith('user/')) {
    throw new ExecError(
      'VALIDATION',
      `свои свойства живут в namespace user/ — «${input.key}» занимает чужой (§А2-1)`,
      { reason: 'KEY_NAMESPACE', key: input.key },
    );
  }
  const key = freeKey(reg, input.key ?? `user/${slugFromLabel(input.label)}`);
  // Явный key владельца НЕ разводится суффиксом молча: он его назвал, и «завёл user/effort,
  // получил user/effort-2» — это подмена адреса, о которой он узнает из текста запроса.
  if (input.key !== undefined && key !== input.key) {
    throw new ExecError('VALIDATION', `key «${input.key}» уже занят другим свойством`, {
      reason: 'KEY_TAKEN',
      key: input.key,
    });
  }
  const rank = Math.max(0, ...[...reg.properties.values()].map((d) => d.rank)) + 1;
  const row: PropertyRow = {
    id: newId(),
    key,
    label: input.label,
    description: input.description,
    type,
    status: input.status,
    storage: 'props',
    scope,
    mergedInto: null,
    module: input.module ?? null,
    rank,
    flags: {},
    rules: [],
    createdAt: new Date().toISOString(),
  };
  await assertRegistryStaysReadable(tx, graphId, row.id, row);
  await insertRow(tx, graphId, row);
  await bumpOwnerRegistryVersion(tx, graphId);
  return { id: row.id, key: row.key };
}

// ---------------------------------------------------------------------------
// updateProperty (§А2-7, §А10-3)
// ---------------------------------------------------------------------------

export interface UpdatePropertyPatch {
  label?: LocalizedText;
  description?: LocalizedText;
  scope?: QueryAst | null;
  rank?: number;
  status?: 'active' | 'deprecated';
}

/**
 * Сколько на свойстве держится: значения на записях и ссылки из AST. Оба числа нужны
 * ровно одному правилу — §А10-3 («`proposed`, отклонённое до первого использования, можно
 * удалить физически»), и считаются они В ТОЙ ЖЕ транзакции, что и удаление.
 */
async function propertyUsage(
  tx: Tx,
  graphId: GraphId,
  id: string,
  key: string,
): Promise<{ values: number; refs: number }> {
  const rows = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM entities WHERE props ? ${id}`)) as unknown as { n: number }[];
  const holders = await collectPropertyHolders(tx, graphId);
  // ССЫЛКА ИЩЕТСЯ ПО ОБОИМ ИМЕНАМ, и это не перестраховка. В дереве §А5-7 лежит id, но
  // дерево приезжает и снаружи — входом `ast:` тула и значением `progress_source`, — а
  // резолвер границы принимает и key (`resolvePropertyRef`), и никто такое дерево к id не
  // нормализует. Значит и в `query_refs`, и в значении цели адрес может оказаться ключом.
  // Спрашивая один id, физическое удаление §А10-3 сносило бы строку из-под живой ссылки —
  // то самое «висение», которое §А10-3 обещает невозможным. Слияние тот же вопрос задаёт
  // двумя именами (`names` ниже), и разойтись этим двум местам нельзя.
  return {
    values: Number(rows[0]?.n ?? 0),
    refs: holders.filter((h) => h.properties.includes(id) || h.properties.includes(key)).length,
  };
}

/**
 * Правка СВОЕЙ строки реестра (§А2-7). Тип и key не меняются: под типом лежат записанные
 * значения (смена типа — форк, §А3-5), а key меняется отдельной операцией, которой в срезе А
 * нет вовсе (Р10).
 *
 * `proposed → active` — принятие предложения. `proposed → deprecated` — ОТКЛОНЕНИЕ, и у него
 * есть единственное в реестре исключение из «строки физически не удаляются» (§А10-3): если
 * значений и ссылок ещё нет, строка удаляется совсем. Иначе каждое отклонённое предложение
 * оставляло бы в каталоге навсегда мёртвую запись, и кап `proposed` пришлось бы считать
 * по строкам, которых владелец в глаза не видел.
 */
export async function updateProperty(
  tx: Tx,
  graphId: GraphId,
  id: string,
  patch: UpdatePropertyPatch,
): Promise<void> {
  const row = await readOwnProperty(tx, graphId, id);
  if (row === undefined) {
    // Встроенное свойство под RLS видно — значит «не своё» надо отличать от «нет такого»:
    // подпись встроенного правится ДЕЛЬТОЙ (§А3-2), и молчаливый NOT_FOUND отправил бы
    // владельца искать несуществующую строку.
    const builtin = (await tx.execute(sql`
      SELECT 1 AS hit FROM property_definitions
      WHERE graph_id IS NULL AND id = ${id}`)) as unknown as unknown[];
    if (builtin.length > 0) {
      throw new ExecError(
        'VALIDATION',
        `${id} — встроенное свойство: его подпись меняется дельтой (aspect_delta_set), ` +
          `а строка реестра остаётся системной`,
        { reason: 'BUILTIN_IMMUTABLE', property: id },
      );
    }
    throw new ExecError('NOT_FOUND', `свойства ${id} нет среди ваших`, { property: id });
  }

  if (row.mergedInto !== null) {
    // Строка поглощена (§А10-2): значений у неё нет, они уехали в цель. Правка — и особенно
    // `status: 'active'` — воскресила бы её В ПОЛУСОСТОЯНИЕ: активная, пустая, с целым
    // указателем `merged_into`. Новые значения писались бы в неё и расходились с целью, а
    // починить это слиянием нельзя — `MERGE_ALREADY_MERGED` отказывает ровно на этой паре.
    // Законный путь назад ровно один, и отказ на него указывает.
    throw new ExecError(
      'VALIDATION',
      `${id} поглощено свойством ${row.mergedInto}: правится не оно, а цель; ` +
        `вернуть его можно только отменой слияния`,
      { reason: 'PROPERTY_MERGED', property: id, successor: row.mergedInto },
    );
  }

  const scopeInput = patch.scope === undefined ? row.scope : patch.scope;
  assertDeclaration(row.type, scopeInput);
  // Имена в `scope` — к id (§А5-2), той же меркой, что у `createProperty`. `type` правка не
  // меняет вовсе, поэтому `ref.target` здесь нормализовать нечего.
  const { scope } = normalizeDeclaration(await currentRegistry(tx, graphId), row.type, scopeInput);

  if (patch.status === 'deprecated' && row.status === 'proposed') {
    const used = await propertyUsage(tx, graphId, row.id, row.key);
    if (used.values === 0 && used.refs === 0) {
      // Дальше адресуем ТОЛЬКО `row.id`: во вход мог прийти key (см. `readOwnProperty`),
      // и `WHERE id = <key>` не задел бы ни одной строки — молча, без единой ошибки.
      await assertRegistryStaysReadable(tx, graphId, row.id, null);
      await tx.execute(sql`
        DELETE FROM property_definitions WHERE graph_id = ${graphId}::uuid AND id = ${row.id}`);
      await bumpOwnerRegistryVersion(tx, graphId);
      return;
    }
  }

  const next: PropertyRow = {
    ...row,
    label: patch.label ?? row.label,
    description: patch.description ?? row.description,
    scope,
    rank: patch.rank ?? row.rank,
    status: patch.status ?? row.status,
  };
  await assertRegistryStaysReadable(tx, graphId, row.id, next);
  await insertRow(tx, graphId, next, { restore: true });
  await bumpOwnerRegistryVersion(tx, graphId);
}

// ---------------------------------------------------------------------------
// КТО СТОИТ НА СВОЙСТВЕ: полный перечень держателей (§А3-5, §А10-2, §А10-3)
// ---------------------------------------------------------------------------

/**
 * Место, которое АДРЕСУЕТ свойство, и имена, которыми оно его называет.
 *
 * ЭТО ОТВЕТ НА ВОПРОС «КТО СТОИТ НА СВОЙСТВЕ», а не «где лежит Q-AST», и разница
 * оплачена: пока перечень описывал только держателей ДЕРЕВА, `propertyUsage` и слияние
 * брали его как полный ответ — и не видели дельту аспекта, которая свойство адресует, но
 * Q-AST не содержит. Из-за этого слияние оставляло аспект стоять на поглощённой строке, а
 * физическое удаление §А10-3 роняло строку из-под живой ссылки.
 *
 * ШЕСТЬ РОДОВ ИСКОМЫХ ДЕРЖАТЕЛЕЙ — четыре среза А, пятый и шестой среза Б-2 (полный ли это перечень —
 * см. ниже «держатели вне перечня»: нет, не полный):
 *  - `registry` — `scope` и `ref.target` СВОЕЙ строки реестра (дерево, адрес — id);
 *  - `progress_source` — значение свойства `orbis/progress_source` на записи (§А5-2;
 *    дерево, адрес — id);
 *  - `body` — query-блок в теле записи. Блок несёт ДЕРЕВО (§А11-1), и адреса из этого
 *    дерева денормализованы в колонку `query_refs` — по ней держатели и ищутся. Обхода
 *    markdown здесь больше нет: он не отличал адрес от строки (любое `a/b` внутри блока,
 *    включая написанный владельцем `title=`, считалось ссылкой) и не видел адресацию
 *    закавыченной подписью (§А5-3а). ЦЕНА, названная вслух: перечень ровно настолько полон,
 *    насколько полна колонка, — писатель тела, её не заполняющий, делает свою запись
 *    невидимой и для слияния, и для пробы §А10-3. Писателей ЧЕТВЕРО, и колонку пишут ТРИ:
 *    исполнитель (`executor/body-fields.ts`), сид (`seed/onboarding.ts`) и само слияние
 *    вместе с откатом (ниже в этом файле). Четвёртый — разовая конверсия корпуса
 *    `db/backfill-body-doc.ts` — НЕ пишет её и блоки не привязывает: реестра у неё нет, она
 *    идёт админ-DSN по всем владельцам сразу. Строка, сконвертированная ею, для перечня
 *    невидима до первого сохранения тела через исполнителя; расхождение известное
 *    (`backfill-body-doc.test.ts` его пиннит) и снимается пересевом Задачи 23, после
 *    которого строк без документа не остаётся вовсе;
 *  - `delta` — строка `registry_deltas` (§А3-2). Дерева не несёт вовсе, но адресует
 *    свойства шестью полями: `properties.add[].propertyId`, `properties.hide[]`,
 *    `properties.relaxRequired[]`, КЛЮЧИ `properties.rank{}`, КЛЮЧИ `selectOptions{}`
 *    и КЛЮЧИ `classMap{}`;
 *  - `bind` — привязка СВОЕГО аспекта к контракту (§Б2-1): ЗНАЧЕНИЯ `implements[].bind` — id
 *    свойств (к id их приводит `normalizeBindAddresses`). `fixed` сюда не входит: там значение
 *    слота, а не адрес свойства. До среза Б-2 привязку не видел никто, и после слияния она
 *    указывала на поглощённое свойство (остаток Б-1 50 и `bind`-половина остатка 51);
 *  - `rule` — правило каталога на СВОЕЙ строке-носителе (свойство, аспект, роль; §Б4-1, Р-И-23): адреса
 *    параметров голыми строками, выражения деревом и область `scope.property` — перечень мест у
 *    `mapRuleAddresses`. Правила ДЕЛЬТЫ встроенной строки (В-6) — не шестой род, а четвёртый: они
 *    лежат в той же строке `registry_deltas` и переписываются тем же UPDATE (`rewriteDelta`).
 *
 * ДЕРЖАТЕЛИ ВНЕ ПЕРЕЧНЯ — их ТРИ, и у каждого своё «почему».
 *
 * Первый — зеркало-ребро роли `ref`,
 * подписанное `relations.meta.property` (§А6-2). Слияние переписывает его подпись само
 * (`mergeProperty`, блок «ЗЕРКАЛО-РЕБРО»), а сюда оно не заведено НАМЕРЕННО: этот же
 * список кормит `propertyUsage` («на строке ничего не держится») и граф зависимостей, и
 * ребро в нём поменяло бы семантику удаления и восстановления строки — производная реестра
 * стала бы поводом запретить операцию над самим реестром. Читателю, сверяющему перечень:
 * пять родов — это ДЕРЖАТЕЛИ, которых надо ИСКАТЬ; зеркало ищется одним UPDATE по подписи.
 *
 * Второй и третий — СОСТАВ СВОЕГО АСПЕКТА (`aspect_definitions.properties[].propertyId`) и ключевые
 * поля карточки той же строки (`view_config.keyFields` — тоже id свойств). Оба хранят id, переживают
 * операции над реестром и слиянием НЕ переписываются: после `src → into` аспект владельца по-прежнему
 * носит поглощённую строку (алиас `deprecated` + `merged_into`, который на чтении никто не
 * разрешает), а переписанная `bind`-привязка смотрит на `into`, которого аспект может не носить
 * (`checkImplements` → `not_carried` на следующей записи привязок). В перечень они не заведены:
 * каждый род перечня слияние ПЕРЕПИСЫВАЕТ (ветка на род в `mergeProperty`), а для состава своей
 * строки аспекта не решено даже, ЧТО писать при слиянии (заменить `src` на `into`, добавить `into` рядом,
 * слить обязательность и порядок двух ссылок), и инструмента, правящего этот состав, у владельца нет
 * (`aspect_update` не существует; `aspect_delta_set` меняет эффективный снимок, а не строку). Это
 * ОТКРЫТАЯ половина остатка Б-1 №51 («состав аспекта»); закрыта здесь только половина `bind`, адрес
 * открытой — реестр остатков среза.
 *
 * ПРИЗНАК, ПО КОТОРОМУ СЛЕДУЮЩИЙ ЧИТАТЕЛЬ ПОЙМЁТ, ЧТО ПЕРЕЧЕНЬ УСТАРЕЛ: появилось место,
 * хранящее идентификатор свойства (в колонке, в jsonb, в тексте) и переживающее операции
 * над реестром, — и оно не названо ни в перечне, ни среди держателей вне его. `bind` — пятый род
 * (срез Б-2, задача 1); правило каталога на строке владельца — шестой (задача 16, вместе с тулами
 * записи правил `rule_set`/`rule_remove`).
 *
 * Граф зависимостей получает этот перечень через ручку `registry.dependants` (`routers/registry.ts`):
 * все держатели, кроме дельт (их зависимость уже сложена в снимок ребром `aspect`), уходят в
 * `queryRefs` и становятся рёбрами рода `'query'` (`from` — id держателя). Своего рода у `bind` в графе
 * нет: привязка приезжает туда ребром `'query'` от id аспекта. Ответ «кто на свойстве стоит» от этого
 * не ложный (аспект действительно зависит), но род ребра — «запрос», а не «привязка». Состав своего
 * аспекта граф при этом видит — ребром `aspect` из снимка; не видит его только слияние.
 */
export interface PropertyHolder {
  kind: 'registry' | 'progress_source' | 'body' | 'delta' | 'bind' | 'rule';
  /**
   * id строки реестра, id сущности, id строки `registry_deltas`, id своего аспекта (`bind`) либо id
   * своей строки-носителя правил (`rule`).
   */
  id: string;
  /** id и key свойств, названные этим держателем. */
  properties: string[];
  /**
   * Только у рода `rule`: в КАКОЙ из трёх таблиц-носителей строка. Правила живут в свойствах, аспектах и
   * ролях (§Б4-1), и один `id` без рода адресовал бы три таблицы сразу.
   */
  carrier?: 'aspect' | 'property' | 'role';
}

/** Таблица-носитель по роду цели: правила живут в трёх реестрах (§Б4-1), а запрос обязан быть один;
 * её же обходит шестой род держателей (`collectPropertyHolders`). */
const RULE_TABLE = {
  aspect: sql`aspect_definitions`,
  property: sql`property_definitions`,
  role: sql`relation_role_definitions`,
} as const;

const PROGRESS_SOURCE = 'orbis/progress_source';

/**
 * Все имена свойств, названные деревом: `prop`, `has`, `sortBy`. Контракты и наборы (`class`,
 * `rel.sourceNotIn`, Б-1) сюда не входят: слияние переписывает СВОЙСТВА, а контракт слиянию
 * не подлежит.
 */
function propertyNamesInAst(value: unknown, out: Set<string>): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null) continue;
    if (!Array.isArray(node)) {
      const rec = node as Record<string, unknown>;
      for (const field of ['prop', 'has', 'field'] as const) {
        if (typeof rec[field] === 'string') out.add(rec[field] as string);
      }
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push(child);
  }
}

/**
 * Namespaced key как отдельный токен — для переписывания имени в ТЕКСТЕ неразобранного
 * блока (у него дерева нет, и адрес в нём только текстом).
 *
 * Замена токенная, а не подстрочная: `user/effort` не должен ловиться в `user/effort-2`.
 */
const KEY_TOKEN_RE = /[a-z][a-z0-9-]*\/[a-z][a-z0-9_-]*/g;

/**
 * Перенос имени свойства в ТЕКСТЕ неразобранного блока — ВНЕ КАВЫЧЕК.
 *
 * Тот же принцип, что у перечня держателей: имя внутри ЗНАЧЕНИЯ — не адрес, а слово, которое
 * написал владелец (`title="про user/effort"`). У разобранного блока это решает дерево; у
 * неразобранного дерева нет, и единственное доступное различение — кавычки. Поиск идёт по
 * МАСКЕ (`maskQuotedValues` сохраняет длину), правка — по тем же индексам в оригинале.
 *
 * Предел назван: значение, которому кавычки не понадобились, от имени поля неотличимо. Цена
 * ошибки здесь мала — блок и так не разбирается, — а альтернатива (не переписывать текст
 * вовсе) оставляла бы висячее имя поглощённого свойства.
 */
function rewriteQueryTextKeys(text: string, from: ReadonlySet<string>, to: string): string {
  const masked = maskQuotedValues(text);
  let out = '';
  let cut = 0;
  for (const m of masked.matchAll(KEY_TOKEN_RE)) {
    const at = m.index as number;
    if (!from.has(m[0])) continue;
    out += text.slice(cut, at) + to;
    cut = at + m[0].length;
  }
  return out + text.slice(cut);
}

/**
 * Имена свойств, названные ДЕЛЬТОЙ: шесть полей аспекта, перечисленных у `PropertyHolder`, и — с Б-2 —
 * правила дельты (`rules`, у аспекта и у свойства; В-6) тем же обходом, что шестой род держателя.
 * `rulesDisabled` адресов свойств не несёт: там id правил.
 */
function propertyNamesInDelta(delta: unknown, out: Set<string>): void {
  if (typeof delta !== 'object' || delta === null) return;
  const d = delta as AspectDelta;
  for (const ref of d.properties?.add ?? []) out.add(ref.propertyId);
  for (const id of d.properties?.hide ?? []) out.add(id);
  for (const id of d.properties?.relaxRequired ?? []) out.add(id);
  for (const id of Object.keys(d.properties?.rank ?? {})) out.add(id);
  for (const id of Object.keys(d.selectOptions ?? {})) out.add(id);
  for (const id of Object.keys(d.classMap ?? {})) out.add(id);
  for (const rule of Array.isArray(d.rules) ? d.rules : []) propertyNamesInRule(rule, out);
}

/**
 * Полный перечень держателей свойства у владельца — вход и графа зависимостей (§А3-5), и
 * переписывания ссылок при слиянии (§А10-2), и пробы «на нём ничего не держится» (§А10-3).
 *
 * ОДИН обход на три вопроса намеренно: «кто на свойстве стоит», «что переписать при
 * слиянии» и «можно ли удалить строку» — это один и тот же список мест, и разъехались бы
 * они первым же новым родом держателя. Ровно это и случилось с дельтой: она была видна
 * графу зависимостей и невидима слиянию.
 */
export async function collectPropertyHolders(tx: Tx, graphId: GraphId): Promise<PropertyHolder[]> {
  const out: PropertyHolder[] = [];

  const regRows = (await tx.execute(sql`
    SELECT id, scope, type FROM property_definitions
    WHERE graph_id = ${graphId}::uuid AND (scope IS NOT NULL OR type->>'kind' = 'ref')
  `)) as unknown as RawRow[];
  for (const r of regRows) {
    const names = new Set<string>();
    propertyNamesInAst(r.scope, names);
    propertyNamesInAst((r.type as PropertyType | null) ?? null, names);
    if (names.size > 0) out.push({ kind: 'registry', id: r.id as string, properties: [...names] });
  }

  const propRows = (await tx.execute(sql`
    SELECT id, props -> ${PROGRESS_SOURCE} AS value FROM entities
    WHERE props ? ${PROGRESS_SOURCE}`)) as unknown as RawRow[];
  for (const r of propRows) {
    const names = new Set<string>();
    propertyNamesInAst(r.value, names);
    if (names.size > 0) {
      out.push({ kind: 'progress_source', id: r.id as string, properties: [...names] });
    }
  }

  // `query_refs` несёт адреса ИЗ ДЕРЕВА: id свойств и ролей, id аспектов, а у связей —
  // uuid цели (`children_of=<id>`). Всё, что не резолвится в свойство, дальше отсеется само
  // — и у слияния (множество имён источника), и у графа зависимостей (`byAlias`).
  const bodyRows = (await tx.execute(sql`
    SELECT id, query_refs FROM entities WHERE query_refs <> '{}'`)) as unknown as RawRow[];
  for (const r of bodyRows) {
    const names = (r.query_refs ?? []) as string[];
    if (names.length > 0) out.push({ kind: 'body', id: r.id as string, properties: [...names] });
  }

  // Дельты — четвёртый род. Читаются ВСЕ цели, а не только `aspect`: строка вида
  // `property`/`contract` в срезе А появиться не может (тулов нет), но обход, отбирающий
  // по `target_kind`, промолчал бы о ней ровно тогда, когда она всё-таки появится.
  const deltaRows = (await tx.execute(sql`
    SELECT id, delta FROM registry_deltas WHERE graph_id = ${graphId}::uuid`)) as unknown as RawRow[];
  for (const r of deltaRows) {
    const names = new Set<string>();
    propertyNamesInDelta(r.delta, names);
    if (names.size > 0) out.push({ kind: 'delta', id: r.id as string, properties: [...names] });
  }

  // ПЯТЫЙ РОД (§Б2-1, `bind`-половина остатка 51 Б-1): привязка аспекта владельца адресует свойство ЗНАЧЕНИЕМ `bind` — тем
  // же id, что лежит в `props`. До этой задачи перечень её не видел, и цена была названа вслух докблоком
  // `assertImplements`: после слияния привязка продолжала указывать на поглощённое свойство, значения
  // которого уже переехали, — аспект тихо выпадал из Повестки и Бюджета, а повторная запись той же привязки
  // отказывала `UNKNOWN_PROPERTY/merged`. `fixed` сюда не входит: там ЗНАЧЕНИЕ слота, а не адрес свойства.
  const bindRows = (await tx.execute(sql`
    SELECT id, implements FROM aspect_definitions
    WHERE graph_id = ${graphId}::uuid AND implements <> '[]'::jsonb`)) as unknown as RawRow[];
  for (const r of bindRows) {
    const names = new Set<string>();
    for (const b of (r.implements ?? []) as AspectImplements[]) {
      for (const p of Object.values(b.bind ?? {})) names.add(p);
    }
    if (names.size > 0) out.push({ kind: 'bind', id: r.id as string, properties: [...names] });
  }

  // ШЕСТОЙ РОД (§Б4-1, Р-И-23): правила каталога на СВОИХ строках трёх реестров-носителей. Встроенные
  // строки владельцу не принадлежат (их правила правит сид, а правила владельца поверх них — дельта,
  // четвёртый род выше), поэтому только `graph_id = владелец`.
  for (const [carrier, table] of Object.entries(RULE_TABLE) as Array<
    ['aspect' | 'property' | 'role', SQL]
  >) {
    const ruleRows = (await tx.execute(sql`
      SELECT id, rules FROM ${table}
      WHERE graph_id = ${graphId}::uuid AND rules <> '[]'::jsonb`)) as unknown as RawRow[];
    for (const r of ruleRows) {
      const names = new Set<string>();
      for (const rule of (r.rules ?? []) as unknown[]) propertyNamesInRule(rule, names);
      if (names.size > 0) {
        out.push({ kind: 'rule', id: r.id as string, properties: [...names], carrier });
      }
    }
  }
  return out;
}

/**
 * Проверить и нормализовать адреса свойств в дельте: каждый обязан резолвиться в реестре,
 * и в строку он ложится ИДЕНТИФИКАТОРОМ.
 *
 * Резолв принимает и id, и key — тем же правилом, что вся граница операций реестра: модель
 * и владелец называют свойство тем именем, которым его видели, а у пользовательского они
 * разные (Р3). Отказ — `DELTA_UNKNOWN_PROPERTY`, с именем, которое не сошлось.
 */
function normalizeDeltaAddresses(
  delta: AspectDelta,
  properties: ReadonlyMap<string, PropertyDefinition>,
  aspectId: string,
): AspectDelta {
  const byName = new Map<string, string>();
  for (const def of properties.values()) {
    byName.set(def.id, def.id);
    // Своя строка перекрывает встроенную — `ORDER BY graph_id NULLS FIRST` у `load.ts`.
    byName.set(def.key, def.id);
  }
  const resolve = (name: string): string => {
    const id = byName.get(name);
    if (id === undefined) {
      throw new ExecError(
        'VALIDATION',
        `свойства «${name}» нет в реестре — дельта аспекта ${aspectId} не поставлена`,
        { reason: 'DELTA_UNKNOWN_PROPERTY', aspect: aspectId, property: name },
      );
    }
    return id;
  };
  // Переименование делает `rewriteDelta`: множество имён — все адреса дельты, цель у
  // каждого своя, поэтому обходим по одному. Одна функция на два вызова тут не выйдет —
  // там одно имя на всё, здесь у каждого своё.
  const names = new Set<string>();
  propertyNamesInDelta(delta, names);
  let out = delta;
  for (const name of names) {
    const id = resolve(name);
    if (id !== name) out = rewriteDelta(out, new Set([name]), id) as AspectDelta;
  }
  return out;
}

/**
 * Читается ли реестр владельца в ТЕКУЩЕМ (уже переписанном) состоянии — см. вызов в
 * `mergeProperty`. Отказ переводится в `REGISTRY_CONFLICT`: слияние не «сломалось», оно
 * упёрлось в настройку, которую до него надо разобрать, — и разбирает её владелец.
 *
 * Причина исходного отказа едет в `details.cause` целиком: без неё владельцу пришлось бы
 * гадать, ЧТО именно в дельте мешает. `reason` при этом СВОЙ, не `MERGE_VALUES`: по нему
 * `registry/merge-conflict.ts` отличает конфликт значений (ему кладётся карточка разбора с
 * повтором слияния) от этого — тут повторять нечего, пока настройка та же.
 */
async function assertMergeLeftRegistryReadable(
  tx: Tx,
  graphId: GraphId,
  source: string,
  into: string,
  conflictsBefore: ReadonlyMap<string, unknown>,
): Promise<void> {
  try {
    const reg = await currentRegistry(tx, graphId);
    // ПРАВИЛА ПОСЛЕ ПЕРЕПИСЫВАНИЯ (шестой род, Р-И-23): слияние сводит два адреса в один, и правила,
    // по отдельности законные (умолчание на источнике и умолчание на цели), становятся двумя писателями
    // одного свойства — `applyDeltas` этого не видит, а движок исполнял бы их в порядке обхода. Круг
    // «свойство → правило → свойство» тем же способом спрашивает граф (`REGISTRY_CYCLE` уходит в catch).
    // Мерка — ПРИРОСТ (гейт 16 I-1): конфликт, живший в снимке ДО слияния (правило своей строки против
    // нового системного — граница пересева, `ruleMergeContextOf`), не вина слияния, и отказ «слияние
    // свело правила» про него был бы ложью.
    const clash = [...conflictKeysOf(reg)].find(([key]) => !conflictsBefore.has(key))?.[1];
    if (clash !== undefined) {
      throw new ExecError(
        'REGISTRY_CONFLICT',
        `слияние ${source} → ${into} свело правила «${clash.a}» и «${clash.b}» на одно свойство ` +
          `(${clash.property}) — разберите правила до слияния`,
        { reason: 'MERGE_RULES_CONFLICT', source, into, rules: [clash.a, clash.b] },
      );
    }
    assertAcyclicGraph(dependencyGraph(reg, { queryRefs: new Map() }));
  } catch (e) {
    if (e instanceof ExecError && e.code === 'REGISTRY_CONFLICT') throw e;
    if (e instanceof ExecError) {
      throw new ExecError(
        'REGISTRY_CONFLICT',
        `слияние ${source} → ${into} сделало бы реестр нечитаемым (${e.message}) — ` +
          `разберите настройку аспекта до слияния`,
        { reason: 'MERGE_REGISTRY_UNREADABLE', source, into, cause: e.details },
      );
    }
    throw e;
  }
}

/**
 * Переписать имя свойства в ДЕЛЬТЕ (§А3-2) — по всем пяти адресующим полям.
 *
 * Цель — ИДЕНТИФИКАТОР, как у дерева: дельта хранит канон, а не текст запроса, и
 * `applyDeltas` ищет свойство в словаре по id (`properties.get(add.propertyId)`).
 *
 * СТОЛКНОВЕНИЕ КЛЮЧЕЙ (владелец настроил и поглощаемое, и поглощающее) разрешается в пользу
 * записи ЦЕЛИ: она относится к свойству, которое остаётся жить.
 *
 * ВЫБРОШЕННАЯ ЗАПИСЬ ИСТОЧНИКА ЗАВЕДОМО ИЗБЫТОЧНА, и это не оценка, а следствие соседнего
 * гейта: `resolveMergePair` отказывает `MERGE_TYPE`, пока ЭФФЕКТИВНЫЕ типы различаются, а
 * `selectOptions` дельты вложены ровно в `type.options`. Значит дельта, которая РЕАЛЬНО
 * изменила набор вариантов источника, делает типы разными — и до слияния дело не доходит
 * вовсе. Дожить до этой строки может только настройка, ничего в наборе не менявшая.
 *
 * Для `rank` довод слабее (ранг в тип не входит), и там выбор именно такой, как назван:
 * порядок полей — свойство ЦЕЛИ, а порядок исчезнувшего свойства исчезает вместе с ним.
 */
function rewriteDelta(delta: unknown, from: ReadonlySet<string>, to: string): unknown {
  if (typeof delta !== 'object' || delta === null) return delta;
  const d = delta as AspectDelta;
  const rename = (id: string): string => (from.has(id) ? to : id);
  /** Переименование КЛЮЧЕЙ карты: запись цели, если она уже была, не затирается. */
  const renameKeys = <T>(map: Record<string, T> | undefined): Record<string, T> | undefined => {
    if (map === undefined) return undefined;
    const out: Record<string, T> = {};
    for (const [id, value] of Object.entries(map)) if (!from.has(id)) out[id] = value;
    for (const [id, value] of Object.entries(map)) {
      if (from.has(id) && out[to] === undefined) out[to] = value;
    }
    return out;
  };
  const properties = d.properties;
  const nextProperties =
    properties === undefined
      ? undefined
      : {
          ...(properties.add !== undefined && {
            add: properties.add.map((ref) => ({ ...ref, propertyId: rename(ref.propertyId) })),
          }),
          ...(properties.hide !== undefined && { hide: properties.hide.map(rename) }),
          ...(properties.relaxRequired !== undefined && {
            relaxRequired: properties.relaxRequired.map(rename),
          }),
          ...(properties.rank !== undefined && { rank: renameKeys(properties.rank) }),
        };
  return {
    ...d,
    ...(nextProperties !== undefined && { properties: nextProperties }),
    ...(d.selectOptions !== undefined && { selectOptions: renameKeys(d.selectOptions) }),
    ...(d.classMap !== undefined && { classMap: renameKeys(d.classMap) }),
    // Правила дельты — тем же UPDATE, что остальная дельта: второго писателя одной строки не заводится,
    // и прежнее значение уже лежит в `MergeInverse.deltas` целиком.
    ...(Array.isArray(d.rules) && { rules: d.rules.map((r) => rewriteRuleAddresses(r, from, to)) }),
  };
}

// ---------------------------------------------------------------------------
// mergeProperty (§А10-2)
// ---------------------------------------------------------------------------

/** Что слияние переписало — ровно столько, сколько нужно, чтобы вернуть всё обратно. */
export interface MergeInverse {
  source: string;
  into: string;
  /** Строка поглощённого свойства ДО слияния: статус и указатель. */
  sourceRow: { status: PropertyRow['status']; mergedInto: string | null };
  /**
   * Записи, у которых переписали значение: прежнее значение обоих ключей.
   *
   * `hadInto` — ОТДЕЛЬНЫЙ флаг, а не «ключ `into` отсутствует»: нагрузка едет в jsonb
   * журнала и обратно через zod, и «ключа не было» от «ключ был со значением null»
   * на этом пути неотличимо. А разница именно в этом: вернуть цель, которой не было,
   * значит не выполнить «байт-в-байт».
   */
  values: Array<{ entityId: string; source: unknown; hadInto: boolean; into: unknown }>;
  /** Свойства, чей `merged_into` компактация перевела на новую цель (§А10-2). */
  compacted: string[];
  /** Строки реестра с переписанным Q-AST: прежние `scope` и `type`. */
  registry: Array<{ id: string; scope: unknown; type: unknown }>;
  /** Записи с переписанным `orbis/progress_source`: прежнее значение. */
  progress: Array<{ entityId: string; value: unknown }>;
  /**
   * Записи с переписанным телом: прежние `body`, `body_doc` и ОБА индекса имён целиком.
   *
   * Индексы лежат в inverse СНИМКОМ, а не пересчитываются на откате из восстановленного
   * документа. Пересчёт дал бы «правильное» значение вместо ПРЕЖНЕГО, а это разные вещи:
   * `body_refs` денормализован и по корпусу местами расходится с телом (`db/backfill-body-doc.ts`
   * переписывает текст и сам индекс не пересчитывает — задокументировано его тестом), и
   * откат, «чинящий» такую строку, перестал бы быть байт-в-байт.
   */
  bodies: Array<{
    entityId: string;
    body: string;
    bodyDoc: unknown;
    bodyRefs?: string[];
    queryRefs?: string[];
  }>;
  /** Строки `registry_deltas` с переписанными адресами: прежняя дельта целиком. */
  deltas: Array<{ id: string; delta: unknown }>;
  /**
   * Зеркала-рёбра (§А6-2), чью подпись `meta.property` слияние перевело на цель.
   *
   * Поле НЕОБЯЗАТЕЛЬНОЕ по той же причине, по которой защитно разбирается `deltas`: журнал
   * append-only, и у слияний, записанных до того, как слияние начало переподписывать зеркала,
   * ключа нет.
   * Хранится СПИСОК id, а не «все рёбра с подписью цели»: откат обязан вернуть подпись
   * ровно тем рёбрам, которые её потеряли, и не отобрать её у зеркал, законно
   * принадлежавших цели ещё до слияния.
   */
  mirrors?: string[];
  /**
   * Свои аспекты, чьи привязки (`implements[].bind`) слияние перевело на цель: прежний `implements`
   * ЦЕЛИКОМ — откат присваивает абсолютное значение, как у дельт. Поле НЕОБЯЗАТЕЛЬНОЕ по той же причине,
   * что `mirrors`: журнал append-only, и слияния, записанные до пятого рода держателей, ключа не несут.
   */
  binds?: Array<{ id: string; implements: AspectImplements[] }>;
  /**
   * Свои строки-носители правил (шестой род, Р-И-23), чьи правила слияние переписало: прежний список
   * `rules` ЦЕЛИКОМ — откат присваивает абсолютное значение. Поле НЕОБЯЗАТЕЛЬНОЕ по доводу `mirrors`:
   * журнал append-only, и слияния, записанные до шестого рода, ключа не несут.
   */
  rules?: Array<{ carrier: 'aspect' | 'property' | 'role'; id: string; rules: unknown }>;
}

export interface MergeResult {
  rewrittenEntities: number;
  rewrittenQueries: number;
  /** Полезная нагрузка ОДНОГО inverse на всю операцию (§А10-2) — её кладёт в журнал executor. */
  inverse: MergeInverse;
}

/** Конфликт значений: у записи заполнены оба свойства, и значения разные. */
export interface MergeValueConflict {
  entityId: string;
  source: unknown;
  into: unknown;
}

/**
 * Записи, на которых слияние не имеет молчаливого правильного ответа (§А10-2).
 *
 * ЧЕМ ДЕРЖИТСЯ «НИЧЕГО НЕ ПРИМЕНЕНО» — точно, без приукрашивания. Функция зовётся ПЕРВЫМ
 * запросом самого `mergeProperty`, то есть до первой записи ЭТОЙ операции, а не на отдельной
 * стадии исполнителя. Значит гарантия двухслойная и обе части нужны: внутри операции ничего
 * не успевает записаться по порядку запросов, а всё, что записали ПРЕДЫДУЩИЕ операции той же
 * пачки, снимает откат транзакции (отказ уходит из `execute` через `ExecError`, и
 * `withIdentity` откатывает tx целиком).
 *
 * ВЫЗЫВАЮЩИЙ ОДИН, и второго не обещается: отчёт о конфликте
 * (`registry/merge-conflict.ts`) читает уже готовый `details` отказа, а не спрашивает
 * заново. Функцией это вынесено ради имени: «что считается конфликтом» — отдельное
 * правило §А10-2, и в теле операции оно потерялось бы среди её шагов.
 */
async function mergeValueConflicts(
  tx: Tx,
  source: string,
  into: string,
): Promise<MergeValueConflict[]> {
  const rows = (await tx.execute(sql`
    SELECT id, props -> ${source} AS a, props -> ${into} AS b FROM entities
    WHERE props ? ${source} AND props ? ${into}
      AND props -> ${source} IS DISTINCT FROM props -> ${into}
    ORDER BY id`)) as unknown as RawRow[];
  return rows.map((r) => ({ entityId: r.id as string, source: r.a, into: r.b }));
}

/** Оба свойства слияния, уже проверенные на пригодность (§А10-2). */
export function resolveMergePair(
  reg: RegistrySnapshot,
  input: { source: string; into: string },
): { source: PropertyDefinition; into: PropertyDefinition } {
  // Адрес — id ИЛИ key: модель и владелец называют свойство тем именем, которым его видели,
  // а у пользовательского они разные (Р3). Снимок сюда приходит СВЕЖИЙ (`currentRegistry`
  // читает строки в этой же транзакции), поэтому свойство, заведённое предыдущей операцией
  // пачки, резолвится наравне с остальными.
  const byKeyOrId = (name: string): PropertyDefinition | undefined => {
    const byId = reg.properties.get(name);
    if (byId !== undefined) return byId;
    let found: PropertyDefinition | undefined;
    for (const def of reg.properties.values()) {
      // Своя строка перекрывает встроенную — то же правило, что у `resolvePropertyRef`:
      // строки идут `ORDER BY graph_id NULLS FIRST`, значит последняя запись и есть своя.
      if (def.key === name && (found === undefined || found.graphId === null)) found = def;
    }
    return found;
  };
  const source = byKeyOrId(input.source);
  const into = byKeyOrId(input.into);
  if (source === undefined || into === undefined) {
    throw new ExecError('NOT_FOUND', 'одного из свойств слияния нет в реестре', {
      source: input.source,
      into: input.into,
    });
  }
  if (source.id === into.id) {
    throw new ExecError('VALIDATION', 'слияние свойства с самим собой', { property: source.id });
  }
  if (source.graphId === null) {
    // Встроенная строка неизменяема (§А3-2): проставленный ей `merged_into` стал бы
    // ВЕЧНЫМ дрейфом (`db/registry-drift.ts` сверяет эту колонку), а пересев затёр бы
    // указатель, оставив данные переписанными. Ошибиться можно только в эту сторону.
    throw new ExecError(
      'VALIDATION',
      `${source.id} — встроенное свойство: поглощать можно только свои (§А3-2)`,
      { reason: 'MERGE_BUILTIN', source: source.id },
    );
  }
  // Д2: ХРАНИЛИЩЕ ЦЕЛИ. Слияние переносит значение внутри `props`
  // (`props = (props - source) || {into: props->source}`), а у core-проекций (§А1-3,
  // `storage: 'core'` — `orbis/title`, `orbis/archived`, `orbis/created_at`,
  // `orbis/updated_at`) значение живёт в КОЛОНКЕ. Такое слияние проходило бы «успешно»,
  // кладя значение в `props` по адресу, которого там никто не читает: у записи оказались бы
  // ДВЕ несогласованные правды под одним реестровым именем, а обещание операции («значения
  // переехали в цель») не выполнялось бы вовсе. Проверяются ОБА конца: у своей строки
  // `storage` сегодня всегда `props`, но правило говорит о хранилище, а не о происхождении.
  for (const [side, def] of [
    ['source', source],
    ['into', into],
  ] as const) {
    if (def.storage !== 'props') {
      throw new ExecError(
        'VALIDATION',
        `${def.id} хранится колонкой (storage: ${def.storage}) — слияние переносит только ` +
          `значения из props`,
        { reason: 'MERGE_STORAGE', side, property: def.id, storage: def.storage },
      );
    }
  }
  // Д3: НИ ОДИН КОНЕЦ НЕ ДОЛЖЕН БЫТЬ УЖЕ ПОГЛОЩЁН. Компактация (§А10-2) выпрямляет цепочку
  // только в одну сторону — «слили в то, что потом слили дальше»; обратный порядок («слить
  // в уже поглощённое») дал бы `a → b → c` в два шага, а на «не длиннее одного» стоят
  // резолвер (`db/schema.ts`, Р10) и обоснование ацикличности (`registry/deps-graph.ts`).
  // Отказ, а не молчаливый перевод на преемника: журнал обязан говорить, во что слили, тем
  // же именем, которое назвал владелец. Поглощённый ИСТОЧНИК запрещён по той же мерке —
  // значений у него нет, и повторное слияние только переставило бы указатель.
  for (const [side, def] of [
    ['source', source],
    ['into', into],
  ] as const) {
    if (def.mergedInto !== null) {
      throw new ExecError(
        'VALIDATION',
        `${def.id} уже поглощено свойством ${def.mergedInto} — сливайте с ним`,
        { reason: 'MERGE_ALREADY_MERGED', side, property: def.id, successor: def.mergedInto },
      );
    }
  }
  // Д3б: ЦЕЛЬ НЕ ДОЛЖНА БЫТЬ ВЫВЕДЕНА ИЗ ОБРАЩЕНИЯ. Слияние в deprecated-строку разложило бы
  // ЖИВЫЕ значения под свойство, запись которого отвергается (§А10-3), — то есть перевело бы
  // владельца в состояние «значение есть, а поправить его заново нельзя» одним успешным
  // вызовом. Источник в этом статусе, наоборот, законен: спрятать строку и потом слить её —
  // ровно тот жест, ради которого статус существует.
  if (into.status === 'deprecated') {
    throw new ExecError(
      'VALIDATION',
      `${into.id} выведено из обращения — сливать в него значит спрятать и значения источника`,
      { reason: 'MERGE_DEPRECATED_TARGET', into: into.id },
    );
  }
  if (JSON.stringify(source.type) !== JSON.stringify(into.type)) {
    // Типы сравниваются ЦЕЛИКОМ, а не по `kind`: `select` с разными наборами вариантов и
    // `decimal` с разными границами — это разные множества значений, и перенос значения
    // из одного в другое дал бы запись, которую собственный валидатор больше не примет.
    // Печатается ТО, ЧТО СРАВНИВАЛОСЬ, — тип целиком. Сообщение по одному `kind` давало
    // «типы свойств не совпадают: number и number» (живая проба), то есть отказ, из
    // которого владелец не может понять, что именно разошлось: границы, варианты, список.
    throw new ExecError(
      'VALIDATION',
      `типы свойств не совпадают: ${JSON.stringify(source.type)} и ${JSON.stringify(into.type)}`,
      {
        reason: 'MERGE_TYPE',
        source: source.id,
        into: into.id,
        sourceType: source.type,
        intoType: into.type,
      },
    );
  }
  return { source, into };
}

/**
 * `ARRAY[$1, $2]::text[]` — каждый элемент параметром.
 *
 * Своя копия по той же причине, что у близнецов в `query/compile-ast.ts` и `registry/ref.ts`:
 * массив JS шаблон `sql` drizzle разворачивает в КОРТЕЖ `($1,…,$N)`, а `record` к `text[]`
 * не приводится — запрос падает `cannot cast type record to text[]` уже на исполнении
 * (проверено: этот UPDATE так и упал до правки).
 */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/** `ARRAY[$1,…]::uuid[]`; пустой список — пустой массив того же типа (id рёбер — uuid). */
function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * Переписать имена свойств внутри произвольного JSON-дерева: `prop`/`has`/`field` и литерал-член
 * `$touched` языка E (`"<id>" in $touched`, Ф-Б2-26) — единственная `{const}`, которая адрес, а не
 * значение (`touchedAddressOf`). Прочие `{const}` не трогаются: `"orbis/x" in ["orbis/x"]` — сравнение
 * значений, и переписать его значило бы поменять смысл данных владельца.
 *
 * Экспорт — ради пина: держателей с E-правилами у слияния пока нет (правила на строках реестра —
 * держатель задачи 16), и без прямого теста ветка `$touched` ждала бы первого потребителя
 * непроверенной.
 */
export function rewriteAst(value: unknown, from: ReadonlySet<string>, to: string): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteAst(v, from, to));
  if (typeof value !== 'object' || value === null) return value;
  const touched = touchedAddressOf(value);
  if (touched !== undefined && from.has(touched)) {
    return { ...(value as Record<string, unknown>), args: [{ const: to }, { ctx: '$touched' }] };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] =
      (k === 'prop' || k === 'has' || k === 'field') && typeof v === 'string' && from.has(v)
        ? to
        : rewriteAst(v, from, to);
  }
  return out;
}

/**
 * СЛИЯНИЕ СВОЙСТВ (§А10-2) — одно действие исполнителя с ОДНИМ inverse под замком реестра.
 *
 * Порядок шагов не переставляется: сперва конфликты (ничего не применено, если они есть),
 * потом значения, потом ссылки, потом сама строка, и только в конце — версия.
 *
 * ССЫЛКИ ИЩУТСЯ И ПО id, И ПО key. В дереве §А5-7 лежат id, но `entity_query` принимает и
 * key (`resolvePropertyRef` резолвит оба), а текст запроса в теле — ТОЛЬКО key. Искать одно
 * из двух значило бы переписать половину ссылок и оставить вторую указывать на поглощённое.
 */
export async function mergeProperty(
  tx: Tx,
  graphId: GraphId,
  input: { source: string; into: string },
): Promise<MergeResult> {
  const reg = await currentRegistry(tx, graphId);
  const { source, into } = resolveMergePair(reg, input);
  // Конфликты правил ДО слияния — база мерки прироста у пробы после переписывания.
  const conflictsBefore = conflictKeysOf(reg);
  const conflicts = await mergeValueConflicts(tx, source.id, into.id);
  if (conflicts.length > 0) {
    throw new ExecError(
      'REGISTRY_CONFLICT',
      `у ${conflicts.length} записей заполнены оба свойства, и значения разные — ` +
        `слияние ждёт разбора пачки`,
      { reason: 'MERGE_VALUES', source: source.id, into: into.id, entities: conflicts },
    );
  }

  // Значения: прежнее состояние ОБОИХ ключей снимается тем же снапшотом, которым идёт
  // UPDATE (CTE + FOR UPDATE), а не отдельным SELECT'ом — иначе запись, получившая
  // свойство между двумя запросами, была бы переписана и не попала бы в inverse.
  const valueRows = (await tx.execute(sql`
    WITH victims AS (
      SELECT id, props -> ${source.id} AS old_source, props -> ${into.id} AS old_into,
             props ? ${into.id} AS had_into
      FROM entities WHERE props ? ${source.id}
      ORDER BY id
      FOR UPDATE
    ), upd AS (
      UPDATE entities e
         SET props = (e.props - ${source.id})
                     || jsonb_build_object(${into.id}::text, e.props -> ${source.id}),
             updated_at = now()
        FROM victims v WHERE e.id = v.id
    )
    SELECT id, old_source, old_into, had_into FROM victims
  `)) as unknown as RawRow[];
  const values = valueRows.map((r) => ({
    entityId: r.id as string,
    source: r.old_source,
    hadInto: r.had_into === true,
    into: r.had_into === true ? r.old_into : null,
  }));

  // ЗЕРКАЛО-РЕБРО — ДЕРЖАТЕЛЬ ВНЕ ПЕРЕЧНЯ (§А6-2): ребро роли `ref` подписывает себя `meta.property`
  // = ИДЕНТИФИКАТОРОМ свойства (`registry/ref.ts`, фаза 2), и подпись переживает слияние
  // ровно так же, как переживал бы её ключ в `props`. Не переписать её — значит вывести
  // ребро из самопочинки НАВСЕГДА: `syncRefMirror` снимает устаревшие зеркала только по
  // подписям из `changed`, а `changed` строится обходом ключей `props`, откуда id источника
  // слияние только что убрало. Дальше — либо вечно чужая подпись в «Связанном», либо (после
  // первой же смены значения) висячее ребро на прежнюю цель: неснимаемый `needs-review` при
  // её архивации и «Связанное», показывающее источник, которого там нет.
  //
  // Конфликта уникальности переподпись дать не может: `rel_uniq` стоит на
  // (source_id, target_id, role), `meta` в ключ не входит; а единственный случай, где у
  // записи было бы ДВА разных зеркала, отбит выше конфликтом значений.
  //
  // `updated_at` ребра не двигаем — по тому же доводу, что у `markRefSourcesNeedsReview`:
  // это производная реестра, а не правка владельца.
  //
  // КЛЮЧ ПОДПИСИ — ЛИТЕРАЛ `property`, и это названный остаток, а не второе мнение: параметр
  // `meta_key` строки `mirror_ref` (Б-2) читает только писатель зеркала (`syncRefMirror`), а ключ
  // заморожен ДАННЫМИ — им подписаны все уже лежащие рёбра, и смена `meta_key` была бы миграцией
  // рёбер, а не правкой параметра. Значение строки пиннит `rules/carriers.test.ts`
  // (`meta_key: 'property'`); этот писатель, backlinks (`entity-read.ts`) и сводка импорта
  // (`import/review.ts`) обязаны совпадать с ним.
  const mirrorRows = (await tx.execute(sql`
    UPDATE relations r
       SET meta = jsonb_set(r.meta, '{property}', to_jsonb(${into.id}::text))
     WHERE r.role = ${ROLE_REF} AND r.meta->>'property' = ${source.id}
       AND EXISTS (SELECT 1 FROM entities e
                    WHERE e.id = r.source_id AND e.graph_id = ${graphId}::uuid)
    RETURNING r.id`)) as unknown as RawRow[];
  const mirrors = mirrorRows.map((r) => r.id as string);

  // Ссылки. Множество ИМЁН ИСТОЧНИКА — id и key: в дереве §А5-7 лежат id, но `entity_query`
  // принимает и key, а текст запроса в теле — ТОЛЬКО key. Искать одно из двух значило бы
  // переписать половину ссылок и оставить вторую указывать на поглощённое.
  //
  // А вот ЦЕЛЬ У ДВУХ РОДОВ ДЕРЖАТЕЛЕЙ РАЗНАЯ, и это не мелочь оформления:
  //  - ДЕРЕВО (`scope`, `ref.target`, значение `progress_source`) адресует свойство
  //    ИДЕНТИФИКАТОРОМ (§А5-7: «в дереве лежат id, не подписи»), туда едет `into.id`;
  //  - ТЕКСТ блока `{{query:…}}` адресует его ТОЛЬКО ключом (§А5-3а), и разбор резолвит
  //    свойство по `key` либо по закавыченной подписи — id он не знает вовсе
  //    (`parse-ast.ts`, индекс `byPropertyKey`). У пользовательского свойства id — uuid
  //    (Р3), поэтому подстановка id в текст даёт `UNKNOWN_FIELD` НАВСЕГДА: смарт-лист
  //    владельца после «успешного» слияния перестаёт разбираться, а отчёт операции говорит
  //    «успех». На встроенных это не всплывало бы никогда — там id совпадает с key.
  const names = new Set([source.id, source.key]);
  // Ссылка на key живой цели висячей не станет: операции «переименовать key» в срезе А нет
  // вовсе (Р10), а появится она — переименование обязано будет пройти по тем же держателям.
  const astTarget = into.id;
  const textTarget = into.key;
  // Снимок разбора — из ТОГО ЖЕ реестра, которым резолвилась пара: печать key-формы блока
  // обязана знать `into.key`, а собранный после слияния снимок читал бы уже поглощённую
  // строку.
  const parseReg = parseRegistryOfSnapshot(reg);
  const holders = (await collectPropertyHolders(tx, graphId)).filter((h) =>
    h.properties.some((p) => names.has(p)),
  );
  const registry: MergeInverse['registry'] = [];
  const progress: MergeInverse['progress'] = [];
  const bodies: MergeInverse['bodies'] = [];
  const deltas: MergeInverse['deltas'] = [];
  const binds: NonNullable<MergeInverse['binds']> = [];
  const ruleRows: NonNullable<MergeInverse['rules']> = [];

  for (const holder of holders) {
    if (holder.kind === 'registry') {
      const rows = (await tx.execute(sql`
        SELECT scope, type FROM property_definitions
        WHERE graph_id = ${graphId}::uuid AND id = ${holder.id}`)) as unknown as RawRow[];
      const row = rows[0];
      if (row === undefined) continue;
      const nextScope = rewriteAst(row.scope ?? null, names, astTarget);
      const nextType = rewriteAst(row.type, names, astTarget);
      registry.push({ id: holder.id, scope: row.scope ?? null, type: row.type });
      await tx.execute(sql`
        UPDATE property_definitions
           SET scope = ${nextScope === null ? null : JSON.stringify(nextScope)}::jsonb,
               type = ${JSON.stringify(nextType)}::jsonb
         WHERE graph_id = ${graphId}::uuid AND id = ${holder.id}`);
      continue;
    }
    if (holder.kind === 'progress_source') {
      const rows = (await tx.execute(sql`
        SELECT props -> ${PROGRESS_SOURCE} AS value FROM entities
        WHERE id = ${holder.id}::uuid FOR UPDATE`)) as unknown as RawRow[];
      const row = rows[0];
      if (row === undefined) continue;
      progress.push({ entityId: holder.id, value: row.value });
      await tx.execute(sql`
        UPDATE entities
           SET props = props || jsonb_build_object(${PROGRESS_SOURCE}::text,
                 ${JSON.stringify(rewriteAst(row.value, names, astTarget))}::jsonb),
               updated_at = now()
         WHERE id = ${holder.id}::uuid`);
      continue;
    }
    if (holder.kind === 'delta') {
      const rows = (await tx.execute(sql`
        SELECT delta FROM registry_deltas
        WHERE graph_id = ${graphId}::uuid AND id = ${holder.id}::uuid FOR UPDATE
      `)) as unknown as RawRow[];
      const row = rows[0];
      if (row === undefined) continue;
      deltas.push({ id: holder.id, delta: row.delta });
      await tx.execute(sql`
        UPDATE registry_deltas SET delta = ${JSON.stringify(
          rewriteDelta(row.delta, names, astTarget),
        )}::jsonb
         WHERE graph_id = ${graphId}::uuid AND id = ${holder.id}::uuid`);
      continue;
    }
    if (holder.kind === 'rule') {
      // Шестой род (Р-И-23): строка-носитель своих правил. Цель — `astTarget` (id): правило хранит
      // канон, движок ищет свойство по id (докблок `rewriteRuleAddresses`).
      const carrier = holder.carrier ?? 'aspect';
      const rows = (await tx.execute(sql`
        SELECT rules FROM ${RULE_TABLE[carrier]}
         WHERE graph_id = ${graphId}::uuid AND id = ${holder.id} FOR UPDATE`)) as unknown as RawRow[];
      const row = rows[0];
      if (row === undefined) continue;
      const before = (row.rules ?? []) as RuleDefinition[];
      ruleRows.push({ carrier, id: holder.id, rules: before });
      const next = before.map((r) => rewriteRuleAddresses(r, names, astTarget));
      await tx.execute(sql`
        UPDATE ${RULE_TABLE[carrier]} SET rules = ${JSON.stringify(next)}::jsonb
         WHERE graph_id = ${graphId}::uuid AND id = ${holder.id}`);
      continue;
    }
    if (holder.kind === 'bind') {
      const rows = (await tx.execute(sql`
        SELECT implements FROM aspect_definitions
         WHERE graph_id = ${graphId}::uuid AND id = ${holder.id} FOR UPDATE`)) as unknown as RawRow[];
      const row = rows[0];
      if (row === undefined) continue;
      const before = (row.implements ?? []) as AspectImplements[];
      binds.push({ id: holder.id, implements: before });
      // Цель — `astTarget` (id), как у дерева: `bind` адресует свойство ИДЕНТИФИКАТОРОМ
      // (`normalizeBindAddresses` приводит вход к нему), а не ключом, как текст блока.
      const next = before.map((b) => ({
        ...b,
        bind: Object.fromEntries(
          Object.entries(b.bind).map(([slot, id]) => [slot, names.has(id) ? astTarget : id]),
        ),
      }));
      await tx.execute(sql`
        UPDATE aspect_definitions SET implements = ${JSON.stringify(next)}::jsonb
         WHERE graph_id = ${graphId}::uuid AND id = ${holder.id}`);
      continue;
    }
    const rows = (await tx.execute(sql`
      SELECT body, body_doc, body_refs, query_refs FROM entities
       WHERE id = ${holder.id}::uuid FOR UPDATE
    `)) as unknown as RawRow[];
    const row = rows[0];
    if (row === undefined) continue;
    const body = String(row.body ?? '');
    bodies.push({
      entityId: holder.id,
      body,
      bodyDoc: row.body_doc ?? null,
      bodyRefs: (row.body_refs ?? []) as string[],
      queryRefs: (row.query_refs ?? []) as string[],
    });
    // ПРАВДА ТЕЛА — ДОКУМЕНТ (§А11-1), и переписывается он первым; `body` пересобирается из
    // него печатью, а не вторым регэкспом по markdown. Два независимых переписывания одной
    // вещи разъезжаются молча — ровно это и случилось: атрибут блока сменил имя, регэксп по
    // `body` продолжал работать, а документ переставал переписываться вовсе.
    //
    // `readBodyDoc` берёт на себя и строку без документа (`body_doc IS NULL` — ленивая
    // конверсия): она собирается из markdown и привязывается тем же реестром. Слияние
    // МАТЕРИАЛИЗУЕТ такой документ, и это названная цена: операция, переписывающая имена,
    // которые документ и держит, не может оставить «ещё не сконвертировано» — иначе
    // следующее чтение собрало бы документ из УЖЕ переписанного текста, а первое
    // сохранение вернуло бы его в базу как правду, минуя проверку слияния.
    //
    // ЖИВЫМИ ПИСАТЕЛЯМИ ЭТО СОСТОЯНИЕ НЕДОСТИЖИМО: держатель ищется по `query_refs`, а её
    // заполняют только те, кто тем же UPDATE пишет и `body_doc`. Ветка оставлена как
    // страховка и ПОКРЫТА тестом с искусственным состоянием (`ops.test.ts`, «строка с
    // индексом, но БЕЗ документа») — иначе цена выше проверялась бы чтением кода. Писатель,
    // заполняющий индекс без документа, появится в тот день, когда `db/backfill-body-doc.ts`
    // получит реестр.
    const nextDoc = bindQueryBlocks(
      rewriteBodyDoc(
        readBodyDoc(row.body_doc ?? null, body, parseReg),
        names,
        astTarget,
        textTarget,
      ),
      parseReg,
    );
    await tx.execute(sql`
      UPDATE entities
         SET body = ${serializeBody(nextDoc)},
             body_doc = ${JSON.stringify(nextDoc)}::jsonb,
             body_refs = ${textArray(bodyRefsFromDoc(nextDoc))},
             query_refs = ${textArray(queryRefsFromDoc(nextDoc))},
             updated_at = now()
       WHERE id = ${holder.id}::uuid`);
  }

  // Компактация цепочки (§А10-2): указатели на поглощённое переводятся на новую цель тем же
  // шагом. Иначе A→B→C копилось бы, а резолвер идёт в ОДИН шаг (Р10) и на второй бы не пошёл.
  const compactedRows = (await tx.execute(sql`
    UPDATE property_definitions SET merged_into = ${into.id}
     WHERE graph_id = ${graphId}::uuid AND merged_into = ${source.id}
    RETURNING id`)) as unknown as RawRow[];

  await tx.execute(sql`
    UPDATE property_definitions SET merged_into = ${into.id}, status = 'deprecated'
     WHERE graph_id = ${graphId}::uuid AND id = ${source.id}`);

  // ПРОБА ПОСЛЕ ПЕРЕПИСЫВАНИЯ — последнее, что делает слияние перед версией.
  //
  // Все остальные писатели реестра спрашивают «останется ли он читаемым» ДО записи
  // (`assertRegistryStaysReadable`), и только слияние не могло: оно не подставляет одну
  // строку, а переписывает разом значения, реестровые ссылки, тела и ДЕЛЬТЫ, и будущее
  // состояние до применения не собрать. Поэтому вопрос задаётся после — по фактически
  // получившемуся состоянию, тем же `applyDeltas`, каким его сложит читатель. Транзакция к
  // этому моменту не закоммичена, отказ откатывает её целиком, и «ничего не применено»
  // держится тем же механизмом, что у конфликта значений.
  //
  // ЗАЧЕМ ЭТО НУЖНО — два состояния, в которые слияние въезжало молча, и оба хуже отказа:
  //  - дельта объявляла на аспекте ОБА сливаемых свойства (по отдельности законно), и после
  //    переименования в `properties.add[]` оказывались две ссылки на одну цель →
  //    `DELTA_PROPERTY_PRESENT` на КАЖДОМ чтении реестра;
  //  - одно свойство объявлено на аспекте дельтой, второе — своим `scope` (§А3-4, тоже по
  //    отдельности законно) → после слияния `SCOPE_DUPLICATE`.
  // И то и другое запирает не аспект, а ВЕСЬ реестр владельца: не работают ни правка, ни
  // снятие дельты, ни откат самого слияния. Это третья и четвёртая двери в ту же комнату,
  // что закрыта у остальных писателей, и выбор здесь тот же — отказать ГРОМКО.
  //
  // ДЕДУПА `add[]` ЗДЕСЬ НЕТ НАМЕРЕННО. Схлопнуть две ссылки в одну технически можно, но у
  // них разные `required` и `rank`, и выбор между ними — решение владельца, а не операции
  // (тот же довод, по которому §А3-3 не сливает молча два похожих варианта). Отказ говорит,
  // что разобрать надо настройку, и оставляет разбор тому, кто её делал.
  await assertMergeLeftRegistryReadable(tx, graphId, source.id, into.id, conflictsBefore);

  await bumpOwnerRegistryVersion(tx, graphId);

  return {
    rewrittenEntities: values.length,
    rewrittenQueries:
      registry.length +
      progress.length +
      bodies.length +
      deltas.length +
      binds.length +
      ruleRows.length,
    inverse: {
      source: source.id,
      into: into.id,
      sourceRow: { status: source.status, mergedInto: source.mergedInto },
      values,
      compacted: compactedRows.map((r) => r.id as string),
      registry,
      progress,
      bodies,
      deltas,
      mirrors,
      binds,
      rules: ruleRows,
    },
  };
}

/**
 * Перенос имени по query-блокам СТРУКТУРНОГО тела — по ОБЕИМ формам блока сразу.
 *
 * Форм две, и цели у них разные (то же различение, что у реестровых держателей выше):
 * `ast` — правда, и адресует свойство ИДЕНТИФИКАТОРОМ (§А5-7); `text` — печать этого
 * дерева, и адресует его ТОЛЬКО ключом (§А5-3а). Одной ветки мало ни в одну сторону:
 * блок без дерева (не разобрался) живёт текстом, и не переписать его значило бы оставить
 * висячее имя; блок с деревом печатается заново привязкой, и его `text` здесь — лишь
 * промежуточное состояние.
 *
 * Возвращает ДОКУМЕНТ, а не произвольный JSON: вход всегда `BodyDoc`, и типизировать его
 * `unknown`, как было, значило разрешить звать это по колонке `body_doc` напрямую — то
 * есть по значению, которое может оказаться и `null`, и документом чужой версии.
 */
function rewriteBodyDoc(
  doc: BodyDoc,
  from: ReadonlySet<string>,
  astTo: string,
  textTo: string,
): BodyDoc {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object' || node === null) return node;
    const rec = node as Record<string, unknown>;
    if (rec.type === 'queryBlock') {
      const attrs = (rec.attrs ?? {}) as Record<string, unknown>;
      return {
        ...rec,
        attrs: {
          ...attrs,
          ast: attrs.ast == null ? attrs.ast : rewriteAst(attrs.ast, from, astTo),
          ...(typeof attrs.text === 'string' && {
            text: rewriteQueryTextKeys(attrs.text, from, textTo),
          }),
        },
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = walk(v);
    return out;
  };
  return { v: doc.v, doc: walk(doc.doc) as BodyDoc['doc'] };
}

/**
 * ОТКАТ СЛИЯНИЯ (§7.8) — одна обратная операция на всё, что сделало слияние.
 *
 * ИДЕМПОТЕНТНА ПО ПОСТРОЕНИЮ: каждое действие здесь — присвоение АБСОЛЮТНОГО прежнего
 * значения (не «прибавить», не «поменять местами»), поэтому второй прогон той же нагрузки
 * оставляет базу ровно там же, где первый. Это не украшение: undo применяется через тот же
 * конвейер, что и всё остальное, и повтор его нагрузки — обычное дело при ретрае транспорта.
 *
 * ОБРАТНАЯ СТОРОНА ТОГО ЖЕ СВОЙСТВА, названная вслух: это LWW-откат (§7.8), и правку,
 * сделанную ПОСЛЕ слияния, он молча теряет. `merge A→B`, потом `entity_update B=42`, потом
 * undo — и вместо 42 вернётся `{A: 5}`. Так устроен весь undo Orbis («восстанавливает
 * зафиксированное в журнале состояние ПОВЕРХ текущего», `executor/types.ts`), и слияние
 * здесь не исключение — но масштаб у него другой: одна отмена трогает все записи владельца
 * со слитым свойством сразу.
 *
 * ЗАМЕТНАЯ АСИММЕТРИЯ между двумя обратными операциями реестра, и она НЕ случайна:
 * `restorePropertyRow` отказывается удалять строку, у которой появились значения
 * («не осироти данные»), а здесь такой страховки нет и быть не может — откат слияния
 * возвращает значения НА МЕСТО, а не удаляет их, и отказывать ему значило бы запретить
 * отмену там, где она как раз и нужна. Цена — потерянная поздняя правка; она предпочтена
 * неотменяемому слиянию тысячи записей.
 */
export async function undoMerge(tx: Tx, graphId: GraphId, iv: MergeInverse): Promise<void> {
  // `iv.deltas` разбирается ЗАЩИТНО по той же причине, что `ref_sources_marked` в
  // `executor/undo.ts`: журнал append-only, и в нём лежат записи, сделанные до появления
  // четвёртого рода держателей. Отсутствие ключа означает «дельт не переписывали», а не
  // исключение на откате действия, которое владелец сделал вчера.
  const deltaRows = Array.isArray(iv.deltas) ? iv.deltas : [];
  for (const v of iv.values) {
    // Ключ цели возвращается ТОЧНО в прежнее состояние: было значение — кладём его, не было
    // ключа вовсе — снимаем. `props - into || {source: …}` без этой развилки оставлял бы
    // цель заполненной там, где её не было, и «байт-в-байт» не выполнялось бы.
    const restoreInto = v.hadInto
      ? sql`|| jsonb_build_object(${iv.into}::text, ${JSON.stringify(v.into ?? null)}::jsonb)`
      : sql``;
    await tx.execute(sql`
      UPDATE entities
         SET props = ((props - ${iv.into})
                      || jsonb_build_object(${iv.source}::text, ${JSON.stringify(v.source ?? null)}::jsonb))
                     ${restoreInto},
             updated_at = now()
       WHERE id = ${v.entityId}::uuid`);
  }
  for (const r of iv.registry) {
    await tx.execute(sql`
      UPDATE property_definitions
         SET scope = ${r.scope === null ? null : JSON.stringify(r.scope)}::jsonb,
             type = ${JSON.stringify(r.type)}::jsonb
       WHERE graph_id = ${graphId}::uuid AND id = ${r.id}`);
  }
  for (const p of iv.progress) {
    await tx.execute(sql`
      UPDATE entities
         SET props = props || jsonb_build_object(${PROGRESS_SOURCE}::text,
               ${JSON.stringify(p.value ?? null)}::jsonb),
             updated_at = now()
       WHERE id = ${p.entityId}::uuid`);
  }
  for (const b of iv.bodies) {
    // Индексы имён возвращаются ТЕМ ЖЕ UPDATE, что и тело. Не вернуть их значило бы
    // оставить расхождение, ПЕРЕЖИВШЕЕ транзакцию: тело от старого состояния, `query_refs`
    // от нового — и держателя, которого слияние переписало, следующий обход по колонке уже
    // не нашёл бы.
    //
    // Ключи читаются ЗАЩИТНО по той же причине, что `iv.deltas` выше: журнал append-only, и
    // слияния, записанные до этой задачи, обоих индексов не несут. Для них честный запасной
    // ход — пересчёт из ВОССТАНОВЛЕННОГО документа (а при его отсутствии — из markdown,
    // где привязки нет и `query_refs` пусты по построению).
    const restored: BodyDoc | null = (b.bodyDoc ?? null) === null ? null : (b.bodyDoc as BodyDoc);
    const fallbackDoc = restored ?? parseBody(b.body);
    const bodyRefs = Array.isArray(b.bodyRefs) ? b.bodyRefs : bodyRefsFromDoc(fallbackDoc);
    const queryRefs = Array.isArray(b.queryRefs) ? b.queryRefs : queryRefsFromDoc(fallbackDoc);
    await tx.execute(sql`
      UPDATE entities
         SET body = ${b.body},
             body_doc = ${restored === null ? null : JSON.stringify(restored)}::jsonb,
             body_refs = ${textArray(bodyRefs)},
             query_refs = ${textArray(queryRefs)},
             updated_at = now()
       WHERE id = ${b.entityId}::uuid`);
  }
  for (const d of deltaRows) {
    await tx.execute(sql`
      UPDATE registry_deltas SET delta = ${JSON.stringify(d.delta)}::jsonb
       WHERE graph_id = ${graphId}::uuid AND id = ${d.id}::uuid`);
  }
  // Привязки своих аспектов — прежний `implements` целиком, тем же UPDATE, что писало слияние; ключ
  // читается защитно, как `iv.deltas` и `iv.mirrors` (см. `MergeInverse.binds`).
  const bindRows = Array.isArray(iv.binds) ? iv.binds : [];
  for (const b of bindRows) {
    await tx.execute(sql`
      UPDATE aspect_definitions SET implements = ${JSON.stringify(b.implements)}::jsonb
       WHERE graph_id = ${graphId}::uuid AND id = ${b.id}`);
  }
  // Правила своих строк-носителей — прежний список целиком (шестой род, `MergeInverse.rules`); ключ
  // читается защитно, как у `binds`.
  const ruleRowsBack = Array.isArray(iv.rules) ? iv.rules : [];
  for (const r of ruleRowsBack) {
    await tx.execute(sql`
      UPDATE ${RULE_TABLE[r.carrier]} SET rules = ${JSON.stringify(r.rules ?? [])}::jsonb
       WHERE graph_id = ${graphId}::uuid AND id = ${r.id}`);
  }
  // Зеркала (§А6-2) — обратная переподпись ровно по списку из inverse (см. `MergeInverse.mirrors`).
  const mirrorIds = Array.isArray(iv.mirrors) ? iv.mirrors : [];
  if (mirrorIds.length > 0) {
    await tx.execute(sql`
      UPDATE relations r
         SET meta = jsonb_set(r.meta, '{property}', to_jsonb(${iv.source}::text))
       WHERE r.id = ANY(${uuidArray(mirrorIds)})
         AND EXISTS (SELECT 1 FROM entities e
                      WHERE e.id = r.source_id AND e.graph_id = ${graphId}::uuid)`);
  }
  for (const id of iv.compacted) {
    await tx.execute(sql`
      UPDATE property_definitions SET merged_into = ${iv.source}
       WHERE graph_id = ${graphId}::uuid AND id = ${id}`);
  }
  await tx.execute(sql`
    UPDATE property_definitions
       SET merged_into = ${iv.sourceRow.mergedInto}, status = ${iv.sourceRow.status}
     WHERE graph_id = ${graphId}::uuid AND id = ${iv.source}`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

// ---------------------------------------------------------------------------
// Дельты аспектов, контрактов и подписок (§А3-2, §Б5-2)
// ---------------------------------------------------------------------------

/**
 * ImplementsIssue → ExecError — один экземпляр на оба писателя привязок (setAspectDelta, задача 13;
 * aspect_create/aspect_implements_set, задача 15). BIND_TYPE и VARIANT_UNMAPPED — свои коды §С1-2;
 * UNKNOWN_CONTRACT/SLOT/PROPERTY и REQUIRED_SLOT_UNBOUND — опечатка адреса, а не расхождение типов:
 * VALIDATION с причиной в details (та же природа, что у остальных отказов дельт).
 *
 * ПОРЯДОК СЛОЖЕНИЯ В ВЕТКЕ VALIDATION — не косметика. У замечаний привязок `details.reason` УЖЕ
 * занят словарём Ф-Б1-18 (`UNKNOWN_CONTRACT` несёт `duplicate`, `VARIANT_UNMAPPED` — `not_status`
 * и прочие), и спред `{reason: issue.code, ...d}` затирал КОД замечания его же уточнением:
 * наружу уходил `reason: 'duplicate'`, по которому не отличить вторую привязку того же контракта
 * от снятого контракта. Поэтому код ложится ПОСЛЕ `d`, а вытесненное уточнение переезжает в
 * `cause` — оба различения остаются у читателя отказа.
 */
export function execErrorOfImplementsIssue(
  issue: ImplementsIssue,
  extra: Record<string, unknown> = {},
): ExecError {
  const d = issue.details as Record<string, unknown>;
  if (issue.code === 'VARIANT_UNMAPPED') {
    return new ExecError(
      'VARIANT_UNMAPPED',
      `вариант «${String(d.variant)}» не отнесён к классу контракта ${String(d.contract)}`,
      { ...extra, ...d },
    );
  }
  if (issue.code === 'BIND_TYPE') {
    return new ExecError(
      'BIND_TYPE',
      `слот ${String(d.slot)} контракта ${String(d.contract)}: тип свойства не подходит`,
      { ...extra, ...d },
    );
  }
  return new ExecError('VALIDATION', `привязка не сходится с реестром: ${issue.code}`, {
    ...extra,
    ...d,
    reason: issue.code,
    ...(typeof d.reason === 'string' && { cause: d.reason }),
  });
}

export async function readAspectDelta(
  tx: Tx,
  graphId: GraphId,
  aspectId: string,
): Promise<AspectDelta | null> {
  const rows = (await tx.execute(sql`
    SELECT delta FROM registry_deltas
    WHERE graph_id = ${graphId}::uuid AND target_kind = 'aspect' AND target_id = ${aspectId}
  `)) as unknown as RawRow[];
  return rows[0] === undefined ? null : (rows[0].delta as AspectDelta);
}

/**
 * Дельта аспекта (§А3-2) — с ПРОВЕРКОЙ ПРИМЕНИМОСТИ ДО ЗАПИСИ.
 *
 * Зачем проверка. `applyDeltas` — fail-closed: неприменимая дельта роняет не саму себя, а
 * ЧТЕНИЕ РЕЕСТРА ЦЕЛИКОМ, и на каждом запросе. Записанная такая дельта означает владельца,
 * запертого снаружи собственного графа до ручной правки базы. Поэтому здесь складывается
 * будущий снимок (система ⊕ все дельты, с этой на месте старой) — ровно тем же кодом,
 * которым его сложит читатель, — и отказ приходит ДО INSERT'а.
 *
 * `base_version` — СИСТЕМНАЯ версия, на которую дельта опирается (§А3-3): с неё начнёт
 * трёхстороннее слияние следующего пересева. С версией владельца её не путать — ту двигает
 * `bumpOwnerRegistryVersion` ниже.
 */
export async function setAspectDelta(
  tx: Tx,
  graphId: GraphId,
  aspectId: string,
  delta: AspectDelta,
): Promise<void> {
  const parsed = aspectDeltaSchema.safeParse(delta);
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `дельта аспекта ${aspectId} не разбирается схемой`, {
      reason: 'DELTA_MALFORMED',
      aspect: aspectId,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const rows = await loadRegistryRows(tx, graphId);
  if (!rows.aspects.has(aspectId)) {
    throw new ExecError('NOT_FOUND', `аспекта ${aspectId} нет в реестре`, { aspect: aspectId });
  }
  // АДРЕСА СВОЙСТВ В ДЕЛЬТЕ ПРОВЕРЯЮТСЯ И НОРМАЛИЗУЮТСЯ К id, а не пишутся как пришли.
  //
  // Проверка — тот же принцип «не заводить висячих ссылок», которым живёт §А10-3, и он
  // дешевле, чем чинить их потом: `applyDeltas` на неизвестный `propertyId` НЕ падает —
  // она молча пушит ссылку в состав аспекта, и владелец видит поле, у которого нет
  // определения. Нормализация — вторая половина того же: дельта хранит канон, а
  // `applyDeltas` ищет свойство в словаре ПО id (`properties.get`), то есть записанный
  // ключом адрес не резолвился бы никогда и молча.
  // Пустые поля правил — отсутствие настройки, а не настройка (`compactRuleDelta`): обратная операция называет
  // их пустыми, чтобы перенос `aspectDeltaAfterSet` не оставил текущие (N-2), а в строку они не ложатся.
  const normalized = compactRuleDelta(
    normalizeDeltaAddresses(parsed.data, rows.properties, aspectId),
  );
  // ПОЛНОТА ОТНЕСЕНИЯ ВАРИАНТОВ (§Б2-2) — ДО записи, тем же доводом, что и проба применимости
  // ниже: `applyDeltas` вариант примет молча, и запись со свежим статусом выпала бы из всех
  // наборов контракта — из чекбокса строки, из `class=`, из Agenda — без следа причины.
  // `rows` — это `RegistryDictionaries` (properties/aspects/contracts), ровно тот словарь,
  // который ждёт проверка.
  const target = rows.aspects.get(aspectId) as AspectDefinition;
  // ПРАВИЛА СВОЕЙ СТРОКИ — ТОЛЬКО В СТРОКЕ (Ф-Б2-30, гейт 16 I-5). Дельта правил — жест поверх ВСТРОЕННОЙ
  // строки (В-6, Р-2); у своего аспекта второе хранилище своих правил развело бы два ответа на «какие
  // правила у строки»: `rule_remove` по колонке отвечал бы «снято», а правило из дельты продолжало бы
  // действовать, и `rulesDisabled` молча гасил бы правила колонки.
  if (
    target.graphId !== null &&
    ((normalized.rules?.length ?? 0) > 0 || (normalized.rulesDisabled?.length ?? 0) > 0)
  ) {
    throw new ExecError(
      'VALIDATION',
      `${aspectId} — ваш аспект: его правила правятся rule_set/rule_remove, а не настройкой аспекта`,
      { reason: 'RULE_DELTA_OWN_ROW', aspect: aspectId },
    );
  }
  const issue = checkClassMap(normalized, target, rows)[0];
  if (issue !== undefined) throw execErrorOfImplementsIssue(issue, { aspect: aspectId });
  const versions = await readRegistryVersions(tx, graphId);
  const existing = await loadRegistryDeltas(tx, graphId);
  const probe = [
    ...existing.filter((r) => !(r.targetKind === 'aspect' && r.targetId === aspectId)),
    {
      id: newId(),
      graphId,
      targetKind: 'aspect' as const,
      targetId: aspectId,
      baseVersion: versions.systemVersion,
      delta: normalized,
    },
  ];
  // Отказ `applyDeltas` — уже ExecError с точной причиной (DELTA_PROPERTY_PRESENT,
  // REQUIRED_NOT_RELAXABLE, …); перехватывать и переименовывать его нечем и незачем.
  const applied = applyDeltas(
    { ...rows, ownerVersion: versions.ownerVersion, systemVersion: versions.systemVersion },
    probe,
  );
  // ИСКЛЮЧИТЕЛЬНОСТЬ НА ИТОГОВОЙ КАРТЕ (Р-И-38, фикс-раунд 1 задачи 14а). `checkClassMap` выше
  // видит эту дельту против строк БЕЗ дельт; отнесение ПРОШЛОЙ дельты другого аспекта в тот же
  // класс он не видит — а `applyDeltas` сложит обе в `value_map` каждой привязки свойства к слоту,
  // и запись классом (`variantOfClass`) станет неоднозначной. Проверяются только свойства ЭТОЙ
  // карты: чужая испорченная строка (фикстура, прошлая версия кода) не должна делать неисполнимой
  // правку соседней — довод `assertImplements`.
  const touched = new Set(Object.keys(normalized.classMap ?? {}));
  const exclusive = exclusiveClassIssues(applied).find((i) =>
    touched.has(String(i.details.propertyId)),
  );
  if (exclusive !== undefined) throw execErrorOfImplementsIssue(exclusive, { aspect: aspectId });
  // ПРАВИЛА ДЕЛЬТЫ (§Б4-1, В-6) — ЗДЕСЬ, а не у `rule_set`: сюда приходят И тул `aspect_delta_set`, И
  // единица разрешения конфликта правил (`merge-conflict.ts`), И `setRuleDelta`; второй экземпляр
  // валидатора разошёлся бы с этим на первой же новой проверке. Снимок «до» — те же строки с живыми
  // дельтами: сторожа носителей и пар меряют СДВИГ, а не состояние.
  const prevDelta = existing.find((r) => r.targetKind === 'aspect' && r.targetId === aspectId)
    ?.delta as AspectDelta | undefined;
  assertDeltaRulesWrite(
    applyDeltas(
      { ...rows, ownerVersion: versions.ownerVersion, systemVersion: versions.systemVersion },
      existing,
    ),
    applied,
    { kind: 'aspect', id: aspectId },
    normalized,
    target.rules,
    Array.isArray(prevDelta?.rules) ? prevDelta.rules : [],
  );

  // ПУСТАЯ ДЕЛЬТА = ОТСУТСТВИЕ СТРОКИ (довод `writeRuleDelta`, N3-4 фикс-раунда 4): пустышка висела бы со своим
  // `base_version`, и пересев сливал бы её вхолостую. Так кончается откат настройки, чьи поля уже сняты
  // другими жестами, и прямое `aspect_delta_set` с `{}`. Проверки выше прошли на той же пробе: дельта `{}`
  // применяется как отсутствие строки. Мерка — та же сериализация, что ляжет в строку ниже.
  if (JSON.stringify(normalized) === '{}') {
    await removeDeltaRow(tx, graphId, 'aspect', aspectId);
    return;
  }
  await tx.execute(sql`
    INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
    VALUES (${newId()}::uuid, ${graphId}::uuid, 'aspect', ${aspectId},
            ${versions.systemVersion}, ${JSON.stringify(normalized)}::jsonb)
    ON CONFLICT (graph_id, target_kind, target_id)
      DO UPDATE SET delta = EXCLUDED.delta, base_version = EXCLUDED.base_version`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

/** Снятие дельты: аспект возвращается к системному определению (§А3-2) — кроме правил (Ф-Б2-29). */
export async function removeAspectDelta(tx: Tx, graphId: GraphId, aspectId: string): Promise<void> {
  // ПОЛЯ ПРАВИЛ ОСТАЮТСЯ (Ф-Б2-29): снимается настройка аспекта — подпись, состав, варианты, отнесения, —
  // а правила аспекта правят только `rule_set`/`rule_remove`. Эффективный список правил от этого не
  // меняется, и проверок правил строке «только правила» не нужно: она их уже прошла.
  const kept = aspectDeltaAfterRemove(await readAspectDelta(tx, graphId, aspectId));
  if (kept === null) {
    await tx.execute(sql`
      DELETE FROM registry_deltas
       WHERE graph_id = ${graphId}::uuid AND target_kind = 'aspect' AND target_id = ${aspectId}`);
  } else {
    await tx.execute(sql`
      UPDATE registry_deltas SET delta = ${JSON.stringify(kept)}::jsonb
       WHERE graph_id = ${graphId}::uuid AND target_kind = 'aspect' AND target_id = ${aspectId}`);
  }
  await bumpOwnerRegistryVersion(tx, graphId);
}

/**
 * ПРОБА ПРИМЕНЕНИЯ → СТРОКА → ВЕРСИЯ — один порядок на все рода дельт, по тому же доводу, что у
 * `setAspectDelta`: `applyDeltas` fail-closed на каждом чтении, значит неприменимая дельта обязана быть
 * отвергнута ДО INSERT'а. Общая функция, а не третья копия: у трёх родов совпадает ВСЁ, кроме проверок
 * до пробы, — и разъехались бы они на первом же новом роде (ровно так уже случилось с
 * `propertyNamesInDelta`).
 */
async function writeDeltaRow(
  tx: Tx,
  graphId: GraphId,
  targetKind: RegistryDeltaTargetKind,
  targetId: string,
  delta: RegistryDelta,
  rows: RegistryDictionaries,
  check?: (probe: RegistrySnapshot) => void,
): Promise<void> {
  const versions = await readRegistryVersions(tx, graphId);
  const existing = await loadRegistryDeltas(tx, graphId);
  const probe = [
    ...existing.filter((r) => !(r.targetKind === targetKind && r.targetId === targetId)),
    { id: newId(), graphId, targetKind, targetId, baseVersion: versions.systemVersion, delta },
  ];
  // Проба считается БЕЗУСЛОВНО, а не внутри аргумента `check?.()`: у необязательного вызова
  // аргумент не вычисляется вовсе, и род БЕЗ своей проверки писал бы неприменимую строку
  // молча — то есть ровно то, ради чего проба и заведена. Сегодня свой `check` есть у всех
  // трёх родов (аспект — `VARIANT_UNMAPPED`, подписка — `assertSubscription`, контракт —
  // `assertSetsFreeOfSubscribers`), и безусловность держит уже не их, а ЧЕТВЁРТЫЙ род.
  const applied = applyDeltas(
    { ...rows, ownerVersion: versions.ownerVersion, systemVersion: versions.systemVersion },
    probe,
  );
  check?.(applied);
  await tx.execute(sql`
    INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
    VALUES (${newId()}::uuid, ${graphId}::uuid, ${targetKind}, ${targetId},
            ${versions.systemVersion}, ${JSON.stringify(delta)}::jsonb)
    ON CONFLICT (graph_id, target_kind, target_id)
      DO UPDATE SET delta = EXCLUDED.delta, base_version = EXCLUDED.base_version`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

async function readDeltaRow(
  tx: Tx,
  graphId: GraphId,
  kind: RegistryDeltaTargetKind,
  targetId: string,
): Promise<unknown> {
  const rows = (await tx.execute(sql`
    SELECT delta FROM registry_deltas
    WHERE graph_id = ${graphId}::uuid AND target_kind = ${kind} AND target_id = ${targetId}`)) as unknown as RawRow[];
  return rows[0]?.delta;
}

async function removeDeltaRow(
  tx: Tx,
  graphId: GraphId,
  kind: RegistryDeltaTargetKind,
  targetId: string,
): Promise<void> {
  await tx.execute(sql`DELETE FROM registry_deltas
     WHERE graph_id = ${graphId}::uuid AND target_kind = ${kind} AND target_id = ${targetId}`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

/**
 * ССЫЛКИ НА НАБОРЫ КОНТРАКТА В ДЕКЛАРАЦИИ — обход дерева, а не разбор по схеме движка.
 *
 * Имя набора стоит в декларации в ЧЕТЫРЁХ формах: правым операндом `in`
 * (`{op:'in', args:[{class:{contract}}, {const:'<набор>'}]}`), полем пары `{contract, set}`
 * (`hide`, `has_relation.in_set`), полем `counted_set` РЯДОМ со своим `contract`
 * (`sources.movement`) и — четвёртой — полем `counted_set` БЕЗ соседнего контракта
 * (`lists.<n>.counted_set`: там стоит `over: 'movement'`, а контракт лежит этажом выше, в
 * `sources.movement.contract`). Четвёртая и есть довод против разбора «по соседним ключам без
 * контекста»: узел сам себя не адресует, и без снесённого сверху контракта источника ссылка
 * читалась бы ничьей — ровно так набор `lists.*` и снимался «ок» из-под живой подписки.
 * Поэтому обход несёт `context` — контракт источника движений, снятый с `sources.movement`
 * на входе в поддерево.
 *
 * Разбирать формы ТИПАМИ двух движков значило бы завести третье описание подписки рядом с
 * zod-схемой и валидатором. Обход по ключам ловит все четыре одним правилом; ПЯТУЮ страхует
 * ветка (б) `assertSetsFreeOfSubscribers` — отказ валидатора, называющий контракт
 * (`details.contract` у `SUBSCRIPTION_UNKNOWN_SET`, `subscriptions/registry.ts`).
 */
function setRefsOf(
  value: unknown,
  out: Array<{ contract: string; set: string }> = [],
  context: string | null = null,
): Array<{ contract: string; set: string }> {
  if (Array.isArray(value)) {
    for (const item of value) setRefsOf(item, out, context);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  const node = value as Record<string, unknown>;
  // Контракт источника движений — контекст для всего поддерева: `lists.*` адресуют набор
  // ИМЕННО его (`over: 'movement'`), не называя контракт у себя.
  const sources = node.sources;
  const movement =
    sources !== null && typeof sources === 'object'
      ? (sources as Record<string, unknown>).movement
      : undefined;
  const movementContract =
    movement !== null && typeof movement === 'object'
      ? (movement as Record<string, unknown>).contract
      : undefined;
  const inner = typeof movementContract === 'string' ? movementContract : context;
  const left = Array.isArray(node.args) ? node.args[0] : undefined;
  const right = Array.isArray(node.args) ? node.args[1] : undefined;
  if (node.op === 'in' && left !== null && typeof left === 'object') {
    const cls = (left as Record<string, unknown>).class;
    const contract =
      cls !== null && typeof cls === 'object'
        ? (cls as Record<string, unknown>).contract
        : undefined;
    const name =
      right !== null && typeof right === 'object'
        ? (right as Record<string, unknown>).const
        : undefined;
    if (typeof contract === 'string' && typeof name === 'string') out.push({ contract, set: name });
  }
  const own = typeof node.contract === 'string' ? node.contract : inner;
  if (own !== null) {
    if (typeof node.set === 'string') out.push({ contract: own, set: node.set });
    if (typeof node.counted_set === 'string') out.push({ contract: own, set: node.counted_set });
  }
  for (const item of Object.values(node)) setRefsOf(item, out, inner);
  return out;
}

/**
 * ПОДПИСКИ, ЗАВИСЯЩИЕ ОТ НАБОРОВ ЭТОГО КОНТРАКТА (Ф-Б1-55б) — fail-closed на ЗАПИСИ.
 *
 * Набор контракта — не только «свой ярлык»: на него ссылаются декларации подписок. Сняв дельту
 * наборов либо заменив её целиком, владелец уносит имя ИЗ-ПОД живой подписки — и `agendaListOf`
 * падает `UNKNOWN_SET` на КАЖДОМ чтении: тул отчитался успехом, а Повестка заперта до `undo`.
 * Смысл подписки проверяется на записи ПОДПИСКИ (Р-И-7) — значит и на записи того, из чего
 * подписка собрана.
 *
 * ЗАВИСИМОСТЬ СЧИТАЕТСЯ ПО ПРИЧИНЕ, А НЕ ПО ФАКТУ ПОЛОМКИ (уточнение Ф-Б1-55б после ре-ревью).
 * Прежняя редакция брала разность «сломано после − сломано до» и оставляла живой путь в два
 * шага: `aspect_implements_remove` ломал подписку ДРУГОЙ причиной (`SUBSCRIPTION_PREFER_UNBOUND`,
 * Повестка при этом ещё читалась), разность становилась пустой, набор снимался «ок» — и
 * Повестка гасла позже, в момент, когда владелец чинил ПЕРВУЮ причину. Поэтому здесь два
 * теста зависимости:
 *   (а) декларация СИНТАКСИЧЕСКИ называет набор этого контракта, которого после правки не
 *       будет (`setRefsOf`) — не зависит от того, читаема ли подписка сейчас;
 *   (б) проба `assertSubscription` после правки отказывает, НАЗЫВАЯ этот контракт
 *       (`details.contract` у `SUBSCRIPTION_UNKNOWN_SET`, `subscriptions/registry.ts`), —
 *       страховка на форму ссылки, которую обход не знает. Ветка не декоративна и это
 *       ПРОВЕРЕНО мутацией: с выключенным (а) четвёртая форма (`lists.<n>.counted_set`)
 *       по-прежнему даёт `SET_IN_USE` — держит её именно (б).
 * Чужая поломка (другой контракт, другая причина) наборы НЕ запирает: отказывать ею значило бы
 * отвечать «набор используется» про набор, который тут ни при чём.
 */
function assertSetsFreeOfSubscribers(after: RegistrySnapshot, contractId: string): void {
  const contract = after.contracts.get(contractId);
  const sets = contract !== undefined && contract.kind === 'slots' ? (contract.sets ?? {}) : {};
  const dependent: string[] = [];
  for (const [id, row] of after.subscriptions) {
    const orphan = setRefsOf(row.definition).some(
      (ref) => ref.contract === contractId && !Object.hasOwn(sets, ref.set),
    );
    if (orphan) {
      dependent.push(id);
      continue;
    }
    try {
      assertSubscription(row, { reg: after, systemSeed: false });
    } catch (e) {
      const named =
        e instanceof ExecError &&
        (e.message.includes(contractId) ||
          (e.details as { contract?: unknown } | undefined)?.contract === contractId);
      if (named) dependent.push(id);
    }
  }
  if (dependent.length === 0) return;
  throw new ExecError(
    'VALIDATION',
    `наборы контракта ${contractId} читают подписки: ${dependent.join(', ')} — правка оставила бы их без набора`,
    { reason: 'SET_IN_USE', contract: contractId, subscriptions: dependent },
  );
}

/** Реестр резолва имён языка E: разбор Q плюс контракты (слоты и наборы живут только у них). */
function exprNormalizeRegistryOf(reg: RegistrySnapshot): ExprNormalizeRegistry {
  return { ...parseRegistryOfSnapshot(reg), contracts: reg.contracts };
}

/** Снимок владельца со ВСЕМИ его дельтами, кроме названной, — «как читалось бы после правки». */
async function probeSnapshot(
  tx: Tx,
  graphId: GraphId,
  rows: RegistryDictionaries,
  drop?: { targetKind: RegistryDeltaTargetKind; targetId: string },
): Promise<RegistrySnapshot> {
  const versions = await readRegistryVersions(tx, graphId);
  const deltas = await loadRegistryDeltas(tx, graphId);
  return applyDeltas(
    { ...rows, ownerVersion: versions.ownerVersion, systemVersion: versions.systemVersion },
    drop === undefined
      ? deltas
      : deltas.filter((r) => !(r.targetKind === drop.targetKind && r.targetId === drop.targetId)),
  );
}

export async function readContractDelta(
  tx: Tx,
  graphId: GraphId,
  contractId: string,
): Promise<ContractDelta | null> {
  const delta = await readDeltaRow(tx, graphId, 'contract', contractId);
  return delta === undefined ? null : (delta as ContractDelta);
}

export async function setContractDelta(
  tx: Tx,
  graphId: GraphId,
  contractId: string,
  delta: ContractDelta,
): Promise<void> {
  const parsed = contractDeltaSchema.safeParse(delta);
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `дельта контракта ${contractId} не разбирается схемой`, {
      reason: 'DELTA_MALFORMED',
      contract: contractId,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const rows = await loadRegistryRows(tx, graphId);
  if (!rows.contracts.has(contractId)) {
    throw new ExecError('NOT_FOUND', `контракта ${contractId} нет в реестре`, {
      contract: contractId,
    });
  }
  // Дельта наборов — ЗАМЕНА целиком (`DO UPDATE SET delta = EXCLUDED.delta`), поэтому набор,
  // выпавший из нового состава, исчезает так же, как при снятии дельты: проба одна на оба пути.
  await writeDeltaRow(tx, graphId, 'contract', contractId, parsed.data, rows, (probe) => {
    assertSetsFreeOfSubscribers(probe, contractId);
  });
}

export async function removeContractDelta(
  tx: Tx,
  graphId: GraphId,
  contractId: string,
): Promise<void> {
  const rows = await loadRegistryRows(tx, graphId);
  assertSetsFreeOfSubscribers(
    await probeSnapshot(tx, graphId, rows, { targetKind: 'contract', targetId: contractId }),
    contractId,
  );
  await removeDeltaRow(tx, graphId, 'contract', contractId);
}

export async function readSubscriptionDelta(
  tx: Tx,
  graphId: GraphId,
  subscriptionId: string,
): Promise<SubscriptionDelta | null> {
  const delta = await readDeltaRow(tx, graphId, 'subscription', subscriptionId);
  return delta === undefined ? null : (delta as SubscriptionDelta);
}

export async function setSubscriptionDelta(
  tx: Tx,
  graphId: GraphId,
  subscriptionId: string,
  delta: SubscriptionDelta,
): Promise<void> {
  const parsed = subscriptionDeltaSchema.safeParse(delta);
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `дельта подписки ${subscriptionId} не разбирается схемой`, {
      reason: 'DELTA_MALFORMED',
      subscription: subscriptionId,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const rows = await loadRegistryRows(tx, graphId);
  if (!rows.subscriptions.has(subscriptionId)) {
    throw new ExecError('NOT_FOUND', `подписки ${subscriptionId} нет в реестре`, {
      subscription: subscriptionId,
    });
  }
  // ИМЕНА → ИДЕНТИФИКАТОРЫ ДО ЗАПИСИ (§А5-2): резолв идёт по ТОМУ ЖЕ снимку, против которого
  // пойдёт проверка (Ф-Б1-55в, «один вердикт на оба пути»), и нормализованное уезжает и в
  // `assertSubscription`, и в строку дельты — иначе читатель получил бы ключ там, где ждёт id.
  const normalized = {
    definition: normalizeSubscriptionExprs(
      parsed.data.definition,
      exprNormalizeRegistryOf(await probeSnapshot(tx, graphId, rows)),
    ),
  } as SubscriptionDelta;
  await writeDeltaRow(tx, graphId, 'subscription', subscriptionId, normalized, rows, (probe) => {
    // СМЫСЛ ПРОВЕРЯЕТСЯ ЗДЕСЬ, а не в applyDeltas: на записи владелец видит отказ и может его исправить,
    // на чтении — только запертый реестр (Р-И-7).
    const merged = probe.subscriptions.get(subscriptionId);
    if (merged !== undefined) assertSubscription(merged, { reg: probe, systemSeed: false });
  });
}

export async function removeSubscriptionDelta(
  tx: Tx,
  graphId: GraphId,
  subscriptionId: string,
): Promise<void> {
  await removeDeltaRow(tx, graphId, 'subscription', subscriptionId);
}

/**
 * Строка подписки по адресу — СВОЯ, если она есть, иначе системная.
 *
 * Один читатель на оба вопроса, потому что вопрос один: «что сейчас стоит по этому адресу».
 * `ORDER BY graph_id NULLS LAST` — та же дисциплина перекрытия, что у `loadRegistryRows`
 * (`registry/load.ts`), только развёрнутая: там снимок собирается сверху вниз и своя строка
 * ложится ПОСЛЕ системной, здесь нужна одна строка и своя важнее.
 */
export async function readSubscriptionRow(
  tx: Tx,
  graphId: GraphId,
  id: string,
): Promise<SubscriptionRow | null> {
  const rows = (await tx.execute(sql`
    SELECT id, graph_id, surface, definition, module, rank FROM subscription_definitions
     WHERE id = ${id} AND (graph_id IS NULL OR graph_id = ${graphId}::uuid)
     ORDER BY graph_id NULLS LAST LIMIT 1`)) as unknown as RawRow[];
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: r.id as string,
    graphId: (r.graph_id as string | null) ?? null,
    surface: r.surface as string,
    definition: r.definition as SubscriptionDefinition,
    module: (r.module as string | null) ?? null,
    rank: Number(r.rank),
  };
}

/**
 * Своя подписка владельца (§Б5-1). Namespace — тот же гейт и тот же довод, что у свойств
 * (`KEY_NAMESPACE` выше): `orbis/…` завтра посеет релиз, и своя строка МОЛЧА перекрыла бы
 * системную по правилу «своя перекрывает встроенную».
 *
 * Смысл декларации проверяется ЗДЕСЬ, до INSERT'а (Р-И-7): на записи владелец видит отказ и
 * может его исправить, на чтении — только запертый снимок реестра.
 */
export async function setOwnSubscription(
  tx: Tx,
  graphId: GraphId,
  row: SubscriptionRow,
): Promise<void> {
  if (!row.id.startsWith('user/')) {
    throw new ExecError(
      'VALIDATION',
      `свои подписки живут в namespace user/ — «${row.id}» занимает чужой (§Б5-1)`,
      { reason: 'SUBSCRIPTION_NAMESPACE', subscription: row.id },
    );
  }
  // СНИМОК С ДЕЛЬТАМИ, а не сырые строки (Ф-Б1-55в): своя подписка вправе ссылаться на СВОЙ
  // набор контракта — он живёт дельтой, и без неё та же декларация, что законна у
  // `setSubscriptionDelta`, здесь получала бы `EXPR_TYPE`. Один вердикт на оба пути записи.
  const rows = await loadRegistryRows(tx, graphId);
  const probe = await probeSnapshot(tx, graphId, rows);
  // Тот же резолв имён, что у дельты: правило адреса одно на оба писателя языка E.
  const definition = normalizeSubscriptionExprs(row.definition, exprNormalizeRegistryOf(probe));
  assertSubscription({ ...row, graphId, definition }, { reg: probe, systemSeed: false });
  await tx.execute(sql`
    INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
    VALUES (${row.id}, ${graphId}::uuid, ${row.surface},
            ${JSON.stringify(definition)}::jsonb, ${row.module}, ${row.rank})
    ON CONFLICT (graph_id, id) WHERE graph_id IS NOT NULL
      DO UPDATE SET surface = EXCLUDED.surface, definition = EXCLUDED.definition,
                    module = EXCLUDED.module, rank = EXCLUDED.rank`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

/** Снятие своей подписки: системные строки не трогаются (`graph_id IS NOT NULL`). */
export async function removeOwnSubscription(tx: Tx, graphId: GraphId, id: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM subscription_definitions WHERE graph_id = ${graphId}::uuid AND id = ${id}`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

// ---------------------------------------------------------------------------
// Правила каталога владельца (§Б4-1, §С3 строка «Правило», В-6, Р-2, Р-2а)
// ---------------------------------------------------------------------------

/**
 * Правила СВОЕЙ строки и её id; `null` — своей строки по адресу нет, значит цель встроенная. Адрес —
 * id ИЛИ key: у своего свойства это разные строки (Р3), и перекрыть одно другим у владельца нечем
 * (оба уникальны среди его строк, а key без слэша не бывает).
 */
async function readOwnRules(
  tx: Tx,
  graphId: GraphId,
  t: RuleCarrier,
): Promise<{ id: string; rules: RuleDefinition[] } | null> {
  const rows = (await tx.execute(sql`SELECT id, rules FROM ${RULE_TABLE[t.kind]}
     WHERE graph_id = ${graphId}::uuid AND (id = ${t.id} OR key = ${t.id})`)) as unknown as RawRow[];
  const row = rows[0];
  return row === undefined
    ? null
    : { id: row.id as string, rules: (row.rules ?? []) as RuleDefinition[] };
}

/**
 * Строка словаря по id ИЛИ key; своя перекрывает встроенную. Обобщение `resolvePropertyRef`
 * (`executor/props.ts`) на аспекты, роли и контракты: адрес правила владелец и модель называют тем
 * именем, которым видели строку (Р3), и правило резолва обязано быть ОДНО — второй экземпляр разошёлся
 * бы с ним на первой же коллизии key.
 */
function byIdOrKey<T extends { id: string; key: string; graphId: string | null }>(
  dict: ReadonlyMap<string, T>,
  address: string,
): T | undefined {
  let byKey: T | undefined;
  for (const def of dict.values()) {
    if (def.key !== address) continue;
    if (byKey === undefined || (byKey.graphId === null && def.graphId !== null)) byKey = def;
  }
  return byKey ?? dict.get(address);
}

/**
 * Копия снимка с подменённым списком правил носителя — «как читалось бы после правки» (вход `assertRule`:
 * конфликт и цикл видны только на ПОЛНОМ списке строки, не на одном правиле). Снимок не мутируется.
 * Элементы могут быть СЫРЫМИ (вход тула): форму называет `assertRule`, а читатели снимка (`rulesOf`)
 * разбирают мягко.
 */
function withCarrierRules(
  reg: RegistrySnapshot,
  t: RuleCarrier,
  rules: readonly unknown[],
): RegistrySnapshot {
  const next = rules as RuleDefinition[];
  if (t.kind === 'aspect') {
    const def = byIdOrKey(reg.aspects, t.id);
    if (def === undefined)
      throw new ExecError('NOT_FOUND', `аспекта ${t.id} нет в реестре`, { target: t });
    return { ...reg, aspects: new Map(reg.aspects).set(def.id, { ...def, rules: next }) };
  }
  if (t.kind === 'property') {
    const def = resolvePropertyRef(reg, t.id);
    if (def === undefined)
      throw new ExecError('NOT_FOUND', `свойства ${t.id} нет в реестре`, { target: t });
    return { ...reg, properties: new Map(reg.properties).set(def.id, { ...def, rules: next }) };
  }
  const def = byIdOrKey(reg.roles, t.id);
  if (def === undefined)
    throw new ExecError('NOT_FOUND', `роли ${t.id} нет в реестре`, { target: t });
  return { ...reg, roles: new Map(reg.roles).set(def.id, { ...def, rules: next }) };
}

/**
 * АДРЕСА СВОЙСТВ В ПРАВИЛЕ — ОДИН ОБХОД НА ТРИ ВОПРОСА: «что правило называет» (перечень держателей,
 * `propertyNamesInRule`), «переписать при слиянии» (`rewriteRuleAddresses`) и «привести к id на записи»
 * (`normalizeRule`). Три обхода разъехались бы — ровно так уже случилось с дельтой, которую видел граф
 * и не видело слияние.
 *
 * Обход по ФОРМЕ шаблонов, а не рекурсией по ключу `prop`: адреса параметров лежат ГОЛЫМИ строками
 * (`params.property`, `params.set.property`, `params.enter.property`, `params.properties[]`,
 * `params.on_leave.unset[]`, область `scope.property`), и рекурсия прошла бы мимо них, а выражения
 * (`when`, `params.value`, `params.set.value`) — наоборот, только деревом. Формы шаблонов-носителей
 * (`targets`, `trigger_properties`, `inherit`, КЛЮЧИ `own`) читаются ЗДЕСЬ ЖЕ: каталог пускает их и на
 * свой аспект владельца, а держатель, не видящий адреса, который каталог адресует, — ровно та молчаливая
 * дыра слияния, от которой заведён весь перечень. Вход бывает СЫРЫМ (jsonb реестра, вход тула), поэтому
 * каждое место читается защитно — формы тут никто не обещал.
 */
function mapRuleAddresses(
  rule: RuleDefinition,
  addr: (address: string) => string,
  expr: (value: unknown) => unknown,
): RuleDefinition {
  const one = (v: unknown): unknown => (typeof v === 'string' ? addr(v) : v);
  const list = (v: unknown): unknown => (Array.isArray(v) ? v.map(one) : v);
  const obj = (v: unknown, fn: (o: Record<string, unknown>) => unknown): unknown =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? fn(v as Record<string, unknown>) : v;
  const raw = rule as unknown as Record<string, unknown>;
  const p = { ...((raw.params ?? {}) as Record<string, unknown>) };
  if ('property' in p) p.property = one(p.property);
  if ('properties' in p) p.properties = list(p.properties);
  if ('value' in p) p.value = expr(p.value);
  if ('trigger_properties' in p) p.trigger_properties = list(p.trigger_properties);
  if ('set' in p) {
    p.set = obj(p.set, (x) => ({
      ...x,
      ...('property' in x && { property: one(x.property) }),
      ...('value' in x && { value: expr(x.value) }),
    }));
  }
  if ('enter' in p) {
    p.enter = obj(p.enter, (x) => ({
      ...x,
      ...('property' in x && { property: one(x.property) }),
    }));
  }
  if ('on_leave' in p) {
    p.on_leave = obj(p.on_leave, (x) => ({ ...x, ...('unset' in x && { unset: list(x.unset) }) }));
  }
  if ('targets' in p) {
    p.targets = obj(p.targets, (x) => ({
      ...x,
      ...('parent' in x && { parent: one(x.parent) }),
      ...('root' in x && { root: one(x.root) }),
    }));
  }
  if ('inherit' in p) {
    p.inherit = obj(p.inherit, (m) =>
      Object.fromEntries(Object.entries(m).map(([aspectId, ids]) => [aspectId, list(ids)])),
    );
  }
  // Ключи карты `own` — адреса свойств. СТОЛКНОВЕНИЕ (после переименования два ключа сошлись в один)
  // разрешается в пользу ключа, который УЖЕ был целью, — правило `renameKeys` у `rewriteDelta`: запись
  // цели относится к тому, что живёт.
  if ('own' in p) {
    p.own = obj(p.own, (m) => {
      const next: Record<string, unknown> = {};
      for (const [id, v] of Object.entries(m)) if (addr(id) === id) next[id] = v;
      for (const [id, v] of Object.entries(m)) {
        const to = addr(id);
        if (to !== id && next[to] === undefined) next[to] = v;
      }
      return next;
    });
  }
  const scope = obj(raw.scope, (x) => ('property' in x ? { ...x, property: one(x.property) } : x));
  return {
    ...raw,
    ...('when' in raw && raw.when !== undefined && { when: expr(raw.when) }),
    ...(raw.scope !== undefined && { scope }),
    params: p,
  } as unknown as RuleDefinition;
}

/** Имена свойств, названные ПРАВИЛОМ (шестой род держателя и адреса правил в дельте) — см. обход выше. */
function propertyNamesInRule(rule: unknown, out: Set<string>): void {
  if (typeof rule !== 'object' || rule === null) return;
  mapRuleAddresses(
    rule as RuleDefinition,
    (a) => {
      out.add(a);
      return a;
    },
    (e) => {
      for (const name of propertyNamesInExpr(e)) out.add(name);
      return e;
    },
  );
}

/**
 * Переписать имя свойства в правиле — РОВНО по тем местам, что читает `propertyNamesInRule` (один
 * обход): разъехавшись, эти двое дали бы держателя, найденного и не переписанного, то есть правило,
 * указывающее на поглощённое свойство навсегда. Выражения переписывает `rewriteAst` (ключи
 * `prop`/`has`/`field` и член `$touched`, Ф-Б2-26); цель — ИДЕНТИФИКАТОР (§А5-7: «в дереве лежат id»),
 * потому что правило хранит канон, а движок ищет свойство по id.
 */
export function rewriteRuleAddresses(
  rule: RuleDefinition,
  from: ReadonlySet<string>,
  to: string,
): RuleDefinition {
  return mapRuleAddresses(
    rule,
    (a) => (from.has(a) ? to : a),
    (e) => rewriteAst(e, from, to),
  );
}

/**
 * ИМЕНА → ИДЕНТИФИКАТОРЫ ДО ЗАПИСИ (§А5-2): модели и владельцу поверхности говорят KEY
 * (`property_catalog`), а у своего свойства id — uuid (Р3), и без резолва первое же своё свойство в
 * правиле получало бы «нет такого свойства». Тот же обход, что у слияния, плюс `normalizeExpr` для
 * выражений (роли `has_relation`, контракты `class`, база и чтение `deref`) и адрес области. Неизвестное
 * имя остаётся как есть — отказ называет валидатор (довод `normalizeExpr`). Нормализуется только
 * РАЗОБРАННОЕ правило: сырой вход с испорченным деревом уронил бы обход `TypeError`'ом, а форму
 * называет `assertRule`.
 */
function normalizeRuleInput(raw: unknown, reg: RegistrySnapshot): unknown {
  const parsed = ruleDefinitionSchema.safeParse(raw);
  if (!parsed.success) return raw;
  const exprReg = exprNormalizeRegistryOf(reg);
  const rule = mapRuleAddresses(
    parsed.data,
    (a) => resolvePropertyRef(reg, a)?.id ?? a,
    (e) => normalizeExpr(e as ExprNode, exprReg),
  );
  const s = rule.scope;
  if (s === undefined || 'property' in s) return rule;
  const scope =
    'aspect' in s
      ? { aspect: byIdOrKey(reg.aspects, s.aspect)?.id ?? s.aspect }
      : 'role' in s
        ? { role: byIdOrKey(reg.roles, s.role)?.id ?? s.role }
        : { contract: byIdOrKey(reg.contracts, s.contract)?.id ?? s.contract };
  return { ...rule, scope };
}

/** Разобранное правило ЛИБО отказ валидатора: zod-ошибка без перевода уехала бы пятисоткой. */
function parsedRuleOrRefusal(
  raw: unknown,
  reg: RegistrySnapshot,
  carrier: RuleCarrier,
): RuleDefinition {
  const r = ruleDefinitionSchema.safeParse(raw);
  // Неразобравшееся называет валидатор: строка в E-позиции — `SECOND_LANGUAGE`, прочее — `RULE_MALFORMED`.
  return r.success ? r.data : assertRule(raw, { reg, carrier, systemSeed: false });
}

/**
 * ЗАВИСИМОСТИ ВКЛЮЧЁННОСТИ СИСТЕМНЫХ ПРАВИЛ (Fable M-2 задачи 14): правило из `BUILTIN_RULE_REQUIRES`
 * включённым без своих опор быть не может — пара «чего ждём» иначе ломает ответ на чекпойнт агент-лупа
 * (уход из ожидания без снятия вопроса → `INVARIANT`). Мерка — сдвиг (довод `assertEngineCarriersKept`):
 * отказ получает запись, которая пару РАЗРЫВАЕТ, а не та, что застала её разорванной.
 */
function assertRulePairsKept(before: RegistrySnapshot, after: RegistrySnapshot): void {
  const enabledIn = (reg: RegistrySnapshot) =>
    new Set(
      rulesOf(reg)
        .filter((r) => r.rule.enabled)
        .map((r) => r.rule.id),
    );
  const was = enabledIn(before);
  const now = enabledIn(after);
  for (const [rule, needs] of Object.entries(BUILTIN_RULE_REQUIRES)) {
    const missing = needs.filter((n) => !now.has(n));
    if (!now.has(rule) || missing.length === 0) continue;
    if (was.has(rule) && needs.some((n) => !was.has(n))) continue;
    throw new ExecError(
      'VALIDATION',
      `правило «${rule}» держится на «${missing.join('», «')}»: без него запрет оставил бы запись, которую нельзя вывести из состояния, — сперва отключите «${rule}» (включать — в обратном порядке)`,
      { reason: 'RULE_PAIR_REQUIRED', rule, requires: missing },
    );
  }
}

/** Ключ пары-конфликта правил без порядка обхода: «a × b на событии». */
function conflictKeysOf(
  reg: RegistrySnapshot,
): Map<string, { a: string; b: string; event: string; property: string }> {
  const out = new Map<string, { a: string; b: string; event: string; property: string }>();
  for (const c of ruleConflictsOf(rulesOf(reg).map((r) => r.rule))) {
    const [x, y] = [c.a, c.b].sort();
    out.set(`${x}|${y}|${c.event}`, c);
  }
  return out;
}

/**
 * НОВЫЕ КОНФЛИКТЫ ПИСАТЕЛЕЙ — ПРИРОСТ, а не наличие (гейт 16 I-2). `assertRule` спрашивает конфликт только
 * у правила, которое пишется; а запись бывает и ВКЛЮЧЕНИЕМ: снятое отключение системного правила
 * (`aspect_delta_set` с пустым `rulesDisabled`, снятие строки дельты) оживляет писателя, спорящего с правилом
 * владельца на ДРУГОМ носителе, — и ни один валидатор отдельного правила этого не видит. Мерка — прирост:
 * конфликт, уже живший в снимке «до» (пересев, порча руками), не вина этой записи и выхода из него не
 * закрывает — снять участника всегда можно.
 */
function assertNoNewConflicts(before: RegistrySnapshot, after: RegistrySnapshot): void {
  const was = conflictKeysOf(before);
  for (const [key, c] of conflictKeysOf(after)) {
    if (was.has(key)) continue;
    throw new ExecError(
      'RULE_CONFLICT',
      `правила «${c.a}» и «${c.b}» пишут ${c.property} на одном событии — приоритета между ними нет; ` +
        `правка оживила бы второго писателя`,
      { rule: c.b, other: c.a, event: c.event, property: c.property },
    );
  }
}

/**
 * ИНВАРИАНТЫ СНИМКА ПОСЛЕ ПРАВКИ ПРАВИЛ — общие для всех писателей правил владельца: круг
 * «свойство → правило → свойство» (свойство ВСЕГО графа, `REGISTRY_CYCLE` — врезка Р-3), прирост
 * конфликтов писателей (включение тоже запись), строки-носители движков (эррата Ф-Б2-24) и пары
 * включённости (Fable M-2 задачи 14).
 */
function assertRuleInvariants(before: RegistrySnapshot, after: RegistrySnapshot): void {
  assertAcyclicGraph(dependencyGraph(after, { queryRefs: new Map() }));
  assertNoNewConflicts(before, after);
  assertEngineCarriersKept(before, after);
  assertRulePairsKept(before, after);
}

/**
 * ПРАВИЛА В ДЕЛЬТЕ НОСИТЕЛЯ — проверка на записи (Р-И-7: `applyDeltas` правило принимает молча, и
 * неверное запирало бы записи владельца на КАЖДОЙ мутации, а не на этой). Полный вердикт (инварианты
 * снимка) — только когда эффективный список носителя сменился: правка иконки аспекта не обязана
 * перепроверять правила, принятые раньше (устаревшее правило назовёт следующая правка самих правил).
 * НОВОЕ правило дельты (его не было в прежней дельте, `prevRules`) валидатором проходит ВСЕГДА — и тогда,
 * когда та же запись его выключает (гейт 16 m-4): выключенное сейчас включат потом, и принятым раньше оно
 * не было никогда.
 *
 * Своё правило с id СИСТЕМНОГО — отказ `RULE_SYSTEM_IMMUTABLE`: вместе с отключением системного оно
 * было бы правкой системного правила мимо запрета §Б4-4. Отключение id, которого у носителя нет, —
 * `NOT_FOUND`: молчаливый успех оставил бы владельца с «отключил, а оно работает» (опечатка в id).
 */
function assertDeltaRulesWrite(
  before: RegistrySnapshot,
  after: RegistrySnapshot,
  carrier: RuleCarrier,
  delta: { rules?: RuleDefinition[]; rulesDisabled?: string[] },
  systemRules: readonly RuleDefinition[],
  prevRules: readonly RuleDefinition[] = [],
): void {
  const system = new Set(systemRules.map((r) => r.id));
  const own = delta.rules ?? [];
  const known = new Set(prevRules.map((r) => canonicalJson(r)));
  const fresh = own.filter((r) => !known.has(canonicalJson(r)));
  // Отключение неизвестного id эффективного списка НЕ меняет — поэтому проверяется ДО выхода по
  // «список тот же», иначе опечатка проходила бы молча.
  for (const id of delta.rulesDisabled ?? []) {
    if (!system.has(id) && !own.some((r) => r.id === id)) {
      throw new ExecError('NOT_FOUND', `правила «${id}» на ${carrier.id} нет — отключать нечего`, {
        target: carrier,
        rule: id,
      });
    }
  }
  const refuseSystemId = (rule: RuleDefinition) => {
    if (!system.has(rule.id)) return;
    throw new ExecError(
      'VALIDATION',
      `системное правило «${rule.id}» правится только релизом — его можно отключить (§Б4-4)`,
      { reason: 'RULE_SYSTEM_IMMUTABLE', rule: rule.id },
    );
  };
  for (const rule of fresh) {
    refuseSystemId(rule);
    assertRule(rule, { reg: after, carrier, systemSeed: false });
  }
  const rulesAt = (r: RegistrySnapshot) =>
    (carrier.kind === 'aspect' ? r.aspects : r.properties).get(carrier.id)?.rules ?? [];
  if (canonicalJson(rulesAt(before)) === canonicalJson(rulesAt(after))) return;
  for (const rule of own) {
    if (fresh.includes(rule)) continue;
    refuseSystemId(rule);
    assertRule(rule, { reg: after, carrier, systemSeed: false });
  }
  assertRuleInvariants(before, after);
}

/**
 * UPDATE колонки `rules` своей строки и версия — ОДНОЙ транзакцией (§А10-1, инвариант кеша
 * `registry/cache.ts`): иначе процесс на той же базе продолжил бы отдавать снимок без правила.
 */
async function writeOwnRules(
  tx: Tx,
  graphId: GraphId,
  t: RuleCarrier,
  rules: RuleDefinition[],
): Promise<void> {
  await tx.execute(sql`UPDATE ${RULE_TABLE[t.kind]} SET rules = ${JSON.stringify(rules)}::jsonb
     WHERE graph_id = ${graphId}::uuid AND id = ${t.id}`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

/**
 * Правило на СВОЕЙ строке (§Б4-1): UPDATE колонки `rules` заменой по id (§С3 «правит заменой»). Смысл
 * проверяется ДО записи (Р-И-7): на записи владелец видит отказ, на чтении — запертый реестр. Порядок —
 * образца `setOwnSubscription`: снимок-проба С ДЕЛЬТАМИ → нормализация адресов → валидатор → инварианты
 * снимка → запись → версия.
 */
export async function setOwnRule(
  tx: Tx,
  graphId: GraphId,
  target: RuleCarrier,
  rule: RuleDefinitionInput,
): Promise<{ carrier: RuleCarrier; rule: RuleDefinition }> {
  const own = await readOwnRules(tx, graphId, target);
  if (own === null) throw new ExecError('NOT_FOUND', `своей строки ${target.id} нет`, { target });
  const carrier: RuleCarrier = { kind: target.kind, id: own.id };
  const before = await probeSnapshot(tx, graphId, await loadRegistryRows(tx, graphId));
  const candidate = normalizeRuleInput(rule, before);
  const id = (candidate as { id?: unknown }).id;
  const rest = own.rules.filter((r) => r.id !== id);
  const after = withCarrierRules(before, carrier, [...rest, candidate]);
  const parsed = assertRule(candidate, { carrier, systemSeed: false, reg: after });
  assertRuleInvariants(before, after);
  await writeOwnRules(tx, graphId, carrier, [...rest, parsed]);
  return { carrier, rule: parsed };
}

/**
 * Снятие своего правила: тот же `writeOwnRules` со списком БЕЗ него. Возвращает снятое — им наполняется
 * inverse журнала (§С3 «правит заменой» ⇒ обратное к снятию это возврат ТОЙ ЖЕ декларации).
 */
export async function removeOwnRule(
  tx: Tx,
  graphId: GraphId,
  target: RuleCarrier,
  ruleId: string,
): Promise<RuleDefinition | null> {
  const own = await readOwnRules(tx, graphId, target);
  if (own === null) throw new ExecError('NOT_FOUND', `своей строки ${target.id} нет`, { target });
  const gone = own.rules.find((r) => r.id === ruleId);
  // ПРАВИЛА С ТАКИМ id НЕ БЫЛО — УСПЕХ БЕЗ ЗАПИСИ, а не отказ (Ф-Б1-56, прецедент
  // `prepareSubscriptionRemove`): состояние на выходе у обоих исходов одно («правила нет»), а владельцу,
  // сказавшему «убери», отказ «а его и не было» ничего не сообщает. `null` наверх означает пустой
  // inverse — откат такого action'а не-операция, а не воскрешение из ничего.
  if (gone === undefined) return null;
  const carrier: RuleCarrier = { kind: target.kind, id: own.id };
  const kept = own.rules.filter((r) => r.id !== ruleId);
  const before = await probeSnapshot(tx, graphId, await loadRegistryRows(tx, graphId));
  assertRuleInvariants(before, withCarrierRules(before, carrier, kept));
  await writeOwnRules(tx, graphId, carrier, kept);
  return gone;
}

/** Своя строка правит правила колонкой, а не дельтой (Ф-Б2-30) — один отказ на оба писателя дельты правил. */
function refuseOwnRowDelta(row: { graphId: string | null }, target: RuleCarrier): void {
  if (row.graphId === null) return;
  throw new ExecError(
    'VALIDATION',
    `${target.id} — ваша строка: её правила правятся колонкой (setOwnRule), а не дельтой`,
    { reason: 'RULE_DELTA_OWN_ROW', target },
  );
}

/** Носитель, у которого есть дельта: роль её не имеет (Р-2), и тип это выражает, а не проверка. */
export type DeltaRuleCarrier = { kind: 'aspect' | 'property'; id: string };

/** Отказ на встроенной роли — один текст на оба писателя дельты правил. */
function refuseSystemRole(target: RuleCarrier): never {
  throw new ExecError('VALIDATION', 'правила на встроенных ролях правит только сид (§Б4-1)', {
    reason: 'RULE_TARGET_SYSTEM_ROLE',
    role: target.id,
  });
}

/** Дельта правил без пустых полей: пустой `rulesDisabled` — отсутствие настройки, а не настройка. */
function compactRuleDelta<T extends { rules?: RuleDefinition[]; rulesDisabled?: string[] }>(
  d: T,
): T {
  const { rules, rulesDisabled, ...rest } = d;
  return {
    ...rest,
    ...(rules !== undefined && rules.length > 0 && { rules }),
    ...(rulesDisabled !== undefined && rulesDisabled.length > 0 && { rulesDisabled }),
  } as T;
}

/**
 * Правило владельца поверх ВСТРОЕННОЙ строки — дельтой (В-6, Р-2). Роли исключены: схемы дельты роли нет
 * (`DELTA_SCHEMA.relation_role = null`), и молчать нельзя — владелец увидел бы «не применилось» без причины.
 * Правило с id СИСТЕМНОГО правила носителя означает «ВКЛЮЧИТЬ ОБРАТНО» (§Б4-4: системное владелец не правит,
 * только отключает) и принимается лишь при совпадении декларации; иначе — `RULE_SYSTEM_IMMUTABLE`. Это же
 * обратная операция к `rule_remove` системного правила: без неё «отключить» было бы необратимо (§С3).
 * Своё правило, записанное заново, снимает и своё отключение (его кладёт пересев, `mergeRules`): «завести
 * заново» значит «пусть работает», и конфликт с системным назовёт валидатор.
 */
export async function setRuleDelta(
  tx: Tx,
  graphId: GraphId,
  target: RuleCarrier,
  rule: RuleDefinitionInput,
): Promise<void> {
  if (target.kind === 'role') refuseSystemRole(target);
  const carrier: DeltaRuleCarrier = { kind: target.kind, id: target.id };
  const rows = await loadRegistryRows(tx, graphId);
  const row = (target.kind === 'aspect' ? rows.aspects : rows.properties).get(target.id);
  if (row === undefined) {
    throw new ExecError('NOT_FOUND', `строки ${target.id} нет в реестре`, { target });
  }
  refuseOwnRowDelta(row, target);
  const base = row.rules;
  const prev = ((await readDeltaRow(tx, graphId, carrier.kind, carrier.id)) ?? {}) as {
    rules?: RuleDefinition[];
    rulesDisabled?: string[];
  };
  const before = await probeSnapshot(tx, graphId, rows);
  const parsed = parsedRuleOrRefusal(normalizeRuleInput(rule, before), before, target);
  const system = base.find((r) => r.id === parsed.id);
  if (system !== undefined && canonicalJson(parsed) !== canonicalJson(system)) {
    throw new ExecError(
      'VALIDATION',
      `системное правило «${system.id}» правится только релизом — его можно отключить (§Б4-4)`,
      { reason: 'RULE_SYSTEM_IMMUTABLE', rule: system.id },
    );
  }
  // Проверка САМОГО правила — до записи дельты и с теми же кодами, что у своей строки (`RULE_*`):
  // запись дельты аспекта сперва нормализует адреса и назвала бы опечатку в свойстве правила отказом
  // ДЕЛЬТЫ. Полный вердикт (инварианты, чужие правила носителя) — у `writeRuleDelta` ниже.
  const current = (target.kind === 'aspect' ? before.aspects : before.properties).get(target.id);
  assertRule(parsed, {
    carrier: target,
    systemSeed: false,
    reg: withCarrierRules(before, target, [
      ...(current?.rules ?? []).filter((r) => r.id !== parsed.id),
      parsed,
    ]),
  });
  const disabled = (prev.rulesDisabled ?? []).filter((id) => id !== parsed.id);
  const next =
    system !== undefined
      ? { ...prev, rulesDisabled: disabled }
      : {
          ...prev,
          rules: [...(prev.rules ?? []).filter((r) => r.id !== parsed.id), parsed],
          rulesDisabled: disabled,
        };
  await writeRuleDelta(tx, graphId, carrier, compactRuleDelta(next), rows);
}

/**
 * «Отключить» (§С3, Р-2а): СВОЁ правило дельты снимается из `rules`, СИСТЕМНОЕ уходит в `rulesDisabled`.
 * Два признака одного состояния не заводятся: строка своего правила — это сама дельта, и «отключить» её
 * значило бы хранить выключенное дважды. Правила с таким id на носителе нет вовсе — `NOT_FOUND`: молчаливый
 * успех оставил бы владельца с «отключил, а оно работает».
 */
export async function disableSystemRuleDelta(
  tx: Tx,
  graphId: GraphId,
  target: RuleCarrier,
  ruleId: string,
): Promise<void> {
  if (target.kind === 'role') refuseSystemRole(target);
  const carrier: DeltaRuleCarrier = { kind: target.kind, id: target.id };
  const rows = await loadRegistryRows(tx, graphId);
  const row = (target.kind === 'aspect' ? rows.aspects : rows.properties).get(target.id);
  if (row === undefined) {
    throw new ExecError('NOT_FOUND', `строки ${target.id} нет в реестре`, { target });
  }
  refuseOwnRowDelta(row, target);
  const base = row.rules;
  const prev = ((await readDeltaRow(tx, graphId, carrier.kind, carrier.id)) ?? {}) as {
    rules?: RuleDefinition[];
    rulesDisabled?: string[];
  };
  if ((prev.rules ?? []).some((r) => r.id === ruleId)) {
    await writeRuleDelta(
      tx,
      graphId,
      carrier,
      compactRuleDelta({
        ...prev,
        rules: (prev.rules ?? []).filter((r) => r.id !== ruleId),
        rulesDisabled: (prev.rulesDisabled ?? []).filter((id) => id !== ruleId),
      }),
      rows,
    );
    return;
  }
  if (!base.some((r) => r.id === ruleId)) {
    throw new ExecError('NOT_FOUND', `правила «${ruleId}» на ${target.id} нет`, {
      target,
      rule: ruleId,
    });
  }
  await writeRuleDelta(
    tx,
    graphId,
    carrier,
    { ...prev, rulesDisabled: [...new Set([...(prev.rulesDisabled ?? []), ruleId])] },
    rows,
  );
}

/**
 * Запись дельты правил, общая для двух родов. У АСПЕКТА — через `setAspectDelta`: там уже стоят
 * нормализация адресов свойств, `checkClassMap`, проба применимости и проверка правил дельты
 * (`assertDeltaRulesWrite`), и второй писатель дельты аспекта разошёлся бы с ней на первой же новой
 * проверке. У СВОЙСТВА писателя не было вовсе — `writeDeltaRow` («безусловность держит уже не их, а
 * ЧЕТВЁРТЫЙ род») с той же проверкой правил в `check`.
 */
async function writeRuleDelta(
  tx: Tx,
  graphId: GraphId,
  target: DeltaRuleCarrier,
  delta: { rules?: RuleDefinition[]; rulesDisabled?: string[] },
  rows: RegistryDictionaries,
): Promise<void> {
  // ПУСТАЯ дельта правил = ОТСУТСТВИЕ настройки, и строка снимается: пустышка висела бы со своим
  // `base_version`, а пересев сливал бы её вхолостую и двигал версию владельца на каждом деплое.
  // Только когда в дельте НЕТ ничего кроме правил: у аспекта та же строка несёт состав, иконку и варианты.
  // Снятие возвращает носитель к СИСТЕМНОМУ списку — он согласован сам с собой (`assertBuiltinRules`,
  // тест `rules.test.ts`), но НЕ с правилами владельца на других носителях: включённое обратно системное
  // правило может спорить с ними (гейт 16 I-2). Поэтому и снятие проходит инварианты снимка.
  if (
    Object.keys(delta).every((k) => k === 'rules' || k === 'rulesDisabled') &&
    (delta.rules ?? []).length === 0 &&
    (delta.rulesDisabled ?? []).length === 0
  ) {
    assertRuleInvariants(
      await probeSnapshot(tx, graphId, rows),
      await probeSnapshot(tx, graphId, rows, { targetKind: target.kind, targetId: target.id }),
    );
    await removeDeltaRow(tx, graphId, target.kind, target.id);
    return;
  }
  if (target.kind === 'aspect') {
    await setAspectDelta(tx, graphId, target.id, delta as AspectDelta);
    return;
  }
  const before = await probeSnapshot(tx, graphId, rows);
  const systemRules = rows.properties.get(target.id)?.rules ?? [];
  const prev = (await readDeltaRow(tx, graphId, 'property', target.id)) as
    | PropertyDelta
    | undefined;
  await writeDeltaRow(tx, graphId, 'property', target.id, delta as PropertyDelta, rows, (probe) =>
    assertDeltaRulesWrite(
      before,
      probe,
      target,
      delta,
      systemRules,
      Array.isArray(prev?.rules) ? prev.rules : [],
    ),
  );
}

/**
 * Сырая строка дельты носителя-встроенной строки — вход обратной операции `rule_set`/`rule_remove` (фикс-раунд 2
 * задачи 16, N-1): КАК ЛЕЖИТ, со своими правилами, выключенными пересевом (`rulesDisabled`). Эффективный список
 * их не содержит, и откат по нему снимал бы декларацию вместо того, чтобы вернуть её выключенной.
 */
export async function readRuleDelta(
  tx: Tx,
  graphId: GraphId,
  carrier: DeltaRuleCarrier,
): Promise<Record<string, unknown> | null> {
  const delta = await readDeltaRow(tx, graphId, carrier.kind, carrier.id);
  return delta === undefined || delta === null ? null : (delta as Record<string, unknown>);
}

/**
 * Записи ОДНОГО правила — к прежним, прочие записи списка — как лежат сейчас (N3-1 фикс-раунда 4). Место
 * прежней записи сохраняется (индекс в прежнем списке, не дальше конца): возврат, повторяющий прежнюю
 * строку, повторяет её и порядком — иначе сверка свежести единиц (`expected_delta`, `canonicalJson`) и
 * выход «список тот же» в `assertDeltaRulesWrite` видели бы правку там, где её нет.
 */
function restoreEntriesOf<T>(
  current: readonly T[],
  prev: readonly T[],
  mine: (x: T) => boolean,
): T[] {
  const rest = current.filter((x) => !mine(x));
  const at = prev.findIndex(mine);
  if (at < 0) return rest;
  return [...rest.slice(0, at), ...prev.filter(mine), ...rest.slice(at)];
}

/**
 * ВОЗВРАТ ОДНОГО ПРАВИЛА ДЕЛЬТЫ К ПРЕЖНЕМУ — внутренняя обратная операция `rule_delta_restore` (N-1 фикс-раунда 2,
 * N2-1 фикс-раунда 3, N3-1 фикс-раунда 4). Каждая прямая операция правил трогает записи ОДНОГО id
 * (`setRuleDelta`, `disableSystemRuleDelta`), и откат возвращает ровно их: своё правило с этим id в `rules`
 * (прежняя декларация — на прежнее место; не было — снимается) и этот id в `rulesDisabled` (было отключено —
 * снова отключено; не было — снято). Всё остальное — поверх ТЕКУЩЕЙ строки: прочие правила и отключения
 * носителя, подпись, иконка, состав, варианты и `classMap` остаются как лежат сейчас. Точечный откат одного
 * жеста (`ai.undo` по id, откат прогона рутины) не вправе стереть поздний другой: ни настройку аспекта
 * (Ф-Б2-27 (г), Ф-Б2-29 — например, иконку, поставленную после отключения правила), ни правку ДРУГОГО
 * правила того же носителя. `prev` — прежняя строка как лежала (`readRuleDelta`): из неё берутся только
 * записи `ruleId` и их место. Строка, где после возврата не осталось ничего, снимается. Пишет тем же
 * `writeRuleDelta`, что и прямые операции: у аспекта — через `setAspectDelta` (проверки дельты и правил), у
 * свойства — `writeDeltaRow` с проверкой правил, пусто — снятие строки с инвариантами снимка. Откат,
 * возвращающий конфликт или цикл (мир сдвинулся после записи), получает громкий отказ, а не нечитаемый реестр.
 */
export async function restoreRuleDelta(
  tx: Tx,
  graphId: GraphId,
  target: DeltaRuleCarrier,
  ruleId: string,
  prev: Record<string, unknown> | null,
): Promise<void> {
  const rows = await loadRegistryRows(tx, graphId);
  // Защита в глубину: обратную операцию пишут только для встроенной строки, но проверка — одна строка.
  const row = (target.kind === 'aspect' ? rows.aspects : rows.properties).get(target.id);
  if (row === undefined) {
    throw new ExecError('NOT_FOUND', `строки ${target.id} нет в реестре`, { target });
  }
  refuseOwnRowDelta(row, target);
  const current = ((await readDeltaRow(tx, graphId, target.kind, target.id)) ?? {}) as {
    rules?: RuleDefinition[];
    rulesDisabled?: string[];
  };
  const back = (prev ?? {}) as { rules?: RuleDefinition[]; rulesDisabled?: string[] };
  await writeRuleDelta(
    tx,
    graphId,
    target,
    compactRuleDelta({
      ...current,
      rules: restoreEntriesOf(current.rules ?? [], back.rules ?? [], (r) => r.id === ruleId),
      rulesDisabled: restoreEntriesOf(
        current.rulesDisabled ?? [],
        back.rulesDisabled ?? [],
        (id) => id === ruleId,
      ),
    }),
    rows,
  );
}

/** Адрес цели правила во входе тула — ровно одна из трёх форм (`ruleTargetSchema`). */
export type RuleTargetAddress = { aspect: string } | { property: string } | { role: string };

/**
 * Цель правила по адресу — СВЕЖИМ снимком этой транзакции (`currentRegistry`), а не снимком исполнителя:
 * тот снят до стадий, и свой аспект, заведённый предыдущей операцией пачки, в нём отсутствует. Ответ —
 * носитель с КАНОНИЧЕСКИМ id, признак «своя строка» (ветка своя строка ∨ дельта встроенной ∨ отказ на
 * встроенной роли, Р-21) и эффективные правила носителя (прежняя декларация для inverse).
 */
export async function resolveRuleTarget(
  tx: Tx,
  graphId: GraphId,
  target: RuleTargetAddress,
): Promise<{ carrier: RuleCarrier; own: boolean; rules: readonly RuleDefinition[] }> {
  const reg = await currentRegistry(tx, graphId);
  const [kind, address] =
    'aspect' in target
      ? (['aspect', target.aspect] as const)
      : 'property' in target
        ? (['property', target.property] as const)
        : (['role', target.role] as const);
  const def =
    kind === 'aspect'
      ? byIdOrKey(reg.aspects, address)
      : kind === 'property'
        ? resolvePropertyRef(reg, address)
        : byIdOrKey(reg.roles, address);
  if (def === undefined) {
    throw new ExecError('NOT_FOUND', `носителя правила ${kind}:${address} нет в реестре`, {
      target,
    });
  }
  return { carrier: { kind, id: def.id }, own: def.graphId !== null, rules: def.rules };
}

// ---------------------------------------------------------------------------
// Своё действие владельца (§Б6-1, §С3 строка «Действие»)
// ---------------------------------------------------------------------------

/**
 * ПОЛНАЯ строка `action_definitions` владельца — в той же форме, что `SubscriptionRow` выше:
 * обратная операция `action_set` обязана вернуть декларацию такой, какой она была.
 */
export interface ActionRow {
  id: string;
  /** Граф строки как он лежит в колонке — голой строкой, как у `SubscriptionRow`: бренд графа
   *  рождает только резолвер, а приведение колонки к нему — ровно форма, которую ловит гейт. */
  graphId: string | null;
  key: string;
  label: LocalizedText;
  description: LocalizedText;
  params: unknown;
  precondition: unknown;
  over: unknown;
  steps: unknown;
  sensitivity: string[];
  offeredBy: unknown;
  module: string | null;
  batchCap: number | null;
  status: 'active' | 'deprecated';
  rank: number;
}

function toActionRow(r: RawRow): ActionRow {
  return {
    id: r.id as string,
    graphId: (r.graph_id ?? null) as string | null,
    key: r.key as string,
    label: r.label as LocalizedText,
    description: r.description as LocalizedText,
    // Колонки 0014 nullable БЕЗ default — умолчания те же, что у схемы на чтении (`registry/load.ts`).
    params: r.params ?? [],
    precondition: r.precondition ?? null,
    over: r.over ?? null,
    steps: r.steps,
    sensitivity: (r.sensitivity ?? []) as string[],
    offeredBy: r.offered_by ?? [],
    module: (r.module ?? null) as string | null,
    batchCap: r.batch_cap === null || r.batch_cap === undefined ? null : Number(r.batch_cap),
    status: r.status as ActionRow['status'],
    rank: Number(r.rank),
  };
}

/** СВОЯ строка действия по id ИЛИ key (у своей они совпадают — решение 2 задачи 10). */
export async function readActionRow(
  tx: Tx,
  graphId: GraphId,
  idOrKey: string,
): Promise<ActionRow | undefined> {
  const rows = (await tx.execute(sql`
    SELECT id, graph_id, key, label, description, params, precondition, "over", steps, sensitivity,
           offered_by, module, batch_cap, status, rank
      FROM action_definitions
     WHERE graph_id = ${graphId}::uuid AND (id = ${idOrKey} OR key = ${idOrKey})
     LIMIT 1`)) as unknown as RawRow[];
  return rows[0] === undefined ? undefined : toActionRow(rows[0]);
}

/**
 * Есть ли СИСТЕМНОЕ действие по этому адресу (Р-К-40). Системные строки у всех графов общие
 * (`graph_id IS NULL`), поэтому проба — без графа.
 */
export async function systemActionAt(tx: Tx, idOrKey: string): Promise<string | undefined> {
  const rows = (await tx.execute(sql`
    SELECT id FROM action_definitions
     WHERE graph_id IS NULL AND (id = ${idOrKey} OR key = ${idOrKey}) LIMIT 1`)) as unknown as Array<{
    id: string;
  }>;
  return rows[0]?.id;
}

/** Ранг своего действия: системные сиды занимают 1..N (§Б6-1), своё встаёт за ними. */
const OWN_ACTION_RANK = 1000;

/**
 * Своё действие владельца (§Б6-1). Namespace — тот же гейт и тот же довод, что у подписок и свойств:
 * `orbis/…` завтра посеет релиз, и своя строка МОЛЧА перекрыла бы системную.
 * Смысл декларации проверяется ЗДЕСЬ, до записи (Р-И-7): на записи владелец видит отказ и может его
 * исправить, на чтении — только запертый снимок реестра.
 *
 * ВХОД ОПЕРАЦИИ = ВХОД ТУЛА (эррата реестра §1.10, бриф задачи 10): служебные поля строки операция
 * проставляет сама и отдаёт РАЗОБРАННУЮ `ActionDefinition`.
 */
export async function setOwnAction(
  tx: Tx,
  graphId: GraphId,
  decl: ActionSetInput,
): Promise<ActionDefinition> {
  // ВСТРОЕННОЕ ДЕЙСТВИЕ ЭТИМ ПУТЁМ НЕ ПРАВИТСЯ (Р-К-40): нужны другие шаги — форк своей строкой с
  // другим key (§Б6-5). Правку ПОДПИСИ встроенного отказ не обещает: схема дельты действия есть
  // (`actionDeltaSchema`, задача 6), но тула, который её пишет, нет, и обещание вело бы в тупик.
  // Проба стоит ДО namespace, потому что причина у отказа своя: «чужой namespace» сказал бы
  // владельцу не то, что он сделал, — он адресовал встроенное действие.
  const system = await systemActionAt(tx, decl.key);
  if (system !== undefined) {
    throw new ExecError(
      'VALIDATION',
      `действие «${decl.key}» встроенное и этим тулом не правится — нужны другие шаги, заведи свою копию с ключом user/… (§Б6-5)`,
      { reason: 'ACTION_TARGET_SYSTEM', action: system },
    );
  }
  if (!decl.key.startsWith('user/')) {
    throw new ExecError(
      'VALIDATION',
      `свои действия живут в namespace user/ — «${decl.key}» занимает чужой (§Б6-1)`,
      { reason: 'ACTION_NAMESPACE', action: decl.key },
    );
  }
  const current = await readActionRow(tx, graphId, decl.key);
  // СНИМОК С ДЕЛЬТАМИ, а не сырые строки: шаг действия вправе ссылаться на СВОЙ аспект и своё
  // свойство — они живут дельтой, и без неё та же декларация получала бы UNKNOWN_PROPERTY.
  const probe = await probeSnapshot(tx, graphId, await loadRegistryRows(tx, graphId));
  const checked = assertAction(
    // Служебные поля строки проставляет ОПЕРАЦИЯ, а не вызывающий: `id` = `key` (решение 2),
    // `graphId` — граф владельца (m-3: своя строка без графа читалась бы системной),
    // `module: null` (решение 6), `status` и `rank` — решения 1 и 3.
    {
      ...decl,
      id: decl.key,
      graphId,
      module: null,
      status: 'active',
      rank: current?.rank ?? OWN_ACTION_RANK,
    },
    { reg: probe, systemSeed: false },
  );
  assertStepLiterals(probe, checked);
  await tx.execute(sql`
    INSERT INTO action_definitions (id, graph_id, key, label, description, params, precondition, "over",
                                    steps, sensitivity, offered_by, module, batch_cap, status, rank)
    VALUES (${checked.id}, ${graphId}::uuid, ${checked.key},
            ${JSON.stringify(checked.label)}::jsonb, ${JSON.stringify(checked.description)}::jsonb,
            ${JSON.stringify(checked.params)}::jsonb, ${JSON.stringify(checked.precondition)}::jsonb,
            ${JSON.stringify(checked.over)}::jsonb, ${JSON.stringify(checked.steps)}::jsonb,
            ${JSON.stringify(checked.sensitivity)}::jsonb, ${JSON.stringify(checked.offered_by)}::jsonb,
            ${checked.module}, ${checked.batch_cap}, ${checked.status}, ${checked.rank})
    ON CONFLICT (graph_id, id) WHERE graph_id IS NOT NULL
      DO UPDATE SET key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
                    params = EXCLUDED.params, precondition = EXCLUDED.precondition, "over" = EXCLUDED."over",
                    steps = EXCLUDED.steps, sensitivity = EXCLUDED.sensitivity, offered_by = EXCLUDED.offered_by,
                    batch_cap = EXCLUDED.batch_cap, status = EXCLUDED.status, rank = EXCLUDED.rank`);
  await bumpOwnerRegistryVersion(tx, graphId);
  return checked;
}

/**
 * ЛИТЕРАЛЫ ЗНАЧЕНИЙ ШАГОВ — ПО ТИПУ СВОЙСТВА-ЦЕЛИ, ТЕМ ЖЕ СРЕДСТВОМ, ЧТО ИСПОЛНИТЕЛЬ (перенос задачи 6).
 * Ступень 8 `assertAction` сверяет с типом позиции только `{$expr}`; литерал (`'orbis/planned': 'да'`)
 * она пропускает, и такое действие записывалось бы, а падало на КАЖДОМ прогоне стадией 2 исполнителя
 * (`validateEntityProps`) — вечно сломанное действие, отказ которого владелец увидит не там, где
 * ошибся. Проверка здесь — та же функция стадии 2 (второго описания типа значения не заводится), по
 * значениям, которые шаг пишет БУКВАЛЬНО: `props` графовых тулов и `data` у `attach_*`.
 *
 * ЗНАЧЕНИЕ С МАРКЕРОМ ВНУТРИ (`['a', {$expr}]` у списка) ПРОПУСКАЕТСЯ ЦЕЛИКОМ: стадия 2 судит значение
 * свойства целиком, а до подстановки его нет; элементы-маркеры уже сверила ступень 8. Живёт здесь,
 * а не в `assertAction`, по доводу двери: валидатору декларации ajv-стадия исполнителя чужая, и
 * системные сиды её тоже не проходят — их значения стерегут тесты сида.
 */
function assertStepLiterals(reg: RegistrySnapshot, decl: ActionDefinition): void {
  const hasMarker = (value: unknown): boolean => {
    // Глубина уже ограничена гейтом двери (`tools/registry-tools.ts`), рекурсия здесь безопасна.
    if (Array.isArray(value)) return value.some(hasMarker);
    if (typeof value !== 'object' || value === null) return false;
    return Object.hasOwn(value, '$expr') || Object.values(value).some(hasMarker);
  };
  for (const [index, step] of decl.steps.entries()) {
    for (const bag of ['props', 'data'] as const) {
      const raw = step.input[bag];
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const literal: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (hasMarker(value)) continue;
        // Адрес уже проверен ступенью 8 (`ACTION_VALUE_TYPE` на отсутствующем свойстве).
        literal[resolvePropertyRef(reg, key)?.id ?? key] = value;
      }
      const violations = validateEntityProps(
        reg,
        { props: literal, aspects: [] },
        new Set(Object.keys(literal)),
      );
      if (violations.length > 0) {
        throw new ExecError(
          'VALIDATION',
          `действие «${decl.key}»: шаг ${index + 1}, steps.${index}.input.${bag} — значение не проходит тип свойства`,
          {
            reason: 'ACTION_VALUE_TYPE',
            action: decl.key,
            step: index,
            path: `steps.${index}.input.${bag}`,
            violations,
          },
        );
      }
    }
  }
}

/**
 * «Устарело» (§Б6-7, §С3): строка ОСТАЁТСЯ — журнал прошлых применений ссылается на неё по id, и
 * снос сделал бы историю нечитаемой (§А10-3). Системную строку этим путём не тронуть: условие по
 * `graph_id` отсекает её, а гейт адреса стоит в `prepareActionRemove`.
 */
export async function deprecateOwnAction(
  tx: Tx,
  graphId: GraphId,
  actionId: string,
): Promise<void> {
  await tx.execute(sql`UPDATE action_definitions SET status = 'deprecated'
                        WHERE graph_id = ${graphId}::uuid AND id = ${actionId}`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

// ---------------------------------------------------------------------------
// Свой аспект и его привязки к контрактам (§Б2-1, §С3)
// ---------------------------------------------------------------------------

/**
 * ПОЛНАЯ строка `aspect_definitions` владельца — в той же форме, что `PropertyRow` у свойств
 * и по тому же доводу: обратная операция обязана вернуть строку такой, какой она была,
 * включая момент заведения, а `AspectDefinition` момента не несёт.
 *
 * `aggregations` (§Б5-5) в форму НЕ входит: у своей строки она пустует по построению —
 * писателя у неё в Б-1 нет ни одного, — а колонка с умолчанием `{}` переживает и создание,
 * и откат (`ON CONFLICT … DO UPDATE` её не перечисляет). Появится писатель — поле приедет
 * сюда вместе с ним, иначе откат молча гасил бы публикацию величин.
 */
export interface AspectRow {
  id: string;
  key: string;
  label: LocalizedText;
  description: LocalizedText;
  properties: AspectPropertyRef[];
  implements: AspectImplements[];
  aiInstructions: string | null;
  tagMappings: string[];
  viewConfig: { keyFields: string[]; icon?: string };
  module: string | null;
  service: boolean;
  rank: number;
  /** Правила каталога на строке — тот же довод и та же необязательность, что у `PropertyRow.rules`. */
  rules?: RuleDefinition[];
  createdAt: string;
}

const ASPECT_ROW_COLUMNS = sql`id, graph_id, key, label, description, properties, implements,
  ai_instructions, tag_mappings, view_config, module, service, rank, rules, created_at`;

function toAspectRow(r: RawRow): AspectRow {
  return {
    id: r.id as string,
    key: r.key as string,
    label: r.label as LocalizedText,
    description: r.description as LocalizedText,
    properties: r.properties as AspectPropertyRef[],
    implements: r.implements as AspectImplements[],
    aiInstructions: (r.ai_instructions ?? null) as string | null,
    tagMappings: (r.tag_mappings ?? []) as string[],
    viewConfig: r.view_config as { keyFields: string[]; icon?: string },
    module: (r.module ?? null) as string | null,
    service: r.service as boolean,
    rank: Number(r.rank),
    rules: (r.rules ?? []) as RuleDefinition[],
    createdAt:
      (r.created_at as Date | string) instanceof Date
        ? (r.created_at as Date).toISOString()
        : String(r.created_at),
  };
}

/**
 * СВОЯ строка аспекта по id ИЛИ key. У аспекта они совпадают (`user/sleep-log` — и адрес, и
 * ключ), и запрос всё равно спрашивает оба: перекрытие встроенного аспекта своей строкой
 * законно (`routers/registry.test.ts`, «своя строка ПЕРЕКРЫВАЕТ встроенную»), а там key
 * равен встроенному id.
 */
export async function readOwnAspect(
  tx: Tx,
  graphId: GraphId,
  idOrKey: string,
): Promise<AspectRow | undefined> {
  const rows = (await tx.execute(sql`
    SELECT ${ASPECT_ROW_COLUMNS} FROM aspect_definitions
    WHERE graph_id = ${graphId}::uuid AND (id = ${idOrKey} OR key = ${idOrKey})`)) as unknown as RawRow[];
  return rows[0] === undefined ? undefined : toAspectRow(rows[0]);
}

/** Строка → определение со строгим разбором; отказ ДО записи (образец `definitionOf` свойств). */
function aspectDefinitionOf(row: AspectRow, graphId: GraphId): AspectDefinition {
  const { createdAt: _createdAt, ...definition } = row;
  const parsed = aspectDefinitionSchema.safeParse({ ...definition, graphId });
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `определение аспекта ${row.id} не разбирается схемой`, {
      reason: 'ASPECT_MALFORMED',
      aspect: row.id,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

/**
 * Привязки проверяются ДО записи чистой функцией shared (Р-И-7). На ЧТЕНИИ реестра их не
 * проверяет никто (`load.ts` берёт только форму zod) — fail-closed на чтении запер бы владельца
 * снаружи графа, — значит писатель и есть единственное место, где ловится несоответствие типа.
 *
 * Проверяется РОВНО правимая строка, а не весь реестр владельца: чужая строка, посеянная
 * фикстурой или прошлой версией кода, не должна делать неисполнимой правку соседней.
 *
 * ПОГЛОЩЁННОЕ СЛИЯНИЕМ СВОЙСТВО В СЛОТЕ — ОТКАЗ, И ЭТО ПРОВЕРКА СЕРВЕРА, А НЕ SHARED.
 * С среза Б-2 `property_merge` привязки ПЕРЕПИСЫВАЕТ (`bind` — пятый род держателей
 * `collectPropertyHolders`), и живым слиянием поглощённое свойство в слот больше не попадает.
 * Отказ остаётся сторожем двух путей, которых слияние не касается: привязок, поглощённых ДО
 * этого (слияние записано кодом, где пятого рода ещё не было), и ручных вставок мимо тулов.
 * Строка `src` в таком слоте ЖИВА (`status: deprecated`, `merged_into` — §А10-2), и
 * `checkImplements` замечания не даёт: свойство и есть, и носится. Молча это означало бы слот,
 * в котором значений уже нет (они переехали в `into`), — то есть аспект, тихо выпавший из
 * Повестки и Бюджета. Из двух исходов выбран громкий: повторная запись такой привязки
 * отказывает, а исправляется она одним движением — привязать `into`.
 * Словарь замечаний при этом НЕ расширяется (Р-К-34, пин «словарь полон» задачи 13): отказ
 * говорит `reason: 'UNKNOWN_PROPERTY'` с уточнением `cause: 'merged'` — ровно та же пара
 * «код + уточнение», что кладёт `execErrorOfImplementsIssue`.
 */
function assertImplements(next: AspectRow, graphId: GraphId, reg: RegistrySnapshot): void {
  for (const binding of next.implements) {
    for (const [slot, propertyId] of Object.entries(binding.bind)) {
      const def = reg.properties.get(propertyId);
      if (def === undefined || def.mergedInto === null) continue;
      throw new ExecError(
        'VALIDATION',
        `свойство «${propertyId}» поглощено слиянием (значения переехали в «${def.mergedInto}») — ` +
          `слот ${slot} контракта ${binding.contract} привяжите к цели слияния`,
        {
          aspect: next.id,
          contract: binding.contract,
          slot,
          propertyId,
          reason: 'UNKNOWN_PROPERTY',
          cause: 'merged',
        },
      );
    }
  }
  const issue = checkImplements(aspectDefinitionOf(next, graphId), reg)[0];
  if (issue === undefined) return;
  // Единственное отображение ImplementsIssue → ExecError — `execErrorOfImplementsIssue` из этого же
  // файла (задача 13, Р-К-35): BIND_TYPE/VARIANT_UNMAPPED — свои коды §С1-2, прочие — VALIDATION с `reason`.
  throw execErrorOfImplementsIssue(issue, { aspect: next.id });
}

/**
 * ИСКЛЮЧИТЕЛЬНОСТЬ НА ИТОГОВОЙ КАРТЕ после записи строки аспекта (Р-И-38, фикс-раунд 1 задачи 14а).
 *
 * `checkImplements` видит только карту самой строки, а живые дельты владельца дописывают в неё свои
 * отнесения (`applyDeltas`, блок «КАРТА КЛАССОВ ⊕ ПРИВЯЗКИ» — во ВСЕ привязки свойства к слоту):
 * старая дельта с `b → queued` поверх новой привязки с `c → queued` — два варианта одного класса,
 * которых ни одна из двух проверок по отдельности не видит. Складывается ровно то, что сложит
 * читатель: строки владельца с подставленной строкой плюс все его дельты. Проверяется только эта
 * строка — довод `assertImplements`.
 */
async function assertExclusiveWithDeltas(tx: Tx, graphId: GraphId, row: AspectRow): Promise<void> {
  if (row.implements.length === 0) return;
  const rows = await loadRegistryRows(tx, graphId);
  const aspects = new Map(rows.aspects);
  aspects.set(row.id, aspectDefinitionOf(row, graphId));
  const probe = await probeSnapshot(tx, graphId, { ...rows, aspects });
  const issue = exclusiveClassIssues(probe).find((i) => i.details.aspect === row.id);
  if (issue !== undefined) throw execErrorOfImplementsIssue(issue, { aspect: row.id });
}

/**
 * АДРЕСА СВОЙСТВ В `bind` — К id, тем же резолвом, что состав аспекта (`resolvePropertyRef`).
 *
 * Один тул не вправе принимать адрес двумя правилами. `properties[].propertyId` резолвился, а
 * значения `bind` уезжали как есть — и `checkImplements`, который ищет свойство ПО id, отвечал
 * `UNKNOWN_PROPERTY/absent` на свойство, которое в реестре есть и аспектом носится. Модель
 * при этом видит в `property_catalog` именно KEY (Р12), то есть промахивалась бы на главном
 * жесте §Б2-4 — и отказ не называл бы выхода.
 *
 * Неразрешимый адрес уезжает КАК ПРИШЁЛ: назвать его должен чекер привязок, одним словарём с
 * остальными замечаниями (`UNKNOWN_PROPERTY/absent`), а не второй отказ на ту же опечатку.
 */
function normalizeBindAddresses(
  bindings: readonly AspectImplements[],
  reg: RegistrySnapshot,
): AspectImplements[] {
  return bindings.map((b) => ({
    ...b,
    bind: Object.fromEntries(
      Object.entries(b.bind).map(([slot, address]) => [
        slot,
        resolvePropertyRef(reg, address)?.id ?? address,
      ]),
    ),
  }));
}

export interface CreateAspectInput {
  key: string;
  label: LocalizedText;
  description: LocalizedText;
  properties: Array<{ propertyId: string; required: boolean }>;
  implements?: AspectImplements[];
  viewConfig?: { keyFields: string[]; icon?: string };
  tagMappings?: string[];
}

export async function createAspect(
  tx: Tx,
  graphId: GraphId,
  input: CreateAspectInput,
): Promise<{ id: string }> {
  // Гейт namespace — довод `createProperty` (`KEY_NAMESPACE`): своя строка с ключом будущего
  // встроенного аспекта МОЛЧА подменила бы его после пересева (`ORDER BY graph_id NULLS FIRST`).
  if (!input.key.startsWith('user/')) {
    throw new ExecError(
      'VALIDATION',
      `свои аспекты живут в namespace user/ — «${input.key}» занимает чужой (§А2-1)`,
      { reason: 'KEY_NAMESPACE', key: input.key },
    );
  }
  const reg = await currentRegistry(tx, graphId);
  // Суффикса разведения у аспекта НЕТ, в отличие от свойства: его key — это его id и имя тула
  // `attach_*`, и «завёл user/sleep, получил user/sleep-2» подменило бы уже названный адрес.
  if (reg.aspects.has(input.key)) {
    throw new ExecError('VALIDATION', `аспект «${input.key}» уже есть`, {
      reason: 'KEY_TAKEN',
      aspect: input.key,
    });
  }
  // ЗАНЯТ НЕ ТОЛЬКО КЛЮЧ, НО И ИМЯ ТУЛА. `attachToolName` сворачивает и «/», и «-» в «_», и
  // сворачивает НЕОБРАТИМО: `user/a-b` и `user/a_b` дают один `attach_user_a_b`. Два дефа с
  // одним именем расходятся молча и в разные стороны — `toSdkTools` (`llm/ai-sdk.ts`,
  // `Object.fromEntries`) оставляет модели схему ПОСЛЕДНЕГО, а `resolveAttachAspect`
  // (`executor/executor.ts`) резолвит вызов в ПЕРВЫЙ: модель заполняет поля одного аспекта,
  // надевается другой. Проба идёт по снимку целиком, значит и по встроенным `attach_*`.
  const wantedTool = attachToolName(input.key);
  const clash = [...reg.aspects.values()].find((a) => attachToolName(a.key) === wantedTool);
  if (clash !== undefined) {
    throw new ExecError(
      'VALIDATION',
      `имя тула «${wantedTool}» уже занято аспектом «${clash.key}» — в имени тула «-» и «_» ` +
        `не различаются; выберите другой ключ`,
      { reason: 'KEY_TAKEN', cause: 'tool_name', aspect: input.key, conflictsWith: clash.key },
    );
  }
  const properties = input.properties.map((p, index) => {
    const def = resolvePropertyRef(reg, p.propertyId);
    if (def === undefined) {
      throw new ExecError('VALIDATION', `свойства «${p.propertyId}» нет в реестре`, {
        reason: 'UNKNOWN_PROPERTY',
        aspect: input.key,
        property: p.propertyId,
      });
    }
    // Адрес — к id: состав аспекта читают через `properties.get(propertyId)`, и записанный
    // ключом адрес не резолвился бы молча (довод `normalizeDeltaAddresses`).
    return { propertyId: def.id, required: p.required, rank: index + 1 };
  });
  // ДУБЛЬ СЧИТАЕТСЯ ПОСЛЕ РЕЗОЛВА, а не по строкам входа: одно и то же свойство законно
  // назвать и ключом, и id (Р3), и сравнение сырых адресов такую пару пропустило бы. Две
  // ссылки на одно поле — это два `rank` и две `required` у одного значения; читатель
  // (`properties.get`) увидит одну из них, а какую — зависит от порядка обхода.
  const carried = new Set<string>();
  for (const p of properties) {
    if (carried.has(p.propertyId)) {
      throw new ExecError('VALIDATION', `свойство «${p.propertyId}» названо в составе дважды`, {
        reason: 'PROPERTY_DUPLICATE',
        aspect: input.key,
        property: p.propertyId,
      });
    }
    carried.add(p.propertyId);
  }
  // КЛЮЧЕВЫЕ ПОЛЯ КАРТОЧКИ — из состава, и нормализуются тем же резолвом. Поле извне состава
  // карточка показала бы пустым: значения читаются по составу аспекта, а не по реестру.
  const keyFields = (input.viewConfig?.keyFields ?? []).map((field) => {
    const id = resolvePropertyRef(reg, field)?.id ?? field;
    if (!carried.has(id)) {
      throw new ExecError(
        'VALIDATION',
        `ключевое поле «${field}» не входит в состав аспекта — карточка показала бы его пустым`,
        { reason: 'KEYFIELD_NOT_CARRIED', aspect: input.key, property: field },
      );
    }
    return id;
  });
  const row: AspectRow = {
    id: input.key,
    key: input.key,
    label: input.label,
    description: input.description,
    properties,
    implements: normalizeBindAddresses(input.implements ?? [], reg),
    aiInstructions: null,
    tagMappings: input.tagMappings ?? [],
    // keyFields по умолчанию — первые три поля: карточка (02 §2.3) показывает три, как у всех
    // встроенных; полный список превратил бы её в ленту значений.
    viewConfig:
      input.viewConfig === undefined
        ? { keyFields: properties.slice(0, 3).map((p) => p.propertyId) }
        : { ...input.viewConfig, keyFields },
    module: null,
    service: false,
    rank: Math.max(0, ...[...reg.aspects.values()].map((a) => a.rank)) + 1,
    rules: [],
    createdAt: new Date().toISOString(),
  };
  assertImplements(row, graphId, reg);
  await assertExclusiveWithDeltas(tx, graphId, row);
  await insertAspectRow(tx, graphId, row);
  await bumpOwnerRegistryVersion(tx, graphId);
  return { id: row.id };
}

/** Своя строка под правку привязок; встроенный аспект — отказ с указанием законного пути. */
async function ownAspectForWrite(tx: Tx, graphId: GraphId, aspectId: string): Promise<AspectRow> {
  const row = await readOwnAspect(tx, graphId, aspectId);
  if (row !== undefined) return row;
  const builtin = (await tx.execute(sql`
    SELECT 1 AS hit FROM aspect_definitions WHERE graph_id IS NULL AND id = ${aspectId}`)) as unknown as unknown[];
  if (builtin.length > 0) {
    // Приём `BUILTIN_IMMUTABLE` свойств: молчаливый NOT_FOUND отправил бы владельца искать
    // несуществующую строку, а законный путь есть — дельта (задача 13 кладёт в неё `classMap`,
    // дополняющий `value_map` встроенной привязки).
    throw new ExecError(
      'VALIDATION',
      `${aspectId} — встроенный аспект: его привязки дополняются дельтой (aspect_delta_set, поле classMap), ` +
        `а системное определение остаётся системным`,
      { reason: 'ASPECT_BUILTIN_IMMUTABLE', aspect: aspectId },
    );
  }
  throw new ExecError('NOT_FOUND', `аспекта ${aspectId} нет среди ваших`, { aspect: aspectId });
}

export async function setAspectImplements(
  tx: Tx,
  graphId: GraphId,
  aspectId: string,
  bindings: AspectImplements[],
): Promise<void> {
  const row = await ownAspectForWrite(tx, graphId, aspectId);
  const reg = await currentRegistry(tx, graphId);
  const next = normalizeBindAddresses(bindings, reg);
  assertImplements({ ...row, implements: next }, graphId, reg);
  await assertExclusiveWithDeltas(tx, graphId, { ...row, implements: next });
  await tx.execute(sql`
    UPDATE aspect_definitions SET implements = ${JSON.stringify(next)}::jsonb
     WHERE graph_id = ${graphId}::uuid AND id = ${row.id}`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

export async function removeAspectImplements(
  tx: Tx,
  graphId: GraphId,
  aspectId: string,
  contract: string,
): Promise<void> {
  const row = await ownAspectForWrite(tx, graphId, aspectId);
  const kept = row.implements.filter((b) => b.contract !== contract);
  if (kept.length === row.implements.length) {
    // Тихий успех хуже отказа: владелец снял НЕ ТУ привязку и узнал бы об этом только по тому,
    // что аспект по-прежнему в Повестке.
    throw new ExecError('NOT_FOUND', `аспект ${row.id} не привязан к контракту ${contract}`, {
      aspect: row.id,
      contract,
    });
  }
  await tx.execute(sql`
    UPDATE aspect_definitions SET implements = ${JSON.stringify(kept)}::jsonb
     WHERE graph_id = ${graphId}::uuid AND id = ${row.id}`);
  await bumpOwnerRegistryVersion(tx, graphId);
}

/**
 * Восстановление строки аспекта из журнала (§7.8) — ОДНА обратная операция на `aspect_create`
 * и на обе операции привязок: «строки не было» (снос) и «строка была вот такой» (upsert) —
 * один вопрос с двумя ответами, ровно как у `restorePropertyRow`.
 */
export async function restoreAspectRow(
  tx: Tx,
  graphId: GraphId,
  id: string,
  row: AspectRow | null,
): Promise<void> {
  if (row === null) {
    const existing = await readOwnAspect(tx, graphId, id);
    if (existing === undefined) return; // строки уже нет — откат идемпотентен
    // Страховка, а не логика (образец `restorePropertyRow`): аспект создало отменяемое
    // действие, носителей у него быть не может. Появились ПОСЛЕ — снос осиротил бы записи, у
    // которых в `aspects[]` остался адрес без определения, и валидатор начал бы отказывать на
    // каждой их правке.
    const worn = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM entities
       WHERE graph_id = ${graphId}::uuid AND aspects @> ARRAY[${existing.id}]::text[]`)) as unknown as {
      n: number;
    }[];
    const n = Number(worn[0]?.n ?? 0);
    if (n > 0) {
      throw new ExecError(
        'INVARIANT',
        `аспект ${id} нельзя снять откатом: он надет на записей — ${n}`,
        { aspect: id, entities: n },
      );
    }
    await tx.execute(sql`
      DELETE FROM aspect_definitions WHERE graph_id = ${graphId}::uuid AND id = ${existing.id}`);
    await bumpOwnerRegistryVersion(tx, graphId);
    return;
  }
  await insertAspectRow(tx, graphId, row, { restore: true });
  await bumpOwnerRegistryVersion(tx, graphId);
}

async function insertAspectRow(
  tx: Tx,
  graphId: GraphId,
  row: AspectRow,
  opts: { restore?: boolean } = {},
): Promise<void> {
  aspectDefinitionOf(row, graphId); // fail-closed до записи
  // ON CONFLICT нужен только откату; создание идёт по пустому месту, и конфликт там означал бы
  // занятый id — о нём молчать нельзя (тот же размен, что в `insertRow` свойств).
  const conflict = opts.restore
    ? sql`ON CONFLICT (graph_id, id) WHERE graph_id IS NOT NULL DO UPDATE SET
            key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
            properties = EXCLUDED.properties, implements = EXCLUDED.implements,
            ai_instructions = EXCLUDED.ai_instructions, tag_mappings = EXCLUDED.tag_mappings,
            view_config = EXCLUDED.view_config, module = EXCLUDED.module,
            service = EXCLUDED.service, rank = EXCLUDED.rank`
    : sql``;
  // `rules` — в INSERT, но не в `DO UPDATE SET`: довод `insertRow` свойств (перенос П-1 задачи 2).
  await tx.execute(sql`
    INSERT INTO aspect_definitions
      (id, graph_id, key, label, description, properties, implements, ai_instructions,
       tag_mappings, view_config, module, service, rank, rules, created_at)
    VALUES (${row.id}, ${graphId}::uuid, ${row.key}, ${JSON.stringify(row.label)}::jsonb,
            ${JSON.stringify(row.description)}::jsonb, ${JSON.stringify(row.properties)}::jsonb,
            ${JSON.stringify(row.implements)}::jsonb, ${row.aiInstructions},
            ${row.tagMappings.length === 0 ? sql`ARRAY[]::text[]` : textArray(row.tagMappings)},
            ${JSON.stringify(row.viewConfig)}::jsonb, ${row.module}, ${row.service},
            ${row.rank}, ${JSON.stringify(row.rules ?? [])}::jsonb, ${row.createdAt}::timestamptz)
    ${conflict}`);
}

// ---------------------------------------------------------------------------
// Замок реестра владельца (§А10-2)
// ---------------------------------------------------------------------------

/**
 * ЗАМОК РЕЕСТРА ВЛАДЕЛЬЦА — первым statement'ом транзакции исполнителя, ДО бюджетного.
 *
 * Порядок захвата глобальный и односторонний: `реестр → бюджет → строки`. Слияние свойств
 * читает и переписывает `props` тысяч записей, а бюджет-контур берёт свой замок на правке
 * конверта — пачка, делающая и то и другое, при обратном порядке образует цикл ожидания,
 * который PostgreSQL разрывает отказом по дедлоку. Увидеть это тестом нельзя (цикл нужен
 * под нагрузкой и с двух сторон сразу), поэтому порядок держится ОДНИМ местом захвата и
 * пином на порядок statement'ов.
 *
 * Ключ — своё пространство имён `<владелец>:registry`, рядом с `:envelope_unique` бюджета
 * (`budget/binding.ts`) и вне `<владелец>:<роль>`, которое занял `assertAcyclic`
 * (`executor/relations.ts`): совпавший ключ слил бы две несвязанные очереди.
 *
 * Замок реентерабелен, поэтому пачка из пяти операций реестра берёт его один раз.
 *
 * ЧЕГО ЭТОТ ЗАМОК НЕ ДЕЛАЕТ. Он сериализует операции ВЛАДЕЛЬЦА между собой — те, что идут
 * через исполнителя. Пересев (`db/seed-registries.ts`) пишет system-строки и сливает дельты
 * админским подключением и этого замка НЕ БЕРЁТ: он идёт на деплое, вне запроса, и своей
 * сериализации у пары «пересев ∥ операция владельца» сегодня нет. Общего вреда это не несёт
 * (пересев трогает `graph_id IS NULL`, операции — свои строки), а единственное пересечение —
 * `registry_deltas`: слияние на пересеве переписывает ту же строку, которую владелец мог
 * править секунду назад. Условие, при котором это перестанет быть допустимым: у пересева
 * появится шаг, читающий строки владельца и решающий по ним, — тогда замок нужен и там.
 */
export async function lockOwnerRegistry(tx: Tx, graph: GraphId): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${graph}:registry`}, 0))`);
}
