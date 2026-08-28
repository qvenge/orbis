// apps/server/src/registry/ref.ts
// Ссылочные kind'ы §А6: `ref` (ссылка на сущность), `registry_ref` (ссылка на запись
// реестра). Здесь живут три вещи, и все три — про ОДНО правило: истина ссылки — значение
// свойства, всё остальное производно от него.
//
//  1. ПРОВЕРКА ЗНАЧЕНИЯ (§А6-1). Множество допустимых целей объявлено в `ref.target`
//     статическим Q-AST, и проверять принадлежность обязан тот же компилятор, что исполняет
//     запросы владельца (`query/compile-ast.ts`): вторая реализация «что такое категория»
//     разошлась бы с первой ровно там, где владелец завёл свою строку реестра.
//  2. ЗЕРКАЛО-РЕБРО (§А6-2). Значение ссылки дублируется ребром роли `ref` с
//     `meta.property` — чтобы «кто ссылается на эту категорию» считалось обходом графа по
//     индексу `(target_id, role)`, а не сканом `props->>` по всем сущностям владельца.
//     Ребро ПРОИЗВОДНО: расхождение чинится сверкой с `props`, а не наоборот (правило 3 §10).
//  3. АРХИВАЦИЯ ЦЕЛИ (§А6-3). Ссылки остаются, источники получают тег `needs-review`.
//     Архивная цель выпадает из множества (`compileWhere` добавляет `NOT archived`), поэтому
//     пере-установка того же значения — честный отказ с именем причины.
//
// ЧТО ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ. Kind `grant` — ссылка в `agent_grants`, и её держит существующий
// инвариант назначения (`executor/invariants.ts`, `assertAssignment`): у него сверх
// существования есть своё условие («грант не отозван») и своя точка вызова («назначение
// затронуто патчем»), и переносить его сюда значило бы разводить одно правило по двум домам.
//
// ПОЧЕМУ ЗАПИСЬ ЗЕРКАЛА ИДЁТ ПРЯМЫМ SQL, А НЕ ОПЕРАЦИЕЙ `relation_create` ИСПОЛНИТЕЛЯ.
// Механизм этой записи — `rule` (§А4-4, правило `mirror_relation`; строкой реестра оно
// станет в части Б, до неё живёт кодом), и гейт `created_by: system` роли `ref` её пропустил
// бы. Дело не в гейте, а в ЖУРНАЛЕ: у операции исполнителя есть inverse, и ребро попало бы в
// откат ДВАЖДЫ — один раз как `relation_create`/`relation_delete`, второй раз как следствие
// восстановленного свойства (единица отката — свойство, §А7-4). Два отката одного факта
// зависят от порядка и гасят друг друга. Поэтому inverse у зеркала нет вовсе, а сходится оно
// само: `syncRefMirror` зовётся и во внутреннем режиме undo. Проверяется это тестом
// «undo правки категории возвращает и свойство, и зеркало-ребро» (`ref.test.ts`).
import { CONTRACT_IDS_V1, newId, type PropertyType, ROLE_REF } from '@orbis/shared';
import type { QueryAst } from '@orbis/shared/query';
import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import { projectLegacyRelationType } from '../executor/legacy-form';
import { type CompileCtx, compileWhere } from '../query/compile-ast';
import type { RegistrySnapshot } from './load';

/**
 * Причина отказа ссылочных kind'ов (§А6-1). Одна на `ref` и `registry_ref`: потребитель
 * различает «какая именно ссылка не сошлась» по `details.property`, а род отказа у них один
 * — названная цель не входит в объявленное множество.
 */
export const REF_TARGET = 'REF_TARGET';

type RefType = Extract<PropertyType, { kind: 'ref' }>;
type RegistryRefType = Extract<PropertyType, { kind: 'registry_ref' }>;

/** Тег ручного разбора (§А6-3, 01-arch §5): его же показывает фильтр «требуют разбора». */
export const NEEDS_REVIEW_TAG = 'needs-review';

/**
 * Значение ссылочного свойства → список id. Скаляр и список (`cardinality: 'many'`) сводятся
 * к одной форме здесь, а не у каждого вызывающего: ветка «а если массив» на четырёх местах —
 * это четыре шанса забыть её на пятом.
 *
 * Не-строки отбрасываются молча: форму значения уже проверил ajv (`propertyValueJsonSchema`
 * даёт `format: uuid`), и второй отказ на ту же опечатку читался бы как второе правило.
 */
