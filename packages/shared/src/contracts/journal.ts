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

/** Ссылка ответа мутации на действие (§8.2): у продолжения правки текста actionId — id сеанса. */
export interface JournalRef {
  actionId: string;
  consequences: boolean;
}

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

/**
 * Ответ отмены (`ai.undo`, спека скорости §8.6, К-30): `actionId` — id ЗАПИСИ ОТМЕНЫ (заведён до применения, РП-11),
 * `undone` — что отменено (подпись — та же, что у «отмени последнее»: у сеанса правки текста — с отрезком),
 * `pinnedVersions` — версии, которыми отмена закрепила текущий текст первыми операциями той же записи отмены (страховка
 * сеанса «перед возвратом к ЧЧ:ММ», продолжение «перед отменой: …»); подтверждение называет их владельцу («ваш текст — в
 * версии …»). `bodyRevisions` — ревизия тела каждой записи, чей текст отмена писала, снятая в транзакции отмены:
 * интерфейс удерживает старый редактор до получения и показа тела с этой ревизией либо новее (R41). Одна ревизия
 * без соответствующего документа не разрешает набор поверх старого текста; сохранённая отмена при отказе чтения остаётся успешной.
 */
export interface UndoResult {
  actionId: string;
  undone: { id: string; title: string };
  pinnedVersions: Array<{ entityId: string; versionId: string; label: string }>;
  bodyRevisions: Array<{ entityId: string; bodyRevision: number }>;
}

/**
 * Действующее действие текущего тела записи (§8.2, §8.6, К-37): колонка «действие тела» с раскруткой через записи
 * отмены. `textSession` — сеанс правки текста; `mine` — действие этого же человека-владельца (пункт «Вернуть текст как
 * на …» показывается по своему сеансу); отрезок — начало (время записи журнала) и конец (время изменения тела, пока
 * колонка указывает на это действие; иначе конца не знает никто — `null`).
 */
export interface BodyActionInfo {
  actionId: string;
  textSession: boolean;
  mine: boolean;
  actorKind: 'owner' | 'ai' | 'agent';
  startedAt: string;
  endedAt: string | null;
}
