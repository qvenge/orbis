import type { QueuedCreate } from './index';

const STORAGE_KEY = 'orbis:retry-buffer:v1';

export interface QueueStorage {
  load(): QueuedCreate[];
  save(items: QueuedCreate[]): void;
}

export const localStorageQueue: QueueStorage = {
  load: () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'),
  save: (items) => localStorage.setItem(STORAGE_KEY, JSON.stringify(items)),
};
