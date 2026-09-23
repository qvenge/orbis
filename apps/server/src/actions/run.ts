// apps/server/src/actions/run.ts
// ИСПОЛНЕНИЕ ДЕЙСТВИЯ (§Б6-2/§Б6-4) — своя ветка `dispatchTool`, как `thread_post` и
// `orbis_propose`, и по той же причине: конверт с предусловиями через `MUTATION_ENVELOPES` не
// проходит по построению (`validateMutationEnvelope`, `tools/dispatch.ts`).
//
// ГЕЙТЫ — ПО КАЖДОМУ ШАГУ (§Б6-2 дословно: «действие доступно актору, только если каждый его
// резолвленный шаг прошёл бы гейты этого актора»). Гейт по внешнему имени — ровно та дыра, из-за
// которой `batch_execute` закрыт рутине наглухо (`routineToolAllowed`, `tools/registry.ts`):
// обёртка провозила бы внутрь что угодно. Имя действия проверяет ОБЩИЙ гейт диспатча (режим
// рутины и скоуп гранта — как у любого тула); здесь — вторая линия, по шагам.
//
// ИМПОРТЫ — ИЗ ОБЩЕГО ДНА, а не из `tools/dispatch.ts`: `dispatchTool` зовёт `runAction`, и
// обратный импорт по значению замкнул бы цикл (Р-К-67, Р-К-87).
import {
  type ActionDefinition,
  BATCH_CAP_DEFAULT,
  effectiveLabel,
  isModuleEnabled,
  newId,
} from '@orbis/shared';
import { OWNER_LOCALE } from '@orbis/shared/query';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { classifyToolCall, factsFromOperations, type ToolCallFacts } from '../policy/confirmation';
import { createPending } from '../policy/pending';
import { sensitivityFactsOf } from '../policy/sensitivity';
import { ownerTimeZone, todayInTimeZone } from '../query/context';
import { stepFactsOf } from '../registry/actions';
import type { RegistrySnapshot } from '../registry/load';
import {
  errorResult,
  levelGate,
  parseEnvelope,
  sink,
  type ToolCallCtx,
  type ToolDispatchResult,
} from '../tools/dispatch-common';
import { buildToolDefs, routineToolAllowed, WORKER_SCOPE_TOOLS } from '../tools/registry';
import { type ExecOperation, lookupAction, resolveAction, runActionInput } from './resolve';

/**
 * Р-К-67: `deferRoutineUnit` живёт в `tools/dispatch.ts` и приватна; сюда она приходит
 * параметром, чтобы `actions/run.ts` не импортировал диспатч значением (цикл). Задача 8 зовёт
 * `hooks.defer` из ветки фона ниже.
 */
export interface RunActionHooks {
  defer: (tool: 'run_action', payload: unknown) => Promise<ToolDispatchResult>;
}

