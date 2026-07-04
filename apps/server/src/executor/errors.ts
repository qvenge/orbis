// apps/server/src/executor/errors.ts
// Реэкспорт для совместимости импортов executor-модулей: сам класс поднят в src/errors.ts
// (минорный долг Task 11 — chat/threads.ts не должен зависеть от executor/).
export { ExecError, type ExecErrorCode } from '../errors';
