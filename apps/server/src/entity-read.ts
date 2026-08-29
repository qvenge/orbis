// apps/server/src/entity-read.ts
// §9.2 entity_get: include-логика полного чтения одной сущности — ОБЩИЙ хелпер
// роутера entity (tRPC) и диспатча тулов LLM/MCP (tools/dispatch.ts), не копия.
// include по умолчанию body+relations; entity возвращается целиком (wire-форма
// entitySchema всегда несёт body), include управляет доп. секциями.
// Вызывается ТОЛЬКО под withIdentity (RLS, §4.10); ошибки — ExecError (роутер
// мапит в TRPCError, диспатч — в структурированный error-результат).
import { type EntityGetUiInput, entityThreadId, ROLE_MENTION, ROLE_REF } from '@orbis/shared';
import { readBodyDoc } from '@orbis/shared/doc';
import { desc, eq, or, sql } from 'drizzle-orm';
import type { WireChatMessage } from './chat/messages';
import { chatMessages, entities, relations } from './db/schema';
import type { Tx } from './db/with-identity';
import { ExecError } from './errors';
import type { WireEntity, WireRelation } from './executor/types';
import { effectiveRegistry } from './registry/cache';
import type { RegistrySnapshot } from './registry/load';
import { toWireChatMessage, toWireEntity, toWireEntityFromSql, toWireRelation } from './wire';

/**
 * Источник обратной ссылки (02-core-os §3.5.8): явная связь роли `mention`, упоминание из
 * body_refs или ССЫЛОЧНОЕ СВОЙСТВО — ребро роли `ref` (§А6-2, §А8 «backlinks видят
 * правила»). Третий вариант появился вместе с зеркалом ссылок: до него открытая категория
 * не показывала ни своих транзакций, ни правил памяти, которые её назначают.
 */
export type BacklinkVia = 'relation' | 'mention' | 'ref';

export interface Backlink {
  entity: WireEntity;
  via: BacklinkVia;
  /**
   * Подпись направления, готовая к показу: её даёт РЕЕСТР ролей (Ч10-С3), а не словарь в
   * web. Для связи это подпись ДРУГОЙ стороны («Упоминает» у того, кто сослался на нас,
   * «Упомянуто» у того, на кого сослались мы), для body_refs — «упоминание», а для
   * ссылочного свойства — `label` САМОГО СВОЙСТВА («Категория»), а не роли `ref`: владельцу
   * важно, ЧЕМ на него сослались, и подпись роли («Откуда ссылка») этого не говорит.
   *
   * Поле обязательное, а не опциональное: секция показывает подпись у каждой строки, и
   * `undefined` тут значил бы «нарисуй что-нибудь сам» — ровно тот словарь в клиенте,
   * который реформа и убирает.
   */
  viaLabel: string;
}

// Роли секции «Связанное» — `ROLE_MENTION` и `ROLE_REF` (общий дом поимённых ролей —
// `@orbis/shared/constants`). До реформы секцию собирал схлопнутый `related_to`, куда
// проецируются ещё `alternative-of` и `supersedes`, — то есть «это альтернатива» и «это
// замена» показывались как «связь». Роль их развела, и секция стала ровно про упоминания;
// рёбра `ref` присоединены к ней §А6-2: открытая категория обязана показывать и свои
// транзакции, и правила памяти, которые её назначают (§А8 «backlinks видят правила»).

/** Потолок объединённой секции «Связанное» (sign-off K1): это экран, а не выгрузка. */
const BACKLINKS_LIMIT = 100;

/**
 * Подпись упоминания из тела. Не из реестра, и это не пробел: у ссылки `[[entity:…]]` роли
 * нет вовсе — её носитель `body_refs`, а не строка связи, и подписывать её определением
 * роли значило бы приписать ей смысл, которого в графе нет.
 */
const MENTION_LABEL = 'упоминание';