export function refIds(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.filter((item): item is string => typeof item === 'string');
}

/** `ARRAY[$1, $2]::uuid[]`; пустой список — пустой массив того же типа. */
function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

/** `ARRAY[$1, $2]::text[]` — id свойств в подписи зеркала лежат текстом. */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/** Альтернативные множества цели (§А6-1): одно, список или «любая сущность владельца». */
function targetsOf(type: RefType): QueryAst[] {
  if (type.target === undefined) return [];
  return Array.isArray(type.target) ? type.target : [type.target];
}

/**
 * SELECT «какие из этих id входят в множество `target`» (§А6-1).
 *
 * Каст `::uuid` обязателен и здесь, и в списке: `entities.id` — колонка uuid, а параметр
 * приезжает текстом, и без каста PostgreSQL отвечает не «не входит», а ошибкой оператора.
 *
 * Несколько альтернативных множеств — ИЛИ: `target` списком означает «годится любое из»
 * (§А6-1), а не пересечение. Пустой `target` (свойство без объявленного множества) —
 * `true`: ограничения нет, остаётся существование и видимость под RLS.
 */
export function refTargetMembershipSql(
  type: RefType,
  ids: readonly string[],
  ctx: CompileCtx,
): SQL {
  const targets = targetsOf(type);
  const inSet =
    targets.length === 0
      ? sql`true`
      : sql.join(
          targets.map((ast) => sql`(${compileWhere(ast, ctx)})`),
          sql` OR `,
        );
  return sql`SELECT e.id FROM entities e WHERE (${inSet}) AND e.id = ANY(${uuidArray(ids)})`;
}

/** Отказ §А6-1 с НАЗВАННОЙ причиной: потребитель читает `details`, а не текст. */
function refFail(propertyId: string, id: string, cause: string): never {
  throw new ExecError('VALIDATION', `ссылка «${propertyId}» на «${id}»: ${cause}`, {
    reason: REF_TARGET,
    property: propertyId,
    value: id,
    cause,
  });
}

/**
 * Значение свойства kind `ref` указывает на существующую цель ВНУТРИ множества `target`
 * (§А6-1). Молчит на пустом значении: снятие ссылки цели не требует.
 *
 * ТРИ ПРИЧИНЫ ОТКАЗА, и разводятся они вторым запросом не из педантизма. «Цель архивна» —
 * штатный исход §А6-3 (владелец убрал категорию, и пере-установка того же значения обязана
 * сказать почему), «не найдена» — опечатка или чужой id, «цель не в множестве target» —
 * названа не та сущность. Один текст на три случая заставил бы владельца гадать, что чинить.
 *
 * Чужая и несуществующая цель неразличимы намеренно (единый «не найдена»): RLS скрывает
 * чужие строки, и разница здесь сделала бы ссылку оракулом чужих id.
 */
export async function assertRefValue(
  tx: Tx,
  ctx: CompileCtx,
  propertyId: string,
  type: RefType,
  value: unknown,
): Promise<void> {
  const ids = refIds(value);
  if (ids.length === 0) return;
  const rows = (await tx.execute(refTargetMembershipSql(type, ids, ctx))) as unknown as Array<{
    id: string;
  }>;
  const inTarget = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !inTarget.has(id));
  if (missing.length === 0) return;

  // Второй запрос идёт ТОЛЬКО на ошибочном пути и только по промахнувшимся id — цена
  // диагностики не берётся с каждой законной записи.
  const state = (await tx.execute(sql`
    SELECT id, archived FROM entities WHERE id = ANY(${uuidArray(missing)})`)) as unknown as Array<{
    id: string;
    archived: boolean;
  }>;
  const archived = new Map(state.map((r) => [r.id, r.archived]));
  for (const id of missing) {
    const visible = archived.get(id);
    if (visible === undefined) refFail(propertyId, id, 'цель не найдена');
    if (visible) refFail(propertyId, id, 'цель архивна');
    refFail(propertyId, id, 'цель не в множестве target');
  }
}

/**
 * Таблица реестра под каждую цель `registry_ref` (§А2-2). Литералами и `Record` по
 * закрытому union'у: имя таблицы уезжает в `sql.raw`, и «а вдруг придёт что-то ещё»
 * здесь означало бы конкатенацию непроверенного имени в текст запроса.
 */
const REGISTRY_TABLE: Readonly<Record<RegistryRefType['target'], string>> = {
  contract: 'contract_definitions',
  aspect: 'aspect_definitions',
  property: 'property_definitions',
  relation_role: 'relation_role_definitions',
};

