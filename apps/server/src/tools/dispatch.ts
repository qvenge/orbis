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
  aspectsNamedInQueryAst,
  OWNER_LOCALE,
  QUERY_TREE_DEPTH_CAP,
  type QueryAst,
  queryTreeExceedsDepth,
  resolveLegacyFieldId,
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
  type ConfirmationLevel,
  classifyToolCall,
  entityUpdatePreviewDiff,
  factsFromToolCall,
  grantsRoutineAutonomy,
  ROUTINE_MODE_PROPERTY,
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
import { loadRegistry, type RegistrySnapshot } from '../registry/load';
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
      const reg = await loadRegistry(tx, ctx.actorUserId);
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
      result: await runPropertyCatalog(tx, reg, parsed, OWNER_LOCALE),
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
 * (`resolveLegacyFieldId`): id, key или старое имя поля — до Задачи 21 модель видит в
 * примерах и промптах именно старые (`amount`), и отвергать их значило бы сломать вопрос
 * «сколько потрачено» на ровном месте.
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
      const compiled = compileSumAst(ast, sumProperty(field, ast, cctx), cctx);
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
 * Аспекты САМОГО ЗАПРОСА участвуют в резолве, как и у старого компилятора
 * (`aspectsInQuery`): старое имя может носить несколько аспектов, и `aspect=` в запросе —
 * единственное, чем автор их разводит. Без этого `sum` по неоднозначному имени отказывал
 * бы там, где текст запроса всё уже сказал, — сужение молчаливое и не названное нигде.
 */
