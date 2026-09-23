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
import { type ActionDefinition, effectiveLabel, isModuleEnabled, newId } from '@orbis/shared';
import { OWNER_LOCALE } from '@orbis/shared/query';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { classifyToolCall, factsFromOperations, type ToolCallFacts } from '../policy/confirmation';
import { createPending } from '../policy/pending';
import { sensitivityFactsOf } from '../policy/sensitivity';
import { stepFactsOf } from '../registry/actions';
import type { RegistrySnapshot } from '../registry/load';
import {
  errorResult,
  levelGate,
  parseEnvelope,
  routineDeferForbidden,
  sink,
  type ToolCallCtx,
  type ToolDispatchResult,
} from '../tools/dispatch-common';
import { buildToolDefs, routineToolAllowed, WORKER_SCOPE_TOOLS } from '../tools/registry';
import { actionDateArgs } from './precondition';
import {
  type ExecOperation,
  lookupAction,
  resolveAction,
  runActionInput,
  unitCapExceeded,
} from './resolve';

/**
 * Р-К-67: `deferRoutineUnit` живёт в `tools/dispatch.ts` и приватна; сюда она приходит
 * параметром, чтобы `actions/run.ts` не импортировал диспатч значением (цикл). Её зовёт ветка
 * фона ниже — после объектного пре-чека (эррата Ф-Б2-18).
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
  hooks: RunActionHooks,
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

  // Гейты полномочий — ПО ШАГАМ, и ДО резолва (М-2 гейта): набор тулов шагов статичен (`step.tool`
  // — имя, а не выражение, и резолв даёт ровно по операции на шаг и цель), поэтому отказ по правам
  // не зависит от данных — ни предусловие цели, ни пустое множество целей пакета не отвечают актору
  // без права раньше, чем «нельзя». Деф шага собирается из реестра: `routineToolAllowed` берёт
  // `{name, kind}`, и подкладывать ему имя ДЕЙСТВИЯ вместо имени ШАГА значило бы проверять не то
  // (§Б6-2).
  const defs = buildToolDefs(reg, disabled);
  for (const tool of new Set(declared.steps.map((step) => step.tool))) {
    const stepDef = defs.find((d) => d.name === tool) ?? { name: tool, kind: 'mutate' as const };
    if (ctx.routine !== undefined && !routineToolAllowed(stepDef, ctx.routine)) {
      return errorResult(
        'FORBIDDEN_LEVEL',
        `действие «${declared.key}»: шаг «${tool}» недоступен рутине в режиме «${ctx.routine.mode}» (§Б6-2, §С2-2)`,
        { action: declared.id, tool, reason: 'action_step_forbidden', mode: ctx.routine.mode },
      );
    }
    if (ctx.grant !== undefined && ctx.grant.scope !== 'full' && !WORKER_SCOPE_TOOLS.has(tool)) {
      return errorResult(
        'FORBIDDEN_LEVEL',
        `действие «${declared.key}»: шаг «${tool}» недоступен скоупу worker (§4.14, §Б6-2)`,
        { action: declared.id, tool, reason: 'action_step_forbidden', scope: ctx.grant.scope },
      );
    }
  }

  const resolved = await withIdentity(ctx.db, ctx.identity, async (tx) =>
    resolveAction(
      tx,
      reg,
      ctx.identity.graph,
      parsed,
      await actionDateArgs(tx, ctx.identity.graph, ctx.clock),
    ),
  );
  const { decl, operations, targets } = resolved;
  if (operations.length === 0) {
    // Пакетному действию нечего делать (запрос не нашёл ни одной цели): исполнять пустую пачку
    // нечем — исполнитель отверг бы её «batch без операций», а журналировать нечего.
    return { status: 'ok', result: [] };
  }

  const facts = actionCallFacts(reg, decl, operations, targets, ctx);
  const level = classifyToolCall(facts);
  const gated = levelGate(level, `run_action:${decl.key}`);
  if (gated !== null) return gated;

  // Фону, которому некому ни показать, ни подтвердить в моменте, любой уровень выше `execute`
  // становится ОТЛОЖЕННОЙ ЕДИНИЦЕЙ D42 (§Б6-2): `preview` пакета здесь не исполняется — «покажи,
  // сделав» без владельца перед экраном было бы молчаливым исполнением. Карточку группы у
  // действия есть чем собрать (носитель — `batch_execute`, Р-8), поэтому довод инварианта 5
  // «одиночное — потому что группу нечем показать» к действию не относится.
  const defers = ctx.source === 'routine' && level !== 'execute';

  if (level === 'explicit-confirmation' || defers) {
    // Скрытый кап единицы (`batch_cap × шагов`, В-9): отказ ДО постановки и до пре-чека —
    // карточка, которую `approvePending` не разберёт никогда, не должна родиться ни в чате, ни в
    // пачке.
    const tooLong = unitCapExceeded(decl, operations.length);
    if (tooLong !== null) return tooLong;
  }

  if (defers) {
    // ОБЪЕКТНЫЙ ПРЕ-ЧЕК ПЕРЕД ОТЛОЖКОЙ (эррата Ф-Б2-18) — тот же рубеж и тот же отказ, что у
    // `runMutation`: запрещённое по объекту фон не откладывает никогда. Без него рутина клала бы в
    // пачку действие над назначенным тикетом, и «Принять» его провезло бы: стадия 4 исполнителя
    // ловит назначение только по `touched`, а правка `due_date` назначения не трогает. Пре-чек
    // смотрит на РЕЗОЛВЛЕННЫЕ операции и факты уровня — то, что действительно исполнится.
    //
    // Правки инструкции act-рутины (`instructionOf`) у действия не бывает по построению: цель-рутину
    // отвергает резолв (`ACTION_TARGET_FORBIDDEN`), а заводить рутины шагами запрещает
    // `assertAction` (Ф-Б2-18 (а)), — поэтому список пуст, а не «не посчитан».
    const forbidden = await routineDeferForbidden(ctx, operations, facts, []);
    if (forbidden !== null) {
      return errorResult('FORBIDDEN_LEVEL', forbidden, {
        tool: 'run_action',
        action: decl.id,
        level,
        reason: 'routine_untouchable',
      });
    }
    // Р-К-67: единицу кладёт `deferRoutineUnit` диспатча — тот же дом, что у правки графа и
    // реестра (проба по PK, кап пачки, тред рутины); здесь нет ни одной её строки.
    return await hooks.defer('run_action', parsed);
  }

  if (level === 'explicit-confirmation') {
    // Форма единицы — `batch_execute` с резолвленными операциями (Р-8): её исполняет
    // `approvePending` одним `execute`. Пара `action` (id, хеш декларации, цели, параметры) —
    // чтобы «Принять» поверх снятой или правленой декларации ответило «Устарело» (§Б6-7) и
    // перевычислило предусловие (эррата Ф-Б2-18), как у отложенной единицы.
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
        action: {
          id: decl.id,
          hash: resolved.hash,
          targets: resolved.targets,
          params: resolved.params,
        },
        // Строки «было → станет» — в карточку, как у отложенной (эррата Ф-Б2-18): владелец
        // подтверждает пакет, глядя на то, ЧТО изменится, а не на одну подпись. Карточку
        // собирает `createPending` — место сборки карточки-запроса одно.
        rows: resolved.rows,
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