/**
 * Русские подписи сторон роли `mention` из ЭФФЕКТИВНОГО реестра — ИЗ СНИМКА, а не своим
 * SQL'ом (гейт-ревью Important-2).
 *
 * Прежде здесь стоял точечный запрос по `effectiveRolesSql()`. Он давал ту же строку,
 * пока «эффективное определение» означало «система ⊕ свои строки»; с приходом дельт
 * (§А3-2) означать это перестало — подпись, переопределённая дельтой, до сырого запроса
 * не доезжает, и секция «Связанное» показывала бы системное имя там, где владелец задал
 * своё. Снимок с Задачи 14 дёшев (процессный кеш по версии), поэтому расхождение
 * устранено, а не задокументировано.
 *
 * Отсутствие строки — сломанный реестр, а не штатный случай, но ронять чтение сущности
 * из-за подписи нельзя: вызывающий подставит id роли, и владелец увидит, что не найдено.
 */
function mentionSideLabels(reg: RegistrySnapshot): { source: string; target: string } | undefined {
  const def = reg.roles.get(ROLE_MENTION);
  if (def === undefined) return undefined;
  // Русской подписи может не быть у СВОЕЙ роли владельца (реестр требует хотя бы одну
  // локаль, а не именно ru) — тогда честнее показать id роли, чем пустую строку.
  return {
    source: def.sourceLabel.ru ?? ROLE_MENTION,
    target: def.targetLabel.ru ?? ROLE_MENTION,
  };
}

/**
 * Русские подписи СВОЙСТВ по их id — из СНИМКА эффективного реестра (§А6-2): ими подписаны
 * ссылочные обратные связи. По той же причине, что у подписей ролей выше: переопределение
 * подписи встроенного свойства дельтой (`PropertyDelta`, Р19) — это её прямое назначение,
 * и сырой запрос его не видел бы.
 *
 * Свойство, которого в реестре нет, подписи не получает (карта его просто не содержит), и
 * вызывающий подставит id: сломанный реестр не должен ронять чтение сущности.
 */
function propertyLabels(reg: RegistrySnapshot, ids: readonly string[]): Map<string, string> {
  return new Map(
    ids.flatMap((id) => {
      const label = reg.properties.get(id)?.label.ru;
      return label === undefined ? [] : [[id, label] as [string, string]];
    }),
  );
}

export interface EntityReadResult {
  entity: WireEntity;
  relations?: WireRelation[];
  backlinks?: Backlink[];
  /**
   * Секция «Связанное» упёрлась в потолок — за списком есть ещё связи (DF п.4).
   * Присутствует, только когда усечение реально произошло: молчаливого обрезания быть
   * не должно (урок C6), а `false` на каждом чтении — шум и в UI, и в контексте модели.
   */
  backlinksTruncated?: boolean;
  thread?: { threadId: string; messages: WireChatMessage[] };
}

/**
 * Вход — UI-вариант схемы: он отличается от тул-контракта одним лишним значением include
 * ('bodyDoc'), а массивы в TS ковариантны, поэтому узкий EntityGetInput диспатча тулов сюда
 * подходит без union'а и без приведений. Более узкий тип не годится: `include.has('bodyDoc')`
 * на Set<'body'|'relations'|'backlinks'|'thread'> не компилируется.
 */
