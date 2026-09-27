// APP_VERSION → CLIENT_VERSION_HEADER (§9.1). ДОЛЖЕН быть ≥ MIN_COMPATIBLE_CLIENT_VERSION ('0.4.0').
// 0.4.0 — срез страниц 1б меняет данные и рамку (узлы тела `ownCards`/`hostBlock`, навигация,
// адреса); клиент 0.3.x их не понимает и обязан получить «Обновить», а не писать вслепую (R-12).
export const APP_VERSION = '0.4.0';