/**
 * Значение kind `registry_ref` указывает на существующую запись целевого реестра (§А2-2).
 *
 * Для `contract` множество — строки таблицы ∪ `CONTRACT_IDS_V1` (РП-6). Шим нужен ровно на
 * интервале А→Б-1: таблица контрактов в срезе А создаётся ПУСТОЙ (§А12-1), а
 * `orbis/rule_scope` обязан принимать `orbis/money-movement` уже здесь (§А8, В7). Снимается
 * первым актом Б-1 вместе с самой константой.
 *
 * Чтение идёт под RLS (`read_builtin_or_own`): своя строка владельца — такая же законная
 * цель, как встроенная.
 */
export async function assertRegistryRefValue(
  tx: Tx,
  propertyId: string,
  type: RegistryRefType,
  value: unknown,
): Promise<void> {
  if (typeof value !== 'string') return; // форму проверил ajv
  if (type.target === 'contract' && (CONTRACT_IDS_V1 as readonly string[]).includes(value)) return;
  const rows = (await tx.execute(sql`
    SELECT 1 AS hit FROM ${sql.raw(REGISTRY_TABLE[type.target])}
     WHERE id = ${value} LIMIT 1`)) as unknown as Array<{ hit: number }>;
  if (rows.length === 0) refFail(propertyId, value, 'запись реестра не найдена');
}

/**
 * Ссылочные свойства ЗАПИСИ, которых касается операция, — против существования их целей.
 *
 * Проверяются РОВНО затронутые свойства, а не всё состояние (в отличие от `assertEntityProps`,
 * §А7-1), и это норматив §А6-3, а не экономия: цель могли заархивировать вчера, и проверка
 * всего состояния заморозила бы источник целиком — переименовать транзакцию стало бы нельзя,
 * пока владелец не разберёт ссылку. Ровно этот исход спека отвергла вместе с запретом
 * архивации. Ссылка остаётся, пометка `needs-review` её показывает, а отказ получает только
 * тот, кто пишет ссылку ЗАНОВО.
 */
export async function assertReferenceProps(
  tx: Tx,
  reg: RegistrySnapshot,
  compileCtx: () => Promise<CompileCtx>,
  props: Record<string, unknown>,
  touched: Iterable<string>,
): Promise<void> {
  for (const propertyId of touched) {
    const def = reg.properties.get(propertyId);
    if (def === undefined) continue; // неизвестное свойство — отказ валидатора, не наш
    const value = props[propertyId];
    if (value === undefined) continue; // снятие ссылки цели не требует
    // Контекст компиляции спрашивается ТОЛЬКО у kind `ref` и ТОЛЬКО когда ссылка есть:
    // его сборка стоит чтения настроек владельца, а правка заголовка за неё платить не
    // должна. Отсюда и функция вместо готового значения.
    if (def.type.kind === 'ref')
      await assertRefValue(tx, await compileCtx(), def.id, def.type, value);
    else if (def.type.kind === 'registry_ref') {
      await assertRegistryRefValue(tx, def.id, def.type, value);
    }
  }
}

/** Ссылочное свойство и его значение ПОСЛЕ операции — вход синхронизации зеркала. */
export interface RefPropChange {
  propertyId: string;
  after: unknown;
}

/**
 * Отражается ли значение свойства ребром роли `ref` (§А6-2): ссылочное И НЕ вычисляемое
 * (рулинг координатора Р-11-2).
 *
 * ПОЧЕМУ ВЫЧИСЛЯЕМЫЕ ИСКЛЮЧЕНЫ. `orbis/parent_project` и `orbis/root_project` — тоже
 * `kind: 'ref'`, но это КЭШ ПРОЕКЦИИ ИЕРАРХИИ: их пишет отдельным UPDATE'ом
 * `recomputeProjectAncestors`, они лежат в `props` любой сущности под проектом, и родство,
 * которое они называют, уже выражено ребром иерархии. Зеркало для них было бы вторым
 * представлением того же смысла — тем самым классом, что этой ветке дважды стоил денег.
 *
 * Что происходило, пока ветки не было (найдено ре-ревью фикс-раунда 1): правка ЛЮБОЙ обычной
 * ссылки у записи под проектом втягивала вычисляемые свойства в общий список синхронизации, и
 * появлялось ребро `запись → проект`. Дальше — четыре следствия разом: архивация ПРОЕКТА
 * метила `needs-review` каждую такую запись (§А6-3 срабатывал на ссылку, которой владелец не
 * писал); карточка проекта показывала эти записи в «Связанном» с подписью «Корневой проект»
 * — направлением, обратным смыслу секции; `unmarkRefSources` видел то же ребро, и пока проект
 * архивен, откат архивации КАТЕГОРИИ тега не снимал; подпись общего ребра доставалась
 * произвольному из двух вычисляемых свойств.
 *
 * Один предикат на обоих концах — у производителя списка (`changedRefProps`) и у писателя
 * (`syncRefMirror`): второй экземпляр правила и был бы тем расхождением, которое он запрещает.
 */