export async function readEntity(
  tx: Tx,
  ownerId: string,
  input: EntityGetUiInput,
): Promise<EntityReadResult> {
  const include = new Set(input.include ?? ['body', 'relations']);
  const rows = await tx.select().from(entities).where(eq(entities.id, input.id));
  const row = rows[0];
  // RLS: чужая и несуществующая неразличимы — единый NOT_FOUND
  if (!row) {
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.id });
  }

  // Тело, созданное до этой работы, документа ещё не имеет — собираем на лету. Правило
  // разрешения общее с клиентом (readBodyDoc): битую форму или версию из будущего пересобираем
  // из `body`, теряя оформление, но не текст. Обратно в БД здесь НЕ пишем: чтение обязано
  // оставаться чтением, а колонку заполнит бэкфилл или первое же сохранение. Порядок важен —
  // после создания `out` документ уехал бы в wire сырым.
  const wantsDoc = include.has('bodyDoc');
  if (wantsDoc) row.bodyDoc = readBodyDoc(row.bodyDoc, row.body);

  const out: EntityReadResult = { entity: toWireEntity(row, wantsDoc) };

  if (include.has('relations')) {
    const rels = await tx
      .select()
      .from(relations)
      .where(or(eq(relations.sourceId, row.id), eq(relations.targetId, row.id)))
      .orderBy(relations.createdAt, relations.id);
    out.relations = rels.map(toWireRelation);
  }
  if (include.has('backlinks')) {
    // §3.5.8: ОДНА секция из двух источников — явные связи роли `mention` обеих сторон и
    // упоминания через body_refs (GIN-индекс §4.9). row.id — каноничный
    // lowercase из БД (body_refs нормализованы экстрактором, сравнение text[]
    // регистрозависимо). Подзапросы по relations тоже под RLS — чужие связи невидимы.
    //
    // ПОЧЕМУ UNION, А НЕ ОДИН WHERE С OR (уборочная фаза, E7). Условие вида
    // `body_refs @> ARRAY[id] OR id IN (SELECT … FROM relations) OR …` планировщик не
    // покрывает `entities_body_refs_gin` целиком: ветки с IN(подзапрос) дают hashed
    // SubPlan, BitmapOr не строится — остаётся seq scan по entities. А запрос горячий:
    // 'backlinks' входит в DETAIL_INCLUDE, то есть уходит на КАЖДОМ открытии detail,
    // и после CSV-импортов фазы C сканировать приходится тысячи строк. Развод на два
    // индексируемых источника (GIN по body_refs + два индексных доступа по relations)
    // с объединением в UNION даёт планировщику работать по индексам; пометка via
    // сохраняется LEFT JOIN'ом на тот же CTE связей.
    //
    // Форма ответа НЕ меняется — контракт readEntity общий с LLM/MCP-диспатчем и
    // запиннен entity-backlinks.test.ts, который правкой не тронут.
    const rows = await tx.execute(sql`
      WITH rel AS MATERIALIZED (
        SELECT target_id AS id, false AS incoming FROM relations
          WHERE source_id = ${row.id} AND role = ${ROLE_MENTION}
        UNION
        SELECT source_id AS id, true AS incoming FROM relations
          WHERE target_id = ${row.id} AND role = ${ROLE_MENTION}
      ), rel_side AS (
        -- Сущность может и упоминать нас, и быть упомянутой нами: строка в секции всё равно
        -- ОДНА (см. ниже «связь сильнее упоминания»), поэтому направления схлопываются здесь,
        -- до объединения ids. Без свёртки LEFT JOIN ниже раздвоил бы такую строку.
        -- Приоритет входящему: «на нас сослались» — то, ради чего секция и открывается.
        SELECT id, bool_or(incoming) AS incoming FROM rel GROUP BY id
      ), ref_side AS MATERIALIZED (
        -- Источники ссылочных свойств (§А6-2): только ВХОДЯЩИЕ. Исходящих здесь нет
        -- намеренно — цель собственной ссылки владелец и так видит значением свойства на
        -- этой же карточке, и вторая её строка в «Связанном» была бы тем же фактом дважды.
        -- Строка на источник ровно одна, и это ОПОРА НА ИНТЕРВАЛЬНЫЙ ИНВАРИАНТ: до
        -- contract-миграции 0017 rel_uniq стоит на тройке с колонкой relation_type, и двух
        -- рёбер роли ref между той же парой концов не бывает — поэтому свёртки, как у
        -- rel_side выше, здесь не требуется. С 0017 (rel_uniq по роли) инвариант падает, и
        -- сюда придётся дописать GROUP BY source_id: без него LEFT JOIN ниже раздвоит строку
        -- источника, сославшегося на нас двумя разными свойствами. Место названо для грепа
        -- Задачи 23: ключ поиска — 0017.
        SELECT source_id AS id, meta->>'property' AS property FROM relations
          WHERE target_id = ${row.id} AND role = ${ROLE_REF}
      ), ids AS (
        SELECT id FROM entities WHERE body_refs @> ARRAY[${row.id}]::text[]
        UNION
        SELECT id FROM rel_side
        UNION
        SELECT id FROM ref_side
      )
      SELECT e.id, e.owner_id, e.title, e.emoji, e.body, e.body_refs, e.tags,
             -- Столбцы те же, что в SELECT-листе компилятора (§6): их ждёт
             -- toWireEntityFromSql, и списочное чтение обязано нести ту же новую форму,
             -- что и одиночное (иначе backlinks молча отдают пустые props/aspects).
             e.props, e.aspects, e.query_refs,
             e.created_at, e.updated_at, e.archived,
             rel_side.id IS NOT NULL AS via_relation,
             rel_side.incoming AS via_incoming,
             ref_side.property AS via_property
        FROM ids
        JOIN entities e ON e.id = ids.id
        LEFT JOIN rel_side ON rel_side.id = e.id
        LEFT JOIN ref_side ON ref_side.id = e.id
       WHERE NOT e.archived
       -- СВЕЖИЕ первыми (DF п.4): при возрастающем порядке потолок отбрасывал ровно ту
       -- связь, которую пользователь только что создал. Лишняя строка сверх потолка —
       -- проба усечения: точный ответ «за списком есть ещё» ценой одной строки.
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ${BACKLINKS_LIMIT + 1}`);
    const refs = [...rows] as Array<Record<string, unknown>>;
    const truncated = refs.length > BACKLINKS_LIMIT;
    // Подписи сторон — одним запросом и ТОЛЬКО когда в секции есть хоть одна связь: у
    // упоминаний из тела роли нет вовсе, и на большинстве открытий detail запрос не уходит.
    const shown = refs.slice(0, BACKLINKS_LIMIT);
    //
    // Снимок реестра берётся ЛЕНИВО и ОДИН на обе подписи: у большинства открытий секция
    // пуста, и платить за него нечем; когда подписывать есть что, второй снимок в той же
    // транзакции разошёлся бы с первым не мог, но стоил бы лишней сверки версии.
    const needsSides = shown.some((r) => r.via_relation === true);
    // Подписи свойств — тем же правилом «только если есть кого подписывать»; берутся по
    // ПОКАЗЫВАЕМЫМ строкам, а не по всей выдаче: усечённая строка подписи не получит.
    const properties = [
      ...new Set(
        shown.flatMap((r) => (typeof r.via_property === 'string' ? [r.via_property] : [])),
      ),
    ];
    const reg =
      needsSides || properties.length > 0 ? await effectiveRegistry(tx, ownerId) : undefined;
    const sides = needsSides && reg !== undefined ? mentionSideLabels(reg) : undefined;
    const propertyLabelById =
      reg === undefined ? new Map<string, string>() : propertyLabels(reg, properties);
    // Ссылка свойства сильнее связи, связь — сильнее упоминания: у сущности, пришедшей
    // сразу двумя путями, строка ОДНА, и подписана она самым точным из них — тем, который
    // называет ИМЕННО ЧЕМ на нас сослались.
    out.backlinks = shown.map((r) => {
      // toWireEntityFromSql, а не toWireEntity: в сырой выдаче drizzle гасит date-парсеры
      // postgres.js, и created_at/updated_at приезжают строкой PG (прецедент — агрегаты).
      const entity = toWireEntityFromSql(r);
      if (typeof r.via_property === 'string') {
        return {
          entity,
          via: 'ref' as const,
          viaLabel: propertyLabelById.get(r.via_property) ?? r.via_property,
        };
      }
      return {
        entity,
        via: r.via_relation === true ? ('relation' as const) : ('mention' as const),
        viaLabel:
          r.via_relation === true
            ? // Подпись ДРУГОЙ стороны: на нас сослались — она источник, сослались мы — цель.
              ((r.via_incoming === true ? sides?.source : sides?.target) ?? ROLE_MENTION)
            : MENTION_LABEL,
      };
    });
    if (truncated) out.backlinksTruncated = true;
  }
  if (include.has('thread')) {
    // Детерминированный id (§4.5); лениво НЕ создаёт: нет треда → пустой список
    const threadId = entityThreadId(ownerId, row.id);
    const msgs = await tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id));
    out.thread = { threadId, messages: msgs.map(toWireChatMessage) };
  }
  return out;
}
