// apps/server/src/rules/carriers.ts
// Читатели строк-носителей параметров (§Б4-3, Р-14): движок остаётся кодом, параметры живут в
// реестре — ровно тем же способом, каким `role.constraints` уже питает ролевые ограничения.
//
// ОТСУТСТВИЕ ВКЛЮЧЁННОЙ СТРОКИ — `Error` СБОРКИ, а не умолчание (Р-И-17). Тот же жанр, что у
// словаря фактов чувствительности (`policy/sensitivity.ts`): молчаливое умолчание означало бы, что
// движок работает по числам, которых в реестре нет, и владелец, снявший строку, узнал бы об этом
// не отказом, а тем, что инстансы порождаются не на тот горизонт.
//
// Строка ищется по ШАБЛОНУ, а не «первое правило носителя»: на одном аспекте лежат строки разных
// шаблонов (`orbis/budget` несёт и `duplicate_envelope`, и `budget_rollover`), а два включённых
// носителя одного шаблона — отдельный отказ сборки ниже, не выбор «какой попался первым».
import type { RuleCarrier, RuleDefinition, RuleTemplate } from '@orbis/shared';
import type { RegistrySnapshot } from '../registry/load';
import { rulesOf } from '../registry/rules';

export interface CarrierRule<T extends RuleTemplate> {
  rule: Extract<RuleDefinition, { template: T }>;
  /** Носитель строки: он же область правила (у `mirror_relation` — роль, поэтому у него своё чтение). */
  aspectId: string;
}

/** Короткие имена форм — чтобы сигнатуры движков не таскали `Extract<…>` целиком. */
export type MaterializeRule = Extract<RuleDefinition, { template: 'materialize' }>;
export type MaterializeParams = MaterializeRule['params'];
export type MirrorRule = Extract<RuleDefinition, { template: 'mirror_relation' }>;

function singleRuleOf<T extends RuleTemplate>(
  reg: RegistrySnapshot,
  template: T,
  carrierKind: 'aspect' | 'role',
): { rule: Extract<RuleDefinition, { template: T }>; carrierId: string } {
  const found = rulesOf(reg).filter(
    (r): r is { rule: Extract<RuleDefinition, { template: T }>; carrier: RuleCarrier } =>
      r.rule.template === template && r.rule.enabled && r.carrier.kind === carrierKind,
  );
  const [hit, ...rest] = found;
  if (hit === undefined) {
    throw new Error(
      `в снимке реестра нет включённой строки правила «${template}»: сид не прогонялся (bun run db:prepare) либо строку выключили — движку нечем работать`,
    );
  }
  if (rest.length > 0) {
    // Два носителя одного шаблона — это два разных горизонта (или две пары целей) на один движок.
    // `RULE_CONFLICT` сюда не дотягивается: он про писателей свойств, а эти шаблоны свойств не пишут.
    throw new Error(
      `в снимке реестра ${found.length} включённых строк правила «${template}» (${found.map((f) => f.carrier.id).join(', ')}): у движка может быть только один носитель`,
    );
  }
  return { rule: hit.rule, carrierId: hit.carrier.id };
}

export function nearestAncestorRuleOf(reg: RegistrySnapshot): CarrierRule<'nearest_ancestor'> {
  const { rule, carrierId } = singleRuleOf(reg, 'nearest_ancestor', 'aspect');
  return { rule, aspectId: carrierId };
}
export function materializeRuleOf(reg: RegistrySnapshot): CarrierRule<'materialize'> {
  const { rule, carrierId } = singleRuleOf(reg, 'materialize', 'aspect');
  return { rule, aspectId: carrierId };
}
/** Носитель — РОЛЬ `ref`: зеркало производно от роли ребра, а не от аспекта записи (§А6-2). */
export function mirrorRuleOf(reg: RegistrySnapshot): MirrorRule {
  return singleRuleOf(reg, 'mirror_relation', 'role').rule;
}
export function rolloverRuleOf(
  reg: RegistrySnapshot,
): Extract<RuleDefinition, { template: 'rollover' }> {
  return singleRuleOf(reg, 'rollover', 'aspect').rule;
}
