// apps/server/src/routers/entity.ts
// Роутер entity (§9.1): ТОЛЬКО трансляция — вход → executor/компилятор, результат → wire,
// коды executor'а → TRPCError. Бизнес-логики здесь нет: мутации идут единственным путём
// через execute (§9.2), чтения — под withIdentity (RLS, §4.10).
import {
  entityCreateUiInput,
  entityGetUiInput,
  entityResolveRefsInput,
  entitySuggestInput,
  entityUpdateUiInput,
} from '@orbis/shared';
import {
  QUERY_TREE_DEPTH_CAP,
  type QueryAst,
  queryAstSchema,
  queryTreeExceedsDepth,
} from '@orbis/shared/query';
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
import { type CompileCtx, compileCountAst, compileQueryAst } from '../query/compile-ast';
import { parseQueryText } from '../query/parse-text';
import { queryWithMaterialization } from '../recurring/with-materialization';
import { readRegistryVersions } from '../registry/version';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';
import { registryVersionOf, toWireEntityFromSql } from '../wire';

// Боевой синк — один инстанс на модуль: makeChatJournalSink состояния не хранит,
// а тред/сообщение он пишет тем же tx, что executor (§7.8).
const sink = makeChatJournalSink();

/**
 * Разбор и компиляция запроса: структурный отказ → BAD_REQUEST со структурой в `cause` (§6.4).
 *
 * Обе стадии ходят через ОДИН перевод, потому что обе теперь бросают одно и то же —
 * `ExecError('VALIDATION')`: разбор текста (`parseQueryText`, обе формы) и компилятор канона
 * (`compile-ast`, неизвестный id свойства, `this` вне контекста, значение не той формы).
 * Клиент (1c) рисует красную плашку по `{message, position}`, и позиция приезжает в
 * `details` там, где она есть, — у компиляции её нет и не бывает.
 */
function queryErrorToTRPC(e: unknown): never {
  if (e instanceof ExecError && e.code === 'VALIDATION') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: e.message,
      cause: { message: e.message, ...(e.details as Record<string, unknown> | undefined) },
    });
  }
  throw e;
}

function parseOrThrow(query: string, cctx: CompileCtx): QueryAst {
  try {
    return parseQueryText(query, cctx);
  } catch (e) {
    return queryErrorToTRPC(e);
  }
}

function compileAstOrThrow(
  ast: QueryAst,
  cctx: CompileCtx,
  compile: typeof compileQueryAst | typeof compileCountAst,
) {
  try {
    return compile(ast, cctx);
  } catch (e) {
    return queryErrorToTRPC(e);
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
  input: QueryInput,
  run: (tx: Tx, ast: QueryAst, cctx: CompileCtx) => Promise<T>,
): Promise<T> {
  return queryWithMaterialization({
    db,
    actorUserId,
    thisEntityId: input.thisEntityId ?? null,
    // Дерево со входа `ast` идёт мимо разбора — как у тула (§А5-4, «два входа, один путь»):
    // дальше окно материализации, компиляция и выдача у обеих форм одни.
    parse: (cctx) => input.ast ?? parseOrThrow(input.query as string, cctx),
    run,
  });
}

/**
 * Вход чтений `entity.query`/`entity.count`: текст грамматики ИЛИ готовый Q-AST — РОВНО
 * ОДНО из двух, той же дисциплиной, что у тула (`entityQueryInput`, §А5-4).
 *
 * Второй вход завела Задача 13c ради пикера ссылочных свойств: цель `ref` объявлена в
 * реестре ДЕРЕВОМ (`{kind:'ref', target: Q-AST}`, §А6-1), а плоский текст §А5-3 дерева не
 * выражает — печать `or`/`not` даёт скобочную форму, которую разбор честно отвергает.
 * Печатать цель в текст, чтобы сервер разобрал её обратно, значило бы пропускать её через
 * форму, в которую она не помещается: половина законных целей отказывала бы на пикере.
 *
 * ВХОД-ДЕРЕВА 2. ГЛУБИНА ПРОВЕРЯЕТСЯ ДО СХЕМЫ, и порядок здесь — суть, а не стиль (тот же довод, что у
 * `assertQueryTreeDepth` тула): `queryAstSchema` рекурсивна через `z.lazy` и на достаточно
 * глубоком входе исчерпывает стек ВНУТРИ собственного разбора — то есть проверка, стоящая
 * после схемы, не выполнилась бы никогда. `z.preprocess` — единственное место конвейера
 * tRPC, которое работает раньше схемы.
 */
const querySignature = z.preprocess(
  (raw) => {
    const ast =
      typeof raw === 'object' && raw !== null ? (raw as { ast?: unknown }).ast : undefined;
    // Меряется ДЕРЕВО, а не конверт: число в отказе обязано быть тем же, что считает код.
    if (queryTreeExceedsDepth(ast, QUERY_TREE_DEPTH_CAP)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          `дерево запроса вложено глубже ${QUERY_TREE_DEPTH_CAP} уровней — ` +
          'столько не нужно ни одному осмысленному запросу',
      });
    }
    return raw;
  },
  z
    .object({
      query: z.string().min(1).optional(),
      ast: queryAstSchema.optional(),
      thisEntityId: z.string().uuid().optional(),
    })
    .strict()
    .refine(
      (v) => (v.query === undefined) !== (v.ast === undefined),
      'entity.query принимает ровно одно: текст запроса (query) ИЛИ готовое дерево (ast)',
    ),
);