export async function runAction(
  ctx: ToolCallCtx,
  reg: RegistrySnapshot,
  disabled: readonly string[],
  actionRef: string,
  input: unknown,
  // Параметр объявлен ради сигнатуры Р-К-67: до задачи 8 ветка фона отказывает fail-closed и
  // `defer` не зовёт (Р-К-29).
  _hooks: RunActionHooks,
): Promise<ToolDispatchResult> {
  // Вход `run_action` приезжает конвертом тула, вход `action_*` — уже разобранным на
  // `{self, params}` веткой диспатча; обе формы сводятся к одному строгому конверту здесь.
  const raw =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const parsed = parseEnvelope(runActionInput, { action: actionRef, ...raw }, 'run_action');

  // §Б8-3 ревизия 4: действие выключенного модуля не исполняется. Вторая линия к маске реестра
  // тулов — она скрывает только `action_*`, а `run_action` берёт действие по ключу. Спрашивается
  // ДО резолва: действие выключенного модуля не читает цели вовсе, и отказ не зависит от того,
  // выполнено ли у цели предусловие.
  const declared = lookupAction(reg, parsed.action);
  if (!isModuleEnabled(declared.module, disabled)) {
    return errorResult(
      'MODULE_DISABLED',
      `действие «${declared.key}» принадлежит выключенному модулю «${declared.module}» (§Б8-3)`,
      { action: declared.id, module: declared.module },
    );
  }
  if (ctx.source === 'routine' && ctx.routine === undefined) {
    // Вторая линия к `routineGate` диспатча: без контекста рутины неизвестно, какого режима
    // держаться, — fail-closed, а не «шаги без проверки».
    return errorResult(
      'FORBIDDEN_LEVEL',
      `вызов из прогона рутины без её контекста — действие «${declared.key}» не исполняется (V1.10)`,
      { action: declared.id },
    );
  }

  const resolved = await withIdentity(ctx.db, ctx.identity, async (tx) => {
    const timeZone = await ownerTimeZone(tx, ctx.identity.graph);
    return resolveAction(tx, reg, ctx.identity.graph, parsed, {
      today: todayInTimeZone(timeZone, ctx.clock?.() ?? new Date()),
      timeZone,
    });
  });
  const { decl, operations, targets } = resolved;
  if (operations.length === 0) {
    // Пакетному действию нечего делать (запрос не нашёл ни одной цели): исполнять пустую пачку
    // нечем — исполнитель отверг бы её «batch без операций», а журналировать нечего.
    return { status: 'ok', result: [] };
  }

  // Гейты полномочий — ПО ШАГАМ. Деф шага собирается из реестра: `routineToolAllowed` берёт
  // `{name, kind}`, и подкладывать ему имя ДЕЙСТВИЯ вместо имени ШАГА значило бы проверять не то
  // (§Б6-2). Имена шагов повторяются по целям пакета — проверяется каждое один раз.
  const defs = buildToolDefs(reg, disabled);
  for (const tool of new Set(operations.map((op) => op.tool))) {
    const stepDef = defs.find((d) => d.name === tool) ?? { name: tool, kind: 'mutate' as const };
    if (ctx.routine !== undefined && !routineToolAllowed(stepDef, ctx.routine)) {
      return errorResult(
        'FORBIDDEN_LEVEL',
        `действие «${decl.key}»: шаг «${tool}» недоступен рутине в режиме «${ctx.routine.mode}» (§Б6-2, §С2-2)`,
        { action: decl.id, tool, reason: 'action_step_forbidden', mode: ctx.routine.mode },
      );
    }
    if (ctx.grant !== undefined && ctx.grant.scope !== 'full' && !WORKER_SCOPE_TOOLS.has(tool)) {
      return errorResult(
        'FORBIDDEN_LEVEL',
        `действие «${decl.key}»: шаг «${tool}» недоступен скоупу worker (§4.14, §Б6-2)`,
        { action: decl.id, tool, reason: 'action_step_forbidden', scope: ctx.grant.scope },
      );
    }
  }

  const facts = actionCallFacts(reg, decl, operations, targets, ctx);
  const level = classifyToolCall(facts);
  const gated = levelGate(level, `run_action:${decl.key}`);
  if (gated !== null) return gated;

  if (level === 'explicit-confirmation' && operations.length > BATCH_CAP_DEFAULT) {
    // Единица подтверждения — конверт `batch_execute` (Р-8), а его длину держит тот же кап, что
    // у пачки модели (В-9, Р-11): `approvePending` разбирает сохранённую карточку той же схемой
    // (`toOperations`). Карточка длиннее капа не исполнилась бы на «Принять» никогда — честный
    // отказ ДО постановки дешевле карточки, которую нельзя принять.
    return errorResult(
      'VALIDATION',
      `действие «${decl.key}»: операций ${operations.length}, предел карточки подтверждения ${BATCH_CAP_DEFAULT} (В-9)`,
      {
        reason: 'BATCH_TOO_LONG',
        action: decl.id,
        cap: BATCH_CAP_DEFAULT,
        found: operations.length,
      },
    );
  }

  if (ctx.source === 'routine' && level !== 'execute') {
    // Р-К-29/Р-К-67: ЗАДАЧА 8 заменяет этот блок вызовом `hooks.defer('run_action', parsed)`.
    // §Б6-2 велит здесь отложенную единицу D42; её кладёт задача 8 (Р-И-31, третья ветка
    // `snapshotDeferredUnit`). До неё — fail-closed ТЕМ ЖЕ ТЕКСТОМ, что инвариант 5
    // (`runMutation`, `tools/dispatch.ts`): фон, которому нечего ни исполнить, ни отложить,
    // обязан получить отказ, а не тишину, — и тот же отказ, что у любого другого пути фона.
    return errorResult(
      'FORBIDDEN_LEVEL',
      `в фоне откладывается только одиночное небезопасное действие — уровень «${level}» не исполняется и не откладывается (V1.10)`,
      { tool: 'run_action', level, action: decl.id },
    );
  }

  if (level === 'explicit-confirmation') {
    // Форма единицы — `batch_execute` с резолвленными операциями (Р-8): её умеет исполнить
    // `approvePending` уже сегодня (`toOperations`, `policy/pending.ts`). Ключи `action`
    // (`action_id` + хеш декларации) и проверку «Устарело» добавляет ЗАДАЧА 8 — без них единица
    // исполнится как обычная пачка, что верно, но не проверит протухание.
    const batchId = parsed.batch_id ?? newId();
    const pending = await withIdentity(ctx.db, ctx.identity, (tx) =>
      createPending(tx, {
        threadId: ctx.threadId,
        summary: resolved.summary,
        // Атрибуция исполнения — за ТЕМ, кто попросил (§7.8, D11 + С2), как у `runMutation`.
        actor: {
          graphId: ctx.identity.graph,
          kind: ctx.actorKind,
          source: ctx.source,
          grantId: ctx.grant?.id,
          runId: ctx.runId,
        },
        tool: 'batch_execute',
        input: { batch_id: batchId, operations },
        level,
        // Дедуп по batch_id вызова: ретрай того же вызова не плодит вторую карточку.
        dedupeKey: batchId,
        clock: ctx.clock,
      }),
    );
    return { status: 'pending_confirmation', pendingId: pending.pendingId, card: pending.card };
  }

  // execute | preview — одна транзакция, одна строка журнала `type:'action'`, один inverse
  // (§Б6-4): исполнитель берёт batch-путь по `batchId`, даже когда операция одна.
  const r = await execute(
    ctx.db,
    {
      identity: ctx.identity,
      actorKind: ctx.actorKind,
      source: ctx.source,
      threadId: ctx.threadId,
      actorGrantId: ctx.grant?.id,
      runId: ctx.runId,
      operations,
      batchId: parsed.batch_id ?? newId(),
      action: { id: decl.id, module: decl.module },
      actionLabel: effectiveLabel(decl.label, OWNER_LOCALE),
      clock: ctx.clock,
    },
    { sink },
  );
  if (!r.ok) return { status: 'error', error: r.error };
  return {
    status: 'ok',
    result: r.results,
    ...(r.idempotentReplay ? {} : { actionId: r.actionId }),
  };
}

