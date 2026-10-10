import type { RuleDefinition } from './rule-type';

/** Ambiguous or disabled declarations cannot identify a mirror for the UI. */
export function mirrorMetaKey(rules: readonly RuleDefinition[]): string | undefined {
  const mirrors = rules.filter((rule) => rule.enabled && rule.template === 'mirror_relation');
  const mirror = mirrors[0];
  return mirrors.length === 1 && mirror?.template === 'mirror_relation'
    ? mirror.params.meta_key
    : undefined;
}

export function mirrorPropertyId(
  rules: readonly RuleDefinition[],
  meta: Readonly<Record<string, unknown>>,
): string | undefined {
  const key = mirrorMetaKey(rules);
  const value = key === undefined ? undefined : meta[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