function sumProperty(field: string, ast: QueryAst, cctx: CompileCtx): string {
  const id = resolveLegacyFieldId(field, parseRegistryOf(cctx), aspectsNamedInQueryAst(ast));
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
  // zod-issues (путь самокоррекции модели), а не wouldBe; для batch — трансляция имён
  // (fix round Task 4) плюс валидация каждого operations[].input схемой его тула.
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
  const ops = batchPayload?.operations ?? [{ tool, input: payload }];
  const instructionOf =
    ctx.actorKind === 'owner' || classified === 'explicit-confirmation'
      ? []
      : await actRoutineInstructionTargets(ctx, ops);
  const level: ConfirmationLevel = instructionOf.length > 0 ? 'explicit-confirmation' : classified;

  // Объектный пре-чек рутинной мутации (D42 ОЧ.4, блокер Б2): запрещённое ПО ОБЪЕКТУ
  // отклоняется ДО постановки и не откладывается никогда. Стоит РАНЬШЕ ветки отложки
  // намеренно: небезопасное ПО УРОВНЮ теперь откладывается, а этому отказу открываться
  // нечем — ни один из четырёх его поводов не становится безопаснее оттого, что владелец
  // разберёт его позже. Уровень `execute` пре-чек не смотрит: там ничего не откладывается, и
  // запрет держит стадия 4 executor'а своим отказом — тем же кодом и с тем же `reason`.
  if (ctx.source === 'routine' && level !== 'execute') {
    const forbidden = await routineDeferForbidden(ctx, ops, facts, instructionOf);
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
    // payload'ом (уже envelope-валидированным и с транслированными batch-именами);
    // до approve ничего не записано ни в граф, ни в журнал §7.8. Исполнение и
    // ревалидацию текущего состояния делает approve (policy/pending.ts)
    const pending = await withIdentity(ctx.db, ctx.actorUserId, async (tx) =>
      createPending(tx, {
        threadId: ctx.threadId,
        // Выдача автономии (V1.10): карточка обязана называть, ЧТО подтверждается — режим и
        // белый список, — а не имя тула: снятие замка — осознанный акт человека (B1-2)
        ...(facts.grantsAutonomy && { summary: await autonomySummary(tx, ops) }),
        // Правка инструкции act-рутины (C1b-1) — тем же языком: кого и что правят
        ...(!facts.grantsAutonomy &&
          instructionOf.length > 0 && {
            summary: `Инструкция act-рутины: правка «${instructionOf.join('», «')}»`,
          }),
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
  // Имена в executor-форме (у batch — уже транслированные): у attach_orbis_routine обе
  // формы совпадают. batch исполняется «всё или ничего» — рутину заводит ЛЮБАЯ операция
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
 * Сводка выдачи автономии для карточки подтверждения (V1.10, B1-2): по каждой операции,
 * выдающей права, — рутина заголовком, режим и белый список. Заголовок живой цели читается
 * из БД (под tx владельца); у создаваемой — из самого входа. Формат намеренно один и тот же
 * для attach/create/update и для batch: владелец сверяет одно и то же — «кому, какой режим,
 * какие инструменты».
 */
async function autonomySummary(
  tx: Tx,
  ops: ReadonlyArray<{ tool: string; input: unknown }>,
): Promise<string> {
  const parts: string[] = [];
  for (const op of ops) {
    if (!grantsRoutineAutonomy(op.tool, op.input) || !isRecord(op.input)) continue;
    // Доверенность лежит там же, где её читает гейт (§А9-1): у attach — в `data` по key
    // свойства, у create/update — в `props`. Второе место чтения разъехалось бы с гейтом, и
    // карточка называла бы владельцу не то, что подтверждается.
    const routine = op.tool === 'attach_orbis_routine' ? op.input.data : op.input.props;
    if (!isRecord(routine)) continue;
    const targetId =
      op.tool === 'entity_update'
        ? op.input.id
        : op.tool === 'attach_orbis_routine'
          ? op.input.entity_id
          : undefined;
    const title =
      typeof targetId === 'string'
        ? ((await entityHead(tx, targetId))?.title ?? `${targetId.slice(0, 8)}…`)
        : typeof op.input.title === 'string'
          ? op.input.title
          : 'новая рутина';
    const facts: string[] = [];
    const mode = routine[ROUTINE_MODE_PROPERTY];
    if (typeof mode === 'string') facts.push(`режим ${mode}`);
    // attach/create кладут набор ЦЕЛИКОМ — отсутствующий белый список значит «нет
    // инструментов», и это надо сказать; у update патч дописывает свойства, и молчание о
    // списке значит «прежний»
    if (ROUTINE_TOOLS_PROPERTY in routine || op.tool !== 'entity_update') {
      const allowed = routine[ROUTINE_TOOLS_PROPERTY];
      const tools = Array.isArray(allowed)
        ? allowed.filter((t): t is string => typeof t === 'string')
        : [];
      facts.push(tools.length > 0 ? `инструменты: ${tools.join(', ')}` : 'инструменты: нет');
    }
    parts.push(`Автономия рутины «${title}»: ${facts.join(', ')}`);
  }
  return parts.join('; ');
}

/**
 * Заголовки act-рутин, чью ИНСТРУКЦИЮ (тело/заголовок) правят операции (V1.10, C1b-1) —
 * пусто, если таких нет. Смотрит только `entity_update` с `body`/`bodyDoc`/`title`: правка
 * расписания и режима идёт другими полями (её держит grantsAutonomy), пауза и метки
 * содержания автономии не меняют. Условие «рутина в act» — по БД, containment'ом по колонке
 * `props` (индекс `entities_props_gin`) под признаком носителя, под tx актора (RLS).
 * Признак обязателен (Р9): `orbis/routine_mode` переживает снятие аспекта рутины, и без
 * него правка заголовка обычной записи, когда-то бывшей рутиной, читалась бы как правка
 * инструкции act-рутины.
 */
async function actRoutineInstructionTargets(
  ctx: ToolCallCtx,
  ops: ReadonlyArray<{ tool: string; input: unknown }>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const op of ops) {
    if (op.tool !== 'entity_update' || !isRecord(op.input)) continue;
    const i = op.input;
    if (i.body === undefined && i.bodyDoc === undefined && i.title === undefined) continue;
    if (typeof i.id === 'string') ids.push(i.id);
  }
  if (ids.length === 0) return [];
  const actRoutine = JSON.stringify({ 'orbis/routine_mode': 'act' });
  return withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
    const rows = await tx
      .select({ title: entities.title })
      .from(entities)
      .where(
        and(
          inArray(entities.id, ids),
          sql`${ROUTINE_ASPECT} = ANY(${entities.aspects})`,
          sql`${entities.props} @> ${actRoutine}::jsonb`,
        ),
      );
    return rows.map((r) => r.title);
  });
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
 * Первые две проверки — не про executor вовсе, а про пачку: «Принять все» одним нажатием
 * сняло бы замок V1.10 мимоходом, если бы выдача автономии или правка инструкции act-рутины
 * умели откладываться. Такое рутина обязана либо делать в лицо владельцу (чат, где он тут же
 * смотрит на карточку), либо не делать.
 *
 * Порядок проверок значим: у операции может сойтись сразу несколько поводов (правка `mode`
 * ЧУЖОЙ рутины — это и автономия, и запретная цель), и назвать агенту надо самый содержательный
 * из них, иначе он будет чинить не то.
 *
 * Цели читаются одним SELECT по id — тем же способом и в том же месте конвейера, что и
 * `actRoutineInstructionTargets` строкой выше (своей транзакции пре-чек не заводит, RLS —
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
  facts: { grantsAutonomy: boolean },
  instructionOf: readonly string[],
): Promise<string | null> {
  if (facts.grantsAutonomy) {
    return 'выдача автономии рутине из фона не откладывается: право писать в граф без спроса даёт только владелец и только глядя на карточку (V1.10)';
  }
  if (instructionOf.length > 0) {
    return `правка инструкции act-рутины из фона не откладывается: «${instructionOf.join('», «')}» (V1.10)`;
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
): Promise<{ title: string; archived: boolean } | undefined> {
  const rows = await tx
    .select({ title: entities.title, archived: entities.archived })
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
 * ГЕЙТ ГЛУБИНЫ входа `entity_query` — ПЕРВЫМ действием тула, до схемы и до компиляции.
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
 * Вход у класса ровно один — `ast:` этого тула: tRPC-роутер принимает только текст, а
 * текстовый разбор дерева не рекурсирует. Поэтому и гейт один, здесь.
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
