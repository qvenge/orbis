// Импорт ТОЛЬКО type, и это не стиль: модуль зовёт useBodySave, а его монтирует экран detail
// (Задача 15) — рантайм-импорт `@orbis/shared/doc` увёл бы схему документа в его чанк, мимо
// двухфазного монтирования. Стережёт save.test.tsx («страж чанка detail»).
import type { BodyDoc } from '@orbis/shared/doc';

/**
 * Неотправленный черновик тела — на диск браузера.
 *
 * Retry-буфер проекта (state/retry.ts) здесь не помощник: он принимает только `entity.create`
 * от fast-path, а у `update` есть `expectedUpdatedAt`, который протухает — правка, пролежавшая
 * час, приедет с 409, то есть отложенная отправка обещала бы то, чего не может выполнить.
 * Поэтому черновик не «очередь на отправку», а сохранённый текст с меткой той версии записи,
 * поверх которой он набран; решение о судьбе принимается при возврате (useBodySave).
 *
 * Это персистенция содержимого сущности на диск, и она принята владельцем ЯВНО как исключение:
 * случай отличается от истории чата (её в localStorage не держим) — здесь не архив, а
 * собственный неотправленный черновик, живущий до первого успеха. Для приложения-памяти потеря
 * набранного текста — тот же худший класс ошибки, ради которого заведены raw-нода и
 * key={entity.id}. Разрешение НЕ переносится ни на что другое.
 */
export type Draft = {
  doc: BodyDoc;
  /** `updatedAt` записи, ПОВЕРХ которого набрана правка (та же строка, что уехала в мутацию). */
  baseUpdatedAt: string;
  savedAt: string;
  /**
   * Сервер отверг ЭТОТ документ терминально (VALIDATION → BAD_REQUEST). Такой черновик не
   * досылается сам никогда: тот же документ будет отвергнут снова, и каждое открытие записи
   * стоило бы обречённого запроса, а заодно молча выключало бы ей сохранение до перезагрузки.
   * Но и стереть его нельзя — это набранный человеком текст; он предлагается выбором.
   */
  rejected: boolean;
};

/**
 * Код отказа, при котором черновик получает приговор (`rejected`).
 *
 * VALIDATION серверного гейта (§5.2, Задача 5) приезжает клиенту как BAD_REQUEST: документ
 * структурно битый или чужой версии схемы — тот же документ будет отвергнут снова, и повторять
 * бессмысленно. Прочие коды приговором НЕ считаются, хотя кандидат есть: NOT_FOUND (запись
 * удалили из другого места) тоже не вылечится повтором. Он не добавлен потому, что не проверен
 * тестом, а тихо расширять множество «больше не сохраняем» опаснее лишнего запроса.
 *
 * Живёт ЗДЕСЬ, а не в хуке сохранения: «какой отказ считается приговором» — свойство самого
 * черновика (см. `Draft.rejected`), и спрашивают об этом двое — хук сохранения и общая обвязка
 * мутации, которая ставит пометку тогда, когда хука уже нет (см. useEntityDetail).
 */
export const DRAFT_REJECTING_CODE = 'BAD_REQUEST';

// Ключ включает id: черновик одной записи не должен подставиться в другую.
const key = (entityId: string) => `orbis:body-draft:${entityId}`;

/**
 * Разбор чужой строки с диска. Проверка формы здесь НЕ перестраховка: `doc` отсюда уезжает
 * прямо в мутацию, а структурно битый документ серверный гейт отвергает ТЕРМИНАЛЬНО — то есть
 * одна испорченная запись в localStorage (чужая версия приложения, оборванная запись, ручная
 * правка в devtools) выключила бы записи сохранение до перезагрузки. Битую запись игнорируем:
 * она хуже отсутствия.
 */
function parseDraft(raw: string): Draft | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) return null;
  const { doc, baseUpdatedAt, savedAt, rejected } = value as Record<string, unknown>;
  if (typeof baseUpdatedAt !== 'string' || typeof savedAt !== 'string') return null;
  if (typeof doc !== 'object' || doc === null) return null;
  const { v, doc: inner } = doc as Record<string, unknown>;
  if (typeof v !== 'number' || typeof inner !== 'object' || inner === null) return null;
  // `rejected` приводится, а не проверяется: записи, сложенные до появления поля, читаются
  // как «не отвергнут» — это верно по смыслу и не повод выбрасывать текст.
  return { doc: doc as BodyDoc, baseUpdatedAt, savedAt, rejected: rejected === true };
}

export function saveDraft(
  entityId: string,
  doc: BodyDoc,
  baseUpdatedAt: string,
  now: string,
): void {
  try {
    const draft: Draft = { doc, baseUpdatedAt, savedAt: now, rejected: false };
    localStorage.setItem(key(entityId), JSON.stringify(draft));
  } catch {
    // Переполненное или отключённое хранилище (приватный режим, квота) не повод ронять набор
    // текста: черновик — страховка, а не главный путь. Молча остаёмся без страховки.
  }
}

export function readDraft(entityId: string): Draft | null {
  try {
    const raw = localStorage.getItem(key(entityId));
    return raw === null ? null : parseDraft(raw);
  } catch {
    return null; // и сам доступ к хранилищу может бросить — см. saveDraft
  }
}

/** Пометить черновик отвергнутым сервером (см. `Draft.rejected`). Нет черновика — нет и дела. */
export function markDraftRejected(entityId: string): void {
  const draft = readDraft(entityId);
  if (draft === null) return;
  // Ветки «уже помечен — не переписывать» здесь НЕТ намеренно: `readDraft` собирает поля в
  // одном и том же порядке, поэтому повторная запись легла бы байт в байт той же строкой.
  // Проверено мутацией (M32): такая ветка неотличима поведением, то есть непроверяема.
  try {
    localStorage.setItem(key(entityId), JSON.stringify({ ...draft, rejected: true }));
  } catch {
    /* см. saveDraft */
  }
}

export function clearDraft(entityId: string): void {
  try {
    localStorage.removeItem(key(entityId));
  } catch {
    /* см. saveDraft */
  }
}
