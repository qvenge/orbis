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
import { ExecError } from '../errors';
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

/**
 * ШАБЛОНЫ-НОСИТЕЛИ ПАРАМЕТРОВ ДВИЖКОВ и род строки, на которой движок ищет свою: по этой карте читает
 * `singleRuleOf` и по ней же сторожит запись `assertEngineCarriersKept` — два перечня разошлись бы на
 * первом новом движке.
 */
export const ENGINE_CARRIER_TEMPLATES = {
  nearest_ancestor: 'aspect',
  materialize: 'aspect',
  rollover: 'aspect',
  mirror_relation: 'role',
} as const satisfies Partial<Record<RuleTemplate, 'aspect' | 'role'>>;

/** Включённые строки шаблона на носителях его рода — ОДНА мерка у читателя и у сторожа записи. */
function enabledCarrierRows<T extends RuleTemplate>(
  reg: RegistrySnapshot,
  template: T,
  carrierKind: 'aspect' | 'role',
): Array<{ rule: Extract<RuleDefinition, { template: T }>; carrier: RuleCarrier }> {
  return rulesOf(reg).filter(
    (r): r is { rule: Extract<RuleDefinition, { template: T }>; carrier: RuleCarrier } =>
      r.rule.template === template && r.rule.enabled && r.carrier.kind === carrierKind,
  );
}

/**
 * СТОРОЖ ЗАПИСИ ПРАВИЛ ВЛАДЕЛЬЦА (эррата Ф-Б2-24): строка-носитель движка неотключаема и одна. Читатели
 * выше бросают `Error` СБОРКИ без включённой строки и на двух включённых (Р-И-17) — выключение роняет
 * целые пути (без `materialize` — каждый запрос через `queryWithMaterialization`, без `mirror_ref` —
 * каждую запись сущности), и отказ обязан прийти ЗАПИСИ, а не всем читателям после неё.
 *
 * Мерка — СДВИГ счёта, а не его значение: отказ получает запись, которая МЕНЯЕТ число включённых строк
 * шаблона и оставляет его не равным одному (1 → 0 — `RULE_CARRIER_REQUIRED`, 1 → 2 — `RULE_CARRIER_DUPLICATE`).
 * Запись, числа не меняющая, не отвечает за чужое состояние (порча базы руками уже роняет читателей), а
 * запись, возвращающая к одному, законна — это починка. Выключать строку уникальности конверта
 * (`duplicate_envelope`) законно: она не носитель движка (Ф-Б2-21 — идентичность конверта от `enabled` не
 * зависит), и в карте её нет.
 */
export function assertEngineCarriersKept(before: RegistrySnapshot, after: RegistrySnapshot): void {
  for (const [template, kind] of Object.entries(ENGINE_CARRIER_TEMPLATES) as Array<
    [RuleTemplate, 'aspect' | 'role']
  >) {
    const was = enabledCarrierRows(before, template, kind).length;
    const rows = enabledCarrierRows(after, template, kind);
    if (rows.length === was || rows.length === 1) continue;
    if (rows.length === 0) {
      throw new ExecError(
        'VALIDATION',
        `строку правила «${template}» выключить нельзя: это параметры движка, и без включённой строки ему нечем работать — параметры меняет только релиз`,
        { reason: 'RULE_CARRIER_REQUIRED', template },
      );
    }
    throw new ExecError(
      'VALIDATION',
      `вторая включённая строка правила «${template}» (${rows.map((r) => `${r.carrier.id}/${r.rule.id}`).join(', ')}): у движка может быть только один носитель параметров`,
      { reason: 'RULE_CARRIER_DUPLICATE', template, rules: rows.map((r) => r.rule.id) },
    );
  }
}

function singleRuleOf<T extends keyof typeof ENGINE_CARRIER_TEMPLATES>(
  reg: RegistrySnapshot,
  template: T,
): { rule: Extract<RuleDefinition, { template: T }>; carrierId: string } {
  const found = enabledCarrierRows(reg, template, ENGINE_CARRIER_TEMPLATES[template]);
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
  const { rule, carrierId } = singleRuleOf(reg, 'nearest_ancestor');
  return { rule, aspectId: carrierId };
}
export function materializeRuleOf(reg: RegistrySnapshot): CarrierRule<'materialize'> {
  const { rule, carrierId } = singleRuleOf(reg, 'materialize');
  return { rule, aspectId: carrierId };
}
/** Носитель — РОЛЬ `ref`: зеркало производно от роли ребра, а не от аспекта записи (§А6-2). */
export function mirrorRuleOf(reg: RegistrySnapshot): MirrorRule {
  return singleRuleOf(reg, 'mirror_relation').rule;
}
export function rolloverRuleOf(
  reg: RegistrySnapshot,
): Extract<RuleDefinition, { template: 'rollover' }> {
  return singleRuleOf(reg, 'rollover').rule;
}