type QueryInput = z.infer<typeof querySignature>;

/** Строка чипа/пункта меню: РОВНО то, что рисуется, — не сущность целиком. */
export interface EntitySuggestion {
  id: string;
  title: string;
  emoji: string | null;
  /** Статус task-аспекта плоским полем: чипу и пикеру нужен только он (зачеркнуть done). */
  status: string | null;
  archived: boolean;
}

/**
 * Ровно те шесть колонок, из которых строится подсказка. Сырой SELECT называет их ТАК ЖЕ —
 * и с переводом на `props`/`aspects[]` алиасы в нём больше не нужны вовсе: обе колонки
 * односложные и в нижнем регистре, сворачивать имена Postgres'у нечего.
 */
interface SuggestionRow {
  id: unknown;
  title: unknown;
  emoji: unknown;
  props: unknown;
  aspects: unknown;
  archived: unknown;
}

/**
 * Маппинг строки (jsonb уже разобран драйвером — как у toWireEntityFromSql) в форму
 * подсказки. Годится и сырой выдаче, и select'у drizzle: имена полей у обеих одинаковы.
 *
 * Статус читается ПОД признаком носителя (Р9): `orbis/task_status` остаётся в `props` и
 * после снятия аспекта задачи, а старая карта теряла его вместе с аспектом. Без признака
 * чип зачёркивал бы как «сделанное» запись, задачей быть переставшую.
 */
function toSuggestion(row: SuggestionRow): EntitySuggestion {
  const aspects = (row.aspects ?? []) as string[];
  const props = (row.props ?? {}) as Record<string, unknown>;
  const status = aspects.includes('orbis/task') ? props['orbis/task_status'] : undefined;
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
      z.object({
        input: entityCreateUiInput,
        source: z.enum(['fast_path', 'quick_capture', 'ui']),
      }),
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
    .query(
      async ({
        ctx,
        input,
      }): Promise<EntityReadResult & { goalProgress?: GoalProgress; registryVersion: string }> => {
        try {
          return await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
            const result = await readEntity(tx, ctx.actorUserId, input);
            // Прогресс цели (§11.3) — АДДИТИВНОЕ поле поверх формы readEntity, и добавляется
            // оно здесь, а не в самом readEntity: та форма — общий контракт с
            // LLM/MCP-диспатчем (tools/dispatch.ts), и всё, что в неё положено, уезжает в
            // контекст модели. Прогресс — материал прогресс-бара, модели он не нужен.
            // Прецедент аддитивного поля с явной аннотацией — actionId у create выше.
            // Той же tx: расчёт читает граф под уже установленной identity (RLS), своей
            // транзакции не открывает. Обычная сущность в него не заходит вовсе.
            const goalProgress = await goalProgressFor(tx, ctx.actorUserId, result.entity);
            /**
             * Версия реестра (§А10-1) — второе аддитивное поле, и по тому же правилу: в
             * `readEntity` её класть нельзя (контракт с диспатчем тулов, модели она не
             * нужна). Едет она ЗДЕСЬ, а не отдельной ручкой, потому что клиенту нужен не
             * опрос версии, а ПОВОД перечитать реестр: `entity.get` уходит после каждой
             * правки графа (invalidateGraph), то есть ровно тогда, когда снимок мог
             * устареть, — и клиентский кеш реестра инвалидируется несовпадением этой
             * строки с той, под которой он сложен (`['registry', version]`, §А9-2).
             *
             * Отдельный запрос `readRegistryVersions`, а не полный `effectiveRegistry`: ради
             * одного числа тянуть 77 свойств, 13 аспектов и 11 ролей на каждое открытие
             * записи дороже самой записи. Цена — один точечный SELECT в той же tx.
             */
            const registryVersion = registryVersionOf(
              await readRegistryVersions(tx, ctx.actorUserId),
            );
            return goalProgress === undefined
              ? { ...result, registryVersion }
              : { ...result, goalProgress, registryVersion };
          });
        } catch (e) {
          if (e instanceof ExecError) throw execErrorToTRPC(e);
          throw e;
        }
      },
    ),

  query: protectedProcedure.input(querySignature).query(({ ctx, input }) =>
    runQueryWithMaterialization(ctx.db, ctx.actorUserId, input, async (tx, ast, cctx) => {
      const compiled = compileAstOrThrow(ast, cctx, compileQueryAst);
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
      const needle = escapeLike(input.term);
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
          sql`SELECT id, title, emoji, props, aspects, archived FROM entities
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
            props: entities.props,
            aspects: entities.aspects,
            archived: entities.archived,
          })
          .from(entities)
          .where(inArray(entities.id, input.ids));
        return rows.map(toSuggestion);
      }),
  ),

  // Бейджи (02 §3.2): count игнорирует limit — compileCountAst не включает его по построению
  count: protectedProcedure.input(querySignature).query(({ ctx, input }) =>
    runQueryWithMaterialization(ctx.db, ctx.actorUserId, input, async (tx, ast, cctx) => {
      const compiled = compileAstOrThrow(ast, cctx, compileCountAst);
      const rows = await tx.execute(compiled);
      return { count: Number(rows[0]?.count) };
    }),
  ),
});