function isMirroredRef(reg: RegistrySnapshot, propertyId: string): boolean {
  const def = reg.properties.get(propertyId);
  return def?.type.kind === 'ref' && def.flags.computed === undefined;
}

/**
 * Ссылочные свойства к синхронизации зеркал: либо ВСЕ отражаемые ссылочные свойства сущности
 * (`isMirroredRef` — ссылочные за вычетом вычисляемых, Р-11-2), либо ни одного. Признак «есть
 * работа» — хотя бы одно из них, чьё значение изменилось ИЛИ которого патч КОСНУЛСЯ, не
 * изменив.
 *
 * Почему «касание» тоже считается работой — это способ починки расхождения (правило 3 §10):
 * ребро производно, и единственный момент, когда сервер вправе привести его к правде, —
 * запись этого свойства. Считай мы только изменившиеся, ребро, разъехавшееся со значением
 * (внешняя правка, снятая миграция, сбой), не чинилось бы уже никогда: повторная запись того
 * же значения проходила бы мимо.
 *
 * ПОЧЕМУ ВСЕ, А НЕ ТОЛЬКО ЗАТРОНУТЫЕ. До 0017 `rel_uniq` стоит на тройке с переходной
 * колонкой `relation_type`, поэтому пара (источник, цель) вмещает ОДНО ребро роли `ref` — и
 * два ссылочных свойства, смотрящих на одну цель, ДЕЛЯТ его. Синхронизируй мы только
 * затронутое свойство, снятие ОДНОЙ из двух ссылок сносило бы общее ребро, а вторая, живая,
 * оставалась бы без зеркала — и её источник переставал бы получать `needs-review` при
 * архивации цели (§А6-3), выпадал из обратного обхода импорта и из секции «Связанное». Это
 * потеря КОРРЕКТНОСТИ, а не скорости, и чинится она ровно здесь: полный список свойств даёт
 * `syncRefMirror` возможность восстановить общее ребро вставкой после удаления.
 */
export function changedRefProps(
  reg: RegistrySnapshot,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  touched: ReadonlySet<string>,
): RefPropChange[] {
  const all: RefPropChange[] = [];
  let hasWork = false;
  for (const propertyId of new Set([...Object.keys(before), ...Object.keys(after), ...touched])) {
    if (!isMirroredRef(reg, propertyId)) continue;
    const wasIds = refIds(before[propertyId]);
    const nowIds = refIds(after[propertyId]);
    const same = wasIds.length === nowIds.length && wasIds.every((id, i) => id === nowIds[i]);
    if (!same || touched.has(propertyId)) hasWork = true;
    all.push({ propertyId, after: after[propertyId] });
  }
  return hasWork ? all : [];
}

