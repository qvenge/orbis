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
  assertPatternRegular,
  type LocalizedText,
  newId,
  PATTERN_NOT_REGULAR,
  PatternNotRegularError,
  type PropertyDefinition,
  type PropertyType,
  propertyDefinitionSchema,
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
  assertStaticQuery,
  QUERY_TREE_DEPTH_CAP,
  type QueryAst,
  type QueryFilterNode,
  queryTreeExceedsDepth,
  ScopeNotStaticError,
} from '@orbis/shared/query';
import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import { parseRegistryOfSnapshot } from './cache';
import { type AspectDelta, applyDeltas, aspectDeltaSchema } from './deltas';
import { loadRegistryDeltas, loadRegistryRows, type RegistrySnapshot } from './load';
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
async function currentRegistry(tx: Tx, ownerId: string): Promise<RegistrySnapshot> {
  const rows = await loadRegistryRows(tx, ownerId);
  const deltas = await loadRegistryDeltas(tx, ownerId);
  const versions = await readRegistryVersions(tx, ownerId);
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
  try {
    assertStaticQuery(ast as QueryAst);
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
    createdAt:
      (r.created_at as Date | string) instanceof Date
        ? (r.created_at as Date).toISOString()
        : String(r.created_at),
  };
}

const ROW_COLUMNS = sql`id, key, label, description, type, status, storage, scope,
                        merged_into, module, rank, flags, created_at`;

/**
 * СВОЯ строка свойства владельца — вход всех правок. `owner_id = …` в запросе стоит рядом с
 * RLS не для скоупа (её и так даёт политика), а ради РАЗЛИЧЕНИЯ: встроенное свойство под
 * RLS видно, и без этого условия «правлю системное» отвечало бы «не найдено» вместо
 * подсказки про дельту.
 */
