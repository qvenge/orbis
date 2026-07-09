import type { QueuedCreate } from './index';

const KEY_PREFIX = 'orbis:retry-buffer:v1';

export interface QueueStorage {
  load(): QueuedCreate[];
  save(items: QueuedCreate[]): void;
}

// Буфер скоупится по владельцу: до скоупа (нет сессии) — общий ключ, после логина —
// `<prefix>:<userId>`. Иначе на общем браузере следующий залогинившийся аккаунт
// дренировал бы чужие незасланные записи в свой workspace (§5.3 — буфер персональный).
let scope: string | null = null;

function keyFor(): string {
  return scope ? `${KEY_PREFIX}:${scope}` : KEY_PREFIX;
}

function readKey(key: string): QueuedCreate[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Порча ключа не должна ронять приложение: store создаётся на импорте модуля
    // (state/retry.ts), исключение здесь означало бы белый экран до ручной чистки
    // localStorage — и на каждой перезагрузке, потому что значение переживает reload.
    return Array.isArray(parsed) ? parsed.filter(isQueuedCreate) : [];
  } catch {
    return [];
  }
}

function isQueuedCreate(v: unknown): v is QueuedCreate {
  if (typeof v !== 'object' || v === null) return false;
  const q = v as Partial<QueuedCreate>;
  return (
    typeof q.clientId === 'string' && typeof q.tool === 'string' && typeof q.createdAt === 'string'
  );
}

/**
 * Привязать буфер к владельцу сессии (null — выход из аккаунта). Записи, накопленные
 * до первого скоупа (общий ключ), переносятся владельцу: это тот же браузер до логина,
 * терять офлайн-ввод нельзя. Дальше каждый аккаунт видит только свою очередь.
 */
export function setQueueScope(userId: string | null): void {
  scope = userId;
  if (!userId) return;
  const legacy = readKey(KEY_PREFIX);
  if (legacy.length === 0) return;
  const own = readKey(keyFor());
  localStorage.setItem(keyFor(), JSON.stringify([...own, ...legacy]));
  localStorage.removeItem(KEY_PREFIX);
}

export const localStorageQueue: QueueStorage = {
  load: () => readKey(keyFor()),
  // save намеренно не глушит исключения (quota/private mode): молча потерянная запись
  // хуже видимой ошибки — вызывающий (useFastPath) сообщает пользователю.
  save: (items) => localStorage.setItem(keyFor(), JSON.stringify(items)),
};
