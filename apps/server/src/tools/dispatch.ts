// apps/server/src/tools/dispatch.ts
// Диспатч тулов LLM/MCP (§9.2) поверх executor'а — контракт для Task 9 (ai.sendMessage)
// и Task 10 (MCP-адаптер). Семантика: (1) резолв тула по реестру (неизвестный —
// ряд «!known → forbidden» политики §7.10, error/FORBIDDEN_LEVEL); (2) чтения — под
// withIdentity, без ветвлений политики (ряд «read → execute»); (3) мутации — уровень
// назначает classifyToolCall (policy/confirmation) ДО execute: forbidden →
// FORBIDDEN_LEVEL, explicit-confirmation → createPending (policy/pending, §7.10) →
// status 'pending_confirmation' с карточкой-запросом, БЕЗ исполнения, preview →
// исполнение + confirmation_card mode='preview', execute — немедленно; исполнение —
// через execute с боевым JournalSink (audit в ctx.threadId, без него — в глобальный
// тред); (4) thread_post — отдельная ветка мимо executor (см. runThreadPost), но тоже
// через классификатор §7.10.
import {
  attachAspectInput,
  type BatchExecuteInput,
  batchExecuteInput,
  budgetStatusInput,
  entityCreateInput,
  entityGetInput,
  entityQueryInput,
  entityUpdateInput,
  newId,
  parseQuery,
  type QueryAst,
  relationCreateInput,
  relationDeleteInput,
} from '@orbis/shared';
import type { z } from 'zod';
import { isWorkerThreadTarget } from '../agent-loop/queries';
import { AGENT_VERB_ENVELOPES, type AgentVerbName, runAgentVerb } from '../agent-loop/verbs';
import { escalateAfterMutation } from '../ai/escalation';
import { budgetStatus } from '../budget/aggregates';
import { appendMessage, appendMessageIdempotent } from '../chat/messages';
import { ensureEntityThread } from '../chat/threads';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import { type EntitlementResolver, IMPORT_CSV_KEY, resolveEntitlement } from '../entitlements';
import { readEntity } from '../entity-read';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind, JournalSink, JournalWrite, WireEntity } from '../executor/types';
import type { GrantRef } from '../oauth/grants';
import {
  type ConfirmationLevel,
  classifyToolCall,
  entityUpdatePreviewDiff,
  factsFromToolCall,
} from '../policy/confirmation';
import { createPending, operationsNoun } from '../policy/pending';
import {
  type CompileContext,
  compileCount,
  compileQuery,
  compileSum,
  QueryCompileError,
} from '../query/compile';
import { queryWithMaterialization } from '../recurring/with-materialization';
import { toWireEntityFromSql } from '../wire';
import {
  AGENT_VERB_NAMES,
  type AspectToolRow,
  buildToolDefs,
  type Card,
  importCsvStartInput,
  loadAspectToolRows,
  type OrbisToolDef,
  type ThreadPostInput,
  threadPostInput,
  userQueryInput,
  WORKER_SCOPE_TOOLS,
} from './registry';

/** Резолв имени в глагол исполнителя (§9.3) — набор имён живёт в реестре, не здесь. */
function isAgentVerb(name: string): name is AgentVerbName {
  return (AGENT_VERB_NAMES as readonly string[]).includes(name);
}

// Боевой синк — один инстанс на модуль (состояния не хранит), как в роутерах 1a.
const sink = makeChatJournalSink();

export interface ToolCallCtx {
  db: Db;
  actorUserId: string;
  actorKind: ActorKind; // 'owner' | 'ai' | 'agent'; в ExecuteRequest идёт как есть
  /**
   * Поверхность вызова. 'routine' (V1.5) — внутренний исполнитель в прогоне рутины:
   * не 'chat', потому что за прогоном не стоит владелец, который только что попросил,
   * и правки рутины он обязан отличать в ленте.
   */
  source: 'chat' | 'mcp' | 'routine';
  threadId?: string; // тред диалога — туда лягут audit-сообщения
  explicitCommand: boolean; // вход политики §7.10; в 1b всегда false
  clock?: () => Date;
  /**
   * Резолвер §8 — инжектируемый шов (как ImportDeps.entitlements у роутера импорта и
   * McpDeps.entitlements у MCP-сервера): по умолчанию боевой resolveEntitlement.
   * Без него денайл-путь гейтов внутри диспатча был бы непокрываем тестом.
   */
  entitlements?: EntitlementResolver;
  /**
   * Грант, от имени которого идёт вызов (С2). Есть ТОЛЬКО у MCP: чат и UI — поверхности
   * самого владельца, гранта за ними нет, и отсутствие ключа здесь означает именно это,
   * а не «грант неизвестен». Отсюда идентичность едет в ExecuteRequest.actorGrantId и
   * дальше в запись журнала (§7.8).
   */
  grant?: GrantRef;
  /**
   * Прогон, в рамках которого идёт вызов (V1.5) — вторая половина атрибуции рядом с
   * грантом: source говорит «рутина», это поле — КАКОЙ её прогон. Доезжает до action
   * журнала как run_id, до pending-записи как run_id и до поста в треде. Ключа нет у
   * обычного чата и MCP-вызова вне прогона.
   */
  runId?: string;
}