/**
 * ФАКТЫ ВЫЗОВА ДЕЙСТВИЯ (§7.10 по §Б6-2) — ЧИСТАЯ функция от резолва, и это не стиль, а условие
 * проверяемости: уровень действия — несущее правило среза, и подсматривать его через подменённый
 * модуль (мока в репозитории нет ни одного) значило бы проверять свою же обвязку. Тест
 * спрашивает эту функцию, а диспатч — только исход.
 *
 * `isBatch` — по НАЛИЧИЮ `over` (Р-7, О7 опровержения): одиночное действие пачкой не становится,
 * map — становится, и ряд «> 10 → обсудить» действует поверх (§Б6-3). Имя тула в фактах всегда
 * `run_action`, даже когда вызвали `action_*`: политика смотрит на шаги, а не на то, каким из
 * двух входов действие позвали.
 *
 * Правила C рёбер записи-цели не перепроверяют (именованное ограничение `relationFactsOf`,
 * `rules/scope.ts`), поэтому факты рёберных шагов здесь — только то, что даёт их тип
 * (`reconfiguresOf`/`grantsRoutineAutonomy` — `none`/`false`) и декларация; на вердикт правил
 * по цели рёберного шага уровень не опирается.
 */
export function actionCallFacts(
  reg: RegistrySnapshot,
  decl: ActionDefinition,
  operations: readonly ExecOperation[],
  targets: readonly string[],
  actor: Pick<ToolCallCtx, 'actorKind' | 'explicitCommand'>,
): ToolCallFacts {
  const stepFacts = factsFromOperations(operations);
  return {
    ...stepFacts,
    tool: 'run_action',
    kind: 'mutate',
    known: true,
    actorKind: actor.actorKind,
    explicitCommand: actor.explicitCommand,
    ...(decl.over !== null && { isBatch: true, batchSize: targets.length }),
    // §Б6-1: объединение фактов декларации и фактов резолвленных шагов; словарь имён —
    // `sensitivityFactsOf`, свёртка типов уже произошла выше (Р-К-23).
    sensitivity: sensitivityFactsOf(reg, { ...stepFacts, tool: 'run_action' }, [
      ...decl.sensitivity,
      ...decl.steps.flatMap((s) => stepFactsOf(reg, s)),
    ]),
  };
}
