// apps/server/src/policy/assign-level.ts
// ОЦЕНОЧНАЯ ОБЛАСТЬ ПРАВИЛ `assign_level` (§Б4-5, приёмка §С8-26). ЭТО НЕ ЖИВОЙ КОНВЕЙЕР: §Б4-3 и
// §С2-1 относят «правила данными» к V2, а Б-2 обязан доказать выразимость — одиннадцать правил дня
// мечты проходят валидатор и дают ожидаемые уровни. Поэтому `classifyToolCall` эту функцию не
// зовёт, и ни одна строка `tools/dispatch.ts` не меняется (сторож — `assign-level.test.ts`).
//
// ОБЛАСТЬ ЦЕЛИ ПРИЕЗЖАЕТ ГОТОВОЙ (`ExprEvalScope`, сборщик — `rules/scope.ts`): интерпретатор
// СИНХРОНЕН, значит рёбра, опубликованные величины соседей и читатель `deref` собраны до вызова
// (Р-4). Факты ВЫЗОВА функция вписывает в область сама: «что за запись» знает цель, «что за вызов»
// — `call`, и два источника одного `$sensitivity` разошлись бы на первом же вызывающем.
import { RULE_LEVEL_TO_CONFIRMATION, type RuleDefinition, type RuleScope } from '@orbis/shared';
import type { ExprNode } from '@orbis/shared/expr';
import { ExecError } from '../errors';
import { carrierAspects } from '../executor/props';
import type { ActorKind, MutationSource } from '../executor/types';
import { type ExprEvalScope, evalExpr } from '../expr/eval';
import type { RegistrySnapshot } from '../registry/load';
import { effectiveRuleScope, rulesOf } from '../registry/rules';
import type { ConfirmationLevel, ToolCallFacts } from './confirmation';
import { floorLevel, stricter } from './floor';

export interface AssignLevelCall {
  actorKind: ActorKind;
  source: MutationSource;
  routineId?: string;
  /** Факты вызова — уже с именами словаря (`sensitivityFactsOf`). */
  facts: ToolCallFacts;
  /** Е-5: id свойств, которые вызов трогает (ключи патча). */
  touched: readonly string[];
  /** `classifyToolCall(facts)` — считает вызывающий: классификатор остаётся чистым. */
  tableLevel: ConfirmationLevel;
  /** Пре-чек фона «запрет по объекту» — готовым ответом (см. `floorLevel`). */
  objectForbidden?: boolean;
}

export interface AssignLevelVerdict {
  level: ConfirmationLevel;
  /** Правило, давшее итоговый уровень, — след §С2-1 «строка журнала несёт rule_id». */
  rule?: string;
  candidates: readonly { rule: string; level: ConfirmationLevel }[];
  /** Итог поднят полом выше уровня победившего правила (Р-27: «игнорирование с пометкой»). */
  floored: boolean;
}

type AssignLevelRule = Extract<RuleDefinition, { template: 'assign_level' }>;

/** Отбор по актору (Р-И-30): `'routine'` — «любая рутина» (правило 11, В-3). */
function actorMatches(rule: AssignLevelRule, call: AssignLevelCall): boolean {
  const actor = rule.actor;
  if (actor === undefined) return true;
  if (actor === 'owner') return call.actorKind === 'owner';
  if (actor === 'ai') return call.actorKind === 'ai';
  if (actor === 'routine') return call.source === 'routine';
  return call.source === 'routine' && call.routineId === actor.routine;
}

/**
 * Применимо ли правило к ЭТОЙ записи (Р-И-13). Область-свойство — та же мерка, что у движка правил
 * записи (`applicableRules`): свойство есть на записи либо его несёт её аспект, носители — общей
 * `carrierAspects`. Область «роль»/«контракт» — правило о ребре и о классе без записи-цели: в Б-2
 * не исполняется (Р-25, Р-К-36), и молчать об этом нельзя — включённое правило, которое никогда не
 * сработает, хуже отказа (fail-closed, §С8-3).
 */
function applies(
  reg: RegistrySnapshot,
  scope: RuleScope,
  target: ExprEvalScope,
  ruleId: string,
): boolean {
  const aspects = target.aspects ?? [];
  if ('aspect' in scope) return aspects.includes(scope.aspect);
  if ('property' in scope) {
    if (Object.hasOwn(target.props, scope.property)) return true;
    return carrierAspects(reg, scope.property).some((id) => aspects.includes(id));
  }
  throw new ExecError(
    'VALIDATION',
    `область правила «${'role' in scope ? scope.role : scope.contract}» в Б-2 не исполняется (§Б4-5, Р-25)`,
    { reason: 'RULE_SCOPE_UNSUPPORTED', rule: ruleId },
  );
}

export function assignLevelOf(
  reg: RegistrySnapshot,
  target: ExprEvalScope,
  call: AssignLevelCall,
): AssignLevelVerdict {
  // Факты вызова — поверх области цели: см. докблок файла.
  const scope: ExprEvalScope = {
    ...target,
    sensitivity: call.facts.sensitivity,
    touched: call.touched,
  };
  const candidates: { rule: string; level: ConfirmationLevel }[] = [];
  for (const { rule, carrier } of rulesOf(reg)) {
    if (rule.template !== 'assign_level' || !rule.enabled) continue;
    if (!actorMatches(rule, call)) continue;
    if (!applies(reg, effectiveRuleScope(rule, carrier), scope, rule.id)) continue;
    // `when` у `assign_level` обязателен (схема §Б4-1, refine), а `rulesOf` отдаёт только разобранные
    // схемой правила; отказ вычисления — структурный отказ вызова, а не «правило не сработало»:
    // невыразимое не бывает пустотой (§С8-3).
    if (evalExpr(rule.when as ExprNode, scope) !== true) continue;
    candidates.push({ rule: rule.id, level: RULE_LEVEL_TO_CONFIRMATION[rule.level] });
  }
  if (candidates.length === 0) return { level: call.tableLevel, candidates: [], floored: false };
  // При нескольких сработавших побеждает более строгое (В-2д); порядок `rulesOf` детерминирован —
  // носители в порядке снимка (`load.ts`: `ORDER BY graph_id NULLS FIRST, id`), правила в порядке
  // строки, — поэтому «первое из равных» тоже воспроизводимо.
  const winner = candidates.reduce((a, b) => (stricter(a.level, b.level) === a.level ? a : b));
  const floor = floorLevel(call.facts, call.objectForbidden ?? false);
  const level = floor === null ? winner.level : stricter(winner.level, floor);
  return { level, rule: winner.rule, candidates, floored: level !== winner.level };
}
