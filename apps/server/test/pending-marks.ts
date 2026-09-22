// apps/server/test/pending-marks.ts
// ЕДИНСТВЕННЫЙ дом списка файлов, где пометка «ожидаемо падающий тест» законна (Р-К-9 Б-1, РП-7).
// Срез Б-2 держит помеченные тесты от вехи 0 до вехи III, и выключенный на это время сторож не
// заметил бы забытой пометки. Каждая закрывающая задача УБИРАЕТ свой файл тем же коммитом, которым
// зеленит тесты: 0e → + gate-b2 · 5 → − gate-b2 · 15 → − assign-level · 17 → − refusals.
// Пустой список = «в репозитории не осталось ни одной пометки», то есть утверждение Б-1.
export const PENDING_MARK_FILES: readonly string[] = [
  'apps/server/src/registry/refusals.test.ts',
  'apps/server/src/policy/assign-level.test.ts',
  'apps/server/test/gate-b2.test.ts', // гейт вехи I — снимает задача 5
];
