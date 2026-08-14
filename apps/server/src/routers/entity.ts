// apps/server/src/routers/entity.ts
// Роутер entity (§9.1): ТОЛЬКО трансляция — вход → executor/компилятор, результат → wire,
// коды executor'а → TRPCError. Бизнес-логики здесь нет: мутации идут единственным путём
// через execute (§9.2), чтения — под withIdentity (RLS, §4.10).
import {
  entityCreateInput,
  entityGetUiInput,
  entityResolveRefsInput,
  entitySuggestInput,
  entityUpdateUiInput,
  parseQuery,
  type QueryAst,
} from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { escalateAfterMutation } from '../ai/escalation';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { type EntityReadResult, readEntity } from '../entity-read';
import { ExecError, execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { WireEntity } from '../executor/types';
import { type GoalProgress, goalProgressFor } from '../goals/progress';
import {
  type CompileContext,
  compileCount,
  compileQuery,
  QueryCompileError,
} from '../query/compile';
import { queryWithMaterialization } from '../recurring/with-materialization';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';
import { toWireEntityFromSql } from '../wire';

// Боевой синк — один инстанс на модуль: makeChatJournalSink состояния не хранит,
// а тред/сообщение он пишет тем же tx, что executor (§7.8).
const sink = makeChatJournalSink();

/** Разбор запроса: ошибки парсинга → BAD_REQUEST, структура в cause (§6.4). */
function parseOrThrow(query: string, cctx: CompileContext): QueryAst {
  const parsed = parseQuery(query, cctx.catalog);
  if (!parsed.ok) {
    // Клиент (1c) рендерит красную плашку по {message, position}
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: parsed.error.message,
      cause: parsed.error,
    });
  }
  return parsed.ast;
}

/** Компиляция AST: ошибки компиляции → BAD_REQUEST (§6.4). */
function compileAstOrThrow(
  ast: QueryAst,
  cctx: CompileContext,
  compile: typeof compileQuery | typeof compileCount,
) {
  try {
    return compile(ast, cctx);
  } catch (e) {
    if (e instanceof QueryCompileError) {
      // Структурная ошибка компиляции (`this` вне контекста): позиция неизвестна
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: e.message,
        cause: { message: e.message },
      });
    }
    throw e;
  }
}

/**
 * Хук материализации (01 §5.4) для query/count: общий каркас queryWithMaterialization —
 * контекст + парс, при окне по start_at/occurred_on — материализация recurring-инстансов
 * ДО компиляции/исполнения; без окна запрос исполняется тем же tx (детали — в
 * recurring/with-materialization.ts, тот же каркас у LLM/MCP-диспатча entity_query).
 */
function runQueryWithMaterialization<T>(
  db: Db,
  actorUserId: string,
  input: { query: string; thisEntityId?: string },
  run: (tx: Tx, ast: QueryAst, cctx: CompileContext) => Promise<T>,
): Promise<T> {
  return queryWithMaterialization({
    db,
    actorUserId,
    thisEntityId: input.thisEntityId ?? null,
    parse: (cctx) => parseOrThrow(input.query, cctx),
    run,
  });
}

const querySignature = z
  .object({ query: z.string().min(1), thisEntityId: z.string().uuid().optional() })
  .strict();

/** Строка чипа/пункта меню: РОВНО то, что рисуется, — не сущность целиком. */
export interface EntitySuggestion {
  id: string;
  title: string;
  emoji: string | null;
  /** Статус task-аспекта плоским полем: чипу и пикеру нужен только он (зачеркнуть done). */
  status: string | null;
  archived: boolean;
}

/** Ровно те пять колонок, из которых строится подсказка; у сырой строки имена те же. */
interface SuggestionRow {
  id: unknown;
  title: unknown;
  emoji: unknown;
  aspects: unknown;
  archived: unknown;
}

/**
 * Маппинг строки (jsonb уже разобран драйвером — как у toWireEntityFromSql) в форму
 * подсказки. Годится и сырой выдаче, и select'у drizzle: все пять имён односложные,
 * snake_case и camelCase у них совпадают.
 */
