// apps/server/src/entitlements.ts
// Entitlements-резолвер (§8). План 'dev' (единственный в 1a) — всё разрешено без лимитов.
// Субъект — параметром (D11: при введении workspace'ов субъектом станет workspace).
// Вызывается стадией 4 executor'а — сейчас no-op гейт, точка врезки для 1b
// (лимиты entities.max, agents.requests_per_day и др.).
export interface EntitlementDecision {
  allowed: true;
  limit: number | null;
}

export function resolveEntitlement(_subjectUserId: string, _key: string): EntitlementDecision {
  return { allowed: true, limit: null };
}
