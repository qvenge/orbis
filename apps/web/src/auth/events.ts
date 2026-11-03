// Мост между tRPC-линком (живёт вне React) и AuthProvider: линк эмитит,
// провайдер подписывается. Однослотовые слушатели — потребитель один (AuthProvider).
type Listener = () => void;
let outdated: Listener | null = null;
let unauthorized: Listener | null = null;

export function onClientOutdated(fn: Listener) {
  outdated = fn;
  return () => {
    if (outdated === fn) outdated = null;
  };
}
export function onUnauthorized(fn: Listener) {
  unauthorized = fn;
  return () => {
    if (unauthorized === fn) unauthorized = null;
  };
}
export function emitClientOutdated() {
  outdated?.();
}
export function emitUnauthorized() {
  unauthorized?.();
}
