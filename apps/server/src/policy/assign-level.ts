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
import { RULE_LEVEL_TO_CONFIRMATION, type RuleDefinition } from '@orbis/shared';
import type { ExprNode } from '@orbis/shared/expr';
import type { ActorKind, MutationSource } from '../executor/types';
import { type ExprEvalScope, evalExpr } from '../expr/eval';
import type { RegistrySnapshot } from '../registry/load';
import { rulesOf } from '../registry/rules';
import { ruleTouchesRecord } from '../rules/engine';
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
  /** Итоговый уровень: правила поверх таблицы, затем пол — В ОБЕИХ ветках (с правилами и без). */
  level: ConfirmationLevel;
  /**
   * Победившее правило (строжайшее из сработавших) — след §С2-1 «строка журнала несёт rule_id». При
   * `floored: true` его уровень перекрыт полом: итог дал не он, а пол, и след называет правило, которое
   * владелец увидит «проигнорированным с пометкой» (Р-27).
   */
  rule?: string;
  candidates: readonly { rule: string; level: ConfirmationLevel }[];
  /**
   * Пол поднял итог выше того, что дали бы правила, а без сработавших правил — таблица (Р-27:
   * «игнорирование с пометкой»; без правил на практике так срабатывает только запрет по объекту —
   * ряды 1/4/6 таблица держит не ниже пола сама).
   */
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
  // Касается ли правило записи — ТА ЖЕ мерка, что у движка правил записи (`ruleTouchesRecord`,
  // Р-И-13): область «роль»/«контракт» отказывает `RULE_SCOPE_UNSUPPORTED` ровно там, где касается
  // записи, и молчит там, где не касается (Р-25, Р-К-36).
  const record = { aspects: target.aspects ?? [], props: target.props };
  const candidates: { rule: string; level: ConfirmationLevel }[] = [];
  for (const { rule, carrier } of rulesOf(reg)) {
    if (rule.template !== 'assign_level' || !rule.enabled) continue;
    if (!actorMatches(rule, call)) continue;
    if (!ruleTouchesRecord(reg, rule, carrier, record)) continue;
    // `when` у `assign_level` обязателен (схема §Б4-1, refine), а `rulesOf` отдаёт только разобранные
    // схемой правила; отказ вычисления — структурный отказ вызова, а не «правило не сработало»:
    // невыразимое не бывает пустотой (§С8-3).
    if (evalExpr(rule.when as ExprNode, scope) !== true) continue;
    candidates.push({ rule: rule.id, level: RULE_LEVEL_TO_CONFIRMATION[rule.level] });
  }
  // Пол накладывается и БЕЗ сработавших правил (гейт задачи 15, m-4): запрет по объекту — не уровень
  // таблицы, а наложение (§Б4-5), и итог, который то несёт его (есть кандидат), то нет (кандидатов
  // ноль), означал бы разное в зависимости от числа правил. Ряды 1/4/6 таблица и так держит не ниже
  // пола, поэтому без правил пол меняет итог только запретом по объекту.
  const floor = floorLevel(call.facts, call.objectForbidden ?? false);
  const withFloor = (base: ConfirmationLevel): ConfirmationLevel =>
    floor === null ? base : stricter(base, floor);
  if (candidates.length === 0) {
    const level = withFloor(call.tableLevel);
    return { level, candidates: [], floored: level !== call.tableLevel };
  }
  // При нескольких сработавших побеждает более строгое (В-2д); порядок `rulesOf` детерминирован —
  // носители в порядке снимка (`load.ts`: `ORDER BY graph_id NULLS FIRST, id`), правила в порядке
  // строки, — поэтому «первое из равных» тоже воспроизводимо.
  const winner = candidates.reduce((a, b) => (stricter(a.level, b.level) === a.level ? a : b));
  const level = withFloor(winner.level);
  return { level, rule: winner.rule, candidates, floored: level !== winner.level };
}
