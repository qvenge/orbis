import Dexie, { type EntityTable } from 'dexie';

export interface CachedEntity {
  id: string;
  data: Record<string, unknown>;
  updatedAt: string;
}

export interface PendingMutation {
  id: string;
  type: 'create' | 'update' | 'delete';
  payload: Record<string, unknown>;
  createdAt: string;
}

class OrbisOfflineDB extends Dexie {
  entities!: EntityTable<CachedEntity, 'id'>;
  pendingMutations!: EntityTable<PendingMutation, 'id'>;

  constructor() {
    super('orbis-offline');
    this.version(1).stores({
      entities: 'id, updatedAt',
      pendingMutations: 'id, createdAt',
    });
  }
}

export const offlineDb = new OrbisOfflineDB();

// Helper methods
export async function cacheEntities(entities: Array<{ id: string; updatedAt: unknown } & Record<string, unknown>>) {
  await offlineDb.entities.bulkPut(
    entities.map((e) => ({
      id: e.id,
      data: e as Record<string, unknown>,
      updatedAt: String(e.updatedAt),
    })),
  );
}

export async function getCachedEntities(): Promise<CachedEntity[]> {
  return offlineDb.entities.toArray();
}

export async function queueMutation(type: PendingMutation['type'], payload: Record<string, unknown>) {
  await offlineDb.pendingMutations.add({
    id: crypto.randomUUID(),
    type,
    payload,
    createdAt: new Date().toISOString(),
  });
}

export async function getPendingMutations(): Promise<PendingMutation[]> {
  return offlineDb.pendingMutations.orderBy('createdAt').toArray();
}

export async function clearPendingMutations(ids: string[]) {
  await offlineDb.pendingMutations.bulkDelete(ids);
}

export async function getPendingCount(): Promise<number> {
  return offlineDb.pendingMutations.count();
}