export type ToolDispatchResult =
  | {
      status: 'ok';
      result: unknown;
      card?: Card;
      /**
       * id action'а журнала §7.8 (undo-адресуемый) — только у мутаций через executor
       * и только когда действие реально журналировалось (идемпотентный replay ничего
       * не журналил — как undoActionId карточки). Потребитель — actions-резюме
       * ai.sendMessage (Task 9) для мгновенного UI-обновления.
       */
      actionId?: string;
    }
  | { status: 'pending_confirmation'; pendingId: string; card: Card } // §7.10 explicit-confirmation (Task 6)
  | { status: 'error'; error: { code: string; message: string; details?: unknown } };

export async function dispatchTool(
  ctx: ToolCallCtx,
  name: string,
  input: unknown,
): Promise<ToolDispatchResult> {
  try {
    // Резолв тула и чтения — один withIdentity-tx (RLS); мутации исполняются после:
    // execute открывает собственный tx, вложить его в текущий нельзя.
    const pre = await withIdentity(ctx.db, ctx.actorUserId, async (tx): Promise<Resolution> => {
      const rows = await loadAspectToolRows(tx);
      const defs = buildToolDefs(rows);
      const def = defs.find((d) => d.name === name);
      if (!def) return { kind: 'unknown' };
      // internalOnly — fail-closed прямо в диспатче (fix round): фильтрация списка
      // тулов в MCP-адаптере (Task 10) — вторая линия, не единственная
      if (def.internalOnly === true && ctx.source === 'mcp') {
        return {
          kind: 'done',
          out: errorResult(
            'VALIDATION',
            `тул «${name}» внутренний — внешним агентам (MCP) недоступен (§9.2)`,
            { tool: name },
          ),
        };
      }
      // Скоуп гранта (С7, §4.14): фоновому исполнителю открыты только чтения, глаголы
      // и thread_post. Условие фактическое — «грант есть И скоуп не full», а не
      // «скоуп === worker»: verifyBearer кастует text-колонку scope как есть
      // (grants.ts), и незнакомое значение обязано СУЖАТЬ доступ, а не открывать
      // полный (fail-closed). Гейт стоит здесь, рядом с internalOnly, а не в
      // классификаторе §7.10: тот по актору сознательно не ветвится, а скоуп — ось
      // доступа. Отказ структурированный (§7.10 «forbidden»), ДО любой записи.
      if (
        ctx.grant !== undefined &&
        ctx.grant.scope !== 'full' &&
        def.kind !== 'read' &&
        !WORKER_SCOPE_TOOLS.has(def.name)
      ) {
        return {
          kind: 'done',
          out: errorResult('FORBIDDEN_LEVEL', `тул «${name}» недоступен скоупу worker (§4.14)`, {
            tool: name,
            scope: ctx.grant.scope,
          }),
        };
      }
      // Глагол исполнителя без гранта (§9.3): чат сюда не доходит — реестр чата такие
      // дефы отсекает (send-message.ts); эта ветка — вторая линия для любого другого
      // вызывающего без гранта (прогон адресуется конкретному доступу, см. agentOnly)
      if (def.agentOnly === true && ctx.grant === undefined) {
        return {
          kind: 'done',
          out: errorResult(
            'VALIDATION',
            `тул «${name}» — глагол исполнителя, доступен только внешнему агенту с грантом (§9.3)`,
            { tool: name },
          ),
        };
      }
      // entity_query — вне pre-tx: хук материализации §5.4 (recurring-инстансы окна
      // запроса) исполняет executor в СОБСТВЕННЫХ tx — из живого tx его не зовём
      // (истощение пула соединений), см. recurring/with-materialization.ts
      if (def.name === 'entity_query') return { kind: 'entity_query' };
      // budget_status — тоже вне pre-tx: конвейер §2.8 (postDue + материализация)
      // внутри budgetStatus исполняет executor в собственных tx
      if (def.name === 'budget_status') return { kind: 'budget_status' };
      // user_query — тот же хук материализации §5.4, что entity_query (обязательство
      // ревью A3): агрегат окна дат обязан видеть свеже-материализованные инстансы
      if (def.name === 'user_query') return { kind: 'user_query' };
      if (def.kind === 'read')
        return { kind: 'done', out: await runRead(tx, ctx, def.name, input) };
      return {
        kind: 'mutate',
        def,
        keyFieldsByAspect: keyFieldsByAspect(rows),
        execToolByName: execToolNames(defs),
      };
    });
    if (pre.kind === 'unknown') {
      // §7.10, ряд «!known → forbidden» (fail-closed): незнакомый вызов не исполняется,
      // и переформулировкой имени запрет не обходится. Уровень честно берём у
      // классификатора — правило живёт в одном месте, dispatch лишь мапит его в код
      // ошибки. kind без реестра неопределим — консервативно 'mutate'; на исход не
      // влияет: ряд «!known» — первый в таблице.
      const level = classifyToolCall({
        tool: name,
        kind: 'mutate',
        known: false,
        actorKind: ctx.actorKind,
        explicitCommand: ctx.explicitCommand,
        archives: false,
        isBatch: false,
        // Незнакомому тулу нечего выдавать: ряд «!known» первый в таблице, факт не влияет
        grantsAutonomy: false,
      });
      const gated = levelGate(level, name, `неизвестный тул «${name}» — вызов запрещён (§7.10)`);
      if (gated !== null) return gated;
      // недостижимо: ряд «!known» всегда даёт forbidden
      throw new Error(`classifyToolCall: неожиданный уровень «${level}» для неизвестного тула`);
    }
    if (pre.kind === 'done') return pre.out;
    // await обязателен: return без await вывел бы reject за пределы try/catch ниже
    if (pre.kind === 'entity_query') return await runEntityQuery(ctx, input);
    if (pre.kind === 'budget_status') return await runBudgetStatus(ctx, input);
    if (pre.kind === 'user_query') return await runUserQuery(ctx, input);
    if (pre.def.name === 'thread_post') {
      // §7.10 распространяется и на thread_post (kind='mutate' в реестре — ради
      // политики): по MVP-таблице одиночная не-архивирующая мутация → execute, но
      // уровень спрашиваем у классификатора — правило в одном месте. preview для
      // thread_post таблицей недостижим (не batch) — карточки предпросмотра нет.
      // Envelope-валидация — ДО классификации (§7.10 дословно, fix round Task 5).
      const parsed = parseEnvelope(threadPostInput, input, 'thread_post');
      const level = classifyToolCall({
        ...factsFromToolCall(pre.def, parsed),
        actorKind: ctx.actorKind,
        explicitCommand: ctx.explicitCommand,
      });
      const gated = levelGate(level, pre.def.name);
      if (gated !== null) return gated;
      if (level === 'explicit-confirmation') {
        // Недостижимо MVP-таблицей (одиночная не-архивирующая мутация → execute);
        // fail-closed на случай её эволюции: thread_post исполняется МИМО executor,
        // и approve (batch-обёртка конвейера, policy/pending) исполнить его не сможет —
        // честный отказ вместо неисполнимого pending
        return errorResult('VALIDATION', 'thread_post не поддерживает pending-подтверждение', {
          tool: 'thread_post',
        });
      }
      return await runThreadPost(ctx, parsed);
    }
    if (isAgentVerb(pre.def.name)) {
      // Ветка глаголов стоит СТРОГО ДО runMutation: у них нет envelope в
      // MUTATION_ENVELOPES, а validateMutationEnvelope без схемы бросает голый Error —
      // тот пролетел бы мимо catch ниже (там ловится только ExecError) и стал бы 500.
      // Схема — из карты глаголов, валидация ДО классификации (§7.10 дословно).
      const parsed = parseEnvelope(AGENT_VERB_ENVELOPES[pre.def.name], input, pre.def.name);
      const level = classifyToolCall({
        ...factsFromToolCall(pre.def, parsed),
        actorKind: ctx.actorKind,
        explicitCommand: ctx.explicitCommand,
      });
      const gated = levelGate(level, pre.def.name);
      if (gated !== null) return gated;
      if (level !== 'execute') {
        // Инвариант 4 спеки: глагол исполнителя НИКОГДА не возвращает pending — фоновому
        // прогону некому нажать «подтвердить», и карточка висела бы вечно. Таблицей
        // §7.10 сюда не попасть (одиночная не-архивирующая мутация → execute), но
        // молчаливого падения в pending при её эволюции быть не должно.
        return errorResult(
          'VALIDATION',
          `глагол «${pre.def.name}» не исполняется на уровне «${level}» (§7.10, инвариант 4)`,
          { tool: pre.def.name, level },
        );
      }
      // ctx.grant здесь заведомо есть: гейт agentOnly выше уже отбил вызов без гранта
      // (глагол адресуется конкретному доступу). Проверка — вторая линия, не логика.
      if (ctx.grant === undefined) {
        return errorResult('VALIDATION', `глагол «${pre.def.name}» требует гранта (§9.3)`, {
          tool: pre.def.name,
        });
      }
      return await runAgentVerb(
        {
          db: ctx.db,
          ownerId: ctx.actorUserId,
          grant: ctx.grant,
          clock: ctx.clock ?? (() => new Date()),
          sink,
        },
        pre.def.name,
        parsed,
      );
    }
    return await runMutation(ctx, pre.def, input, pre.keyFieldsByAspect, pre.execToolByName);
  } catch (e) {
    // Доменные отказы (NOT_FOUND, VALIDATION, ...) — структурированный error-результат;
    // инфраструктурные ошибки и баги не маскируются (та же дисциплина, что в execute)
    if (e instanceof ExecError) {
      return { status: 'error', error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}

type Resolution =
  | { kind: 'unknown' }
  | { kind: 'done'; out: ToolDispatchResult }
  | { kind: 'entity_query' } // исполняется вне pre-tx — хук материализации §5.4
  | { kind: 'user_query' } // вне pre-tx — тот же хук материализации §5.4 (ревью A3)
  | { kind: 'budget_status' } // вне pre-tx — конвейер §2.8 (postDue + материализация)
  | {
      kind: 'mutate';
      def: OrbisToolDef;
      keyFieldsByAspect: Map<string, string[]>;
      /** Реестровое имя → executor-форма (для трансляции вложенных операций batch). */
      execToolByName: Map<string, string>;
    };

function errorResult(code: string, message: string, details?: unknown): ToolDispatchResult {
  return { status: 'error', error: { code, message, details } };
}

/**
 * §7.10: маппинг уровня в ранний отказ; null — уровень не отказной: execute/preview
 * исполняются, explicit-confirmation обрабатывает вызывающий (runMutation →
 * createPending, policy/pending). forbidden → FORBIDDEN_LEVEL (403 маппингом errors.ts).
 *
 * КОНТРАКТ PENDING (fix round Task 5 → Task 6): сюда уровень приходит только ПОСЛЕ
 * envelope-валидации input'а (validateMutationEnvelope / validateBatchOperations в
 * runMutation) — pending создаётся из envelope-валидированного payload'а. Полная
 * провалидированность (стадии 2–4 конвейера §9.2: aspects-схемы реестра,
 * expectedUpdatedAt/§5.2, доменные инварианты над текущим состоянием) — обязанность
 * РЕВАЛИДАЦИИ APPROVE (полный конвейер executor'а, см. policy/pending.ts): dry-run
 * при создании не спасал бы от изменения состояния за время ожидания — ревалидация
 * на approve обязательна в любом случае, двойная валидация избыточна.
 */
function levelGate(
  level: ConfirmationLevel,
  tool: string,
  forbiddenMessage?: string,
): ToolDispatchResult | null {
  if (level === 'forbidden') {
    return errorResult(
      'FORBIDDEN_LEVEL',
      forbiddenMessage ?? `вызов тула «${tool}» запрещён политикой подтверждений (§7.10)`,
      { tool },
    );
  }
  return null;
}

/**
 * Обёртка боевого синка для уровня preview (§7.10): перехватывает JournalWrite —
 * diff карточки строится из action.inverse (§7.8) — делегируя запись боевому синку
 * тем же tx. Push после успешной записи: конфликт/откат не оставляет фантомного entry.
 */
function captureSink(inner: JournalSink): { sink: JournalSink; entries: JournalWrite[] } {
  const entries: JournalWrite[] = [];
  return {
    entries,
    sink: {
      async write(tx, entry) {
        await inner.write(tx, entry);
        entries.push(entry);
      },
      findByAuditId: (tx, id) => inner.findByAuditId(tx, id),
    },
  };
}

// ---------------------------------------------------------------------------
// Чтения: entity_get / import_csv_start — под RLS; ветвлений политики нет:
// ряд «read → execute» таблицы §7.10 (закреплён юнит-тестом классификатора)
// ---------------------------------------------------------------------------

async function runRead(
  tx: Tx,
  ctx: ToolCallCtx,
  name: string,
  input: unknown,
): Promise<ToolDispatchResult> {
  // entity_query/user_query/budget_status сюда не попадают — свои ветки Resolution
  // (хук материализации §5.4 / конвейер §2.8 исполняются вне pre-tx)
  if (name === 'entity_get') {
    const parsed = parseEnvelope(entityGetInput, input, 'entity_get');
    return { status: 'ok', result: await readEntity(tx, ctx.actorUserId, parsed) };
  }
  if (name === 'import_csv_start') {
    parseEnvelope(importCsvStartInput, input, 'import_csv_start');
    return importCsvStart(ctx);
  }
  throw new Error(`runRead: нет обработчика read-тула «${name}»`); // недостижимо: kind задаёт реестр
}

/**
 * import_csv_start (Task C4c, 03-budget §3.4): вход в импорт из чата. Тул-аффорданс —
 * единственный эффект: карточка import_review, с которой владелец откроет экран
 * импорта. Ничего не читает и не пишет (файл выписки живёт в браузере и разбирается
 * локально, §3.4 шаг 1; модуль import/ отсюда намеренно не вызывается — роутер
 * import.* зовёт только владелец, C2). Форма карточки обязана дословно совпадать
 * с web-типом ImportReviewData (chat/cards/types.ts) — типы намеренно не общие.
 */
function importCsvStart(ctx: ToolCallCtx): ToolDispatchResult {
  // Гейт §8 — тот же ключ 'import.csv', что у процедур роутера импорта
  // (по образцу gateImportCsv из import/review.ts): отказ резолвера → LIMIT, не карточка.
  // Резолвер — из инъецируемого шва ctx (как у роутера), иначе денайл непокрываем.
  const decision = (ctx.entitlements ?? resolveEntitlement)(ctx.actorUserId, IMPORT_CSV_KEY);
  if (!decision.allowed) {
    throw new ExecError('LIMIT', `лимит «${IMPORT_CSV_KEY}» исчерпан`, {
      key: IMPORT_CSV_KEY,
      limit: decision.limit,
    });
  }
  return {
    status: 'ok',
    // result — для модели: что произошло и почему продолжать нечего
    result: {
      note:
        'карточка входа в импорт показана — пользователь откроет экран импорта и выберет ' +
        'файл локально в браузере; сам импорт через чат не выполняется, не повторяй вызов',
    },
    card: { kind: 'import_review' },
  };
}

/**
 * entity_query с хуком материализации (§5.4, fix round A3): тот же общий каркас, что у
 * entity.query/count роутера, — окно по start_at/occurred_on материализует recurring-
 * инстансы ДО компиляции; ошибки парсинга/компиляции — ExecError/VALIDATION (§6.4),
 * их развернёт catch dispatchTool.
 */
async function runEntityQuery(ctx: ToolCallCtx, input: unknown): Promise<ToolDispatchResult> {
  const parsed = parseEnvelope(entityQueryInput, input, 'entity_query');
  return queryWithMaterialization({
    db: ctx.db,
    actorUserId: ctx.actorUserId,
    thisEntityId: null, // `this` вне контекста сущности
    parse: (cctx) => parseAstOrThrow(parsed.query, cctx),
    run: async (tx, ast, cctx) => {
      const compiled = compileOrThrow(() => compileQuery(ast, cctx));
      const rows = await tx.execute(compiled);
      const entities = [...rows].map((r) => toWireEntityFromSql(r as Record<string, unknown>));
      const card: Card = {
        kind: 'query_result',
        ...(ast.title !== undefined && { title: ast.title }),
        count: entities.length,
        entityIds: entities.map((e) => e.id),
      };
      return { status: 'ok', result: entities, card };
    },
  });
}

/**
 * budget_status (Task A6, 03-budget §4.3/§4.5/§4.7): готовые агрегаты Budget для
 * финансовых вопросов LLM/MCP. Исполняется вне pre-tx: budgetStatus начинается
 * конвейером §2.8 (postDueInstances + materializeInstances) — executor в собственных tx.
 * Карточки нет: результат — данные для ответа модели, а не сущность/выборка (02 §2.3).
 */
async function runBudgetStatus(ctx: ToolCallCtx, input: unknown): Promise<ToolDispatchResult> {
  const parsed = parseEnvelope(budgetStatusInput, input, 'budget_status');
  const result = await budgetStatus(ctx.db, ctx.actorUserId, parsed.month);
  return { status: 'ok', result };
}

/**
 * user_query (решение 7 плана): агрегация НА SQL — sum через ::numeric::text
 * (точность decimal §3.3, не JS-float), count(*) без limit (агрегат по всей выборке).
 * Хук материализации §5.4 (обязательство ревью A3): тот же каркас, что entity_query, —
 * агрегат с окном по start_at/occurred_on считается ПОСЛЕ материализации инстансов окна.
 */
async function runUserQuery(ctx: ToolCallCtx, input: unknown): Promise<ToolDispatchResult> {
  const parsed = parseEnvelope(userQueryInput, input, 'user_query');
  // sum без field — структурная VALIDATION ДО парсинга/материализации
  if (parsed.aggregate === 'sum' && parsed.field === undefined) {
    throw new ExecError('VALIDATION', 'user_query: aggregate=sum требует field', {
      tool: 'user_query',
    });
  }
  return queryWithMaterialization({
    db: ctx.db,
    actorUserId: ctx.actorUserId,
    thisEntityId: null, // `this` вне контекста сущности
    parse: (cctx) => parseAstOrThrow(parsed.query, cctx),
    run: async (tx, ast, cctx) => {
      if (parsed.aggregate === 'count') {
        // compileOrThrow обязателен и здесь: QueryCompileError (например children_of=this
        // вне контекста) — структурная VALIDATION, не throw мимо catch (fix round)
        const compiledCount = compileOrThrow(() => compileCount(ast, cctx));
        const rows = await tx.execute(compiledCount);
        const count = Number(rows[0]?.count);
        return {
          status: 'ok',
          result: count,
          card: aggregateCard(ast, count, { op: 'count', value: String(count) }),
        };
      }
      // aggregate === 'sum'; field проверен выше
      const field = parsed.field as string;
      const compiled = compileOrThrow(() => compileSum(ast, cctx, field));
      const rows = await tx.execute(compiled);
      const count = Number(rows[0]?.count);
      const value = (rows[0]?.sum as string | null) ?? '0'; // пустая выборка: sum NULL → '0'
      return {
        status: 'ok',
        result: value,
        card: aggregateCard(ast, count, { op: 'sum', value }),
      };
    },
  });
}

function aggregateCard(
  ast: QueryAst,
  count: number,
  aggregate: { op: 'sum' | 'count'; value: string },
): Card {
  return {
    kind: 'query_result',
    ...(ast.title !== undefined && { title: ast.title }),
    count,
    entityIds: [], // агрегат id не выбирает; список — отдельным entity_query
    aggregate,
  };
}

// ---------------------------------------------------------------------------
// Мутации через executor (конвейер §9.2, журнал §7.8)
// ---------------------------------------------------------------------------

async function runMutation(
  ctx: ToolCallCtx,
  def: OrbisToolDef,
  input: unknown,
  keyFieldsMap: Map<string, string[]>,
  execToolByName: Map<string, string>,
): Promise<ToolDispatchResult> {
  // Имя тула для executor'а: у attach_* он ждёт форму attach_<aspect_id с заменой
  // только «/»> — восстанавливаем из aspectId (см. OrbisToolDef.aspectId).
  // Структурная валидация ДО классификации (§7.10 дословно: уровень получает tool-call
  // ПОСЛЕ структурной валидации input'а): невалидный envelope — честная VALIDATION с
  // zod-issues (путь самокоррекции модели), а не wouldBe; для batch — трансляция имён
  // (fix round Task 4) плюс валидация каждого operations[].input схемой его тула.
  // Факты классификатора дальше извлекаются из уже ПРОВАЛИДИРОВАННОГО payload'а.
  const tool = execToolName(def);
  const batchPayload =
    def.name === 'batch_execute'
      ? validateBatchOperations(translateBatchInput(input, execToolByName))
      : undefined;
  const payload = batchPayload ?? validateMutationEnvelope(def, input);

  // §7.10: уровень определяет политика по типизированным фактам вызова, не модель;
  // forbidden и explicit-confirmation разворачиваются ДО execute — в БД и журнал (§7.8)
  // ничего не попадает
  const level = classifyToolCall({
    ...factsFromToolCall(def, payload),
    actorKind: ctx.actorKind,
    explicitCommand: ctx.explicitCommand,
  });
  const gated = levelGate(level, def.name);
  if (gated !== null) return gated;

  if (level === 'explicit-confirmation') {
    // §7.10: действие НЕ исполняется — в тред пишется карточка-запрос с immutable
    // payload'ом (уже envelope-валидированным и с транслированными batch-именами);
    // до approve ничего не записано ни в граф, ни в журнал §7.8. Исполнение и
    // ревалидацию текущего состояния делает approve (policy/pending.ts)
    const pending = await withIdentity(ctx.db, ctx.actorUserId, (tx) =>
      createPending(tx, {
        threadId: ctx.threadId,
        // Грант едет в pending-запись: подтверждать будет владелец кнопкой, но
        // атрибуция исполнения остаётся за ТЕМ, кто попросил (§7.8, D11 + С2)
        actor: {
          userId: ctx.actorUserId,
          kind: ctx.actorKind,
          source: ctx.source,
          grantId: ctx.grant?.id,
          // Прогон доживает до исполнения так же, как грант (V1.6): подтвердит владелец,
          // но в журнале останется видно, какой прогон это предложил
          runId: ctx.runId,
        },
        tool,
        input: payload,
        level,
        // batch: дедуп pending по исходному batch_id модели — ретрай того же batch
        // не плодит вторую карточку (одиночная мутация без batch_id → без дедупа)
        ...(batchPayload !== undefined && { dedupeKey: batchPayload.batch_id }),
        clock: ctx.clock,
      }),
    );
    return { status: 'pending_confirmation', pendingId: pending.pendingId, card: pending.card };
  }

  // execute | preview — действие исполняется (§7.10: предпросмотр информационный, не
  // блокирующий); для preview перехватываем JournalWrite — diff строится из inverse (§7.8)
  const capture = level === 'preview' ? captureSink(sink) : undefined;
  const r = await execute(
    ctx.db,
    {
      actorUserId: ctx.actorUserId,
      actorKind: ctx.actorKind,
      source: ctx.source,
      threadId: ctx.threadId,
      // undefined у чатовых и UI-путей — executor такой ключ в action не пишет
      actorGrantId: ctx.grant?.id,
      // То же и для прогона (V1.5): по run_id действия прогона находит откат (rollback.ts)
      runId: ctx.runId,
      operations: [{ tool, input: payload }],
      clock: ctx.clock,
    },
    { sink: capture?.sink ?? sink },
  );
  if (!r.ok) return { status: 'error', error: r.error };

  // id action'а для actions-резюме (Task 9): та же семантика, что у undoActionId
  // карточки — идемпотентный replay ничего не журналил, action этого вызова нет
  const actionId = r.idempotentReplay ? undefined : r.actionId;

  // Эскалация повторных исправлений категории (§7.8) — ЧАТ-путь: план D3 требует
  // source ∈ ui|chat, а UI-половина уже висит на роутере entity.update. Контракт тот же
  // (K7): ПОСЛЕ успешного execute, отдельной транзакцией; свою ошибку эскалация
  // логирует внутри и не пробрасывает — ответ модели она уронить не имеет права.
  // Идемпотентный replay (actionId === undefined) ничего не журналировал — считать
  // нечего. source 'mcp' сюда не попадает намеренно: внешний агент — не правка
  // пользователя, план перечисляет только ui и chat.
  //
  // Гейт — по ОПЕРАЦИЯМ действия (DF п.1), а не по имени тула: групповую
  // рекатегоризацию план требует слать одним batch_execute, и условие
  // `def.name === 'entity_update'` отсекало её целиком. Операции те же, что ушли в
  // execute (у батча — плоский список, у одиночной мутации — она сама);
  // отфильтровать «не рекатегоризации» — работа самой эскалации.
  if (ctx.source === 'chat' && actionId !== undefined) {
    await escalateAfterMutation(ctx.db, {
      ownerId: ctx.actorUserId,
      actionId,
      // payload'ы уже прошли схемы тулов в validateMutationEnvelope/validateBatchOperations
      operations: batchPayload?.operations ?? [{ tool, input: payload }],
    });
  }

  // batch: результат — массив по операциям; на уровне preview — confirmation_card с
  // кратким summary «N операций» (пополевого diff у группы нет — масштаб задаёт размер)
  if (batchPayload !== undefined) {
    if (level === 'preview') {
      const n = batchPayload.operations.length;
      return {
        status: 'ok',
        result: r.results,
        card: { kind: 'confirmation_card', mode: 'preview', summary: `${n} ${operationsNoun(n)}` },
        ...(actionId !== undefined && { actionId }),
      };
    }
    return { status: 'ok', result: r.results, ...(actionId !== undefined && { actionId }) };
  }

  const result = r.results[0];
  if (level === 'preview') {
    // Одиночный preview: MVP-таблицей §7.10 сейчас недостижим (preview даёт только
    // batch), но семантика уровня общая — при эволюции таблицы ветка готова: diff
    // entity_update — прежние значения vs новые из inverse журнала (§7.8)
    const entry = capture?.entries[0];
    const diff =
      def.name === 'entity_update' && entry !== undefined
        ? entityUpdatePreviewDiff(entry.action)
        : undefined;
    return {
      status: 'ok',
      result,
      card: {
        kind: 'confirmation_card',
        mode: 'preview',
        summary:
          def.name === 'entity_update' ? `Обновление «${(result as WireEntity).title}»` : def.name,
        ...(diff !== undefined && { diff }),
      },
      ...(actionId !== undefined && { actionId }),
    };
  }

  // уровень execute — немедленное исполнение, карточка и журнал постфактум (§7.10):
  // entity_card (02 §2.3) — для create/update/attach; relation-мутации карточку
  // этого типа не несут (их карточки появятся вместе с confirmation/error, Task 6/9)
  const isEntityMutation =
    def.name === 'entity_create' || def.name === 'entity_update' || def.aspectId !== undefined;
  const card = isEntityMutation
    ? entityCard(
        result as WireEntity,
        keyFieldsMap,
        // идемпотентный replay ничего не журналил — action для Undo не существует
        actionId,
      )
    : undefined;
  return {
    status: 'ok',
    result,
    ...(card !== undefined && { card }),
    ...(actionId !== undefined && { actionId }),
  };
}

/** Имя тула в executor-форме: у attach_* «/» → «_», «-» сохраняется (см. aspectId). */
function execToolName(def: OrbisToolDef): string {
  return def.aspectId !== undefined ? `attach_${def.aspectId.replaceAll('/', '_')}` : def.name;
}

/** Маппинг реестровое имя → executor-форма по всем тулам (для операций batch). */
function execToolNames(defs: OrbisToolDef[]): Map<string, string> {
  return new Map(defs.map((d) => [d.name, execToolName(d)]));
}

/**
 * Трансляция envelope batch_execute: operations[].tool — реестровые имена (их публикует
 * buildToolRegistry и видят LLM/MCP) → executor-форма. Имя вне реестра — структурная
 * VALIDATION с индексом элемента. Известные, но непригодные для batch имена (read-тулы,
 * thread_post, вложенный batch_execute) транслируются как есть — их отклоняет стадия 1
 * executor'а собственной честной ошибкой.
 */
function translateBatchInput(
  input: unknown,
  execToolByName: Map<string, string>,
): BatchExecuteInput {
  const parsed = parseEnvelope(batchExecuteInput, input, 'batch_execute');
  return {
    batch_id: parsed.batch_id,
    operations: parsed.operations.map((op, index) => {
      const tool = execToolByName.get(op.tool);
      if (tool === undefined) {
        throw new ExecError('VALIDATION', `batch_execute: неизвестный тул операции «${op.tool}»`, {
          index,
          tool: op.tool,
        });
      }
      return { tool, input: op.input };
    }),
  };
}

/**
 * Envelope-схемы мутирующих core-тулов §9.2 (shared) — для структурной валидации ДО
 * классификации §7.10 (fix round Task 5). batch_execute и thread_post здесь не нужны:
 * batch валидируют translateBatchInput + validateBatchOperations, thread_post — своя
 * ветка dispatchTool; ключи — исполнительные имена (у core они совпадают с реестровыми).
 */
const MUTATION_ENVELOPES: Record<string, z.ZodTypeAny> = {
  entity_create: entityCreateInput,
  entity_update: entityUpdateInput,
  relation_create: relationCreateInput,
  relation_delete: relationDeleteInput,
};

/**
 * Структурная валидация envelope одиночной мутации ДО классификации (§7.10 дословно:
 * уровень получает структурно валидный вызов). Возвращает ПРОВАЛИДИРОВАННЫЙ payload
 * (safeParse.data) — из него же извлекаются факты классификатора; стадия 1 executor'а
 * остаётся второй линией (тот же контракт схем).
 */
function validateMutationEnvelope(def: OrbisToolDef, input: unknown): unknown {
  const schema = def.aspectId !== undefined ? attachAspectInput : MUTATION_ENVELOPES[def.name];
  if (schema === undefined) {
    // недостижимо: все мутирующие тулы реестра покрыты (batch/thread_post — свои ветки)
    throw new Error(`validateMutationEnvelope: нет схемы envelope для «${def.name}»`);
  }
  return parseEnvelope(schema, input, def.name);
}

/**
 * Структурная валидация вложенных операций batch ДО классификации §7.10 (fix round
 * Task 5): operations[].input проверяется схемой соответствующего мутирующего тула
 * (имена уже в executor-форме после translateBatchInput). Имена, непригодные для batch
 * (read-тулы, thread_post, вложенный batch_execute), не валидируются — их отклоняет
 * стадия 1 executor'а собственной честной ошибкой, валидировать их envelope бессмысленно.
 * Возвращает payload с ПРОВАЛИДИРОВАННЫМИ input'ами операций.
 */
function validateBatchOperations(payload: BatchExecuteInput): BatchExecuteInput {
  return {
    batch_id: payload.batch_id,
    operations: payload.operations.map((op, index) => {
      const schema = op.tool.startsWith('attach_')
        ? attachAspectInput
        : MUTATION_ENVELOPES[op.tool];
      if (schema === undefined) return op;
      const parsed = schema.safeParse(op.input);
      if (!parsed.success) {
        throw new ExecError('VALIDATION', `batch_execute: невалидный input операции «${op.tool}»`, {
          index,
          tool: op.tool,
          issues: parsed.error.issues,
        });
      }
      return { tool: op.tool, input: parsed.data as Record<string, unknown> };
    }),
  };
}

/** keyFields карточки (02 §2.3): значения полей из viewConfig.keyFields каждого аспекта. */
function keyFieldsByAspect(rows: AspectToolRow[]): Map<string, string[]> {
  return new Map(
    rows.map((r) => {
      const kf = (r.viewConfig as { keyFields?: unknown } | null)?.keyFields;
      return [r.id, Array.isArray(kf) ? kf.filter((f): f is string => typeof f === 'string') : []];
    }),
  );
}

function entityCard(
  e: WireEntity,
  keyFieldsMap: Map<string, string[]>,
  undoActionId: string | undefined,
): Card {
  const aspects = Object.keys(e.aspects);
  const keyFields: Record<string, unknown> = {};
  for (const aspectId of aspects) {
    for (const field of keyFieldsMap.get(aspectId) ?? []) {
      const value = e.aspects[aspectId]?.[field];
      if (value !== undefined) keyFields[field] = value;
    }
  }
  return {
    kind: 'entity_card',
    entityId: e.id,
    title: e.title,
    aspects,
    keyFields,
    ...(undoActionId !== undefined && { undoActionId }),
  };
}

// ---------------------------------------------------------------------------
// thread_post — отдельная ветка мимо executor
// ---------------------------------------------------------------------------

/**
 * thread_post — НЕ мутация графа: сообщение-в-тред и есть артефакт, inverse не имеет
 * смысла (chat_messages append-only, §4.6), Undo не применяется — ровно как
 * appendUserMessage владельца. Поэтому action в журнал §7.8 не пишется, а исполнение
 * идёт мимо executor: ensureEntityThread + appendMessage одним withIdentity-tx.
 * kind 'mutate' в реестре — для политики §7.10 (уровень одиночной мутации).
 * Envelope валидирует dispatchTool ДО классификации (§7.10) — сюда приходит parsed.
 */
async function runThreadPost(
  ctx: ToolCallCtx,
  parsed: ThreadPostInput,
): Promise<ToolDispatchResult> {
  const message = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
    // Периметр записи фонового исполнителя (С7/С9, инвариант 2 спеки) — ДО создания
    // треда и записи. Условие «не full», а не «= worker», по той же причине, что и в
    // гейте скоупа выше: незнакомое значение колонки scope обязано сужать доступ.
    // Несуществующая/чужая сущность здесь даёт FORBIDDEN_LEVEL, а не NOT_FOUND, — и это
    // правильно: исполнителю не с чего узнавать, что за пределами его назначений вообще
    // что-то есть.
    if (ctx.grant !== undefined && ctx.grant.scope !== 'full') {
      const allowed = await isWorkerThreadTarget(
        tx,
        ctx.actorUserId,
        ctx.grant.id,
        parsed.entity_id,
      );
      if (!allowed) {
        throw new ExecError(
          'FORBIDDEN_LEVEL',
          'worker пишет только в треды назначенных тикетов и их прямых родителей (С7/С9)',
          { tool: 'thread_post', entity_id: parsed.entity_id },
        );
      }
    }
    // Тред создаётся только для видимой актору сущности; чужая и несуществующая
    // под RLS неразличимы — единый NOT_FOUND (бросает ensureEntityThread)
    const threadId = await ensureEntityThread(tx, ctx.actorUserId, parsed.entity_id);
    const fields = {
      threadId,
      role: 'user' as const,
      content: parsed.content,
      // Пометка автора — для всех НЕ-владельческих постов (§9.3, V1.6): внешний агент
      // и внутренний AI одинаково пишут в тред не от лица владельца, и он обязан это
      // видеть. Пометки нет только у самого владельца — сообщать ему, что автор он,
      // нечего. Прогон (run_id) связывает пост с историей рутины; ключа нет вне прогона.
      metadata:
        ctx.actorKind === 'owner'
          ? {}
          : {
              author_kind: ctx.actorKind,
              ...(ctx.runId !== undefined && { run_id: ctx.runId }),
            },
    };
    // client-UUID (§2.1, как appendUserMessage владельца): повтор с тем же id —
    // идемпотентный ретрай (ON CONFLICT → исходный пост, append-only игнорирует новый
    // content), второй пост не создаётся; без id — серверный uuidv7 (ретрай неотличим).
    if (parsed.id !== undefined) {
      const r = await appendMessageIdempotent(tx, { id: parsed.id, ...fields });
      return r.message;
    }
    return appendMessage(tx, { id: newId(), ...fields });
  });
  return { status: 'ok', result: message };
}

// ---------------------------------------------------------------------------
// Общие хелперы
// ---------------------------------------------------------------------------

/** Структурная валидация envelope read-тулов и thread_post (мутации валидирует executor). */
function parseEnvelope<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  tool: string,
): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `невалидный input тула «${tool}»`, {
      tool,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** Разбор запроса грамматики §6: ошибка парсинга → VALIDATION со структурой §6.4. */
function parseAstOrThrow(query: string, cctx: CompileContext): QueryAst {
  const parsed = parseQuery(query, cctx.catalog);
  if (!parsed.ok) {
    throw new ExecError('VALIDATION', parsed.error.message, {
      position: parsed.error.position,
    });
  }
  return parsed.ast;
}

/** Структурная ошибка компиляции (`this` вне контекста, нечисловое поле sum) → VALIDATION. */
function compileOrThrow<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof QueryCompileError) {
      throw new ExecError('VALIDATION', e.message);
    }
    throw e;
  }
}
