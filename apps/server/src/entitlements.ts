// apps/server/src/entitlements.ts
// Entitlements-резолвер (§8). План 'dev' (единственный в 1a/1b) — всё разрешено без
// лимитов. Субъект — параметром (D11: при введении workspace'ов субъектом станет
// workspace). Потребители: стадия 4 executor'а (гейт мутаций) и ai.sendMessage
// (гейт ai.requests_per_day/ai.tokens_per_day ДО вызова провайдера, Task 9).
// allowed: boolean (расширено Task 9) — инжектируемые резолверы тестов и будущие
// планы могут отказывать; limit: число — дневной лимит, сравнивается с ai_usage (§4.7).
export interface EntitlementDecision {
  allowed: boolean;
  limit: number | null; // null — не ограничено
}

/** Сигнатура резолвера — для инъекции (тесты Task 9, будущий конфиг планов §8). */
export type EntitlementResolver = (subjectUserId: string, key: string) => EntitlementDecision;

export const resolveEntitlement: EntitlementResolver = (_subjectUserId, _key) => {
  return { allowed: true, limit: null };
};
