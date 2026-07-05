// Мост между tRPC-линком (живёт вне React) и AuthProvider: линк эмитит,
// провайдер подписывается. Однослотовые слушатели — потребитель один (AuthProvider).
type Listener = () => void;
let outdated: Listener | null = null;
let unauthorized: Listener | null = null;

export function onClientOutdated(fn: Listener) {
  outdated = fn;
}
export function onUnauthorized(fn: Listener) {
  unauthorized = fn;
}
export function emitClientOutdated() {
  outdated?.();
}
export function emitUnauthorized() {
  unauthorized?.();
}