/**
 * Зеркало-рёбра роли `ref` приводятся к значениям свойств (§А6-2) — ТЕМ ЖЕ tx, что и сама
 * запись: ребро и значение обязаны быть согласованы на момент коммита.
 *
 * Сверка идёт с РЕАЛЬНЫМИ строками, а не с «состоянием до»: только так расхождение чинится
 * (см. `changedRefProps`). Отсюда же идемпотентность — повторный вызов на неизменном
 * состоянии не пишет ничего.
 *
 * ГРАНИЦА САМОПОЧИНКИ, названная точно. Снимок `existing` берётся не по всем зеркалам
 * сущности, а по подписям ИЗ `changed` (`meta->>'property' = ANY(properties)`), а `changed`
 * после Р-11-2 несёт только ОТРАЖАЕМЫЕ свойства. Значит расхождение чинится ВНУТРИ
 * отражаемого множества, и ребро, подписанное свойством вне него — нессылочным или
 * вычисляемым, — этот механизм не видит вовсе: ни удалить, ни учесть в фазе 2.
 *
 * Сегодня таких рёбер не бывает: единственный их писатель — этот же код, а он их и не пишет.
 * Достижимым это станет при ИЗМЕНЕНИИ РЕЕСТРА — если свойству, у которого зеркала уже
 * стоят, позже проставят `flags.computed` (операции реестра Задачи 15 либо часть Б). Тогда
 * ребро осиротеет: продолжит попадать в `markRefSourcesNeedsReview` и в backlinks и — хуже —
 * займёт единственный слот `rel_uniq` на паре (источник, цель) до 0017, из-за чего вставка
 * фазы 2 для ЗАКОННОГО невычисляемого свойства на ту же цель молча уйдёт в
 * `ON CONFLICT DO NOTHING` и останется без зеркала. Это ровно класс Important-1.
 *
 * Чинить это здесь нечем и рано: правильное место — сама операция реестра, которая метит
 * свойство вычисляемым (она же обязана снять его зеркала), и «Пересев мира» (Задача 23),
 * который в срезе А сносит граф целиком. Ключ для грепа обоих: `flags.computed`.
 *
 * ДВЕ ФАЗЫ, И ПОРЯДОК ИХ СУЩЕСТВЕНЕН: сначала удаляются ВСЕ устаревшие рёбра, потом
 * вставляются недостающие. Причина — общее ребро двух свойств (до 0017 `rel_uniq` вмещает
 * одно ребро роли `ref` на пару концов): при обходе «удалил-вставил по одному свойству за
 * раз» вставка живого свойства пришлась бы на ещё не удалённое чужое ребро, получила бы
 * `ON CONFLICT DO NOTHING`, а следующее удаление снесло бы его совсем. `changedRefProps`
 * приносит сюда ВСЕ ссылочные свойства сущности именно затем, чтобы у второй фазы был полный
 * список кандидатов.
 *
 * `ownerId` стоит в обоих запросах, хотя RLS уже скоупит выдачу: та же защита в глубину, что
 * у пересчёта предков (`executor/ancestors.ts`), — под админским подключением (сиды,
 * скрипты) политик нет вовсе, а ребро, поставленное на чужую сущность, увидеть было бы негде.
 *
 * `reg` спрашивается ради ОДНОГО вопроса — отражается ли это свойство ребром (`isMirroredRef`):
 * ребро роли `ref` по нессылочному свойству было бы фактом, которого в реестре нет, а по
 * вычисляемому — вторым представлением иерархии (Р-11-2).
 */
export async function syncRefMirror(
  tx: Tx,
  ownerId: string,
  entityId: string,
  changed: readonly RefPropChange[],
  reg: RegistrySnapshot,
): Promise<void> {
  const wanted = changed.filter((c) => isMirroredRef(reg, c.propertyId));
  if (wanted.length === 0) return;
  const properties = wanted.map((c) => c.propertyId);

  // Один снимок зеркал сущности на обе фазы: их единицы, а по одному SELECT на свойство
  // платила бы каждая правка транзакции.
  const existing = (await tx.execute(sql`
    SELECT target_id, meta->>'property' AS property FROM relations
     WHERE source_id = ${entityId}::uuid AND role = ${ROLE_REF}
       AND meta->>'property' = ANY(${textArray(properties)})`)) as unknown as Array<{
    target_id: string;
    property: string;
  }>;

  // Фаза 1: снять рёбра, которым в значениях свойств больше нет соответствия.
  const desiredOf = new Map(wanted.map((c) => [c.propertyId, new Set(refIds(c.after))]));
  const stale = existing.filter((r) => desiredOf.get(r.property)?.has(r.target_id) !== true);
  if (stale.length > 0) {
    await tx.execute(sql`
      DELETE FROM relations
       WHERE source_id = ${entityId}::uuid AND role = ${ROLE_REF}
         AND (target_id, meta->>'property') IN (${sql.join(
           stale.map((r) => sql`(${r.target_id}::uuid, ${r.property})`),
           sql`, `,
         )})
         AND EXISTS (SELECT 1 FROM entities e
                      WHERE e.id = relations.source_id AND e.owner_id = ${ownerId}::uuid)`);
  }

  // Фаза 2: вставить недостающие. `remaining` считается по ЦЕЛИ, а не по паре
  // (цель, свойство): до 0017 ребро на паре концов одно, и второе свойство, смотрящее на ту
  // же цель, своего ребра не получит — но и не потеряет чужое (см. докблок).
  const remaining = new Set(existing.filter((r) => !stale.includes(r)).map((r) => r.target_id));
  for (const { propertyId, after } of wanted) {
    for (const targetId of refIds(after)) {
      if (remaining.has(targetId)) continue;
      remaining.add(targetId);
      await tx.execute(sql`
        INSERT INTO relations (id, source_id, target_id, role, relation_type, meta,
                               created_at, updated_at)
        SELECT ${newId()}::uuid, ${entityId}::uuid, ${targetId}::uuid, ${ROLE_REF},
               ${projectLegacyRelationType(ROLE_REF)},
               jsonb_build_object('property', ${propertyId}::text), now(), now()
         WHERE EXISTS (SELECT 1 FROM entities e
                        WHERE e.id = ${entityId}::uuid AND e.owner_id = ${ownerId}::uuid)
        ON CONFLICT DO NOTHING`);
    }
  }
}

