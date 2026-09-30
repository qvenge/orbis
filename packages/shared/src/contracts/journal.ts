// packages/shared/src/contracts/journal.ts
// Сводка действия журнала в выдаче треда (спека скорости §11.3, §9): что сделано, кем, можно ли отменить. Операций,
// данных отмены, результатов пачки и аккаунта актора в ней нет — провод треда тел действия не несёт. Производитель —
// `apps/server/src/journal/thread-page.ts`, читатель — лента web (`features/chat/cards`). Только типы: web тянет
// отсюда форму, а не код.

/** Канал, которым пришла правка (`MutationSource` сервера) — на проводе тот же перечень. */
export type MutationSourceWire =
  | 'chat'
  | 'fast_path'
  | 'quick_capture'
  | 'mcp'
  | 'ui'
  | 'system'
  | 'routine';

/**
 * Элемент журнала в треде — `metadata.journal` строки `role: 'system'`. `actionId` — id ДЕЙСТВИЯ (по нему
 * `ai.undo`); id самой строки треда — свой, производный (рулинг R-12). `undoable` — показывать ли «Отменить»
 * (§11.3: правки агента вне прогона, быстрый ввод, рутина и пачки разговора — да; глаголы прогона агента — нет,
 * К-42); `undone` — действие уже отменено (у записи отмены своей строки нет, К-45).
 */
export interface JournalCardMeta {
  actionId: string;
  source: MutationSourceWire;
  actorKind: 'owner' | 'ai' | 'agent';
  runId?: string;
  title: string;
  tool: string;
  entityId: string | null;
  undoable: boolean;
  undone: boolean;
}