function toSuggestion(row: SuggestionRow): EntitySuggestion {
  const aspects = (row.aspects ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const status = aspects['orbis/task']?.status;
  return {
    id: String(row.id),
    title: String(row.title),
    emoji: row.emoji == null ? null : String(row.emoji),
    status: typeof status === 'string' ? status : null,
    archived: row.archived === true,
  };
}

/**
 * Пользовательский ввод внутрь шаблона LIKE: снимаем регистр (сравнение идёт с
 * `lower(title)`) и экранируем спецсимволы шаблона, иначе `%` искал бы что угодно,
 * `_` — любой символ, а `\` съедал бы следующий. Экранирующий символ — backslash
 * (умолчание LIKE в PG), поэтому в замене он и стоит.
 */
function escapeLike(value: string): string {
  return value.toLowerCase().replace(/[\\%_]/g, '\\$&');
}

export const entityRouter = router({
  // Источник клиентского create ограничен fast_path/quick_capture/ui (§7.5, 02 §5;
  // 'ui' — прямое действие владельца в форме, например создание конверта 03 §3.1);
  // 'chat'/'mcp'/'system' недостижимы через этот роутер по построению.
  create: ownerOnlyProcedure
    .input(
      z.object({ input: entityCreateInput, source: z.enum(['fast_path', 'quick_capture', 'ui']) }),
    )
    .mutation(async ({ ctx, input }): Promise<WireEntity & { actionId?: string }> => {
      const r = await execute(
        ctx.db,
        {
          actorUserId: ctx.actorUserId,
          actorKind: 'owner',
          source: input.source,
          operations: [{ tool: 'entity_create', input: input.input }],
        },
        { sink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      // actionId — для Undo прямо из UI-формы (03-budget §3.6, quick-add): аддитивное
      // поле поверх wire-сущности, потребители `.id` не задеты. При идемпотентном
      // replay (§5.3) журнал не писался — actionId под этим id не существует, не отдаём.
      const entity = r.results[0] as WireEntity;
      return r.idempotentReplay ? entity : { ...entity, actionId: r.actionId };
    }),

  // UI-вариант схемы: у владельца из редактора есть структурная форма тела, у тула модели —
  // нет. Тело процедуры от этого не меняется: путь записи один — executor.
  update: ownerOnlyProcedure
    .input(entityUpdateUiInput)
    .mutation(async ({ ctx, input }): Promise<WireEntity> => {
      const r = await execute(
        ctx.db,
        {
          actorUserId: ctx.actorUserId,
          actorKind: 'owner',
          source: 'ui', // прямое действие владельца в UI (не chat/mcp/system)
          operations: [{ tool: 'entity_update', input }],
        },
        { sink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      // Эскалация повторных исправлений категории (§7.8, решение K7): пост-коммит
      // хуков в executor'е нет — вызов идёт ЗДЕСЬ, после успешного execute, отдельной
      // транзакцией. Своей ошибки наружу не отдаёт: правка категории уже закоммичена.
      await escalateAfterMutation(ctx.db, {
        ownerId: ctx.actorUserId,
        actionId: r.actionId,
        operations: [{ tool: 'entity_update', input }],
      });
      return r.results[0] as WireEntity;
    }),

  // §9.2 entity_get: include-логика вынесена в общий хелпер entity-read.ts —
  // его же переиспользует диспатч тулов LLM/MCP (tools/dispatch.ts, 1b Task 4).
  get: protectedProcedure
    .input(entityGetUiInput)
    .query(async ({ ctx, input }): Promise<EntityReadResult & { goalProgress?: GoalProgress }> => {
      try {
        return await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
          const result = await readEntity(tx, ctx.actorUserId, input);
          // Прогресс цели (§11.3) — АДДИТИВНОЕ поле поверх формы readEntity, и добавляется
          // оно здесь, а не в самом readEntity: та форма — общий контракт с LLM/MCP-диспатчем
          // (tools/dispatch.ts), и всё, что в неё положено, уезжает в контекст модели.
          // Прогресс — материал прогресс-бара, модели он не нужен. Прецедент аддитивного
          // поля с явной аннотацией — actionId у create выше.
          // Той же tx: расчёт читает граф под уже установленной identity (RLS), своей
          // транзакции не открывает. Обычная сущность в него не заходит вовсе.
          const goalProgress = await goalProgressFor(tx, ctx.actorUserId, result.entity);
          return goalProgress === undefined ? result : { ...result, goalProgress };
        });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  query: protectedProcedure.input(querySignature).query(({ ctx, input }) =>
    runQueryWithMaterialization(ctx.db, ctx.actorUserId, input, async (tx, ast, cctx) => {
      const compiled = compileAstOrThrow(ast, cctx, compileQuery);
      const rows = await tx.execute(compiled);
      return [...rows].map((r) => toWireEntityFromSql(r as Record<string, unknown>));
    }),
  ),

  /**
   * Поиск сущности по заголовку для `/`-меню, @-упоминаний и пикеров. Грамматику `search=`
   * (§6.1) не трогаем: там семантика ЦЕЛОГО слова осмысленна и на неё завязаны сидированные
   * смарт-листы, а меню, не находящее по началу набранного слова, бесполезно. RLS скоупит
   * выдачу владельцем (§4.10) — своего owner_id в WHERE нет намеренно, источник правды о
   * видимости один.
   *
   * Сопоставление — по ВХОЖДЕНИЮ (`%фрагмент%`), а не по началу заголовка: якорь отнимал бы
   * находимость, которую давал прежний путь («Отчёт за квартал» обязан находиться набором
   * «квартал»), и превращал бы промах в немую «Ничего не найдено». Плата за снятие якоря
   * нулевая — индекса под этот запрос всё равно нет (см. ниже), а при Seq Scan оба шаблона
   * стоят одинаково. Релевантность держит ПЕРВЫЙ ключ сортировки: совпавшие с начала
   * заголовка идут выше вхождений в середине, и только потом свежесть.
   *
   * Индекса по заголовку здесь нет и заводить его бессмысленно — измерено EXPLAIN'ом:
   * `lower(text)` и `~~` не leakproof (pg_proc.proleakproof = false), а при включённом RLS
   * не-leakproof квал нельзя вычислить раньше security-квала политики, значит и в index cond
   * он не превращается. От роли postgres тот же запрос шёл Bitmap Index Scan, от
   * `authenticated` — Seq Scan даже при enable_seqscan=off; поэтому btree по lower(title) из
   * миграции 0007 убран, он только дорожал бы на каждой правке заголовка. Ровно та же участь
   * у GIN entities_title_fts под живущим в проде `search=` (to_tsvector/ts_match_vq тоже не
   * leakproof) — это свойство схемы, а не беда этой процедуры. Фактически план опирается на
   * entities_owner_updated (owner_id, updated_at DESC) WHERE NOT archived, то есть стоимость
   * линейна по числу сущностей ВЛАДЕЛЬЦА, а не всей таблицы. Путь на будущее, если счёт
   * сущностей вырастет, — хранимая колонка lower(title) с btree text_pattern_ops и запрос
   * явным диапазоном: операторы диапазона по КОЛОНКЕ leakproof, и квал снова станет
   * индексируемым (гипотеза, не мерена).
   */
  suggest: protectedProcedure
    .input(entitySuggestInput)
    .query(({ ctx, input }): Promise<EntitySuggestion[]> => {
      const limit = input.limit ?? 10;
      const needle = escapeLike(input.prefix);
      const anywhere = `%${needle}%`;
      const fromStart = `${needle}%`;
      return withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        // Закрытые задачи НЕ фильтруются намеренно: упомянуть сделанное — валидный сценарий
        // ссылки, а чип сам зачёркивает done/cancelled. Архивные — отфильтрованы: их прячет
        // весь UI. Решение зафиксировано при v2 (ревью И14 требовало явности).
        //
        // Тай-брейк по id обязателен (M4): updated_at по умолчанию now() — время НАЧАЛА
        // транзакции, поэтому всё, созданное одним batch_execute, несёт ОДИН штамп, и без
        // последнего ключа порядок таких строк определял бы план. id — UUIDv7, так что DESC
        // читается как «свежее выше» (тот же тай-брейк — llm/context.ts:126).
        const rows = await tx.execute(
          sql`SELECT id, title, emoji, aspects, archived FROM entities
              WHERE archived = false AND lower(title) LIKE ${anywhere}
              ORDER BY (lower(title) LIKE ${fromStart}) DESC, updated_at DESC, id DESC
              LIMIT ${limit}`,
        );
        return [...rows].map((r) => toSuggestion(r as unknown as SuggestionRow));
      });
    }),

  /**
   * Заголовки для чипов ссылок ОДНИМ запросом. Per-id entity.get годится для коротких
   * списков связей, но в теле записи ссылок может быть много, и там это шторм запросов.
   * Отдаём ровно то, что рисует чип, а не сущность целиком.
   *
   * Архивные НЕ отфильтрованы, в отличие от suggest: ссылка на архивную сущность в теле
   * остаётся ссылкой, и спрятать заголовок значило бы показать вместо названия обрубок id.
   * Признак `archived` отдаём — рисовать решает чип. Ненайденные (в т.ч. чужие под RLS)
   * просто отсутствуют в ответе.
   */
  resolveRefs: protectedProcedure.input(entityResolveRefsInput).query(
    ({ ctx, input }): Promise<EntitySuggestion[]> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        // Не сырое `= ANY($1::uuid[])`: массив из шаблона `sql` уезжает в драйвер как есть и
        // падает «malformed array literal» (проверено пробой). inArray — идиома репозитория
        // (ai/escalation.ts:217, recurring/materialize.ts:285) и разворачивается в IN-список.
        const rows = await tx
          .select({
            id: entities.id,
            title: entities.title,
            emoji: entities.emoji,
            aspects: entities.aspects,
            archived: entities.archived,
          })
          .from(entities)
          .where(inArray(entities.id, input.ids));
        return rows.map(toSuggestion);
      }),
  ),

  // Бейджи (02 §3.2): count игнорирует limit — compileCount не включает его по построению
  count: protectedProcedure.input(querySignature).query(({ ctx, input }) =>
    runQueryWithMaterialization(ctx.db, ctx.actorUserId, input, async (tx, ast, cctx) => {
      const compiled = compileAstOrThrow(ast, cctx, compileCount);
      const rows = await tx.execute(compiled);
      return { count: Number(rows[0]?.count) };
    }),
  ),
});