/**
 * Архивация цели помечает источники ссылок тегом `needs-review` (§А6-3) — ТЕМ ЖЕ tx, что и
 * сама архивация: пометка есть часть решения «ссылки остаются», и разъехаться с ним при
 * откате она не должна.
 *
 * Идемпотентна по построению: тег добавляется только там, где его ещё нет, поэтому повторная
 * архивация (и архивация того, что уже архивно) тега не плодит.
 *
 * `updated_at` НЕ двигается — по той же причине, что у пересчёта предков: это не правка
 * владельца, а следствие чужого действия, и сдвиг метки ронял бы CAS соседней правки.
 *
 * Возвращает id ПОМЕЧЕННЫХ строк — ровно тех, кому тег поставила ЭТА операция. Список точен
 * благодаря гейту `NOT (… = ANY(tags))`: источник, у которого тег уже стоял, в `RETURNING` не
 * попадает. Он уезжает в журнал и по нему же откат снимает пометку (Р-11-1, см.
 * `unmarkRefSources`), поэтому счётчиком тут не обойтись.
 */
export async function markRefSourcesNeedsReview(
  tx: Tx,
  ownerId: string,
  archivedTargetId: string,
): Promise<string[]> {
  const rows = (await tx.execute(sql`
    UPDATE entities e
       SET tags = e.tags || ARRAY[${NEEDS_REVIEW_TAG}]::text[]
     WHERE e.owner_id = ${ownerId}::uuid
       AND NOT (${NEEDS_REVIEW_TAG} = ANY(e.tags))
       AND EXISTS (SELECT 1 FROM relations r
                    WHERE r.target_id = ${archivedTargetId}::uuid
                      AND r.role = ${ROLE_REF} AND r.source_id = e.id)
    RETURNING e.id`)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Снятие пометки `needs-review` при откате архивации (рулинг координатора Р-11-1).
 *
 * ПОЧЕМУ ОТКАТ ВООБЩЕ СНИМАЕТ ТЕГ. §А6-3 про undo молчит, а правило ветки «undo — полный
 * откат операции» — нет. Цена молчания названа: случайная архивация ходовой категории метит
 * сотни источников, undo возвращает категорию, а теги остаются навсегда — массового снятия в
 * v1 нет. Если владелец решит, что «тег снимает только человек», инверсия убирается одной
 * веткой в `undo.ts`, а список id в журнале остаётся полезным для аудита.
 *
 * Снимается тег ТОЛЬКО у тех, кому его поставила отменяемая операция (список из журнала), и
 * ТОЛЬКО если у источника не осталось ни одной ссылки на архивную цель. Второе условие — не
 * перестраховка: тег один на все причины, и источник, помеченный сперва архивацией цели A, а
 * потом ссылающийся ещё и на архивную B, при откате A обязан остаться помеченным — иначе
 * откат одной операции стирал бы след другой.
 *
 * Возвращает id строк, с которых тег снят: тем же журналом мерится, что откат сработал.
 */
export async function unmarkRefSources(
  tx: Tx,
  ownerId: string,
  sourceIds: readonly string[],
): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const rows = (await tx.execute(sql`
    UPDATE entities e
       SET tags = array_remove(e.tags, ${NEEDS_REVIEW_TAG})
     WHERE e.owner_id = ${ownerId}::uuid
       AND e.id = ANY(${uuidArray(sourceIds)})
       AND ${NEEDS_REVIEW_TAG} = ANY(e.tags)
       AND NOT EXISTS (SELECT 1 FROM relations r
                         JOIN entities t ON t.id = r.target_id
                        WHERE r.source_id = e.id AND r.role = ${ROLE_REF} AND t.archived)
    RETURNING e.id`)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