export async function readOwnProperty(
  tx: Tx,
  ownerId: string,
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
    WHERE owner_id = ${ownerId}::uuid AND (id = ${idOrKey} OR key = ${idOrKey})`)) as unknown as RawRow[];
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
  ownerId: string,
  id: string,
  row: PropertyRow | null,
): Promise<void> {
  if (row === null) {
    // Строку удаляем — значит нужен её `key`: ссылка на неё в теле записана ключом, и без
    // него проба «на ней ничего не держится» слепа ровно на текстовых держателей.
    const existing = await readOwnProperty(tx, ownerId, id);
    if (existing === undefined) return; // строки уже нет — откат идемпотентен
    // Страховка, а не логика: строку создало отменяемое действие, и значений у неё быть не
    // может. Если они появились ПОСЛЕ (кто-то успел записать), физическое удаление осиротило
    // бы их — отказываем fail-closed, откат целиком не применяется.
    const used = await propertyUsage(tx, ownerId, id, existing.key);
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
    await assertRegistryStaysReadable(tx, ownerId, existing.id, null);
    await tx.execute(sql`
      DELETE FROM property_definitions WHERE owner_id = ${ownerId}::uuid AND id = ${existing.id}`);
    await bumpOwnerRegistryVersion(tx, ownerId);
    return;
  }
  // ОТКАТ ТОЖЕ ПРОХОДИТ ПРОБУ, хотя возвращает состояние, которое когда-то было читаемым.
  // Между записью и откатом мир двигался: `scope` сняли, а освободившееся место заняла
  // дельта аспекта — и возврат `scope` замкнул бы §А3-4 (`SCOPE_DUPLICATE`). Из двух
  // исходов выбран громкий: неприменимый откат — это отказ, который владелец видит и
  // разбирает, а нечитаемый реестр — это замок снаружи всего графа.
  await assertRegistryStaysReadable(tx, ownerId, id, row);
  await insertRow(tx, ownerId, row, { restore: true });
  await bumpOwnerRegistryVersion(tx, ownerId);
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
function definitionOf(row: PropertyRow, ownerId: string): PropertyDefinition {
  const { createdAt: _createdAt, ...definition } = row;
  const parsed = propertyDefinitionSchema.safeParse({ ...definition, ownerId });
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
  ownerId: string,
  id: string,
  next: PropertyRow | null,
): Promise<void> {
  const rows = await loadRegistryRows(tx, ownerId);
  const deltas = await loadRegistryDeltas(tx, ownerId);
  const versions = await readRegistryVersions(tx, ownerId);
  const properties = new Map(rows.properties);
  if (next === null) properties.delete(id);
  else properties.set(next.id, definitionOf(next, ownerId));
  applyDeltas(
    {
      properties,
      aspects: rows.aspects,
      roles: rows.roles,
      ownerVersion: versions.ownerVersion,
      systemVersion: versions.systemVersion,
    },
    deltas,
  );
}

async function insertRow(
  tx: Tx,
  ownerId: string,
  row: PropertyRow,
  opts: { restore?: boolean } = {},
): Promise<void> {
  definitionOf(row, ownerId);
  // ON CONFLICT нужен только откату (строку могли не удалить, а изменить); создание идёт по
  // пустому месту, и конфликт там означал бы занятый id — о нём молчать нельзя.
  const conflict = opts.restore
    ? sql`ON CONFLICT (owner_id, id) WHERE owner_id IS NOT NULL DO UPDATE SET
            key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
            type = EXCLUDED.type, status = EXCLUDED.status, storage = EXCLUDED.storage,
            scope = EXCLUDED.scope, merged_into = EXCLUDED.merged_into,
            module = EXCLUDED.module, rank = EXCLUDED.rank, flags = EXCLUDED.flags`
    : sql``;
  await tx.execute(sql`
    INSERT INTO property_definitions
      (id, owner_id, key, label, description, type, status, storage, scope, merged_into,
       module, rank, flags, created_at)
    VALUES (${row.id}, ${ownerId}::uuid, ${row.key}, ${JSON.stringify(row.label)}::jsonb,
            ${JSON.stringify(row.description)}::jsonb, ${JSON.stringify(row.type)}::jsonb,
            ${row.status}, ${row.storage},
            ${row.scope === null ? null : JSON.stringify(row.scope)}::jsonb,
            ${row.mergedInto}, ${row.module}, ${row.rank},
            ${JSON.stringify(row.flags)}::jsonb, ${row.createdAt}::timestamptz)
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
  ownerId: string,
  input: CreatePropertyInput,
): Promise<{ id: string; key: string }> {
  const scope = input.scope ?? null;
  assertDeclaration(input.type, scope);

  const reg = await currentRegistry(tx, ownerId);

  if (input.status === 'proposed') {
    const proposed = [...reg.properties.values()].filter(
      (d) => d.ownerId !== null && d.status === 'proposed',
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
  // и по правилу «своя строка перекрывает системную» (`ORDER BY owner_id NULLS FIRST`,
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
    type: input.type,
    status: input.status,
    storage: 'props',
    scope,
    mergedInto: null,
    module: input.module ?? null,
    rank,
    flags: {},
    createdAt: new Date().toISOString(),
  };
  await assertRegistryStaysReadable(tx, ownerId, row.id, row);
  await insertRow(tx, ownerId, row);
  await bumpOwnerRegistryVersion(tx, ownerId);
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
  ownerId: string,
  id: string,
  key: string,
): Promise<{ values: number; refs: number }> {
  const rows = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM entities WHERE props ? ${id}`)) as unknown as { n: number }[];
  const holders = await collectPropertyHolders(tx, ownerId);
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
  ownerId: string,
  id: string,
  patch: UpdatePropertyPatch,
): Promise<void> {
  const row = await readOwnProperty(tx, ownerId, id);
  if (row === undefined) {
    // Встроенное свойство под RLS видно — значит «не своё» надо отличать от «нет такого»:
    // подпись встроенного правится ДЕЛЬТОЙ (§А3-2), и молчаливый NOT_FOUND отправил бы
    // владельца искать несуществующую строку.
    const builtin = (await tx.execute(sql`
      SELECT 1 AS hit FROM property_definitions
      WHERE owner_id IS NULL AND id = ${id}`)) as unknown as unknown[];
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

  const scope = patch.scope === undefined ? row.scope : patch.scope;
  assertDeclaration(row.type, scope);

  if (patch.status === 'deprecated' && row.status === 'proposed') {
    const used = await propertyUsage(tx, ownerId, row.id, row.key);
    if (used.values === 0 && used.refs === 0) {
      // Дальше адресуем ТОЛЬКО `row.id`: во вход мог прийти key (см. `readOwnProperty`),
      // и `WHERE id = <key>` не задел бы ни одной строки — молча, без единой ошибки.
      await assertRegistryStaysReadable(tx, ownerId, row.id, null);
      await tx.execute(sql`
        DELETE FROM property_definitions WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}`);
      await bumpOwnerRegistryVersion(tx, ownerId);
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
  await assertRegistryStaysReadable(tx, ownerId, row.id, next);
  await insertRow(tx, ownerId, next, { restore: true });
  await bumpOwnerRegistryVersion(tx, ownerId);
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
 * ЧЕТЫРЕ РОДА, и это ПОЛНЫЙ перечень для среза А:
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
 *    свойства пятью полями: `properties.add[].propertyId`, `properties.hide[]`,
 *    `properties.relaxRequired[]`, КЛЮЧИ `properties.rank{}` и КЛЮЧИ `selectOptions{}`.
 *
 * ПРИЗНАК, ПО КОТОРОМУ СЛЕДУЮЩИЙ ЧИТАТЕЛЬ ПОЙМЁТ, ЧТО ПЕРЕЧЕНЬ УСТАРЕЛ: появилось место,
 * хранящее идентификатор свойства (в колонке, в jsonb, в тексте) и переживающее операции
 * над реестром. Подписка и правило части Б — ровно такие; они и будут пятым и шестым.
 * Проверяется это не памятью, а согласием двух половин: `registry/deps-graph.ts` строит
 * рёбра по ТОМУ ЖЕ множеству мест, и разойтись им нельзя.
 */
export interface PropertyHolder {
  kind: 'registry' | 'progress_source' | 'body' | 'delta';
  /** id строки реестра, id сущности либо id строки `registry_deltas`. */
  id: string;
  /** id и key свойств, названные этим держателем. */
  properties: string[];
}

const PROGRESS_SOURCE = 'orbis/progress_source';

/** Все имена свойств, названные деревом: `prop`, `has`, `sortBy`, `rel.sourceNotIn.prop`. */
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

/** Имена свойств, названные ДЕЛЬТОЙ аспекта: пять полей, перечисленных у `PropertyHolder`. */
function propertyNamesInDelta(delta: unknown, out: Set<string>): void {
  if (typeof delta !== 'object' || delta === null) return;
  const d = delta as AspectDelta;
  for (const ref of d.properties?.add ?? []) out.add(ref.propertyId);
  for (const id of d.properties?.hide ?? []) out.add(id);
  for (const id of d.properties?.relaxRequired ?? []) out.add(id);
  for (const id of Object.keys(d.properties?.rank ?? {})) out.add(id);
  for (const id of Object.keys(d.selectOptions ?? {})) out.add(id);
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
export async function collectPropertyHolders(tx: Tx, ownerId: string): Promise<PropertyHolder[]> {
  const out: PropertyHolder[] = [];

  const regRows = (await tx.execute(sql`
    SELECT id, scope, type FROM property_definitions
    WHERE owner_id = ${ownerId}::uuid AND (scope IS NOT NULL OR type->>'kind' = 'ref')
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
    SELECT id, delta FROM registry_deltas WHERE owner_id = ${ownerId}::uuid`)) as unknown as RawRow[];
  for (const r of deltaRows) {
    const names = new Set<string>();
    propertyNamesInDelta(r.delta, names);
    if (names.size > 0) out.push({ kind: 'delta', id: r.id as string, properties: [...names] });
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
    // Своя строка перекрывает встроенную — `ORDER BY owner_id NULLS FIRST` у `load.ts`.
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
  ownerId: string,
  source: string,
  into: string,
): Promise<void> {
  try {
    await currentRegistry(tx, ownerId);
  } catch (e) {
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
      // строки идут `ORDER BY owner_id NULLS FIRST`, значит последняя запись и есть своя.
      if (def.key === name && (found === undefined || found.ownerId === null)) found = def;
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
  if (source.ownerId === null) {
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

/** Переписать имена свойств внутри произвольного JSON-дерева (`prop`/`has`/`field`). */
function rewriteAst(value: unknown, from: ReadonlySet<string>, to: string): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteAst(v, from, to));
  if (typeof value !== 'object' || value === null) return value;
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
  ownerId: string,
  input: { source: string; into: string },
): Promise<MergeResult> {
  const reg = await currentRegistry(tx, ownerId);
  const { source, into } = resolveMergePair(reg, input);
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
  const holders = (await collectPropertyHolders(tx, ownerId)).filter((h) =>
    h.properties.some((p) => names.has(p)),
  );
  const registry: MergeInverse['registry'] = [];
  const progress: MergeInverse['progress'] = [];
  const bodies: MergeInverse['bodies'] = [];
  const deltas: MergeInverse['deltas'] = [];

  for (const holder of holders) {
    if (holder.kind === 'registry') {
      const rows = (await tx.execute(sql`
        SELECT scope, type FROM property_definitions
        WHERE owner_id = ${ownerId}::uuid AND id = ${holder.id}`)) as unknown as RawRow[];
      const row = rows[0];
      if (row === undefined) continue;
      const nextScope = rewriteAst(row.scope ?? null, names, astTarget);
      const nextType = rewriteAst(row.type, names, astTarget);
      registry.push({ id: holder.id, scope: row.scope ?? null, type: row.type });
      await tx.execute(sql`
        UPDATE property_definitions
           SET scope = ${nextScope === null ? null : JSON.stringify(nextScope)}::jsonb,
               type = ${JSON.stringify(nextType)}::jsonb
         WHERE owner_id = ${ownerId}::uuid AND id = ${holder.id}`);
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
        WHERE owner_id = ${ownerId}::uuid AND id = ${holder.id}::uuid FOR UPDATE
      `)) as unknown as RawRow[];
      const row = rows[0];
      if (row === undefined) continue;
      deltas.push({ id: holder.id, delta: row.delta });
      await tx.execute(sql`
        UPDATE registry_deltas SET delta = ${JSON.stringify(
          rewriteDelta(row.delta, names, astTarget),
        )}::jsonb
         WHERE owner_id = ${ownerId}::uuid AND id = ${holder.id}::uuid`);
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
     WHERE owner_id = ${ownerId}::uuid AND merged_into = ${source.id}
    RETURNING id`)) as unknown as RawRow[];

  await tx.execute(sql`
    UPDATE property_definitions SET merged_into = ${into.id}, status = 'deprecated'
     WHERE owner_id = ${ownerId}::uuid AND id = ${source.id}`);

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
  await assertMergeLeftRegistryReadable(tx, ownerId, source.id, into.id);

  await bumpOwnerRegistryVersion(tx, ownerId);

  return {
    rewrittenEntities: values.length,
    rewrittenQueries: registry.length + progress.length + bodies.length + deltas.length,
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
            text: attrs.text.replace(KEY_TOKEN_RE, (t) => (from.has(t) ? textTo : t)),
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
export async function undoMerge(tx: Tx, ownerId: string, iv: MergeInverse): Promise<void> {
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
       WHERE owner_id = ${ownerId}::uuid AND id = ${r.id}`);
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
       WHERE owner_id = ${ownerId}::uuid AND id = ${d.id}::uuid`);
  }
  for (const id of iv.compacted) {
    await tx.execute(sql`
      UPDATE property_definitions SET merged_into = ${iv.source}
       WHERE owner_id = ${ownerId}::uuid AND id = ${id}`);
  }
  await tx.execute(sql`
    UPDATE property_definitions
       SET merged_into = ${iv.sourceRow.mergedInto}, status = ${iv.sourceRow.status}
     WHERE owner_id = ${ownerId}::uuid AND id = ${iv.source}`);
  await bumpOwnerRegistryVersion(tx, ownerId);
}

// ---------------------------------------------------------------------------
// Дельты аспектов (§А3-2)
// ---------------------------------------------------------------------------

export async function readAspectDelta(
  tx: Tx,
  ownerId: string,
  aspectId: string,
): Promise<AspectDelta | null> {
  const rows = (await tx.execute(sql`
    SELECT delta FROM registry_deltas
    WHERE owner_id = ${ownerId}::uuid AND target_kind = 'aspect' AND target_id = ${aspectId}
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
  ownerId: string,
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
  const rows = await loadRegistryRows(tx, ownerId);
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
  const normalized = normalizeDeltaAddresses(parsed.data, rows.properties, aspectId);
  const versions = await readRegistryVersions(tx, ownerId);
  const existing = await loadRegistryDeltas(tx, ownerId);
  const probe = [
    ...existing.filter((r) => !(r.targetKind === 'aspect' && r.targetId === aspectId)),
    {
      id: newId(),
      ownerId,
      targetKind: 'aspect' as const,
      targetId: aspectId,
      baseVersion: versions.systemVersion,
      delta: normalized,
    },
  ];
  // Отказ `applyDeltas` — уже ExecError с точной причиной (DELTA_PROPERTY_PRESENT,
  // REQUIRED_NOT_RELAXABLE, …); перехватывать и переименовывать его нечем и незачем.
  applyDeltas(
    { ...rows, ownerVersion: versions.ownerVersion, systemVersion: versions.systemVersion },
    probe,
  );

  await tx.execute(sql`
    INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
    VALUES (${newId()}::uuid, ${ownerId}::uuid, 'aspect', ${aspectId},
            ${versions.systemVersion}, ${JSON.stringify(normalized)}::jsonb)
    ON CONFLICT (owner_id, target_kind, target_id)
      DO UPDATE SET delta = EXCLUDED.delta, base_version = EXCLUDED.base_version`);
  await bumpOwnerRegistryVersion(tx, ownerId);
}

/** Снятие дельты: аспект возвращается к системному определению (§А3-2). */
export async function removeAspectDelta(tx: Tx, ownerId: string, aspectId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM registry_deltas
     WHERE owner_id = ${ownerId}::uuid AND target_kind = 'aspect' AND target_id = ${aspectId}`);
  await bumpOwnerRegistryVersion(tx, ownerId);
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
 * (пересев трогает `owner_id IS NULL`, операции — свои строки), а единственное пересечение —
 * `registry_deltas`: слияние на пересеве переписывает ту же строку, которую владелец мог
 * править секунду назад. Условие, при котором это перестанет быть допустимым: у пересева
 * появится шаг, читающий строки владельца и решающий по ним, — тогда замок нужен и там.
 */
export async function lockOwnerRegistry(tx: Tx, ownerId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ownerId}:registry`}, 0))`,
  );
}
