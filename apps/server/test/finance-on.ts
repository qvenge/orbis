// apps/server/test/finance-on.ts
import type { GraphId } from '@orbis/shared';
import { setExtensionDisabled } from '../src/registry/extensions';
import { adminDb } from './helpers';

/**
 * Включить Финансы в графе теста — ЯВНО, словом сьюта (РП-36).
 *
 * Сьют проверяет Финансы — включены явно, РП-36. Заведение графа (`setupGraph`) заводит его так же,
 * как бой: Финансы выключены (спека 1б §8.6). Финансовый сьют, который молча получил бы включённые
 * Финансы от фикстуры, проверял бы не тот граф, что у владельца; поэтому включение — его собственная
 * строка сразу после сева, а ожидания сьюта остаются прежними.
 *
 * Под админом, мимо исполнителя и журнала: это подготовка фикстуры, а не действие владельца, и
 * «последним действием» для Undo сьюта она стать не должна.
 */
export async function enableFinanceForTest(graph: GraphId): Promise<void> {
  const { db, client } = adminDb();
  try {
    await db.transaction((tx) => setExtensionDisabled(tx, graph, 'finance', false));
  } finally {
    await client.end();
  }
}
