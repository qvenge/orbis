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
  askInput,
  attachAspectInput,
  type BatchExecuteInput,
  batchExecuteInput,
  budgetStatusInput,
  type EntityUpdatePreconditionItem,
  effectiveLabel,
  entityCreateInput,
  entityGetInput,
  entityQueryInput,
  entityUpdateInput,
  newId,
  pendingMessageId,
  proposeInput,
  relationCreateInput,
  relationDeleteInput,
} from '@orbis/shared';
import {
  OWNER_LOCALE,
  QUERY_TREE_DEPTH_CAP,
  type QueryAst,
  queryTreeExceedsDepth,
  resolvePropertyFieldId,
} from '@orbis/shared/query';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { isWorkerThreadTarget } from '../agent-loop/queries';
import {
  AGENT_VERB_ENVELOPES,
  type AgentVerbName,
  type RunSubject,
  runAgentVerb,
} from '../agent-loop/verbs';
import { escalateAfterMutation } from '../ai/escalation';
import { budgetStatus } from '../budget/aggregates';
import { appendMessage, appendMessageIdempotent } from '../chat/messages';
import { ensureEntityThread } from '../chat/threads';
import type { Db } from '../db/client';
import { chatMessages, entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import {
  type EntitlementResolver,
  IMPORT_CSV_KEY,
  ROUTINES_MAX_KEY,
  resolveEntitlement,
} from '../entitlements';
import { readEntity } from '../entity-read';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { ROUTINE_UNTOUCHABLE_OBJECTS, routineUntouchableError } from '../executor/invariants';
import { makeChatJournalSink } from '../executor/journal';
import { nearestPropertyKey, resolvePropertyRef } from '../executor/props';
import type { ActorKind, JournalSink, JournalWrite, WireEntity } from '../executor/types';
import { undoLast } from '../executor/undo';
import type { GrantRef } from '../oauth/grants';
import {
  AUTONOMY_PROPERTIES,
  autonomyArmed,
  type ConfirmationLevel,
  classifyToolCall,
  entityUpdatePreviewDiff,
  factsFromToolCall,
  grantsRoutineAutonomy,
  type Reconfigures,
  ROUTINE_MODE_PROPERTY,
  ROUTINE_STAGE_PROPERTY,
  ROUTINE_TOOLS_PROPERTY,
} from '../policy/confirmation';
import { createPending, deferDedupeKey, listRunUnits, operationsNoun } from '../policy/pending';
import {
  type CompileCtx,
  compileCountAst,
  compileQueryAst,
  compileSumAst,
} from '../query/compile-ast';
import { parseQueryText, parseRegistryOf } from '../query/parse-text';
import { queryWithMaterialization } from '../recurring/with-materialization';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';

import { readAspectDelta } from '../registry/ops';
import { runAsk } from '../routines/ask';
import { CORE_FIELD_LABELS, MAX_RUN_UNITS } from '../routines/constants';
import { buildUpdate, loadTargets, runPropose } from '../routines/propose';
import { toLlmEntity, toWireEntityFromSql } from '../wire';
import { propertyCatalogInput, runPropertyCatalog } from './property-catalog';
import {
  AGENT_VERB_NAMES,
  buildToolDefs,
  type Card,
  importCsvStartInput,
  type OrbisToolDef,
  type RoutineRef,
  routineToolAllowed,
  type ThreadPostInput,
  threadPostInput,
  undoLastInput,
  userQueryInput,
  WORKER_SCOPE_TOOLS,
} from './registry';
import { REGISTRY_TOOL_ENVELOPES, REGISTRY_TOOL_NAMES } from './registry-tools';

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
   * Рутина и её прогон, от имени которых идёт вызов (V1.10) — ровно то же место в
   * контексте, что `grant` у внешнего исполнителя: субъект, которому адресован доступ.
   * Есть ТОЛЬКО у `source: 'routine'`; отсутствие ключа при таком source — не «рутина
   * неизвестна», а поломка вызывающего, и гейт ниже трактует это fail-closed.
   */
  routine?: RoutineRef;
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
      // Снимок реестров — ОДИН на вызов, и он же уезжает дальше: по нему собираются
      // определения тулов, резолвятся ключи свойств на границе и печатается LLM-проекция.
      // Второй снимок, взятый отдельно, мог бы разойтись с первым на правке реестра между
      // двумя чтениями (тот же довод, что у `loadTargets` предложения).
      const reg = await effectiveRegistry(tx, ctx.actorUserId);
      const defs = buildToolDefs(reg);
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
      // Гейты рутины (V1.10) — рядом с internalOnly и ДО скоупа/политики/любой записи:
      // «кому этот тул вообще адресован» решается раньше, чем «на каком уровне его
      // исполнять». Разбор — в routineGate (та же функция под юнит-тестом).
      const routineDenial = routineGate(def, ctx);
      if (routineDenial !== null) return { kind: 'done', out: routineDenial };
      // Скоуп гранта (С7, §4.14): фоновому исполнителю открыты только чтения, глаголы
      // и thread_post. Условие фактическое — «грант есть И скоуп не full», а не
      // «скоуп === worker»: verifyBearer кастует text-колонку scope как есть
      // (grants.ts), и незнакомое значение обязано СУЖАТЬ доступ, а не открывать
      // полный (fail-closed). Гейт стоит здесь, рядом с internalOnly, а не в
      // классификаторе §7.10: тот по актору сознательно не ветвится, а скоуп — ось
      // доступа. Отказ структурированный (§7.10 «forbidden»), ДО любой записи.
      //
      // `fullScopeOnly` (§А9-4, РП-14) — вторая ось того же гейта: тул, адресованный
      // только полному доступу, закрыт фону ДАЖЕ БУДУЧИ ЧТЕНИЕМ. Без этой половины
      // `property_catalog` пролетал бы сюда по ветке «чтения открыты все» — то есть
      // список тулов сужался бы, а вызов по угаданному имени всё равно работал.
      if (
        ctx.grant !== undefined &&
        ctx.grant.scope !== 'full' &&
        (def.fullScopeOnly === true || (def.kind !== 'read' && !WORKER_SCOPE_TOOLS.has(def.name)))
      ) {
        return {
          kind: 'done',
          out: errorResult('FORBIDDEN_LEVEL', `тул «${name}» недоступен скоупу worker (§4.14)`, {
            tool: name,
            scope: ctx.grant.scope,
          }),
        };
      }
      // Глагол исполнителя без СУБЪЕКТА (§9.3, V1.10): чат сюда не доходит — реестр чата
      // такие дефы отсекает (send-message.ts); эта ветка — вторая линия для любого другого
      // вызывающего. Условие — «нет ни гранта, ни рутины», а не «нет гранта»: прогон
      // адресуется конкретному субъекту, и с V1 субъектов два — внешний доступ и рутина
      // (Задача 7 сведёт их в общий RunSubject глаголов).
      if (def.agentOnly === true && ctx.grant === undefined && ctx.routine === undefined) {
        return {
          kind: 'done',
          out: errorResult(
            'VALIDATION',
            `тул «${name}» — глагол исполнителя, доступен только прогону с субъектом (§9.3)`,
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
      // undo_last — вне pre-tx: undoLast применяет inverse через executor в СОБСТВЕННОМ tx
      // (internal-режим, §7.8) и не проходит ни политику §7.10, ни runMutation — см. runUndoLast
      if (def.name === 'undo_last') return { kind: 'undo_last' };
      if (def.kind === 'read')
        return { kind: 'done', out: await runRead(tx, ctx, reg, def.name, input) };
      return {
        kind: 'mutate',
        def,
        reg,
        keyFieldsByAspect: keyFieldsByAspect(reg),
        knownTools: knownToolNames(defs),
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
        // …и перенастраивать ему тоже нечего: имени нет в реестре, объекта у вызова нет
        reconfigures: 'none',
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
    if (pre.kind === 'undo_last') return await runUndoLast(ctx, input);
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
      // Субъект прогона (V1.5): грант — внешний исполнитель, рутина — внутренний. Ровно
      // ОДИН из двух: грант приходит с MCP, рутина — из фонового прогона, и вместе они
      // означают вызов, собранный не тем, кто его шлёт. Молчаливое «грант побеждает»
      // писало бы шаги внешнего исполнителя в прогон рутины (или наоборот) — отказ
      // fail-closed дешевле разбора такого журнала.
      if (ctx.grant !== undefined && ctx.routine !== undefined) {
        return errorResult(
          'VALIDATION',
          `контекст вызова собран неверно: и грант, и рутина — у глагола «${pre.def.name}» ровно один субъект (V1.5)`,
          { tool: pre.def.name },
        );
      }
      // Субъект здесь заведомо есть — гейт agentOnly выше уже отбил вызов без обоих;
      // проверка — вторая линия, не логика.
      const subject: RunSubject | null =
        ctx.grant !== undefined
          ? { kind: 'grant', grant: ctx.grant }
          : ctx.routine !== undefined
            ? { kind: 'routine', routineId: ctx.routine.id }
            : null;
      if (subject === null) {
        return errorResult(
          'VALIDATION',
          `глагол «${pre.def.name}» требует субъекта — гранта или рутины (§9.3, V1.5)`,
          { tool: pre.def.name },
        );
      }
      return await runAgentVerb(
        {
          db: ctx.db,
          ownerId: ctx.actorUserId,
          subject,
          clock: ctx.clock ?? (() => new Date()),
          sink,
        },
        pre.def.name,
        parsed,
      );
    }
    if (pre.def.name === 'orbis_propose') {
      // Ветка стоит ДО runMutation, а не внутри него: предложение не проходит ни политику
      // §7.10, ни инвариант 5 (V1.10) — оно и есть тот САНКЦИОНИРОВАННЫЙ способ отложить
      // правку, ради которого инвариант 5 запрещает все остальные. Гейты доступа (реестр,
      // routineGate) отработали выше; envelope разбирается здесь, как у глаголов.
      return await runPropose(ctx, parseEnvelope(proposeInput, input, pre.def.name));
    }
    if (pre.def.name === 'orbis_ask') {
      // Ветка стоит ДО runMutation по той же причине, что у предложения, и по своей: вопрос
      // не правит граф вовсе, и политике §7.10 его классифицировать нечем. Через ветку
      // глаголов он тоже не пошёл бы (рулинг Р-1): та требует уровня `execute` и на любом
      // другом отвечает VALIDATION «инвариант 4» — то есть pending, которым вопрос и
      // является, там запрещён по построению. Гейты доступа (реестр, routineGate)
      // отработали выше; envelope разбирается здесь, как у глаголов.
      return await runAsk(ctx, parseEnvelope(askInput, input, pre.def.name));
    }
    return await runMutation(ctx, pre.def, input, pre.reg, pre.keyFieldsByAspect, pre.knownTools);
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
  | { kind: 'undo_last' } // вне pre-tx — undoLast открывает собственный tx (§7.8)
  | {
      kind: 'mutate';
      def: OrbisToolDef;
      /** Снимок реестров вызова: резолв ключей свойств на границе и LLM-проекция ответа. */
      reg: RegistrySnapshot;
      keyFieldsByAspect: Map<string, string[]>;
      /** Имена тулов реестра — гейт вложенных операций batch (перевода имён больше нет). */
      knownTools: ReadonlySet<string>;
    };

function errorResult(code: string, message: string, details?: unknown): ToolDispatchResult {
  return { status: 'error', error: { code, message, details } };
}

/**
 * Гейты рутины pre-блока (V1.10, инварианты 4–5) — обе стороны одной границы, поэтому
 * одной функцией: тул, адресованный ТОЛЬКО рутине, не отдаётся никому другому, а рутине
 * не отдаётся ничего сверх её режима. Возвращает готовый отказ или null (проходим дальше).
 *
 * Чистая функция от (def, ctx) — не потому, что так короче, а потому, что деф
 * `orbis_propose` появится в реестре только Задачей 8, а правило доступа обязано быть
 * закрыто тестом уже сейчас: гейт fail-closed, который никто не проверил, — это гейт,
 * которого нет.
 *
 * Fail-closed дважды: `source: 'routine'` без `ctx.routine` — отказ (какого режима
 * держаться, неизвестно), и незнакомое имя в белом списке доступа не открывает
 * (`routineToolAllowed` перечисляет разрешённое, а не запрещённое).
 */
export function routineGate(
  def: Pick<OrbisToolDef, 'name' | 'kind' | 'routineOnly'>,
  ctx: Pick<ToolCallCtx, 'source' | 'routine'>,
): ToolDispatchResult | null {
  if (ctx.source !== 'routine') {
    // VALIDATION, а не FORBIDDEN_LEVEL: для чата и MCP такого тула просто не существует
    // (их реестры его не публикуют) — это ошибка формы вызова, а не отказ по правам
    if (def.routineOnly !== true) return null;
    return errorResult(
      'VALIDATION',
      `тул «${def.name}» доступен только внутреннему исполнителю рутины (V1.10)`,
      { tool: def.name, source: ctx.source },
    );
  }
  const routine = ctx.routine;
  if (routine === undefined) {
    return errorResult(
      'FORBIDDEN_LEVEL',
      `вызов из прогона рутины без её контекста — тул «${def.name}» не исполняется (V1.10)`,
      { tool: def.name },
    );
  }
  if (routineToolAllowed(def, routine)) return null;
  return errorResult(
    'FORBIDDEN_LEVEL',
    `тул «${def.name}» недоступен рутине в режиме «${routine.mode}» (V1.10)`,
    { tool: def.name, mode: routine.mode },
  );
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
  reg: RegistrySnapshot,
  name: string,
  input: unknown,
): Promise<ToolDispatchResult> {
  // entity_query/user_query/budget_status сюда не попадают — свои ветки Resolution
  // (хук материализации §5.4 / конвейер §2.8 исполняются вне pre-tx)
  if (name === 'entity_get') {
    const parsed = parseEnvelope(entityGetInput, input, 'entity_get');
    return { status: 'ok', result: await readEntity(tx, ctx.actorUserId, parsed) };
  }
  if (name === 'property_catalog') {
    // Каталог читается из СНИМКА реестра — того же, по которому собран список тулов и по
    // которому валидируется запись. Отдельного запроса к таблицам реестра здесь нет
    // намеренно: он был бы вторым мнением о том, что в реестре есть.
    const parsed = parseEnvelope(propertyCatalogInput, input, 'property_catalog');
    return {
      status: 'ok',
      // Часы вызова, а не `now()` БД: фильтр возраста (`olderThanDays`) обязан мерить время
      // тем же источником, которым его мерит весь остальной прогон.
      result: await runPropertyCatalog(tx, reg, parsed, OWNER_LOCALE, {
        ownerId: ctx.actorUserId,
        now: (ctx.clock ?? (() => new Date()))(),
      }),
    };
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
 * undo_last (хвост V1, Д-1): «отмени последнее» словами в чате. Обёртка над `undoLast`
 * §7.8 — снимает последнее видимое действие журнала владельца, кем бы оно ни было сделано.
 *
 * Мимо политики §7.10 и runMutation НАМЕРЕННО: undo — не мутация графа по существу, а
 * снятие уже подтверждённой (владельцем или его же просьбой) правки; свой action он не
 * порождает (undo неотменяем), поэтому `actionId` в ToolDispatchResult не отдаётся —
 * тот означает «undo-адресуемое действие», а тут его нет. Владелец же может отменить
 * ту же правку кнопкой на карточке — тул лишь даёт модели тот же рычаг по его слову.
 *
 * Только `source: 'chat'` и актор `ai` (реестр закрывает MCP через internalOnly, рутину —
 * через ROUTINE_CLOSED_TOOLS; здесь — вторая линия, fail-closed): за чатом стоит владелец,
 * только что попросивший отменить, а за фоном и внешним агентом — нет, и снимать его
 * действия им нельзя.
 *
 * «Отменять нечего» — штатный ok-ответ модели, а не error_card в ленту: для владельца это
 * не сбой, а ответ на вопрос.
 */
async function runUndoLast(ctx: ToolCallCtx, input: unknown): Promise<ToolDispatchResult> {
  parseEnvelope(undoLastInput, input, 'undo_last');
  if (ctx.source !== 'chat' || ctx.actorKind !== 'ai') {
    return errorResult(
      'FORBIDDEN_LEVEL',
      'undo_last доступен только внутреннему чату владельца (§7.8): фоновый прогон и внешний агент чужие действия не отменяют',
      { tool: 'undo_last', source: ctx.source, actorKind: ctx.actorKind },
    );
  }
  const r = await undoLast(ctx.db, { actorUserId: ctx.actorUserId });
  if (r.ok) {
    return {
      status: 'ok',
      result: {
        undone: true,
        actionId: r.undone.actionId,
        type: r.undone.type,
        ...(r.undone.entityId !== null && { entityId: r.undone.entityId }),
        title: r.undone.title,
        note: 'действие отменено; сообщи пользователю, что именно откачено',
      },
    };
  }
  const details = r.error.details as { reason?: string } | undefined;
  if (r.error.code === 'NOT_FOUND' && details?.reason === 'nothing_to_undo') {
    return {
      status: 'ok',
      result: { undone: false, note: 'отменять нечего: неотменённых действий в журнале нет' },
    };
  }
  return { status: 'error', error: r.error };
}

/**
 * entity_query с хуком материализации (§5.4, fix round A3): тот же общий каркас, что у
 * entity.query/count роутера, — окно по датам материализует recurring-инстансы ДО
 * компиляции; ошибки разбора/компиляции — ExecError/VALIDATION (§6.4), их развернёт catch
 * dispatchTool.
 *
 * ДВА ВХОДА, ОДИН ПУТЬ (§А5-4): текст разбирается в то же дерево, что приходит в `ast`, и
 * дальше они неразличимы — окно, компиляция и карточка одни на оба. Дерево со входа `ast`
 * уже прошло схему канона в envelope (`entityQueryInput`), а по РЕЕСТРУ его проверяет
 * компилятор — неизвестный id свойства, аспекта или роли он отвергает `VALIDATION` с
 * причиной `UNKNOWN_FIELD`/`UNKNOWN_ASPECT`/`UNKNOWN_ROLE`. Второй сверки по реестру здесь
 * нет намеренно: она была бы вторым мнением о том, что в реестре есть, и первым же
 * расхождением дала бы «схема пропустила, компилятор упал».
 */
async function runEntityQuery(ctx: ToolCallCtx, input: unknown): Promise<ToolDispatchResult> {
  assertQueryTreeDepth(input);
  const parsed = parseEnvelope(entityQueryInput, input, 'entity_query');
  return queryWithMaterialization({
    db: ctx.db,
    actorUserId: ctx.actorUserId,
    thisEntityId: null, // `this` вне контекста сущности
    parse: (cctx) => parsed.ast ?? parseQueryText(parsed.query as string, cctx),
    run: async (tx, ast, cctx) => {
      const compiled = compileQueryAst(ast, cctx);
      const rows = await tx.execute(compiled);
      const entities = [...rows].map((r) => toWireEntityFromSql(r as Record<string, unknown>));
      const card: Card = {
        kind: 'query_result',
        ...(ast.title !== undefined && { title: ast.title }),
        count: entities.length,
        entityIds: entities.map((e) => e.id),
      };
      // МОДЕЛИ уезжает LLM-проекция (§А9-2): props по key, без `meta` и без старой карты
      // аспектов. Карточка при этом строится по id — её читает web (02 §2.3), и там адрес
      // значения остаётся машинным. Реестр берётся из контекста компиляции: он же
      // разбирал и компилировал этот запрос, и второй снимок мог бы с ним разойтись.
      return { status: 'ok', result: entities.map((e) => toLlmEntity(e, cctx.reg)), card };
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
 * агрегат с окном по датам считается ПОСЛЕ материализации инстансов окна.
 *
 * `field` — АДРЕС СВОЙСТВА, а не имя поля аспекта: компилятор канона адресует значение в
 * `props` по id (§А5-2). Резолвится он тем же правилом, что имена в тексте запроса
 * (`resolvePropertyFieldId`): id либо key. Старых имён полей аспекта (`amount`) он больше
 * не принимает — их карта снята «Пересевом мира» вместе с формой данных, а промпты линейки
 * v5 показывают модели канон.
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
    parse: (cctx) => parseQueryText(parsed.query, cctx),
    run: async (tx, ast, cctx) => {
      if (parsed.aggregate === 'count') {
        const compiledCount = compileCountAst(ast, cctx);
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
      const compiled = compileSumAst(ast, sumProperty(field, cctx), cctx);
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

/**
 * Имя поля агрегата → id свойства. Не резолвится — структурная VALIDATION с именем, которое
 * прислала модель: у `compileSumAst` на руках был бы только несуществующий id, и отказ
 * назвал бы его вместо того, что написал вызывающий.
 *
 * Аспекты САМОГО ЗАПРОСА в резолве больше не участвуют, и это следствие сноса старой формы:
 * разводить ими приходилось СТАРОЕ имя поля (`amount` носили и `orbis/financial`, и
 * `orbis/budget`). Канон однозначен — `orbis/amount` называет одно свойство.
 */
function sumProperty(field: string, cctx: CompileCtx): string {
  const id = resolvePropertyFieldId(field, parseRegistryOf(cctx));
  if (id === undefined) {
    throw new ExecError('VALIDATION', `user_query: свойства '${field}' нет в реестре`, {
      tool: 'user_query',
      field,
    });
  }
  return id;
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
  reg: RegistrySnapshot,
  keyFieldsMap: Map<string, string[]>,
  knownTools: ReadonlySet<string>,
): Promise<ToolDispatchResult> {
  // Имя тула — ОДНО на реестр, диспатч и исполнителя (общая `attachToolName`, §А9-1):
  // переводить его здесь больше не во что.
  // Структурная валидация ДО классификации (§7.10 дословно: уровень получает tool-call
  // ПОСЛЕ структурной валидации input'а): невалидный envelope — честная VALIDATION с
  // zod-issues (путь самокоррекции модели), а не wouldBe; для batch — сверка имён с
  // реестром плюс валидация каждого operations[].input схемой его тула.
  // Факты классификатора дальше извлекаются из уже ПРОВАЛИДИРОВАННОГО payload'а.
  const tool = def.name;
  const batchPayload =
    def.name === 'batch_execute'
      ? validateBatchOperations(assertBatchToolsKnown(input, knownTools))
      : undefined;
  const payload = batchPayload ?? validateMutationEnvelope(def, input);

  // §7.10: уровень определяет политика по типизированным фактам вызова, не модель;
  // forbidden и explicit-confirmation разворачиваются ДО execute — в БД и журнал (§7.8)
  // ничего не попадает
  // Адреса свойств — ПО ГРАНИЦЕ (§А9-1): неизвестный key отвергается здесь, с подсказкой
  // ближайшего, а не доезжает до валидатора записи. Разница не косметическая: валидатор
  // отвечает `UNKNOWN_PROPERTY` уже внутри исполнения и по ИДЕНТИФИКАТОРУ, то есть модели,
  // написавшей `orbis/amout`, он повторяет её же опечатку и молчит о том, что рядом есть
  // `orbis/amount`. Проверяются все операции разом — одиночная мутация это список из одной.
  const unknownProperty = unknownPropertyError(
    reg,
    batchPayload?.operations ?? [{ tool, input: payload }],
  );
  if (unknownProperty !== null) return unknownProperty;

  const facts = factsFromToolCall(def, payload);
  const classified = classifyToolCall({
    ...facts,
    actorKind: ctx.actorKind,
    explicitCommand: ctx.explicitCommand,
  });
  const gated = levelGate(classified, def.name);
  if (gated !== null) return gated;

  // Инструкция act-рутины — содержание её автономии (V1.10, C1b-1): тело и заголовок
  // рутины с `mode: act` уезжают в системный слой прогона целиком, и правка их AI/агентом без
  // подтверждения обходила бы замок, который держит гейт grantsAutonomy. Проверка по БД
  // (объект — рутина в act), а не по форме: аспекта рутины в таком патче нет.
  //
  // Спрашивается ВСЕГДА, а не только пока уровень ещё не поднят: с фикс-раунда 3 ответ едет
  // не только в уровень, но и в СВОДКУ карточки, и прежнее короткое замыкание на уже
  // поднятом уровне отняло бы у владельца половину сведений — «подтверди автономию» без
  // «заодно правят инструкцию». Цена — один SELECT, и только когда операции вообще трогают
  // `title`/`body`: иначе функция уходит по пустому списку id, не сходив в БД.
  const ops = batchPayload?.operations ?? [{ tool, input: payload }];
  const ownerKnows = ctx.actorKind === 'owner';
  // РАЗОРУЖЕНИЕ ЧЕРЕЗ НОСИТЕЛЬ (рулинги Р-12-2 и Р-12-3). Два вызова разоружают рутину
  // МОЛЧА, потому что в их ФОРМЕ снятия не видно — оно есть только в разнице с текущим
  // состоянием: `attach_orbis_routine` заменяет носитель целиком (§А7-4), а
  // `entity_update {aspects:{detach:['orbis/routine']}}` уносит сам носитель, оставляя
  // значения (Р9). Замок §7.10 оба классифицировал как `execute`, то есть AI одним вызовом
  // гасил режим и стирал белый список без карточки — ровно то, что запрещено делать через
  // `unset`, только в обход. Правило замка сформулировано по СМЫСЛУ действия, а не по имени
  // тула, поэтому проверка стоит здесь: классификатор чист, а состояние знает диспатч.
  //
  // Владельцу карточка не нужна и здесь: он разоружает свою рутину, глядя на неё, и ряд
  // автономии §7.10 для `owner` не срабатывает по той же причине.
  const scan: CarrierScan = ownerKnows
    ? emptyCarrierScan()
    : await autonomyChangedByCarrier(ctx, ops);
  const disarmed = scan.changes;
  // Гейт инструкции act-рутины (C1b-1) читается из ТОГО ЖЕ скана: вопрос «чем станет текст
  // этой записи» задаётся тому же свёрнутому состоянию, что и вопрос об оживлении, — иначе
  // между двумя правилами снова появится зазор, который закрывался перестановкой вызовов.
  // ДЕДУПЛИКАЦИЯ обязательна: скан отвечает ПО ОПЕРАЦИЯМ, а фраза говорит О РУТИНЕ, и две
  // операции одной пачки, правящие текст одной рутины, давали «правка «X», «X»». Снятый
  // `actRoutineInstructionTargets` брал заголовки одним `SELECT` по сущностям и потому дублей
  // не знал — переезд на пооперационный ответ принёс их вместе с точностью момента.
  // Единица фразы — пара «повод + рутина»: одна и та же рутина законно попадает и в `edit`, и
  // в `becomes`, и это два разных события для владельца.
  const instructionOf = [
    ...new Map(
      [...scan.instructionAtOp.values()].map((touch) => [
        `${touch.reason}\u0000${touch.title}`,
        touch,
      ]),
    ).values(),
  ];
  const level: ConfirmationLevel =
    instructionOf.length > 0 || disarmed.size > 0 ? 'explicit-confirmation' : classified;

  // Объектный пре-чек рутинной мутации (D42 ОЧ.4, блокер Б2): запрещённое ПО ОБЪЕКТУ
  // отклоняется ДО постановки и не откладывается никогда. Стоит РАНЬШЕ ветки отложки
  // намеренно: небезопасное ПО УРОВНЮ теперь откладывается, а этому отказу открываться
  // нечем — ни один из четырёх его поводов не становится безопаснее оттого, что владелец
  // разберёт его позже. Уровень `execute` пре-чек не смотрит: там ничего не откладывается, и
  // запрет держит стадия 4 executor'а своим отказом — тем же кодом и с тем же `reason`.
  if (ctx.source === 'routine' && level !== 'execute') {
    const forbidden = await routineDeferForbidden(
      ctx,
      ops,
      facts,
      // Тут вопрос другой — не «что за события», а «какие рутины трогает фон», поэтому и
      // дедупликация своя, по заголовку: повод в тексте отказа не участвует.
      [...new Set(instructionOf.map((touch) => touch.title))],
    );
    if (forbidden !== null) {
      // `reason` — та же пара, что у запрета по объекту в executor'е: код FORBIDDEN_LEVEL
      // перегружен шестью источниками, и различать их в тестах и UI больше нечем
      return errorResult('FORBIDDEN_LEVEL', forbidden, {
        tool: def.name,
        level,
        reason: 'routine_untouchable',
      });
    }
  }

  // Небезопасное действие фонового прогона — больше не отказ, а ЕДИНИЦА ПАЧКИ (D42 ОЧ.4):
  // владелец решит её потом карточкой, а прогон продолжит работу. Одиночное — потому что
  // групповой вызов рутине закрыт гейтом режима всегда (ROUTINE_CLOSED_TOOLS, registry.ts),
  // и карточку группы, которую сегодня нечем ни собрать, ни показать, рождать не за что:
  // условие fail-closed — batch на explicit-уровне упрётся в гейт инварианта 5 строкой ниже.
  const defersUnit =
    ctx.source === 'routine' && level === 'explicit-confirmation' && batchPayload === undefined;

  // Инвариант 5 (V1.10) в формулировке D42 (§9.1): «В фоне небезопасное откладывается с
  // продолжением работы; запрещённое — по уровню или по объекту — отклоняется и не
  // откладывается никогда».
  //
  // Прежнее обоснование отказа («за прогоном владельца нет, и pending повис бы в её треде
  // вопросом без контекста») снято: контекст пачке даёт отчёт завершившегося прогона рядом
  // с карточками, а предусловия, снятые при постановке (ОЧ.13), не дают отложенному
  // действию затереть правку владельца.
  //
  // Что осталось гейту: всё, что рутине и не откладывается, и не исполняется. Сегодня это
  // `preview` (батч — но он рутине закрыт гейтом режима) и любой будущий уровень таблицы
  // §7.10; `forbidden` сюда не доходит — его снял levelGate выше, а запрет ПО ОБЪЕКТУ —
  // пре-чек строкой выше.
  if (ctx.source === 'routine' && level !== 'execute' && !defersUnit) {
    return errorResult(
      'FORBIDDEN_LEVEL',
      `в фоне откладывается только одиночное небезопасное действие — уровень «${level}» не исполняется и не откладывается (V1.10)`,
      { tool: def.name, level },
    );
  }

  // Лимит §8 на число рутин (V1.15) — ДО записи и до pending: право завести рутину
  // проверяется там же, где проверяются все остальные права вызова.
  const overLimit = await gateRoutinesMax(ctx, tool, payload, batchPayload);
  if (overLimit !== null) return overLimit;

  if (defersUnit) return await deferRoutineUnit(ctx, def, tool, payload);

  if (level === 'explicit-confirmation') {
    // §7.10: действие НЕ исполняется — в тред пишется карточка-запрос с immutable
    // payload'ом (уже envelope-валидированным; имена операций batch сверены с реестром);
    // до approve ничего не записано ни в граф, ни в журнал §7.8. Исполнение и
    // ревалидацию текущего состояния делает approve (policy/pending.ts)
    const pending = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
      // Карточка обязана называть, ЧТО подтверждается, — а не имя тула: снятие замка (как и
      // его установка) — осознанный акт человека (B1-2). Называется ВСЁ, что подняло
      // уровень: и правка автономии (V1.10 — режим, белый список и то, что СНИМАЕТСЯ), и
      // правка инструкции act-рутины (C1b-1). Фразы СКЛЕИВАЮТСЯ, а не вытесняют друг друга:
      // до фикс-раунда 3 ветка инструкции требовала «снятий нет», и в пачке «переименовать
      // act-рутину + разоружить её attach'ем» правка заголовка не называлась вовсе.
      // Условие автономии шире `grantsAutonomy`: разоружение через носитель фактов
      // классификатора не меняет, а карточку требует ровно так же (Р-12-2, Р-12-3).
      const summaryParts: string[] = [];
      if (facts.grantsAutonomy || disarmed.size > 0) {
        summaryParts.push(await autonomySummary(tx, ops, scan));
      }
      // ТРЕТИЙ ПОВОД — МУТАЦИЯ РЕЕСТРА (§С2-1, ряд 4a). Фраза берётся ТОЙ ЖЕ функцией и по
      // ТОМУ ЖЕ снимку, что у карточки `preview` и у отложенной единицы: владелец видит все
      // три в одной ленте, и три разных обозначения одного действия читались бы как три
      // разных действия. Без этой ветки сводка не собиралась вовсе, и `createPending`
      // честно падал в фолбэк по имени тула — владелец получал «Требуется подтверждение:
      // property_merge» и жал «Принять» вслепую, тогда как §С8-11 требует у слияния и дельты
      // ДИФФ, то есть форму, в которой видно содержание.
      //
      // ФРАЗЫ СКЛЕИВАЮТСЯ с поводами выше, а не вытесняют их: пачка «слить свойства +
      // разоружить act-рутину» обязана назвать оба (тот же довод, по которому фикс-раунд 3
      // Задачи 12 переводил ветку инструкции со «вместо» на «склеиваются»).
      //
      // Идём по `ops`, а не по `def.name`: форм, доводящих реестровую операцию до этой
      // ветки, ДВЕ — одиночный вызов и `batch_execute` с реестровой операцией внутри
      // (конверты реестра лежат в `MUTATION_ENVELOPES`, и пачка сворачивается по самой
      // тяжёлой операции). Источник роли не играет — чат и MCP идут сюда одним кодом, а
      // рутина до ветки не доходит вовсе: одиночное уходит в отложку выше, пачка ей закрыта
      // (`ROUTINE_CLOSED_TOOLS`). Дедуп по самой фразе: две операции, сливающие одну и ту же
      // пару, дали бы владельцу одно и то же дважды.
      const registryParts = [
        ...new Set(
          ops
            .filter((op) => REGISTRY_TOOL_NAMES.has(op.tool) && isRecord(op.input))
            .map((op) =>
              registryOperationSummary(reg, op.tool, op.input as Record<string, unknown>),
            ),
        ),
      ];
      if (registryParts.length > 0) summaryParts.push(registryParts.join('; '));
      // Правку и СТАНОВЛЕНИЕ владельцу надо назвать по-разному: «правка» про запись, текста
      // которой этот вызов не касался, была бы неправдой — её тело написали раньше и молча,
      // а этот вызов делает его инструкцией.
      for (const reason of ['edit', 'becomes'] as const) {
        const titles = instructionOf.filter((touch) => touch.reason === reason);
        if (titles.length === 0) continue;
        const names = titles.map((touch) => touch.title).join('», «');
        summaryParts.push(
          reason === 'edit'
            ? `Инструкция act-рутины: правка «${names}»`
            : `Инструкция act-рутины: тело «${names}» становится инструкцией`,
        );
      }
      // МАСШТАБ ПАЧКИ НЕ ТЕРЯЕТСЯ ВМЕСТЕ С ФОЛБЭКОМ — и приписка стоит на ВСЕЙ сводке, а не
      // на одном поводе. Собранная сводка вытесняет `pendingSummary` целиком, а тот у батча
      // говорил «N операций»: владелец, подтверждающий что угодно внутри пачки из
      // одиннадцати, подписывает всю группу и обязан видеть её объём — довод один и тот же
      // для реестровой операции, выдачи автономии и правки инструкции. Фикс-раунд 1 повесил
      // приписку только на реестровую часть, и пачка «разоружить act-рутину + создать
      // запись» осталась без счёта — асимметрия, которой у правила нет.
      //
      // ЗАДВОЕНИЯ НЕТ ПО ПОСТРОЕНИЮ: приписка живёт в той же ветке, что и `summary`, а она
      // ставится только когда сводка СОБРАЛАСЬ. Пустая сводка уходит в `pendingSummary`,
      // который сам скажет «N операций» — второй раз это же число не приедет.
      const n = batchPayload?.operations.length;
      const summary =
        summaryParts.length === 0
          ? undefined
          : n === undefined
            ? summaryParts.join('; ')
            : `${summaryParts.join('; ')} — в пачке из ${n} ${operationsNoun(n)}`;
      return createPending(tx, {
        threadId: ctx.threadId,
        ...(summary !== undefined && { summary }),
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
      });
    });
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
  // КАРТОЧКИ РАЗБОРА КОНФЛИКТА СЛИЯНИЯ ЗДЕСЬ БОЛЬШЕ НЕТ, И ЭТО НЕ ПОТЕРЯ. До Задачи 16
  // `property_merge` из чата исполнялся ЭТОЙ строкой, и конфликт значений (§А10-2)
  // разбирала она же. С §С2-1 слияние — `behavior-delta`: ряд 4a поднимает его до
  // `explicit-confirmation` ДЛЯ ЛЮБОГО актора, значит до `execute` оно здесь не доходит ни
  // одним путём (batch тоже: пачка сворачивается по самой тяжёлой операции). Вызов остался
  // бы МЁРТВЫМ адресом, а обещание докблока — неправдой. Дом карточки переехал туда, где
  // сохранённый payload теперь и исполняется, — в `approvePending` (`policy/pending.ts`),
  // и оттуда он накрывает и кнопку владельца, и «Принять» единицы пачки. Вернуть строку
  // сюда придётся ровно при одном условии: если таблица §7.10 однажды снова начнёт давать
  // мутации реестра уровень `execute` или `preview`.
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
    // Одиночный preview СТАЛ ДОСТИЖИМ Задачей 16: ряд 4b §С2-1 («своя строка реестра от
    // AI») — первый и пока единственный, кто им отвечает на не-batch вызов. Прежняя
    // редакция этой приписки («MVP-таблицей недостижим») была верна до него и снята вместе
    // с поводом. Diff по-прежнему строится только у `entity_update` — прежние значения
    // против новых из inverse журнала (§7.8); у операций реестра пополевого diff'а нет, и
    // называет правку сводка.
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
        // Сводка НАЗЫВАЕТ СДЕЛАННОЕ, а не имя тула: preview исполняет действие и лишь
        // показывает его владельцу, и «property_create» в ленте не отвечает на вопрос
        // «что у меня в системе изменилось». Имя тула остаётся запасным ответом для
        // форм, у которых своей фразы ещё нет.
        summary:
          def.name === 'entity_update'
            ? `Обновление «${(result as WireEntity).title}»`
            : REGISTRY_TOOL_NAMES.has(def.name) && isRecord(payload)
              ? registryOperationSummary(reg, def.name, payload)
              : def.name,
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

/**
 * КАК НАЗВАТЬ ВЛАДЕЛЬЦУ МУТАЦИЮ РЕЕСТРА — одной фразой на все карточки, которые её несут.
 *
 * МЕСТ СБОРКИ КАРТОЧКИ, СПОСОБНОЙ НЕСТИ МУТАЦИЮ РЕЕСТРА, ЧЕТЫРЕ, и три из них зовут эту
 * функцию:
 *  1. `confirmation_card` mode `preview`, ОДИНОЧНЫЙ вызов — §С2-1 ряд 4b, своя строка,
 *     исполнено и показано (`runMutation`, ветка `level === 'preview'`) → зовёт;
 *  2. `confirmation_card` mode `explicit` — ряд 4a, слияние/статус/дельта, ждёт нажатия
 *     (`runMutation`, ветка `level === 'explicit-confirmation'` → `summaryParts` →
 *     `createPending`, где карточка и собирается, `policy/pending.ts`) → зовёт;
 *  3. `deferred_action_card` — та же операция от рутины, единица пачки D42
 *     (`snapshotRegistryUnit` ниже) → зовёт;
 *  4. `confirmation_card` mode `preview`, ПАЧКА (`runMutation`, ветка `batchPayload !==
 *     undefined` при `level === 'preview'`) → НЕ зовёт, и это решение, а не пропуск: у
 *     группы пополевого diff'а нет и никогда не было, масштаб её и есть её содержание
 *     («N операций»). Пачка с `property_create` внутри доходит сюда живьём (ряд 4b даёт ей
 *     `preview`), и владелец видит счёт, а не перечень. Развернуть счёт в перечень — работа
 *     на карточку группы целиком, а не на реестровую половину: сегодня она молчит и об
 *     остальных операциях тоже, и чинить надо либо всё, либо ничего.
 *
 * Владелец видит их в одной ленте, и разные обозначения одного и того же действия читались
 * бы как разные действия — тот же довод, по которому у строки снятия свойства литерал общий
 * с предложением рутины. Перечень пиннится НЕ грепом по вызовам этой функции: дефект уже
 * дважды был формы «место сборки карточки, которое функцию НЕ звало», и такой греп его не
 * видит по построению. Пин — источниковый, по местам сборки самих карточек
 * (`dispatch.test.ts`, «места сборки карточек — перечень закрыт по всему apps/server/src»).
 *
 * СЧЁТ «ЧЕТЫРЕ» ВЕРЕН СЕГОДНЯ, А ДОСЯГАЕМОСТЬ ОХРАНЫ ПОД НИМ — НАЗВАНА, НЕ АБСОЛЮТНА.
 * Охрана обходит весь `apps/server/src` (не список файлов — это исправление раунда 3, до него
 * пятая сборка в третьем файле проходила молча) и видит место сборки, у которого род записан
 * ЛИТЕРАЛОМ. Род, пришедший переменной или параметром фабрики, она не видит: проба ре-ревью
 * `const kind = …; return { kind, mode: 'preview', … }` проходит и линт, и пин. Сегодня это
 * не дыра — все шесть сборщиков `Card` пишут род литералом (`dispatch.ts:681,786,2721`,
 * `ai/escalation.ts:498,632`, `policy/pending.ts:360`), — но условие обнуления охраны прямое:
 * если три почти одинаковые inline-сборки вынесут в общий хелпер с родом-параметром, новые
 * места станут невидимы, а «четыре» останется зелёным навсегда. Тогда охрану надо менять
 * вместе с рефакторингом, а не после него.
 * Границей служит сервер: web карточки РИСУЕТ, но не собирает, производитель у них один
 * (`Card`, `tools/registry.ts`).
 * Прежние редакции этого докблока насчитали сперва ДВЕ карточки (неправда на explicit), потом
 * ТРИ (неправда на пачке), потом объявили охрану абсолютной (неправда на роде-переменной) —
 * каждый раз это правилось после того, как ошибка проезжала в ветку. Четвёртая редакция
 * говорит не «поймать нельзя нигде», а ЧТО ИМЕННО ловится и чем это перестанет быть верным.
 *
 * ФРАЗЫ НЕЙТРАЛЬНЫ КО ВРЕМЕНИ, И ЭТО ПРАВИЛО, А НЕ СТИЛЬ. Одна и та же строка уезжает и на
 * карточку, где действие УЖЕ исполнено (preview), и на карточку, где оно ЕЩЁ НЕ произошло
 * (запрос, отложенная единица). Прошедшее время правдиво ровно в одном из трёх случаев, а в
 * двух других сообщает владельцу «расслабься, уже случилось» там, где у него СПРАШИВАЮТ
 * разрешение, — замок, рассказывающий о несделанном в прошедшем времени, хуже замка без
 * сводки вовсе. Поэтому голова каждой фразы — ОТГЛАГОЛЬНОЕ СУЩЕСТВИТЕЛЬНОЕ («Заведение»,
 * «Правка», «Слияние», «Настройка», «Сброс»), а не форма глагола. Ре-ревью фикс-раунда 1
 * поймало здесь «Заведено свойство «X»» на карточке-ЗАПРОСЕ при нуле строк в
 * `property_definitions`. Правило пиннится тестом, который проверяет ВСЕ пять фраз и падает
 * на шестой, написанной иначе.
 *
 * Функция ЭКСПОРТИРОВАНА ровно за этим — по тому же доводу, что `routineGate` и
 * `routineDeferForbidden`: правило, которое никто не проверил, — это не правило. Живьём через
 * диспатч доходят не все пять фраз (у трёх из пяти тулов уровень выше `preview`), и перебор
 * по реестру тулов возможен только отсюда.
 *
 * ИМЕНА — ПОДПИСИ ИЗ РЕЕСТРА, а не адреса: id своей строки это uuid (Р3), и «019e4466-…» в
 * карточке не отвечает на вопрос, что владельцу предлагают. Снимок передаёт вызывающий —
 * чатовый путь свой, допакетный (свежее взять неоткуда: операция уже исполнена), отложка
 * свой, снятый в той же транзакции. У создания подпись берётся из ВЫЗОВА: строки в снимке
 * ещё нет по построению.
 *
 * ИЗВЕСТНОЕ РАСХОЖДЕНИЕ, НАЗВАННОЕ ВСЛУХ: заголовок ДЕЙСТВИЯ в журнале (§7.8, `registryPlan`
 * в `executor/executor.ts`) у правки свойства говорит `«<id>»`, а не подпись. Владелец видит
 * его в audit-строке рядом с этой карточкой. Расхождение не чинится здесь: заголовок журнала
 * — территория Задачи 15, и правка его тянет за собой снимок в исполнителе; остаток записан
 * в отчёт.
 */
export function registryOperationSummary(
  reg: RegistrySnapshot,
  tool: string,
  payload: Record<string, unknown>,
): string {
  const named = (label: unknown, fallback: unknown): string =>
    isRecord(label)
      ? effectiveLabel(label as Record<string, string>, OWNER_LOCALE)
      : String(fallback);
  const propertyName = (address: unknown): string => {
    if (typeof address !== 'string') return String(address);
    const def = resolvePropertyRef(reg, address);
    return def === undefined ? address : effectiveLabel(def.label, OWNER_LOCALE);
  };
  const aspectName = (address: unknown): string => {
    if (typeof address !== 'string') return String(address);
    const def = reg.aspects.get(address);
    return def === undefined ? address : effectiveLabel(def.label, OWNER_LOCALE);
  };
  switch (tool) {
    case 'property_create': {
      const proposed = payload.status === 'proposed' ? ' (предложение)' : '';
      return `Заведение свойства «${named(payload.label, tool)}»${proposed}`;
    }
    case 'property_update':
      return `Правка свойства «${propertyName(payload.id)}»`;
    case 'property_merge':
      return `Слияние свойств: «${propertyName(payload.source)}» → «${propertyName(payload.into)}»`;
    case 'aspect_delta_set':
      return `Настройка аспекта «${aspectName(payload.aspect)}»`;
    case 'aspect_delta_remove':
      return `Сброс настройки аспекта «${aspectName(payload.aspect)}»`;
  }
  // Недостижимо: зовётся только под `REGISTRY_TOOL_NAMES`, и switch перечисляет все пять.
  return tool;
}

/** Строка карточки отложенного действия — «было → станет» по одному полю (ОЧ.13). */
type DeferredRow = { field: string; before?: string; after: string };

/**
 * «Станет» у строки СНЯТИЯ свойства в карточке отложенной единицы. Тот же литерал, что у
 * строки предложения (`routines/lifecycle.ts`): владелец видит обе карточки в одной пачке,
 * и два разных обозначения одного и того же читались бы как два разных исхода.
 */
const DEFERRED_UNSET_VALUE = '—';

/**
 * Отложка небезопасного действия рутины (D42 ОЧ.4, ОЧ.13) — ядро оси Б среза: вместо
 * `FORBIDDEN_LEVEL` прогон получает честное `{status:'pending_confirmation', pendingId}` и
 * работает дальше, а сам вызов ложится единицей пачки в тред РУТИНЫ — туда, где владелец
 * читает её историю и её предложения.
 *
 * ПОРЯДОК ШАГОВ ЗНАЧИМ и не переставляется: проба существования по PK → есть запись, значит
 * это РЕТРАЙ (капом он не отвергается) → иначе счёт открытых единиц → кап → снятие
 * предусловий → запись. Наивный порядок «кап → запись» отверг бы повтор ДЕСЯТОЙ единицы:
 * модель, повторившая шаг после сетевого чиха, получила бы «пачка полна» на том, что уже
 * стоит в пачке, и стала бы чинить не то.
 *
 * ЛИЧНОСТЬ ЕДИНИЦЫ СЧИТАЕТСЯ ОТ ИСХОДНОГО PAYLOAD'А МОДЕЛИ (tool + envelope-input), а не от
 * того, что уедет в запись: ретрай модели побайтово тот же, а предусловия ВТОРОГО снятия
 * могли бы уже отличаться (владелец успел тронуть цель) — и один и тот же шаг дал бы
 * владельцу вторую карточку. В `createPending` при этом едет input С предусловиями: на
 * «Принять» исполняется именно он.
 *
 * ВСЁ — В ОДНОЙ ТРАНЗАКЦИИ ВЛАДЕЛЬЦА, и это контракт, а не удобство: `listRunUnits` требует
 * `withIdentity` ТОГО ЖЕ владельца (иначе судьбы молча читаются как `open`, и кап считал бы
 * уже решённое), а проба и запись обязаны видеть одну и ту же ленту.
 */
async function deferRoutineUnit(
  ctx: ToolCallCtx,
  def: OrbisToolDef,
  tool: string,
  payload: unknown,
): Promise<ToolDispatchResult> {
  const routine = ctx.routine;
  const runId = ctx.runId;
  if (routine === undefined || runId === undefined) {
    // Недостижимо: `source:'routine'` без контекста рутины снимает routineGate ещё в
    // pre-блоке. Fail-closed, а не `!`: единица без прогона не попала бы ни в пачку, ни в
    // сверку `undecided` — она повисла бы в треде карточкой, которой никто не ждёт.
    return errorResult(
      'FORBIDDEN_LEVEL',
      `отложить вызов «${def.name}» нечем: у вызова из прогона нет контекста рутины (V1.10)`,
      { tool: def.name },
    );
  }
  const dedupeKey = deferDedupeKey(runId, tool, payload);
  const pendingId = pendingMessageId(ctx.actorUserId, dedupeKey);

  return await withIdentity(ctx.db, ctx.actorUserId, async (tx): Promise<ToolDispatchResult> => {
    // 1. Проба существования по PK (образец — `routines/propose.ts`): `createPending`
    // идемпотентен, но «завёл» и «нашёл» он не различает, а кап различать обязан.
    const found = await tx
      .select({ metadata: chatMessages.metadata })
      .from(chatMessages)
      .where(eq(chatMessages.id, pendingId));
    const existing = found[0];
    if (existing !== undefined) {
      // Карточка возвращается СОХРАНЁННАЯ, а не пересобранная: «было» в ней — снимок первой
      // постановки (ОЧ.13, предусловия не переснимаются), и пересборка нарисовала бы модели
      // одно, а владельцу в ленте — другое.
      const stored = (existing.metadata as { cards?: unknown[] }).cards?.[0] as Card | undefined;
      if (stored === undefined) {
        throw new ExecError('VALIDATION', 'pending-запись повреждена — у единицы нет карточки', {
          pendingId,
        });
      }
      return { status: 'pending_confirmation', pendingId, card: stored };
    }

    // 2. Кап единиц на прогон (ОЧ.10) — по ОТКРЫТЫМ: решённая владельцем освобождает место.
    // Отказ структурный, чтобы модель скорректировалась (§9.9); молчаливое усечение
    // означало бы «сделано» для модели и «не было» для владельца.
    const open = (await listRunUnits(tx, ctx.actorUserId, runId)).filter((u) => u.fate === 'open');
    if (open.length >= MAX_RUN_UNITS) {
      return errorResult('VALIDATION', 'пачка полна — заверши прогон', {
        reason: 'run_units_cap',
        limit: MAX_RUN_UNITS,
      });
    }

    // 3. Предусловия и «было» снимаются ЗДЕСЬ и больше не переснимаются (ОЧ.13, §9.4)
    const snapshot = await snapshotDeferredUnit(tx, ctx.actorUserId, tool, payload);
    if ('error' in snapshot) return snapshot.error;

    const pending = await createPending(tx, {
      // Тред РУТИНЫ, а не тред вызова (V1.6): единица — событие рутины, и читается она там
      // же, где вся её остальная переписка с владельцем.
      threadId: await ensureEntityThread(tx, ctx.actorUserId, routine.id),
      actor: { userId: ctx.actorUserId, kind: ctx.actorKind, source: 'routine', runId },
      tool,
      input: snapshot.input,
      level: 'explicit-confirmation',
      dedupeKey,
      kind: 'action',
      card: {
        kind: 'deferred_action_card',
        pendingId,
        runId,
        routineId: routine.id,
        summary: snapshot.summary,
        rows: snapshot.rows,
      },
      // Строка ленты называет СОБЫТИЕ, а не «требуется подтверждение»: за прогоном никто не
      // стоит, подтверждать в моменте некому — владелец разберёт пачку позже.
      content: `Отложено до решения: ${snapshot.summary}`,
      clock: ctx.clock,
    });
    return { status: 'pending_confirmation', pendingId: pending.pendingId, card: pending.card };
  });
}

/**
 * Снятие предусловий единицы ПРИ ПОСТАНОВКЕ (D42 ОЧ.13) плюс строки «было → станет» для её
 * карточки. Возвращает payload, который уедет в pending-запись, — исполнит его approve.
 *
 * Механика — ТА ЖЕ, что у предложения рутины, и теми же двумя функциями: `loadTargets`
 * читает цели под RLS (отсутствующая — NOT_FOUND здесь, а не на кнопке владельца),
 * `buildUpdate` собирает `entity_update` со снятыми предусловиями (`in:[текущее]` /
 * `absent:true`; для тела — `expectedUpdatedAt` НАСТОЯЩЕГО снимка, модельный отбрасывается).
 * Второй реализации той же пары в сервере нет намеренно: разъехавшись, она дала бы
 * предложению и отложке РАЗНЫЕ предусловия на одном и том же патче.
 *
 * АРХИВАЦИЮ `buildUpdate` НЕ ПОКРЫВАЕТ — он ходит только по `input.aspects`, а `archived`
 * это КОЛОНКА, и для чистой архивации список предусловий у него пуст. Предусловие по
 * core-свойству `orbis/archived` (§А1-3: хранение колонкой, адрес — обычный id свойства)
 * добавляет эта функция, а не `buildUpdate`: предложение обязано остаться байт-в-байт
 * прежним. `in:[false]`, а НЕ `absent:true` — колонка NOT NULL DEFAULT false всегда несёт
 * значение, и `absent` не был бы выполним никогда.
 *
 * Строку «было» для архивации тоже кладём здесь и явно: общий сборщик строк предложения
 * (`routines/lifecycle.ts`, updateRows) строит «было» ТОЛЬКО из пар, совпавших с
 * `input.aspects`, — предусловия по колонке там нет, и карточка архивации показывала бы
 * владельцу одно «станет».
 *
 * Формы, кроме `entity_update`, — fail-closed отказ. Сегодня они недостижимы (уровень выше
 * `execute` прочим даёт только выдача автономии, а её снимает объектный пре-чек), но если
 * таблица §7.10 однажды поменяется, лучше прежний отказ, чем единица, которой нечем ни
 * протухнуть, ни объяснить владельцу, что она сделает, — ровно то, чего велел не допускать
 * блокер Б3 ревью спеки.
 */
async function snapshotDeferredUnit(
  tx: Tx,
  ownerId: string,
  tool: string,
  payload: unknown,
): Promise<
  { input: unknown; summary: string; rows: DeferredRow[] } | { error: ToolDispatchResult }
> {
  if (REGISTRY_TOOL_NAMES.has(tool) && isRecord(payload)) {
    return await snapshotRegistryUnit(tx, ownerId, tool, payload);
  }
  if (tool !== 'entity_update' || !isRecord(payload)) {
    return {
      error: errorResult(
        'FORBIDDEN_LEVEL',
        `в фоне вызов «${tool}» не откладывается: снять предусловия и показать «было» у него нечем (V1.10)`,
        { tool },
      ),
    };
  }
  const targets = await loadTargets(tx, ownerId, [{ tool, input: payload }]);
  if ('error' in targets) return { error: targets.error };
  const id = String(payload.id);
  const current = targets.rows.get(id);
  if (current === undefined) {
    // Недостижимо: отсутствующую цель `loadTargets` уже вернул бы как NOT_FOUND
    return { error: errorResult('NOT_FOUND', 'сущность не найдена', { id }) };
  }
  const built = buildUpdate(targets.reg, 0, payload, current);
  if ('error' in built) return { error: built.error };
  const input: Record<string, unknown> = { ...built.op.input };

  // Заголовок и признак архива цели читаются отдельным запросом: `loadTargets` возвращает
  // только аспекты и штамп версии, а трогать его тело нельзя — оно общее с предложением.
  // Цена — один SELECT по PK на постановку единицы; `archived` едет тем же запросом.
  const head = await entityHead(tx, id);
  // Гард архивации (Minor ревью Задачи 5): предусловие по колонке ставится ниже ЛИТЕРАЛОМ
  // `in:[false]`, а не снимком. Цель, УЖЕ архивированную — владельцем среди прогона или
  // повторным намерением модели, — это превратило бы в карточку с «было: false», то есть в
  // ложь владельцу, и в заведомый CONFLICT на «Принять», пока модель считает единицу
  // поставленной. Отказываем структурно и карточки не рождаем.
  if (payload.archived === true && head?.archived === true) {
    return {
      error: errorResult('CONFLICT', 'цель уже архивирована — откладывать нечего', {
        reason: 'already_archived',
        id,
      }),
    };
  }

  const rows: DeferredRow[] = [];
  // Строка на СВОЙСТВО (§А1-1): аспект её больше не адресует, и поля `aspect` у неё нет.
  // «Было» читается из НОВОЙ правды по тому же id, по которому `buildUpdate` снял
  // предусловие (иначе карточка показала бы владельцу одно «было», а CAS сверял бы другое);
  // адреса в собранной операции уже нормализованы в id — там же, где снимались предусловия.
  const built_props = (built.op.input.props as Record<string, unknown> | undefined) ?? {};
  for (const [property, after] of Object.entries(built_props)) {
    const before = current.props[property];
    rows.push({
      field: property,
      ...(before !== undefined && { before: rowValue(before) }),
      after: rowValue(after),
    });
  }
  for (const property of (built.op.input.unset as string[] | undefined) ?? []) {
    const before = current.props[property];
    rows.push({
      field: property,
      ...(before !== undefined && { before: rowValue(before) }),
      // «Станет» у снятия — тот же литерал, что у строки предложения: пустое «станет»
      // владелец прочитал бы как недорисованную строку.
      after: DEFERRED_UNSET_VALUE,
    });
  }
  // Поля вне аспектов — тем же списком, что читает экран предложения (CORE_FIELD_LABELS):
  // второй перечень «что рутина вправе тронуть вне аспектов» разъехался бы с первым молча.
  // Подписи оттуда НЕ берутся — их ставит web (см. док карточки в registry.ts).
  for (const field of Object.keys(CORE_FIELD_LABELS)) {
    const after = payload[field];
    if (after === undefined) continue;
    if (field === 'archived' && after === true) {
      // `buildUpdate` кладёт в `precondition` ровно эту форму и валидирует собранную
      // операцию `entityUpdateExecInput` — читаем её обратно, чтобы дописать пункт колонки
      const fromAspects = built.op.input.precondition as EntityUpdatePreconditionItem[] | undefined;
      input.precondition = [...(fromAspects ?? []), { property: 'orbis/archived', in: [false] }];
      rows.push({ field, before: 'false', after: 'true' });
      continue;
    }
    rows.push({ field, after: rowValue(after) });
  }

  const title = head?.title ?? id;
  return {
    input,
    // Сводку читает ВЛАДЕЛЕЦ — в ленте рутины и в пачке: цель по имени, а не «entity_update»
    summary: payload.archived === true ? `Архивация: «${title}»` : `Правка: «${title}»`,
    rows,
  };
}

/**
 * ЕДИНИЦА ПАЧКИ ДЛЯ МУТАЦИИ РЕЕСТРА (§С2-1, Задача 16): та же отложка, но объект другой —
 * не запись графа, а строка реестра владельца.
 *
 * ПРЕДУСЛОВИЙ ЗДЕСЬ НЕТ, И ЭТО НЕ УПУЩЕНИЕ. У правки графа отложка обязана снять CAS при
 * ПОСТАНОВКЕ (ОЧ.13), потому что исполнение на «Принять» иначе затрёт правку владельца,
 * сделанную тем временем. У операций реестра эту работу делает САМА ОПЕРАЦИЯ и делает её в
 * момент исполнения: `registry/ops.ts` берёт `lockOwnerRegistry`, перечитывает строки и
 * отвечает `PROPERTY_MERGED`, `MERGE_ALREADY_MERGED`, `MERGE_VALUES`, `BUILTIN_IMMUTABLE`,
 * `PROPOSED_CAP` по СВЕЖЕМУ состоянию. Снимать предусловия поверх этого значило бы завести
 * второе мнение о том, что считается «состояние изменилось», — и первое же расхождение
 * двух мнений владелец увидел бы как отказ на кнопке там, где операция была законна.
 * Поэтому `input` уезжает в pending-запись БАЙТ-В-БАЙТ таким, каким его прислала модель.
 *
 * «БЫЛО → СТАНЕТ» ЧИТАЕТСЯ ИЗ ЭФФЕКТИВНОГО РЕЕСТРА — того же снимка, по которому владелец
 * видит свои свойства (§А3-2, система ⊕ его строки ⊕ дельты). Имена в строках — ПОДПИСИ, а
 * не адреса: пачку читает владелец, и «019e4466-…» в карточке не отвечает на вопрос, что
 * ему предлагают. Адрес при этом не теряется — он остаётся в `input`, который и исполнится.
 */
async function snapshotRegistryUnit(
  tx: Tx,
  ownerId: string,
  tool: string,
  payload: Record<string, unknown>,
): Promise<{ input: unknown; summary: string; rows: DeferredRow[] }> {
  const reg = await effectiveRegistry(tx, ownerId);
  const summary = registryOperationSummary(reg, tool, payload);
  const propertyName = (address: unknown): string => {
    if (typeof address !== 'string') return String(address);
    const def = resolvePropertyRef(reg, address);
    return def === undefined ? address : effectiveLabel(def.label, OWNER_LOCALE);
  };

  switch (tool) {
    case 'property_merge':
      return {
        input: payload,
        summary,
        // Одна строка, а не две: у слияния меняется ОДНО — то, каким свойством описаны
        // значения; «было» и «станет» тут буквальны.
        rows: [
          {
            field: 'property_merge',
            before: propertyName(payload.source),
            after: propertyName(payload.into),
          },
        ],
      };
    case 'property_update': {
      const current = resolvePropertyRef(reg, String(payload.id));
      const rows: DeferredRow[] = [];
      // Поля патча — ровно те, что объявляет `propertyUpdateInput` (`tools/registry-tools.ts`);
      // `id` — адрес, а не правка, и в строки не идёт (тот же приём, что в preview-диффе).
      for (const field of ['label', 'description', 'scope', 'rank', 'status'] as const) {
        if (!(field in payload)) continue;
        const before = current === undefined ? undefined : current[field];
        rows.push({
          ...(before !== undefined && before !== null && { before: rowValue(before) }),
          field,
          after: rowValue(payload[field]),
        });
      }
      return { input: payload, summary, rows };
    }
    case 'aspect_delta_set':
    case 'aspect_delta_remove': {
      const before = await readAspectDelta(tx, ownerId, String(payload.aspect));
      return {
        input: payload,
        summary,
        rows: [
          {
            field: 'delta',
            ...(before !== null && { before: rowValue(before) }),
            after: tool === 'aspect_delta_set' ? rowValue(payload.delta) : DEFERRED_UNSET_VALUE,
          },
        ],
      };
    }
  }
  // `property_create` — ЕДИНСТВЕННЫЙ из пяти, который сюда не доходит, и не потому, что
  // забыт: он даёт `own-property` → `preview` (§С2-1 ряд 1 адресован владельцу через чат), а
  // `preview` фон не откладывает и не исполняет — его снимает инвариант 5 в `runMutation`.
  // Ветка оставлена fail-closed, а не собрана «на всякий случай»: карточка, которую нечем
  // показать владельцу, хуже честного отказа (блокер Б3 ревью спеки).
  return { input: payload, summary, rows: [{ field: tool, after: rowValue(payload) }] };
}

/**
 * Потолок значения в строке карточки. Тело записи или длинный список меток уехали бы в
 * ленту целиком — а строка «было → станет» нужна владельцу, чтобы УЗНАТЬ правку, а не
 * прочитать её содержимое: полное значение он видит на самой записи.
 */
const CARD_VALUE_CAP = 200;

/**
 * Значение поля строкой карточки: строки — как есть, прочее — JSON'ом. `String(объект)`
 * дал бы владельцу «[object Object]», то есть строку без единого сведения.
 */
function rowValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= CARD_VALUE_CAP ? text : `${text.slice(0, CARD_VALUE_CAP - 1)}…`;
}

/**
 * Аспект рутины на JS-стороне гейта лимита. В SQL ниже он остаётся литералом: оператор
 * `?` jsonb с bind-параметром требует явного каста, а литерал читается как в остальных
 * запросах репозитория (agent-loop/queries.ts) — расхождение двух написаний исключено
 * тестом лимита, который гоняет обе стороны на живой БД.
 */
const ROUTINE_ASPECT = 'orbis/routine';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * ЗАВОДИТ ли операция рутину: у attach-пути аспект в имени тула, у create/update — имя
 * аспекта в списке `aspects` (у создания) или в `aspects.attach` (у правки), §А9-1.
 *
 * Считается именно НАВЕШИВАНИЕ, а не правка свойств рутины: лимит §8 отвечает на вопрос
 * «сколько рутин заведено», и патч `orbis/routine_at` живой рутины его не касается. Снятие
 * (`detach`) рутину тоже не заводит — потому `namedAspects` здесь не годится, она читает
 * обе стороны сразу. Форма проверяется защитно — сюда доезжает уже envelope-валидированный
 * payload (validateMutationEnvelope / validateBatchOperations).
 */
function carriesRoutineAspect(tool: string, input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (tool === 'attach_orbis_routine') return isRecord(input.data);
  if (tool === 'entity_create') {
    return Array.isArray(input.aspects) && input.aspects.includes(ROUTINE_ASPECT);
  }
  if (tool !== 'entity_update') return false;
  const attach = isRecord(input.aspects) ? input.aspects.attach : undefined;
  return Array.isArray(attach) && attach.includes(ROUTINE_ASPECT);
}

/**
 * Гейт §8 «сколько рутин можно завести» (V1.15). Стоит в диспатче, а не в стадии 4
 * executor'а, по той же причине, что и гейт import.csv: резолвер §8 инжектируется
 * контекстом вызова (`ctx.entitlements`), а модульный gateEntitlements executor'а — нет.
 * Цена этого решения принята планом (Р-13): создание рутины рукой владельца из UI идёт
 * роутерами мимо dispatch и лимитом не считается — лимит адресован пути модели.
 *
 * Считаются операции, которые заводят НОВУЮ рутину, и считается их ЧИСЛО, а не сам факт:
 * batch исполняется целиком, и проверка «сейчас рутин меньше лимита» пропустила бы группу,
 * переваливающую за лимит всеми своими операциями сразу. attach/update над сущностью, у
 * которой аспект уже есть, — правка живой рутины и в счёт не идёт: упёршийся в лимит
 * владелец обязан сохранить возможность править то, что уже завёл, иначе лимит
 * превращается в блокировку.
 */
async function gateRoutinesMax(
  ctx: ToolCallCtx,
  tool: string,
  payload: unknown,
  batchPayload: BatchExecuteInput | undefined,
): Promise<ToolDispatchResult | null> {
  // Имена — реестровые, они же исполнительные (§А9-1): переводить их перестали, и у
  // batch тут ровно то же, что у одиночного вызова. batch исполняется «всё или ничего» —
  // рутину заводит ЛЮБАЯ операция
  const ops = batchPayload?.operations ?? [{ tool, input: payload }];
  const routineOps = ops.filter((op) => carriesRoutineAspect(op.tool, op.input));
  if (routineOps.length === 0) return null;

  const createdCount = routineOps.filter((op) => op.tool === 'entity_create').length;
  const overExisting = routineOps.filter((op) => op.tool !== 'entity_create');
  const targets = overExisting
    .map((op) => {
      const input = op.input as Record<string, unknown>;
      return op.tool === 'entity_update' ? input.id : input.entity_id;
    })
    .filter((id): id is string => typeof id === 'string');
  // Неразобранный id (после envelope-валидации структурно невозможен) считаем новой
  // рутиной: гейт лимита не имеет права открываться от мусора во входе
  const unresolvedCount = overExisting.length - targets.length;

  return withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
    const alreadyRoutines =
      targets.length === 0 ? new Set<string>() : await routinesAmong(tx, targets);
    // Set: две операции по одной цели заводят одну рутину, а не две
    const newTargets = new Set(targets.filter((id) => !alreadyRoutines.has(id)));
    const newRoutines = createdCount + newTargets.size + unresolvedCount;
    if (newRoutines === 0) return null;

    const decision = (ctx.entitlements ?? resolveEntitlement)(ctx.actorUserId, ROUTINES_MAX_KEY);
    const denial = errorResult('LIMIT', `достигнут лимит рутин («${ROUTINES_MAX_KEY}»)`, {
      key: ROUTINES_MAX_KEY,
      limit: decision.limit,
      requested: newRoutines,
    });
    // Отказ резолвера — «рутин на этом плане нет вовсе»: считать уже нечего
    if (!decision.allowed) return denial;
    if (decision.limit === null) return null; // безлимитный план (сегодняшний 'dev')
    return (await countRoutines(tx)) + newRoutines > decision.limit ? denial : null;
  });
}

/**
 * Человеческое имя свойства доверенности для карточки. Ключи — те же константы, что читает
 * гейт (§7.10): третьего письменного представления адреса здесь нет, только подпись к нему.
 */
/**
 * Как назвать владельцу переключённый выключатель отбора. Ключи — те же, что у
 * `RevivalSwitch`: третьего письменного представления списка выключателей здесь нет.
 */
const REVIVAL_PHRASE: Record<RevivalSwitch, string> = {
  aspect: 'навешивает аспект рутины',
  archive: 'возвращает из архива',
  unpause: 'снимает паузу',
  activate: 'переводит в рабочую стадию',
};

const AUTONOMY_LABEL: Record<string, string> = {
  [ROUTINE_MODE_PROPERTY]: 'режим',
  [ROUTINE_TOOLS_PROPERTY]: 'белый список',
};

/**
 * Сводка правки автономии для карточки подтверждения (V1.10, B1-2): по каждой операции,
 * ТРОГАЮЩЕЙ доверенность, — рутина заголовком и что с ней делают. Заголовок живой цели
 * читается из БД (под tx владельца); у создаваемой — из самого входа. Формат намеренно один
 * и тот же для attach/create/update и для batch: владелец сверяет одно и то же — «кому, что
 * даётся и что снимается».
 *
 * СНЯТИЕ НАЗЫВАЕТСЯ НАРАВНЕ С ВЫДАЧЕЙ, и это исправление фикс-раунда 2 (N-1). Замок §7.10
 * научился видеть `unset` раньше, чем сводка: вызов `{id, unset:['orbis/allowed_tools']}`
 * поднимал уровень, а сводка читала только `props`, не находила ничего и отдавала ПУСТУЮ
 * строку — владелец получал «Требуется подтверждение: » и карточку без единого сведения о
 * том, что он подтверждает. Смешанный патч (`props` + `unset`) был хуже пустого: карточка
 * называла МЕНЬШЕ, чем делает вызов. Читатель обязан ходить туда же, куда гейт, — иначе
 * унификация адресов (`AUTONOMY_PROPERTIES`) закрывает половину класса и создаёт вторую.
 *
 * `disarmed` — то, чего В ПАТЧЕ НЕ ВИДНО: носитель (`attach_*` заменяет его целиком, §А7-4;
 * `aspects.detach` уносит совсем, Р9) отнимает доверенность разницей с текущим состоянием, и
 * узнать её можно только по БД (считает `autonomyChangedByCarrier`, там же довод).
 *
 * Ключ у него — ИНДЕКС ОПЕРАЦИИ, а не id цели, и это исправление фикс-раунда 3: по id снятие
 * прилипало к ЛЮБОЙ операции над той же рутиной, и пачка «переименовать + разоружить
 * attach'ем» рассказывала владельцу «переименование снимает белый список» — неправда про
 * операцию, которая доверенности не касается вовсе.
 *
 * ОБЪЕКТ называется честно, и это исправление фикс-раунда 4: значения доверенности живут
 * независимо от аспекта (Р9), поэтому вызов вправе положить белый список на запись, рутиной не
 * являющуюся, — и фраза «Автономия рутины «Не рутина»» врала владельцу про то, над чем его
 * просят нажать «Принять». Уровень при этом прежний: значения вооружат запись в тот миг, когда
 * аспект появится, и замок держит их на любом объекте — меняется только подпись.
 *
 * ПУСТОЙ строки функция не возвращает никогда: её зовут только когда доверенность
 * действительно тронута, и «нечего сказать» тут означало бы осечку сборки, а не отсутствие
 * события. Fail-closed — назвать событие общими словами (createPending на всякий случай
 * держит вторую линию: пустая сводка считается отсутствующей).
 */
async function autonomySummary(
  tx: Tx,
  ops: ReadonlyArray<{ tool: string; input: unknown }>,
  scan: CarrierScan = emptyCarrierScan(),
): Promise<string> {
  const parts: string[] = [];
  for (const [index, op] of ops.entries()) {
    if (!isRecord(op.input)) continue;
    // Доверенность лежит там же, где её читает гейт (§А9-1): у attach — в `data` по key
    // свойства, у create/update — в `props`. Второе место чтения разъехалось бы с гейтом, и
    // карточка называла бы владельцу не то, что подтверждается.
    const given = op.tool === 'attach_orbis_routine' ? op.input.data : op.input.props;
    const routine = isRecord(given) ? given : {};
    const targetId =
      op.tool === 'entity_update'
        ? op.input.id
        : op.tool === 'attach_orbis_routine'
          ? op.input.entity_id
          : undefined;
    // Снятое ЯВНО (`unset` правки) и снятое ФОРМОЙ ЭТОЙ ЖЕ операции (носитель).
    const unset = Array.isArray(op.input.unset)
      ? op.input.unset.filter((v): v is string => typeof v === 'string')
      : [];
    const byCarrier = scan.changes.get(index);
    const removed = [
      ...AUTONOMY_PROPERTIES.filter((p) => unset.includes(p)),
      ...(byCarrier?.removed ?? []),
    ];
    // Обесцененное (`act` → `propose` при живом свойстве) отдельной фразы не требует: новое
    // значение уже названо ниже из самого патча — но операцию в сводку пускает.
    const touches =
      grantsRoutineAutonomy(op.tool, op.input) || removed.length > 0 || byCarrier !== undefined;
    if (!touches) continue;

    const head = typeof targetId === 'string' ? await entityHead(tx, targetId) : undefined;
    const title =
      typeof targetId === 'string'
        ? (head?.title ?? `${targetId.slice(0, 8)}…`)
        : typeof op.input.title === 'string'
          ? op.input.title
          : 'новая рутина';
    // Карточка обязана честно называть ОБЪЕКТ. Свойства доверенности живут независимо от
    // аспекта (Р9), поэтому модель вправе положить `orbis/allowed_tools` на что угодно — и
    // прежде такой вызов давал «Автономия рутины «Не рутина»», то есть карточка врала про то,
    // над чем владельца просят нажать «Принять». Рутиной запись считается, если операция сама
    // навешивает аспект (attach, `aspects`/`aspects.attach` — `carriesRoutineAspect`) или он
    // уже на строке. Цели не видно (её нет или она чужая) — рутиной звать не за что:
    // исполнение ответит NOT_FOUND. Уровень это НЕ трогает: значения доверенности вооружают
    // запись в тот миг, когда аспект появится, и замок держит их на любом объекте.
    // Носитель НА МОМЕНТ ОПЕРАЦИИ (с учётом предыдущих операций пачки) — первее строки из БД, и
    // теперь В ОБЕ СТОРОНЫ. В `||`-цепочке он был первее только в направлении `true`: `false`
    // от скана не перебивал `true` из допачечной строки, и в пачке `[detach, правка
    // доверенности]` вторая фраза звала рутиной запись, у которой носителя на её момент уже
    // нет. Ответ скана авторитетен, когда он ЕСТЬ; строка из БД — фолбэк для операций, которых
    // скан не проходил (он не запускается, когда состояние никому не нужно).
    const aboutRoutine =
      carriesRoutineAspect(op.tool, op.input) ||
      (scan.carrierAtOp.get(index) ?? head?.aspects.includes(ROUTINE_ASPECT) === true);
    // ИСТОЧНИК ФРАЗ О ЗНАЧЕНИЯХ. Обычно это сам патч. Но у ОЖИВЛЕНИЯ выключателем (Р-12-5 —
    // аспект, Р-12-6 — архив) значимы не свойства вызова, а ИТОГОВЫЕ: их в патче может не быть
    // ни одного, а вооружают запись именно они — боевые значения лежат на ней с тех пор, как
    // её выключили. Владельцу надо видеть, ЧЕМ оживает рутина, а не пустую фразу.
    const named = byCarrier?.revives?.values ?? routine;
    const facts: string[] = [];
    const mode = named[ROUTINE_MODE_PROPERTY];
    if (typeof mode === 'string') facts.push(`режим ${mode}`);
    // attach/create кладут набор ЦЕЛИКОМ — отсутствующий белый список значит «нет
    // инструментов», и это надо сказать; у update патч дописывает свойства, и молчание о
    // списке значит «прежний». Снятое заменой носителя перечисляется отдельной фразой —
    // «инструменты: нет» и «снимает белый список» это разные сведения для владельца.
    if (
      ROUTINE_TOOLS_PROPERTY in named ||
      (op.tool !== 'entity_update' && !removed.includes(ROUTINE_TOOLS_PROPERTY))
    ) {
      const allowed = named[ROUTINE_TOOLS_PROPERTY];
      const tools = Array.isArray(allowed)
        ? allowed.filter((t): t is string => typeof t === 'string')
        : [];
      facts.push(tools.length > 0 ? `инструменты: ${tools.join(', ')}` : 'инструменты: нет');
    }
    if (removed.length > 0) {
      facts.push(`снимает ${removed.map((p) => AUTONOMY_LABEL[p] ?? p).join(' и ')}`);
    }
    // Снятие носителя — не снятие значений (Р9), и называть его «снимает режим» было бы
    // враньём: режим и белый список уцелеют в `props`, работать перестанет сама рутина.
    if (byCarrier?.detached === true) facts.push('снимает аспект рутины');
    // Обратная сторона того же: значения уже лежат, вызов щёлкает выключателем — и запись
    // оживает рутиной с правами, перечисленными выше. Каждый выключатель называется СВОИМ
    // именем и все, что щёлкнуты: «вернули из архива», «сняли паузу» и «сделали рутиной» —
    // разные события для владельца, и вызов вправе сделать несколько разом.
    for (const revived of byCarrier?.revives?.switches ?? []) {
      facts.push(REVIVAL_PHRASE[revived]);
    }
    const subject = aboutRoutine
      ? `Автономия рутины «${title}»`
      : `Свойства доверенности рутины на записи «${title}»`;
    parts.push(`${subject}: ${facts.length > 0 ? facts.join(', ') : 'правка доверенности'}`);
  }
  // Fail-closed: сюда попадают только вызовы, тронувшие доверенность (см. шапку).
  return parts.length > 0 ? parts.join('; ') : 'Правка автономии рутины';
}

/**
 * Что ОДНА операция делает с доверенностью рутины через её НОСИТЕЛЬ — отнимает или выдаёт.
 *
 * САМО НАЛИЧИЕ записи в карте значит «эта операция двигает доверенность» — поля лишь
 * перечисляют то, что можно НАЗВАТЬ владельцу отдельной фразой. Обесценивание (`act` →
 * `propose` при живом свойстве) фразы не требует — новое значение сводка назовёт из самого
 * патча, — но запись порождает, и потому у него своего поля здесь нет: write-only поле не
 * проверяется ничем (Н-5 ре-ревью фикс-раунда 3).
 */
/**
 * Выключатель отбора прогонов, который вызов переводит в положение «работает».
 *
 * УСЛОВИЙ ОТБОРА ТРИ, а членов здесь ЧЕТЫРЕ, и это не расхождение: у стадии два наблюдаемых
 * входа в рабочее положение — из паузы (`paused → active`) и из «стадии не было вовсе»
 * (свойство необязательно у записи, ещё не бывшей рутиной), — и владельцу это РАЗНЫЕ слова.
 * Сказать «снимает паузу» про запись, которая на паузе не стояла, значило бы соврать в
 * карточке ровно так же, как «Автономия рутины «Не рутина»» врала про объект.
 */
type RevivalSwitch = 'aspect' | 'archive' | 'unpause' | 'activate';

interface CarrierAutonomyChange {
  /** свойства доверенности, которых замена носителя лишает запись целиком */
  removed: string[];
  /** снятие самого аспекта рутины у ВООРУЖЁННОЙ записи: значения уцелеют, рутина — нет */
  detached: boolean;
  /**
   * Чем вызов ОЖИВЛЯЕТ вооружённую рутину и на каких значениях; `null` — не оживляет.
   *
   * Живой рутину делают ТРИ условия (`activeRoutines`, `agent-loop/queries.ts`): аспект на
   * строке, `NOT archived` и `orbis/routine_stage: 'active'`. Ни одно не выражается свойствами
   * доверенности, поэтому все три щёлкаются мимо гейта формы; рулинги Р-12-5 (аспект), Р-12-6
   * (архив) и Р-12-4 в исправленной редакции (снятие паузы) требуют за них карточку.
   *
   * Выключателей СПИСОК, а не один: вызов вправе щёлкнуть несколько разом
   * (`{archived:false, props:{routine_stage:'active'}}`), и назвать владельцу надо все — иначе
   * карточка расскажет о половине сделанного. Поле НЕСЁТ значения, а не флаг, потому что их
   * читает сводка: владельцу нужно видеть, ЧЕМ именно оживает рутина, а в патче этих свойств
   * может не быть вовсе — они лежат на записи с тех пор, как её выключили.
   */
  revives: { switches: RevivalSwitch[]; values: Record<string, unknown> } | null;
}

/**
 * Что ЭТОТ вызов делает с доверенностью рутины через НОСИТЕЛЬ (рулинги Р-12-2, Р-12-3, Р-12-5):
 * ИНДЕКС ОПЕРАЦИИ в `ops` → изменение. Пусто — доверенность носителем не двигается.
 *
 * Носитель ходит В ОБЕ СТОРОНЫ, и функция это отражает: он не только ОТНИМАЕТ (замена, снятие
 * аспекта), но и ВЫДАЁТ — `aspects.attach` возвращает аспект записи, на которой боевые
 * значения уже лежат (они переживают снятие аспекта, Р9), и вооружённая рутина оживает без
 * единого свойства в payload'е. Симметрия обязательна: владельца, подтвердившего «снимает
 * аспект рутины», следующий молчаливый `attach` возвращал бы к тому же, с чего он начал.
 *
 * СЮДА ЖЕ — ВСЕ ВЫКЛЮЧАТЕЛИ ОТБОРА, хотя носителя два из них не трогают: возврат из архива
 * (`archived: false`, Р-12-6) и снятие паузы (`orbis/routine_stage: 'active'`, Р-12-4 в
 * исправленной редакции). Место общее не по механике, а по вопросу: отбор прогонов
 * (`activeRoutines`) требует трёх условий — носитель, `NOT archived`, `stage: 'active'`, — и
 * любой выключатель, возвращающий запись в этот отбор, оживляет вооружённую рутину одинаково
 * молча. Разводить их по разным функциям значило бы завести второй ответ на один вопрос.
 *
 * СПРАШИВАЕТСЯ ОТБОР ЦЕЛИКОМ, А НЕ ВЫКЛЮЧАТЕЛЬ ПО ОТДЕЛЬНОСТИ, и это исправление раунда 7
 * (Minor-1 ре-ревью раунда 6). Прежняя формулировка обещала «оживление считается только там,
 * где оно РЕАЛЬНО происходит», а проверяла два условия из трёх — и архивная рутина, которая
 * ЕЩЁ И на паузе, получала карточку «возвращает из архива», хотя в отбор всё равно не
 * попадала. Теперь считается ПЕРЕХОД: `liveRoutine` на состоянии ДО и на состоянии ПОСЛЕ
 * патча, карточка — только когда «не работала» стало «работает» и запись при этом вооружена.
 * Обратная сторона того же сужения: навесить аспект записи, у которой стадия НЕ рабочая, можно
 * молча — рутиной она работать не станет, а вызов, который её включит, упрётся в замок. На
 * практике это ровно случай `stage: 'paused'`: `orbis/routine_stage` у аспекта ОБЯЗАТЕЛЕН, и
 * `attach` записи вовсе без стадии до замка не доходит — его отвергает валидатор (`REQUIRED`).
 *
 * Почему это отдельная проверка ПО БД, а не факт классификатора: носитель отвечает на вопрос
 * «что станет с доверенностью» только вместе с текущим состоянием цели.
 *  - `attach_*` заменяет носитель целиком (§А7-4): свойство аспекта, не названное в `data`,
 *    СНИМАЕТСЯ, а названное с другим значением — ОБЕСЦЕНИВАЕТСЯ. Один и тот же
 *    `attach_orbis_routine {routine_stage, routine_at, routine_mode:'propose'}` на
 *    вооружённой рутине разоружает её, а на безоружной не делает ничего.
 *  - `entity_update {aspects:{detach:['orbis/routine']}}` значений не трогает (Р9), но уносит
 *    САМ НОСИТЕЛЬ: режим и белый список остаются в `props`, а рутина перестаёт быть рутиной.
 *    Разоружение это или уборка мусора — видно только по тому, была ли она вооружена.
 *  - `entity_update {aspects:{attach:['orbis/routine']}}` — то же зеркально (Р-12-5): по форме
 *    вызова это «заведи рутину», а по состоянию — либо обычное заведение, либо возврат к жизни
 *    act-рутины с прежним белым списком. Различает их только вопрос к ИТОГОВЫМ значениям.
 * Классификатор §7.10 по построению чист (типизированные факты вызова, без БД), поэтому
 * состояние спрашивает диспатч — и ОДНИМ чтением на оба гейта: тем же свёрнутым состоянием
 * отвечает и гейт инструкции act-рутины (C1b-1, `instructionAtOp`), у которого прежде был свой
 * `SELECT` и свой момент, а между двумя моментами — зазор (фикс-раунд 9).
 *
 * ОБЕСЦЕНИВАНИЕ считается наравне со снятием, и это фикс-раунд 3. Прежде проба спрашивала
 * только «пропало ли свойство», и модель гасила act-режим ЭХОМ: `entity_get` показывал ей
 * белый список, она повторяла его в `data` вместе с `routine_mode: 'propose'` — свойства на
 * месте, снятого ноль, карточки нет. Тот же переход через `entity_update` карточку требовал:
 * замок держал смысл на одном пути и не держал на соседнем.
 *
 * Консервативный вариант («attach без названных свойств доверенности поднимает уровень
 * всегда») отклонён: `orbis/routine_mode` обязателен в аспекте, поэтому единственным
 * наблюдаемым случаем стал бы `allowed_tools`, и заведение обычной propose-рутины через
 * attach начало бы требовать подтверждения на ровном месте. Лишняя карточка дешевле
 * молчаливого разоружения — но не там, где точный ответ стоит один SELECT по PK.
 *
 * ЧЕГО ЭТОТ `SELECT` НЕ ГАРАНТИРУЕТ — сказано вслух вместо переноса (Important-3 ре-ревью).
 * Он идёт СВОЕЙ транзакцией и ДО записи, поэтому прочитанное состояние авторитетно только на
 * момент чтения — но что из этого следует, за раунды менялось, и вот как обстоит сейчас:
 *  1. Между пробой и записью состояние может измениться. Сам AI окна не открывает —
 *     вооружить рутину без карточки он не может, — но его открывает владелец: пока он жмёт
 *     «Принять» на запрос вооружения, MCP-агент в цикле шлёт разоружающий attach, проба
 *     видит ещё безоружную рутину и отвечает «отнимать нечего».
 *  2. ВНУТРИПАЧЕЧНАЯ половина ЗАКРЫТА фикс-раундом 8, и прежняя запись здесь («направление
 *     безопасное — прав меньше, чем обещано») была ОПРОВЕРГНУТА живой пробой: с переходной
 *     формулировкой раунда 7 направление стало НЕбезопасным — пачка из двух операций,
 *     переключающих по одному выключателю каждая, возвращала вооружённую act-рутину в работу
 *     БЕЗ КАРТОЧКИ. Теперь строка читается по-прежнему один раз, но состояние СВОРАЧИВАЕТСЯ
 *     по ходу пачки, и каждая операция спрашивается о своём моменте.
 *     Свёртка моделирует ровно то, что читают предикаты замка: носитель, признак архива и три
 *     адреса свойств. Она НЕ моделирует `entity_create` (строки ещё нет) — и не обязана:
 *     создание с боевыми значениями поднимает уровень гейтом формы, а безоружное вооружить
 *     может только операция, трогающая свойства доверенности, то есть снова гейт формы.
 * ОСТАВШИЙСЯ ПУНКТ 1 закрывается перепроверкой в ТОЙ ЖЕ транзакции, что и запись, и знать
 * §7.10 исполнителю для этого не нужно: сверить прочитанные пробой значения умеет CAS-предусловие §А7-3
 * (`assertPrecondition`, `executor/executor.ts`, сверка под `FOR UPDATE`). Технической
 * невозможности здесь НЕТ, и утверждать обратное было бы ложью (Н-3 ре-ревью фикс-раунда 3).
 *
 * НО ГОТОВ МЕХАНИЗМ ЛИШЬ НАПОЛОВИНУ, и это тоже надо сказать точно (Minor-3 ре-ревью
 * фикс-раунда 4): `assertPrecondition` зовётся из ОДНОГО места — `prepareEntityUpdate`, — то
 * есть готов для `entity_update` (`aspects.attach`/`detach`), а `prepareAttach` предусловий не
 * принимает и не сверяет вовсе. Для `attach_orbis_routine` — главного пути замены носителя, о
 * котором весь этот докблок, — предусловие пришлось бы сперва завести.
 *
 * НЕ СДЕЛАНО ПО ЦЕНЕ, и цена такая. Предусловие меняет РЕДКУЮ гонку на РЕДКИЙ ЖЁСТКИЙ отказ:
 * вызов, к которому оно приложено, упирается в `precondition_failed` посреди пачки, которую
 * владелец УЖЕ подтвердил, — то есть проигрыш гонки превращается в оборванное на середине
 * подтверждённое действие, и разбирать его придётся человеку. Гонка же требует
 * ОДНОВРЕМЕННОГО действия владельца (он в этот миг смотрит на экран автономии), а батч-половина
 * ошибается в безопасную сторону. Размен признан невыгодным; когда §7.10 станет данными
 * (часть Б, `assign_level`), решать это будет правило, а не эта функция.
 *
 * ТА ЖЕ ОГОВОРКА ОТНОСИТСЯ И К ГЕЙТУ ИНСТРУКЦИИ act-рутины: с фикс-раунда 9 он отвечает по
 * этому же свёрнутому состоянию (`instructionAtOp`), то есть делит с оживлением и один
 * `SELECT`, и одну гонку — act-режим, выставленный между пробой и записью, правку инструкции
 * этим гейтом не задержит.
 */
async function autonomyChangedByCarrier(
  ctx: ToolCallCtx,
  ops: ReadonlyArray<{ tool: string; input: unknown }>,
): Promise<CarrierScan> {
  const out = new Map<number, CarrierAutonomyChange>();
  const carrierAtOp = new Map<number, boolean>();
  const instructionAtOp = new Map<number, InstructionTouch>();
  // ПЕРВЫЙ ПРОХОД — по форме: есть ли о чём спрашивать БД и кого спрашивать. Идентификаторы
  // собираются ШИРЕ проб: состояние цели внутри пачки двигают и операции, сами по себе
  // карточки не требующие (постановка на паузу, архивация), а свернуть надо все.
  const touched = new Set<string>();
  let needsState = false;
  for (const op of ops) {
    if (!isRecord(op.input)) continue;
    const id =
      op.tool === 'attach_orbis_routine'
        ? op.input.entity_id
        : op.tool === 'entity_update'
          ? op.input.id
          : undefined;
    if (typeof id !== 'string') continue;
    touched.add(id);
    if (
      op.tool === 'attach_orbis_routine' ||
      namesRoutineAspect(op.input, 'detach') ||
      touchesRevivalSwitch(op.input) ||
      editsInstruction(op.input)
    ) {
      needsState = true;
    }
  }
  if (!needsState) return { changes: out, carrierAtOp, instructionAtOp };

  const rows = await withIdentity(ctx.db, ctx.actorUserId, (tx) =>
    tx
      .select({
        id: entities.id,
        title: entities.title,
        props: entities.props,
        aspects: entities.aspects,
        archived: entities.archived,
      })
      .from(entities)
      .where(inArray(entities.id, [...touched])),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  // ВТОРОЙ ПРОХОД — ПО ПОРЯДКУ ОПЕРАЦИЙ, со свёрнутым состоянием цели. Каждая операция
  // спрашивается о состоянии НА СВОЙ МОМЕНТ, а не о допачечном, и это фикс-раунд 8: пока
  // строка читалась один раз и до пачки, вопрос «стала ли запись живой» каждая операция
  // честно отвечала «нет» — переключала-то она ОДИН выключатель из трёх, — и пачка из двух
  // операций возвращала вооружённую act-рутину в работу молча (блокер ре-ревью раунда 7).
  const state = new Map<string, TargetState>();
  const stateOf = (id: string): TargetState | undefined => {
    const known = state.get(id);
    if (known !== undefined) return known;
    const row = byId.get(id);
    // Невидимой цели (её нет или она чужая) касаться нечем: двигать доверенность не у чего, а
    // исполнение ответит честным NOT_FOUND. Сюда же попадает цель, СОЗДАВАЕМАЯ этой же пачкой:
    // строки ещё нет, но и защищать нечего — `entity_create` с боевыми значениями поднимает
    // уровень гейтом ФОРМЫ (`autonomyArmed` по `props`), а безоружное создание вооружить может
    // только операция, трогающая свойства доверенности, то есть снова гейт формы.
    if (row === undefined) return undefined;
    const fresh: TargetState = {
      carrier: row.aspects.includes(ROUTINE_ASPECT),
      archived: row.archived,
      props: row.props as Record<string, unknown>,
      title: row.title,
    };
    state.set(id, fresh);
    return fresh;
  };

  for (const [index, op] of ops.entries()) {
    if (!isRecord(op.input)) continue;
    if (op.tool === 'attach_orbis_routine') {
      const id = op.input.entity_id;
      if (typeof id !== 'string') continue;
      const now = stateOf(id);
      if (now === undefined) continue;
      carrierAtOp.set(index, now.carrier);
      const data = isRecord(op.input.data) ? op.input.data : {};
      const taken = carrierReplaced(now, data);
      if (taken !== null) out.set(index, taken);
      const next = afterAttachRoutine(now, data);
      const touch = instructionTouched(now, next, false);
      if (touch !== null) instructionAtOp.set(index, touch);
      state.set(id, next);
      continue;
    }
    if (op.tool !== 'entity_update') continue;
    const id = op.input.id;
    if (typeof id !== 'string') continue;
    const now = stateOf(id);
    if (now === undefined) continue;
    carrierAtOp.set(index, now.carrier);
    const patch = op.input;
    if (namesRoutineAspect(patch, 'detach')) {
      // Признак носителя обязателен (Р9): значения доверенности переживают снятие аспекта, и
      // без него запись, КОГДА-ТО бывшая рутиной, читалась бы как разоружаемая рутина.
      if (now.carrier && autonomyArmed(now.props)) {
        out.set(index, { removed: [], detached: true, revives: null });
      }
    } else if (touchesRevivalSwitch(patch)) {
      const revived = revivedByPatch(now, patch);
      if (revived !== null) out.set(index, revived);
    }
    const next = afterUpdate(now, patch);
    const touch = instructionTouched(now, next, editsInstruction(patch));
    if (touch !== null) instructionAtOp.set(index, touch);
    state.set(id, next);
  }
  return { changes: out, carrierAtOp, instructionAtOp };
}

/** Правит ли патч ТЕКСТ записи — тело или заголовок (V1.10, C1b-1). */
function editsInstruction(input: Record<string, unknown>): boolean {
  return input.body !== undefined || input.bodyDoc !== undefined || input.title !== undefined;
}

/**
 * Стал ли ТЕКСТ записи инструкцией act-рутины ЭТОЙ операцией; `null` — нет.
 *
 * Вопрос задан состоянию ПОСЛЕ операции, и это исправление фикс-раунда 9 (Important-1
 * ре-ревью раунда 8). Прежний гейт спрашивал «act-рутина ли цель СЕЙЧАС», и между ним и
 * правилом оживления зиял зазор: правка тела записи БЕЗ носителя — не рутина, значит молча;
 * возврат носителя записи на паузе — не оживляет, значит тоже молча; а вместе два обычных
 * одиночных вызова собирали act-рутину с инструкцией, написанной моделью. Замок обходился
 * перестановкой: обратный порядок карточку давал.
 *
 * Признак носителя обязателен (Р9): `orbis/routine_mode` переживает снятие аспекта, и без него
 * правка заголовка обычной записи, когда-то бывшей рутиной, читалась бы как правка инструкции.
 * Именно поэтому мало спросить «изменился ли текст» — вопрос про то, ЧЕМ этот текст станет.
 */
function instructionTouched(
  before: TargetState,
  after: TargetState,
  edited: boolean,
): InstructionTouch | null {
  const actAfter = after.carrier && after.props[ROUTINE_MODE_PROPERTY] === 'act';
  if (!actAfter) return null;
  if (edited) return { title: before.title, reason: 'edit' };
  const actBefore = before.carrier && before.props[ROUTINE_MODE_PROPERTY] === 'act';
  if (actBefore) return null;
  // СТАНОВЛЕНИЕ значимо ровно тогда, когда act-режим УЖЕ ЛЕЖАЛ на записи, а вызов лишь вернул
  // ей носитель: тогда права и текст собираются молча, мимо гейта формы, — это и есть зазор.
  // Если режим приносит сам вызов (`attach` с `mode:'act'` в `data`, патч по свойству), его
  // держит гейт формы, и вторая фраза была бы шумом на каждом заведении act-рутины.
  if (before.props[ROUTINE_MODE_PROPERTY] !== 'act') return null;
  return { title: before.title, reason: 'becomes' };
}

/**
 * Что проба узнала об операциях вызова.
 *
 * `carrierAtOp` — РУТИНА ЛИ объект операции на её момент, с учётом предыдущих операций пачки.
 * Отдельным полем, а не выводом из `changes`, потому что вопрос другой: `changes` решают,
 * поднимать ли уровень, а этот ответ решает, как НАЗВАТЬ объект в карточке. Пока сводка
 * спрашивала строку из БД, внутри пачки она видела допачечное состояние и звала уже
 * навешенную рутину «записью» — тот же класс, что и блокер раунда 7, только в тексте.
 *
 * ОТВЕЧАЕТ В ОБЕ СТОРОНЫ, и это не мелочь: `false` здесь значит «на момент этой операции
 * носителя уже НЕТ» (его сняла предыдущая операция пачки) и обязан перебивать допачечную
 * строку так же, как `true`. Ключ ставится для КАЖДОЙ операции, которую скан прошёл, — поэтому
 * «ключа нет» и «ответ false» различимы, и фолбэк на строку из БД берётся только в первом
 * случае (скан не запускается вовсе, когда состояние никому не нужно).
 */
interface CarrierScan {
  changes: Map<number, CarrierAutonomyChange>;
  carrierAtOp: Map<number, boolean>;
  /**
   * Гейт инструкции act-рутины (V1.10, C1b-1) — ЗДЕСЬ ЖЕ, а не своим запросом, и это фикс-раунд
   * 9. Прежде он спрашивал «является ли запись act-рутиной СЕЙЧАС» отдельным `SELECT`'ом, и
   * между ним и правилом оживления был зазор: правка тела записи БЕЗ носителя проходила молча
   * (не рутина), возврат носителя на паузе — тоже молча (не оживляет), а вместе они собирали
   * act-рутину с инструкцией от модели. Обратный порядок карточку давал, то есть замок
   * обходился перестановкой. Вопрос теперь один и задаётся состоянию ПОСЛЕ операции — тому же
   * свёрнутому, что и у оживления.
   */
  instructionAtOp: Map<number, InstructionTouch>;
}

/** Пустой результат скана — для путей, где состояние не спрашивают (владелец, умолчания). */
function emptyCarrierScan(): CarrierScan {
  return { changes: new Map(), carrierAtOp: new Map(), instructionAtOp: new Map() };
}

/** Состояние цели НА МОМЕНТ ОПЕРАЦИИ — ровно то, что читают предикаты замка. */
interface TargetState {
  carrier: boolean;
  archived: boolean;
  props: Record<string, unknown>;
  /** Заголовок ДО операции: им карточка называет рутину, и переименование его не сдвигает. */
  title: string;
}

/**
 * Операция, после которой ТЕКСТ записи (тело и заголовок) — инструкция act-рутины, и привела
 * его туда ЭТА операция. Два способа, и владельцу это разные события:
 *  - `edit` — текст правят у записи, которая act-рутиной уже была или становится ею тем же
 *    вызовом (C1b-1: инструкция уезжает в системный слой прогона целиком);
 *  - `becomes` — текст не трогают, но запись СТАНОВИТСЯ act-рутиной, и её готовое тело с этого
 *    мига и есть инструкция. Модель пишет тело обычной записи (никакой замок этого не держит и
 *    держать не должен), а следующим вызовом возвращает носитель — и владелец, нажимая
 *    «возобновить мою рутину», запускает инструкцию, написанную моделью.
 */
interface InstructionTouch {
  title: string;
  reason: 'edit' | 'becomes';
}

/**
 * Что замена носителя (`attach_*`, §А7-4) ОТНИМАЕТ у доверенности; `null` — не отнимает.
 *
 * «ОТНИМАТЬ НЕЧЕГО» — ОДИН ответ на оба вида снятия (Minor-2 ре-ревью фикс-раунда 4): прежде
 * `detach` спрашивал `autonomyArmed`, а замена носителя считала по наличию ключа, и безоружная
 * рутина с `allowed_tools: []` получала карточку «снимает белый список» — сообщение о снятии
 * того, чего нет, — тогда как `detach` у неё проходил молча.
 */
function carrierReplaced(
  now: TargetState,
  data: Record<string, unknown>,
): CarrierAutonomyChange | null {
  if (!now.carrier || !autonomyArmed(now.props)) return null;
  const held = AUTONOMY_PROPERTIES.filter((property) => Object.hasOwn(now.props, property));
  const removed = held.filter((property) => !Object.hasOwn(data, property));
  const devalued = held.filter(
    (property) =>
      Object.hasOwn(data, property) && !sameAutonomyValue(now.props[property], data[property]),
  );
  // ОБЕСЦЕНЕННОЕ записи в карте не адресует, но её ПОРОЖДАЕТ: отдельной фразы владельцу оно
  // не требует (новое значение сводка назовёт из самого патча), а операцию — требует.
  if (removed.length === 0 && devalued.length === 0) return null;
  return { removed, detached: false, revives: null };
}

/**
 * Оживляет ли патч ВООРУЖЁННУЮ рутину (рулинги Р-12-5, Р-12-6 и Р-12-4 в исправленной
 * редакции); `null` — не оживляет.
 *
 * Вопрос задаётся НЕ выключателю по отдельности, а ОТБОРУ ЦЕЛИКОМ: карточка нужна там, где
 * вызов переводит запись ИЗ «не работает» В «работает» и она при этом вооружена. Проверять
 * выключатели порознь — значит врать в обе стороны сразу: архивная рутина, которая ещё и на
 * паузе, получала карточку «возвращает из архива», хотя в отбор всё равно не попадёт (Minor-1
 * ре-ревью раунда 6), а рутина, оживающая ДВУМЯ выключателями разом, была бы названа
 * половиной. Условия отбора — ровно три, и читает их одна `liveRoutine`, общая с обоими
 * концами перехода.
 */
function revivedByPatch(
  now: TargetState,
  patch: Record<string, unknown>,
): CarrierAutonomyChange | null {
  if (liveRoutine(now.carrier, now.archived, now.props)) return null;
  const next = afterUpdate(now, patch);
  if (!liveRoutine(next.carrier, next.archived, next.props)) return null;
  if (!autonomyArmed(next.props)) return null;
  // Названы ВСЕ выключатели, которые этот вызов перевёл в рабочее положение: владелец читает
  // карточку, а не диф, и «вернули из архива» ≠ «сняли паузу» ≠ «сделали рутиной».
  const switches: RevivalSwitch[] = [];
  if (!now.carrier && next.carrier) switches.push('aspect');
  if (now.archived && !next.archived) switches.push('archive');
  if (
    now.props[ROUTINE_STAGE_PROPERTY] !== 'active' &&
    next.props[ROUTINE_STAGE_PROPERTY] === 'active'
  ) {
    // Из паузы и из «стадии не было» — один выключатель, но разные слова владельцу.
    switches.push(now.props[ROUTINE_STAGE_PROPERTY] === 'paused' ? 'unpause' : 'activate');
  }
  return { removed: [], detached: false, revives: { switches, values: next.props } };
}

/**
 * Состояние цели ПОСЛЕ `entity_update`. Одна функция и на «что будет» у пробы, и на свёртку
 * пачки: разъедься они, вопрос об отборе задавался бы одному состоянию, а следующая операция
 * видела бы другое.
 */
function afterUpdate(now: TargetState, patch: Record<string, unknown>): TargetState {
  return {
    // Патологический `{attach:[…], detach:[…]}` одним вызовом читается как СНЯТИЕ — тем же
    // порядком, каким его разбирает проба выше.
    carrier: namesRoutineAspect(patch, 'detach')
      ? false
      : now.carrier || namesRoutineAspect(patch, 'attach'),
    archived: typeof patch.archived === 'boolean' ? patch.archived : now.archived,
    props: propsAfterPatch(now.props, patch),
    // Заголовок для карточки берётся ДО правки — владелец узнаёт рутину по имени, которое
    // видит у себя, а не по тому, которое ей предлагает дать модель. Это ЕДИНСТВЕННОЕ, что
    // сводка спрашивает у допачечной строки намеренно: второй её вопрос («рутина ли объект»)
    // ответ той же пачки переворачивает, и на него отвечает `carrierAtOp` — в обе стороны.
    title: now.title,
  };
}

/**
 * Состояние цели ПОСЛЕ `attach_orbis_routine`: носитель заменяется ЦЕЛИКОМ (§А7-4), и
 * свойство аспекта, не названное в `data`, снимается.
 *
 * Свёртка чистит ровно ТРИ адреса, которые читают предикаты замка, а не весь состав аспекта из
 * реестра: расписание и дни на ответ не влияют, а их список здесь стал бы вторым письменным
 * представлением состава носителя. Настоящий состав знает исполнитель (`replaceAspectProps`,
 * `executor/props.ts`).
 */
function afterAttachRoutine(now: TargetState, data: Record<string, unknown>): TargetState {
  const props = { ...now.props };
  for (const property of [ROUTINE_MODE_PROPERTY, ROUTINE_TOOLS_PROPERTY, ROUTINE_STAGE_PROPERTY]) {
    delete props[property];
  }
  return { carrier: true, archived: now.archived, props: { ...props, ...data }, title: now.title };
}

/**
 * РАБОТАЕТ ЛИ запись как рутина — ровно три условия отбора прогонов (`activeRoutines`,
 * `agent-loop/queries.ts`): носитель на строке, не в архиве, `orbis/routine_stage: 'active'`.
 *
 * Функция одна на «до» и «после»: замок поднимает уровень на ПЕРЕХОДЕ между ними, и считать
 * два конца перехода разными формулами значило бы завести ту самую вторую правду, на которой
 * ветку ловили каждый раунд. Второго представления списка условий в коде нет — отбор в SQL и
 * эта функция обязаны сойтись, и расхождение видно первым же тестом оживления.
 */
function liveRoutine(carrier: boolean, archived: boolean, props: Record<string, unknown>): boolean {
  return carrier && !archived && props[ROUTINE_STAGE_PROPERTY] === 'active';
}

/**
 * Трогает ли патч хоть один выключатель отбора В СТОРОНУ РАБОТЫ. Сюда нужен грубый фильтр —
 * кого вообще спрашивать у БД; точный ответ даёт разбор строки (`liveRoutine` на обоих концах).
 * Выключения (`archived: true`, `stage: 'paused'`) не считаются: их направление — сужение прав.
 */
function touchesRevivalSwitch(input: Record<string, unknown>): boolean {
  if (namesRoutineAspect(input, 'attach')) return true;
  if (input.archived === false) return true;
  const props = isRecord(input.props) ? input.props : {};
  return props[ROUTINE_STAGE_PROPERTY] === 'active';
}

/** Называет ли патч аспект рутины этой стороной: `aspects.attach`/`detach` (§А9-1). */
function namesRoutineAspect(input: Record<string, unknown>, side: 'attach' | 'detach'): boolean {
  const aspects = input.aspects;
  if (!isRecord(aspects)) return false;
  const named = aspects[side];
  return Array.isArray(named) && named.includes(ROUTINE_ASPECT);
}

/**
 * Значения ПОСЛЕ этого патча: `props` дописываются, `unset` снимаются (§А9-1) — то самое
 * итоговое состояние, к которому и задаётся вопрос «вооружит ли навешивание аспекта».
 * Спрашивать одну половину нельзя ни в какую сторону: вызов вправе и принести боевые значения
 * вместе с аспектом, и, наоборот, снять их тем же патчем, которым аспект навешивает.
 */
function propsAfterPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current };
  if (isRecord(patch.props))
    for (const [key, value] of Object.entries(patch.props)) next[key] = value;
  if (Array.isArray(patch.unset)) {
    for (const key of patch.unset) if (typeof key === 'string') delete next[key];
  }
  return next;
}

/**
 * Одно ли это значение свойства доверенности. Сравнение по JSON, а не `===`: белый список —
 * МАССИВ, и ссылочное равенство отвечало бы «изменилось» на любом эхе. Порядок ключей
 * сравнение не подводит: по реестру оба свойства — скаляр (`select`) и список строк, объектов
 * среди них нет (соответствие констант реестру пиннится в `confirmation.test.ts`).
 */
function sameAutonomyValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Аспект назначения — четвёртый запретный объект рутины рядом с `ROUTINE_UNTOUCHABLE_OBJECTS`:
 * раздавать исполнителю работу — не то же самое, что править рутину, но запрещено рутине по
 * той же причине.
 *
 * Зеркало executor'а здесь НЕПОЛНОЕ, и намеренно (рулинг Р4-1, разбор — в доке пре-чека
 * ниже): стадия 4 (`assertRoutineUntouchable`, `executor/invariants.ts`) запрещает рутине
 * ТРОГАТЬ аспект назначения (`touched`), а пре-чек запрещает трогать сущность, у которой он
 * уже есть. Буква спеки среза (ОЧ.4, §9.1) требует второго; расхождение названо и вынесено
 * владельцу как остаток.
 */
const ASSIGNMENT_ASPECT = 'orbis/assignment';

/**
 * Объектный пре-чек рутинной мутации (D42 ОЧ.4, инвариант 1 среза): `null` — откладывать
 * можно, строка — человекочитаемая причина отказа АГЕНТУ, здесь и сейчас.
 *
 * Зачем отдельный рубеж, когда те же запреты держит стадия 4 executor'а: отложенная карточка
 * исполняется не в момент постановки, а когда владелец нажмёт «Принять» — и отказ прилетел бы
 * ЕМУ, хотя виноват не он (тот же довод, что у пре-чека предложения, `routines/propose.ts`).
 * Карточка, которую executor гарантированно убьёт, не должна рождаться.
 *
 * НО ПО НАЗНАЧЕНИЮ ЭТА ВЕТКА СТРОЖЕ EXECUTOR'А, и это решено сознательно (рулинг координатора
 * Р4-1). Стадия 4 ловит назначение только по `touched` (`executor/invariants.ts`) — то есть
 * рутина вправе править СВОЙ назначенный тикет, и «архивировать назначенный тикет» на
 * «Принять» прошло бы. Пре-чек же смотрит на СОСТОЯНИЕ цели и отказывает. Так написана буква
 * спеки среза (ОЧ.4 и §9.1 говорят дважды: «цель в `ROUTINE_UNTOUCHABLE_OBJECTS` ∪
 * `orbis/assignment`»), и для фонового актора выбран fail-closed: отказ виден агенту явно, он
 * о нём доложит, цена узкая, откат — одна строка.
 *
 * Первые ТРИ проверки — не про executor вовсе, а про пачку: «Принять все» одним нажатием
 * сняло бы замок мимоходом, если бы выдача автономии, правка инструкции act-рутины или
 * перенастройка системного объекта реестра (§С2-1 ряд 3, Задача 16) умели откладываться.
 * Такое рутина обязана либо делать в лицо владельцу (чат, где он тут же смотрит на карточку),
 * либо не делать. У третьей проверки есть и вторая половина, которой нет у первых двух: у
 * операций реестра запрета по объекту НА СТАДИИ 4 нет вовсе — `assertRoutineUntouchable`
 * стережёт аспекты ЗАПИСЕЙ, а не строки реестра, — то есть здесь это не зеркало, а
 * единственный рубеж. Тем важнее, что уровень до него доводит: `system-object` поднимает ряд
 * 4a до `explicit-confirmation`, и `level !== 'execute'` выполняется всегда.
 *
 * Порядок проверок значим: у операции может сойтись сразу несколько поводов (правка `mode`
 * ЧУЖОЙ рутины — это и автономия, и запретная цель), и назвать агенту надо самый содержательный
 * из них, иначе он будет чинить не то.
 *
 * Цели читаются одним SELECT по id — тем же способом и в том же месте конвейера, что и
 * пробой носителя выше (своей транзакции пре-чек не заводит, RLS —
 * под `withIdentity` актора). Containment тут не нужен: у пре-чека на руках готовые id, а
 * запретных аспектов четыре — читается СПИСОК `aspects[]`, то есть ровно то, чем аспект
 * теперь и является (§А1-1).
 *
 * Пре-чек разбирает ВСЕ формы операции, включая те, до которых таблица §7.10 сегодня его не
 * доводит (связи и attach классифицируются как `execute`, batch рутине закрыт совсем): он —
 * зеркало запрета по объекту, и зеркало, отражающее половину, разошлось бы со стадией 4
 * молча, стоит таблице уровней однажды поменяться. По той же причине функция экспортирована —
 * ровно как `routineGate` выше: рубеж, который никто не проверил, — это рубеж, которого нет.
 */
export async function routineDeferForbidden(
  ctx: ToolCallCtx,
  ops: ReadonlyArray<{ tool: string; input: unknown }>,
  facts: { grantsAutonomy: boolean; reconfigures: Reconfigures },
  instructionOf: readonly string[],
): Promise<string | null> {
  if (facts.grantsAutonomy) {
    return 'выдача автономии рутине из фона не откладывается: право писать в граф без спроса даёт только владелец и только глядя на карточку (V1.10)';
  }
  if (instructionOf.length > 0) {
    return `правка инструкции act-рутины из фона не откладывается: «${instructionOf.join('», «')}» (V1.10)`;
  }
  // ТРЕТИЙ ПОВОД — ЗАПРЕТ ПО ОБЪЕКТУ РЕЕСТРА (§С2-1 ряд 3, Задача 16). Встроенное свойство,
  // встроенный аспект и всё, что приедет с частью Б (`implements`, роли `created_by: system`,
  // определения чужих модулей), фон не перенастраивает НИКОГДА — ни сейчас, ни отложенной
  // единицей. Довод тот же, что у двух поводов выше: «Принять все» одним нажатием сняло бы
  // замок мимоходом, а анти-цель 3 (§С2-3) запрещает рутине «тихо перенастроить, что видит
  // владелец». Свои строки владельца сюда не попадают — их правка откладывается штатно.
  //
  // ВЫХОД У АГЕНТА ЕСТЬ, и отказ его называет: `orbis_ask`/`orbis_checkpoint` открыты рутине
  // В ЛЮБОМ РЕЖИМЕ (`ROUTINE_BASE_TOOLS`, `tools/registry.ts`) — фон говорит владельцу, чего
  // хочет, и тот делает это сам либо подтверждает в чате. Отказ без выхода был бы ловушкой.
  if (facts.reconfigures === 'system-object') {
    return 'перенастройка системного объекта (встроенное свойство, встроенный аспект) из фона не откладывается: устройство системы меняет владелец, а не прогон (§С2-1). Скажите ему об этом — orbis_ask открыт в любом режиме';
  }

  // Цель правки и конец связи — разные множества запретных аспектов, и это не небрежность:
  // executor запрещает связь только по рутине и прогону (`assertRoutineRelationUntouchable`),
  // а назначенный тикет связями обвешивать не мешает. Пре-чек зеркалит его ровно, иначе он
  // отказывал бы в том, что на «Принять» прошло бы.
  const entityTargets: string[] = [];
  const relationEnds: string[] = [];
  for (const op of ops) {
    if (!isRecord(op.input)) continue;
    if (op.tool === 'entity_update') {
      if (typeof op.input.id === 'string') entityTargets.push(op.input.id);
    } else if (op.tool === 'relation_create' || op.tool === 'relation_delete') {
      for (const end of [op.input.source_id, op.input.target_id]) {
        if (typeof end === 'string') relationEnds.push(end);
      }
    } else if (op.tool.startsWith('attach_')) {
      // attach — третий путь появления аспекта на ЖИВОЙ сущности; `entity_create` целей
      // в БД не имеет вовсе, его запретные формы ловит проверка автономии выше и стадия 4
      if (typeof op.input.entity_id === 'string') entityTargets.push(op.input.entity_id);
    }
  }
  const ids = [...new Set([...entityTargets, ...relationEnds])];
  if (ids.length === 0) return null;

  const rows = await withIdentity(ctx.db, ctx.actorUserId, (tx) =>
    tx
      .select({ id: entities.id, aspects: entities.aspects })
      .from(entities)
      .where(inArray(entities.id, ids)),
  );
  const aspectsById = new Map(rows.map((r) => [r.id, r.aspects]));
  // Невидимой цели (её нет или она чужая) пре-чек не касается: NOT_FOUND — честный ответ
  // исполнения, и подменять его отказом по объекту значило бы разглашать, что строка есть.
  const untouchable = (id: string): boolean => {
    const aspects = aspectsById.get(id);
    return aspects !== undefined && ROUTINE_UNTOUCHABLE_OBJECTS.some((a) => aspects.includes(a));
  };

  for (const id of entityTargets) {
    if (untouchable(id) || aspectsById.get(id)?.includes(ASSIGNMENT_ASPECT) === true) {
      return routineUntouchableError().message;
    }
  }
  for (const id of relationEnds) {
    if (untouchable(id)) return routineUntouchableError().message;
  }
  return null;
}

/**
 * Заголовок и признак архива сущности под tx владельца; `undefined` — не видна (чужая или
 * её нет). Оба поля одним SELECT'ом по PK: `archived` нужен гарду отложки (карточка с
 * ложным «было» не должна родиться), и второй запрос ради одной колонки был бы лишним.
 */
async function entityHead(
  tx: Tx,
  id: string,
): Promise<{ title: string; archived: boolean; aspects: string[] } | undefined> {
  const rows = await tx
    .select({ title: entities.title, archived: entities.archived, aspects: entities.aspects })
    .from(entities)
    .where(eq(entities.id, id));
  return rows[0];
}

/** Сколько живых рутин у актора (под RLS его же tx): архивные лимит не занимают. */
async function countRoutines(tx: Tx): Promise<number> {
  const rows = await tx.execute(
    sql`SELECT count(*)::int AS n FROM entities WHERE NOT archived AND 'orbis/routine' = ANY(aspects)`,
  );
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

/** Какие из целей УЖЕ рутины — отличает правку живой рутины от заведения новой. */
async function routinesAmong(tx: Tx, ids: string[]): Promise<Set<string>> {
  // inArray, а не сырое `= ANY($1::uuid[])`: массив из шаблона `sql` уезжает в драйвер
  // как есть и падает «malformed array literal» (идиома репозитория, routers/entity.ts)
  const rows = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(and(inArray(entities.id, ids), sql`'orbis/routine' = ANY(${entities.aspects})`));
  return new Set(rows.map((r) => r.id));
}

/**
 * Отказ «такого свойства нет» ПО ГРАНИЦЕ тула (§А9-1) — `null`, если все адреса известны.
 *
 * Смотрятся только `props` и `unset`: имена ПАРАМЕТРОВ `attach_*` схема тула уже перечислила
 * поимённо (`additionalProperties: false`), а имена аспектов — не свойства, их отвергает
 * валидатор своим кодом `UNKNOWN_ASPECT`.
 *
 * Отказ структурный и с `reason`: код `VALIDATION` перегружен, и различать «опечатка в
 * имени свойства» от «значение не того типа» в тестах и в самокоррекции модели больше нечем.
 */
function unknownPropertyError(
  reg: RegistrySnapshot,
  ops: ReadonlyArray<{ tool: string; input: unknown }>,
): ToolDispatchResult | null {
  for (const op of ops) {
    if (!isRecord(op.input)) continue;
    const props = isRecord(op.input.props) ? Object.keys(op.input.props) : [];
    const unset = Array.isArray(op.input.unset)
      ? op.input.unset.filter((v): v is string => typeof v === 'string')
      : [];
    for (const keyOrId of [...props, ...unset]) {
      if (resolvePropertyRef(reg, keyOrId) !== undefined) continue;
      const nearest = nearestPropertyKey(reg, keyOrId);
      return errorResult(
        'VALIDATION',
        `свойства «${keyOrId}» нет в реестре${nearest === undefined ? '' : ` — возможно, «${nearest}»`}`,
        {
          tool: op.tool,
          reason: 'UNKNOWN_PROPERTY',
          property: keyOrId,
          ...(nearest !== undefined && { nearest }),
        },
      );
    }
  }
  return null;
}

/**
 * Имена тулов реестра — для проверки операций batch.
 *
 * ПЕРЕВОДА БОЛЬШЕ НЕТ, и его отсутствие — суть правки (§А9-1, Задача 12). Прежде здесь
 * жила ВТОРАЯ нормализация имени `attach_*` («/» → «_», дефис сохраняется), потому что
 * исполнитель ждал не то имя, которое реестр показывал модели. Обе сведены в общую
 * `attachToolName`, имя стало одним на всех — и переводчику посередине стало нечего делать.
 * Осталась только проверка «такой тул в реестре есть»: имя вне реестра — структурная
 * VALIDATION с индексом элемента, а известные, но непригодные для batch (read-тулы,
 * thread_post, вложенный batch_execute) отклоняет стадия 1 executor'а своей ошибкой.
 */
function knownToolNames(defs: OrbisToolDef[]): ReadonlySet<string> {
  return new Set(defs.map((d) => d.name));
}

function assertBatchToolsKnown(input: unknown, known: ReadonlySet<string>): BatchExecuteInput {
  const parsed = parseEnvelope(batchExecuteInput, input, 'batch_execute');
  for (const [index, op] of parsed.operations.entries()) {
    if (!known.has(op.tool)) {
      throw new ExecError('VALIDATION', `batch_execute: неизвестный тул операции «${op.tool}»`, {
        index,
        tool: op.tool,
      });
    }
  }
  return parsed;
}

/**
 * Envelope-схемы мутирующих core-тулов §9.2 (shared) — для структурной валидации ДО
 * классификации §7.10 (fix round Task 5). batch_execute и thread_post здесь не нужны:
 * batch валидируют `assertBatchToolsKnown` + `validateBatchOperations`, thread_post — своя
 * ветка dispatchTool. Ключи — имена реестра: с Задачи 12 исполнительная форма им равна
 * (§А9-1, общая `attachToolName`), и «исполнительных имён» как отдельного словаря больше
 * не существует.
 */
const MUTATION_ENVELOPES: Record<string, z.ZodTypeAny> = {
  entity_create: entityCreateInput,
  entity_update: entityUpdateInput,
  relation_create: relationCreateInput,
  relation_delete: relationDeleteInput,
  // Тулы реестра (§А10-2): их схемы живут рядом с дефами (`tools/registry-tools.ts`), и
  // копии здесь нет намеренно — парность двух представлений там держится соседством строк.
  ...REGISTRY_TOOL_ENVELOPES,
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
 * (имена — реестровые, они же исполнительные; `assertBatchToolsKnown` уже отверг те, что
 * реестру неизвестны). Имена, непригодные для batch
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

/**
 * keyFields карточки (02 §2.3): id свойств из `view_config.keyFields` каждого аспекта.
 *
 * Переходный шим снят (Задача 12): прежде id свойства переводился в СТАРОЕ ИМЯ ПОЛЯ
 * (`propertyToLegacyField`), потому что значения читались из карты `aspects[id][поле]`, а
 * web искал подпись по имени поля. Обе половины ушли: значения лежат в `props` по id
 * (§А1-1), и карточка адресует их тем же id, что и всё остальное. Цена названа вслух: до
 * Задачи 13c web не находит подпись по новому ключу и покажет сам ключ — это ОДНА
 * поверхность (карточка чата), и держать ради неё вторую правду об адресе значения дороже.
 */
function keyFieldsByAspect(reg: RegistrySnapshot): Map<string, string[]> {
  return new Map([...reg.aspects.values()].map((a) => [a.id, a.viewConfig.keyFields]));
}

function entityCard(
  e: WireEntity,
  keyFieldsMap: Map<string, string[]>,
  undoActionId: string | undefined,
): Card {
  // Список аспектов — из НОВОЙ правды (§А1-1): он и есть то, чем аспект стал.
  const aspects = e.aspects;
  // Значения — из НОВОЙ правды по id свойства (§А1-1). Признак носителя обязателен (Р9):
  // значение переживает снятие аспекта, и без проверки списка карточка показывала бы поле
  // аспекта, которого на записи уже нет.
  const keyFields: Record<string, unknown> = {};
  for (const aspectId of aspects) {
    for (const propertyId of keyFieldsMap.get(aspectId) ?? []) {
      const value = e.props[propertyId];
      if (value !== undefined) keyFields[propertyId] = value;
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
      // нечего. Прогон (run_id) связывает пост с историей рутины, рутина (routine_id) —
      // с самой рутиной: по прогону её пришлось бы искать вторым запросом, а лента
      // показывает автора сразу. Обоих ключей нет вне прогона рутины.
      metadata:
        ctx.actorKind === 'owner'
          ? {}
          : {
              author_kind: ctx.actorKind,
              ...(ctx.runId !== undefined && { run_id: ctx.runId }),
              ...(ctx.routine !== undefined && { routine_id: ctx.routine.id }),
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

/**
 * ВХОД-ДЕРЕВА 1: ГЕЙТ ГЛУБИНЫ входа `entity_query` — ПЕРВЫМ действием тула, до схемы и до
 * компиляции. Перечень всех входов дерева и гейтов — в шапке `queryFilterNodeSchema`
 * (`@orbis/shared`, `query/ast.ts`).
 *
 * Порядок здесь и есть суть. Ниже по конвейеру глубину не остановить ничем: `z.lazy`
 * рекурсивен и исчерпывает стек внутри самого `safeParse`, а то, что через zod всё же
 * проходит, компилируется в цепочку `NOT COALESCE(…)`, на которой отвечает уже парсер
 * Postgres (`stack depth limit exceeded`) — не `ExecError`, то есть мимо всех наших
 * catch'ей. Между этими двумя порогами лежала полоса, в которой модель получала сырой
 * обрыв вместо отказа; кап её закрывает целиком, потому что стоит РАНЬШЕ обоих.
 *
 * Кап проверяется ЯВНЫМ итеративным обходом (`queryTreeExceedsDepth`) и от чужих порогов
 * НЕ ЗАВИСИТ — обоснование числа целиком в докблоке `QUERY_TREE_DEPTH_CAP`.
 *
 * МЕРЯЕТСЯ ИМЕННО ДЕРЕВО, а не конверт `{ast: …}`: кап — про глубину запроса, и число, о
 * котором говорит отказ, обязано быть тем же, которое считает код. Конверт дал бы на
 * единицу больше, и пользователю мы называли бы не ту величину, что проверяем (находка
 * ре-ревью). Всё остальное в конверте — строка `query`, рекурсии там нет.
 *
 * Входов у класса ДВА, и у каждого свой гейт — общий предикат (`queryTreeExceedsDepth`),
 * своя обёртка отказа: `ast:` этого тула (ниже) и `ast:` роутера `entity.query`/`entity.count`
 * (`routers/entity.ts`, `querySignature` через `z.preprocess`). Второй завела Задача 13c —
 * пикеру ссылочных свойств цель приезжает деревом (§А6-1), а не текстом. Текстовый разбор
 * дерева не рекурсирует, и третьего входа у класса нет.
 */
function assertQueryTreeDepth(input: unknown): void {
  if (typeof input !== 'object' || input === null) return;
  const ast = (input as { ast?: unknown }).ast;
  if (!queryTreeExceedsDepth(ast, QUERY_TREE_DEPTH_CAP)) return;
  // В тексте отказа названа только та величина, которую этот код и меряет, — сам кап.
  // Глубина эталонов (обоснование числа) живёт в докблоке `QUERY_TREE_DEPTH_CAP` и
  // пиннится там же тестами; третья её копия здесь разъехалась бы с ними молча.
  throw new ExecError(
    'VALIDATION',
    `entity_query: дерево запроса вложено глубже ${QUERY_TREE_DEPTH_CAP} уровней — ` +
      `столько не нужно ни одному осмысленному запросу`,
    { tool: 'entity_query', reason: 'QUERY_TOO_DEEP', cap: QUERY_TREE_DEPTH_CAP },
  );
}

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

/**
 * Структурный отказ компиляции (`this` вне контекста, нечисловое свойство sum, значение не
 * той формы) компилятор канона уже бросает как `ExecError('VALIDATION')` — перевод больше
 * не нужен, и обёртка осталась бы враньём про то, что здесь что-то происходит.
 */
