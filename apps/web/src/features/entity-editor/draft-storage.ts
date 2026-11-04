// Импорт ТОЛЬКО type, и это не стиль: модуль зовёт useBodySave, а его монтирует экран detail
// (Задача 15) — рантайм-импорт `@orbis/shared/doc` увёл бы схему документа в его чанк, мимо
// двухфазного монтирования. Стережёт save.test.tsx («страж чанка detail»).

import { newId } from '@orbis/shared';
import type { BodyDoc } from '@orbis/shared/doc';
import {
  captureInputAccess,
  type InputAccess,
  type InputStorage,
  removeStorageKeys,
} from '../../lib/local-data/input-access';
import { validInputToken } from '../../lib/local-data/input-slot';
import {
  type InputDraftSnapshot,
  type InputDraftToken,
  sameInputToken,
} from '../../lib/local-data/input-store';
import { createDraftMirror, type DraftSource } from './draft-mirror';

/**
 * Неотправленный черновик тела — на диск браузера.
 *
 * Retry-буфер проекта (state/retry.ts) здесь не помощник: он принимает только `entity.create`
 * от fast-path, а у правки тела есть замок — ревизия тела (`expectedBodyRevision`, спека скорости
 * §8.1), который протухает: правка, пролежавшая час, приедет с 409, то есть отложенная отправка
 * обещала бы то, чего не может выполнить. Поэтому черновик не «очередь на отправку», а сохранённый
 * текст с ревизией тела, поверх которой он набран; решение о судьбе принимается при возврате
 * (useBodySave).
 *
 * Это персистенция содержимого сущности на диск, и она принята владельцем ЯВНО как исключение:
 * случай отличается от истории чата (её в localStorage не держим) — здесь не архив, а
 * собственный неотправленный черновик, живущий до первого успеха. Для приложения-памяти потеря
 * набранного текста — тот же худший класс ошибки, ради которого заведены raw-нода и
 * key={entity.id}. Разрешение НЕ переносится ни на что другое.
 */
export type Draft = {
  doc: BodyDoc;
  /** Unique local write identity; legacy slots did not have one. */
  slot?: string;
  recovery?: true;
  inputToken?: InputDraftToken;
  inputRecovery?: true;
  acknowledged?: true;
  /** Ревизия тела, ПОВЕРХ которой набрана правка (та же, что уехала в мутацию `expectedBodyRevision`). */
  baseRevision?: number;
  /**
   * Черновик СТАРОЙ формы (клиент до плана А скорости) несёт вместо ревизии штамп `updatedAt` записи. Новый клиент
   * такие черновики только читает — пишет он всегда ревизию — и решает их судьбу правилом К-26 (useBodySave): совпал
   * штамп с записью — основа черновика = текущая ревизия; не совпал — конфликт, выбор человеку. Ровно одно из двух
   * полей есть у каждого черновика: без основы сверять не с чем (см. `parseDraft`).
   */
  baseUpdatedAt?: string;
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
 * VALIDATION серверного гейта (Задача 5) приезжает клиенту как BAD_REQUEST: документ
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

const KEY_PREFIX = 'orbis:body-draft';
const CHECKPOINT_SLOT = 'head';
const ACKNOWLEDGED_SLOT = 'ack-head';
const FINISHED_PREFIX = 'orbis:body-draft-finished:';

/**
 * Сколько живёт неотправленный черновик.
 *
 * Срок нужен затем же, зачем он нужен любому хранилищу на диске браузера: без него черновик,
 * который человек не забрал и не выбросил, лежит там ВЕЧНО — текст заметки в общем браузере,
 * переживающий и выход из аккаунта, и переустановку приложения. Тридцать дней — заведомо больше
 * любого «вернусь к этой записи на неделе» и заведомо меньше «навсегда».
 *
 * Просроченное не читается и сносится с диска (см. `readDraft` и `sweepDrafts`).
 */
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Аккаунт, которому принадлежат черновики этой сессии.
 *
 * Скоуп — тот же приём и по той же причине, что у retry-буфера (`lib/retry-buffer/storage.ts`):
 * браузер бывает общим, и следующий залогинившийся аккаунт не должен видеть неотправленные
 * заметки предыдущего. Пустая строка — «аккаунт ещё не известен»; ветки на это нет намеренно,
 * она просто даёт свой, отдельный от всех аккаунтов ключ.
 *
 * Скоуп ставит `AuthProvider` из сессии (`session.userId`), рядом с `setRetryScope`. Из записи
 * (`entity.graphId`) его брать нельзя: ключ записи — ГРАФ, а черновик принадлежит человеку за
 * этим браузером; в личном графе значения совпадают, в графе компании — нет (D44). Модуль
 * остаётся ЛИСТОВЫМ: значение по-прежнему приходит параметром, рантайм-зависимостей нет.
 */
let scope = '';

export function setDraftScope(accountId: string): void {
  scope = accountId;
}

// Ключ включает аккаунт и id записи: черновик одной записи не должен подставиться в другую,
// а черновик одного аккаунта — в чужую сессию.
const key = (entityId: string) => `${KEY_PREFIX}:${scope}:${entityId}`;

/** Просрочен ли черновик. Неразобранная метка времени просроченной НЕ считается: судить не по
 *  чему, а выбрасывать текст по своей же неспособности прочитать дату — худший из исходов. */
function expired(savedAt: string, now: number): boolean {
  const at = Date.parse(savedAt);
  return !Number.isNaN(at) && now - at > DRAFT_TTL_MS;
}

/**
 * Уборка: сносит просроченные черновики и ключи ПРЕЖНЕГО вида (без аккаунта).
 *
 * Зовётся при открытии записи (`useBodySave`), а не по таймеру и не на импорте: обход хранилища
 * стоит доли миллисекунды, а открытие записи и так стоит круга сети. Зато срок жизни при этом
 * относится ко ВСЕМ черновикам, а не только к тому, который сейчас читают, — иначе черновик
 * записи, которую больше никогда не откроют, не истёк бы никогда.
 *
 * Ключи прежнего вида (`orbis:body-draft:<id>`, без аккаунта) сносятся безусловно: прочитать их
 * больше некому, и оставленные они пролежали бы вечно — ровно та беда, против которой заведён
 * срок жизни. Чужие ключи хранилища не трогаются вовсе.
 */
export function sweepDrafts(access = captureInputAccess()): void {
  if (!access?.isCurrent()) return;
  const { storage, prefix } = access;
  try {
    const now = Date.now();
    const doomed = new Map<string, string>();
    for (const k of storage.keys()) {
      if (!k.startsWith(prefix)) continue;
      const localKey = k.slice(prefix.length);
      if (localKey.startsWith(FINISHED_PREFIX)) {
        const raw = storage.getItem(k);
        if (raw !== null && now - Number(raw) > DRAFT_TTL_MS) doomed.set(k, raw);
        continue;
      }
      if (!localKey.startsWith(`${KEY_PREFIX}:`)) continue;
      const rest = localKey.slice(KEY_PREFIX.length + 1);
      const raw = storage.getItem(k);
      if (raw === null) continue;
      // Old unscoped keys and exact retired copies can free room before a quota retry.
      const [owner, entityId] = rest.split(':');
      if (!rest.includes(':')) {
        doomed.set(k, raw);
        continue;
      }
      try {
        const draft = parseDraft(raw);
        if (
          draft === null ||
          expired(draft.savedAt, now) ||
          (draft.slot &&
            owner !== undefined &&
            entityId !== undefined &&
            isDraftSlotFinishedIn(storage, owner, entityId, draft.slot, prefix))
        )
          doomed.set(k, raw);
      } catch {
        // A malformed key does not prevent cleaning the remaining independently scoped copies.
      }
    }
    for (const [key, raw] of doomed) {
      if (access.isCurrent() && storage.getItem(key) === raw) storage.removeItem(key);
    }
  } catch {
    // Отключённое хранилище — не повод ронять открытие записи (см. saveDraft).
  }
}

/**
 * Запись с одной попыткой уборки. Переполнение — самый вероятный отказ записи, и молчаливо
 * сдаваться на нём не за что: место чаще всего занято просроченными черновиками соседних
 * записей, и уборка его освобождает. Вторая неудача уже принимается молча — страховка не
 * главный путь, а сама правка в это время уезжает на сервер и о своей судьбе честно
 * докладывает индикатором.
 */
function writeKey(
  k: string,
  value: string,
  access: InputAccess | null = captureInputAccess(),
): boolean {
  if (!access?.isCurrent()) return false;
  const { storage, prefix } = access;
  try {
    storage.setItem(prefix + k, value);
    return true;
  } catch {
    sweepDrafts(access);
    try {
      if (!access.isCurrent()) return false;
      storage.setItem(prefix + k, value);
      return true;
    } catch {
      return false;
    }
  }
}

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
  const {
    doc,
    baseRevision,
    baseUpdatedAt,
    savedAt,
    rejected,
    slot,
    recovery,
    inputToken,
    inputRecovery,
    acknowledged,
  } = value as Record<string, unknown>;
  if (typeof savedAt !== 'string') return null;
  // Основа — ревизия (новая форма) или штамп записи (старая форма, К-26); без основы черновик сверять не с чем, и он
  // ушёл бы в предложение про запись, которой никто не менял. Ноль — законная основа: так пишется черновик записи, чья
  // ревизия экрану неизвестна (`shownBodyRevision`), и выбросить его значило бы потерять набранный текст.
  const revision =
    typeof baseRevision === 'number' && Number.isInteger(baseRevision) && baseRevision >= 0
      ? baseRevision
      : undefined;
  const stamp = typeof baseUpdatedAt === 'string' ? baseUpdatedAt : undefined;
  if (revision === undefined && stamp === undefined) return null;
  if (typeof doc !== 'object' || doc === null) return null;
  const { v, doc: inner } = doc as Record<string, unknown>;
  if (typeof v !== 'number' || typeof inner !== 'object' || inner === null) return null;
  // `rejected` приводится, а не проверяется: записи, сложенные до появления поля, читаются
  // как «не отвергнут» — это верно по смыслу и не повод выбрасывать текст.
  return {
    doc: doc as BodyDoc,
    ...(revision !== undefined ? { baseRevision: revision } : { baseUpdatedAt: stamp }),
    savedAt,
    ...(typeof slot === 'string' && { slot }),
    ...(recovery === true && { recovery }),
    ...(validInputToken(inputToken) && { inputToken }),
    ...(inputRecovery === true && { inputRecovery }),
    ...(acknowledged === true && { acknowledged }),
    rejected: rejected === true,
  };
}

const draftSessions = new WeakMap<
  NonNullable<InputAccess['drafts']>,
  ReturnType<typeof createDraftMirror>
>();

export function draftFromInput(snapshot: InputDraftSnapshot): Draft {
  const { token, recovery, ...value } = snapshot;
  return {
    ...value,
    ...(recovery && { recovery }),
    ...('revision' in token.basis
      ? { baseRevision: token.basis.revision }
      : { baseUpdatedAt: token.basis.updatedAt }),
    slot: token.nonce,
    inputToken: token,
  };
}

function sameWriter(a: InputDraftToken, b: InputDraftToken): boolean {
  return (
    a.accountId === b.accountId &&
    a.graphId === b.graphId &&
    a.generation === b.generation &&
    a.entityId === b.entityId &&
    a.writerId === b.writerId
  );
}

function checkpointKey(token: InputDraftToken, acknowledged = false): string {
  const slot = acknowledged ? ACKNOWLEDGED_SLOT : CHECKPOINT_SLOT;
  return `${KEY_PREFIX}:${token.accountId}:${token.entityId}:${encodeURIComponent(token.writerId)}:${slot}`;
}

function inputSession(access = captureInputAccess()) {
  const metadata = access?.drafts;
  if (!access || !metadata || metadata.scope.accountId !== scope || metadata.signal.aborted)
    return undefined;
  let session = draftSessions.get(metadata);
  if (session) return session;
  const { storage, prefix } = access;
  const { accountId, graphId, generation } = metadata.scope;
  const start = `${prefix}${KEY_PREFIX}:${accountId}:`;
  function sources(targetEntity?: string): DraftSource[] {
    const sources: DraftSource[] = [];
    try {
      for (const key of storage.keys()) {
        if (!key.startsWith(start)) continue;
        const [entityId, writerOrSlot, slotPart, extra] = key.slice(start.length).split(':');
        if (!entityId || extra !== undefined || (targetEntity && entityId !== targetEntity))
          continue;
        const acknowledgedHead = slotPart === ACKNOWLEDGED_SLOT;
        const writerHead = slotPart === CHECKPOINT_SLOT || acknowledgedHead;
        const keySlot = writerHead ? undefined : (slotPart ?? writerOrSlot);
        const raw = storage.getItem(key);
        if (raw === null) continue;
        let draft: Draft | null;
        try {
          draft = parseDraft(raw);
        } catch {
          continue;
        }
        if (
          !draft ||
          (writerHead && !draft.inputToken) ||
          (acknowledgedHead && !draft.acknowledged) ||
          (keySlot && draft.slot !== keySlot)
        )
          continue;
        if (expired(draft.savedAt, Date.now())) {
          if (access?.isCurrent() && storage.getItem(key) === raw) storage.removeItem(key);
          continue;
        }
        if (draft.slot && isDraftSlotFinishedIn(storage, accountId, entityId, draft.slot, prefix))
          continue;
        const token = draft.inputToken;
        if (
          token &&
          (token.accountId !== accountId ||
            token.graphId !== graphId ||
            token.generation !== generation ||
            token.entityId !== entityId ||
            token.nonce !== draft.slot ||
            (slotPart !== undefined &&
              (writerHead ? encodeURIComponent(token.writerId) : token.writerId) !== writerOrSlot))
        )
          continue;
        const { doc, rejected, savedAt, acknowledged } = draft;
        const recovery = token && slotPart ? draft.inputRecovery : draft.recovery;
        const basis =
          draft.baseRevision !== undefined
            ? { revision: draft.baseRevision }
            : draft.baseUpdatedAt !== undefined
              ? { updatedAt: draft.baseUpdatedAt }
              : undefined;
        if (
          !basis ||
          (token &&
            ('revision' in token.basis
              ? basis.revision !== token.basis.revision
              : basis.updatedAt !== token.basis.updatedAt))
        )
          continue;
        sources.push({
          entityId,
          slot: draft.slot,
          token,
          basis,
          raw,
          snapshot: {
            doc,
            rejected,
            savedAt,
            ...(acknowledged && { acknowledged }),
            ...(recovery && { recovery }),
          },
          stillCurrent() {
            try {
              return access?.isCurrent() === true && storage.getItem(key) === raw;
            } catch {
              return false;
            }
          },
          remove(slot) {
            try {
              if (
                access?.isCurrent() &&
                !isDraftSlotFinishedIn(storage, accountId, entityId, slot, prefix) &&
                storage.getItem(key) === raw
              )
                storage.removeItem(key);
            } catch {
              // A retained source is harmless once the exact native copy is committed.
            }
          },
        });
      }
    } catch {
      // Storage may be disabled independently of IndexedDB.
    }
    return sources.sort(
      (a, b) => Number(!!b.snapshot.acknowledged) - Number(!!a.snapshot.acknowledged),
    );
  }
  session = createDraftMirror(
    { ...access, drafts: metadata },
    sources,
    (snapshot, preserve) => {
      const { token } = snapshot;
      const target = checkpointKey(token, snapshot.acknowledged);
      const headKey = prefix + checkpointKey(token);
      const current = preserve ? (access.canPreserve ?? access.isCurrent) : access.isCurrent;
      const scoped = { ...access, isCurrent: current };
      try {
        if (
          !current() ||
          isDraftSlotFinishedIn(storage, accountId, token.entityId, token.nonce, prefix)
        )
          return false;
        const raw = storage.getItem(prefix + target);
        if (raw !== null) {
          const prior = parseDraft(raw);
          const previous = prior?.inputToken;
          if (
            !previous ||
            !sameWriter(previous, token) ||
            previous.sequence > token.sequence ||
            (previous.sequence === token.sequence && !sameInputToken(previous, token))
          )
            return false;
          // Older clients recorded ACK in the pending head. Preserve that exact
          // copy before replacing it. A failed backup leaves the head in place.
          if (
            !snapshot.acknowledged &&
            prior.acknowledged &&
            !sameInputToken(previous, token) &&
            !expired(prior.savedAt, Date.now()) &&
            !isDraftSlotFinishedIn(storage, accountId, previous.entityId, previous.nonce, prefix)
          ) {
            const backup = checkpointKey(previous, true);
            const existingRaw = storage.getItem(prefix + backup);
            const existing = existingRaw === null ? null : parseDraft(existingRaw);
            const retained = existing?.inputToken;
            if (
              existingRaw !== null &&
              (!retained ||
                !existing.acknowledged ||
                !sameWriter(retained, previous) ||
                (retained.sequence === previous.sequence && !sameInputToken(retained, previous)))
            )
              return false;
            if (
              (!retained ||
                !existing ||
                retained.sequence < previous.sequence ||
                expired(existing.savedAt, Date.now()) ||
                isDraftSlotFinishedIn(
                  storage,
                  accountId,
                  retained.entityId,
                  retained.nonce,
                  prefix,
                )) &&
              !writeKey(backup, raw, scoped)
            )
              return false;
            if (storage.getItem(headKey) !== raw) return false;
          }
        }
      } catch {
        return false;
      }
      // Web Storage replaces the same key atomically. Quota failure leaves its prior text intact.
      // An ACK writes its own key without deleting the pending head, which another tab may replace.
      return writeKey(
        target,
        JSON.stringify({
          ...draftFromInput(snapshot),
          recovery: true,
          ...(snapshot.recovery && { inputRecovery: true }),
        }),
        scoped,
      );
    },
    (entityId, slot) => markLegacyFinished(accountId, entityId, slot, access),
    (entityId, slot) => {
      try {
        return isDraftSlotFinishedIn(storage, accountId, entityId, slot, prefix);
      } catch {
        return false;
      }
    },
    (token) => {
      try {
        const raw = storage.getItem(prefix + checkpointKey(token));
        const draft = raw === null ? null : parseDraft(raw);
        const head = draft?.inputToken;
        // A physical head can remain after its exact cancellation. Only a recoverable
        // successor is evidence that an older input snapshot has been superseded.
        return (
          !!draft &&
          !!head &&
          sameWriter(head, token) &&
          head.sequence > token.sequence &&
          draft.slot === head.nonce &&
          !expired(draft.savedAt, Date.now()) &&
          !isDraftSlotFinishedIn(storage, accountId, head.entityId, head.nonce, prefix)
        );
      } catch {
        return false;
      }
    },
  );
  draftSessions.set(metadata, session);
  return session;
}

export function hydrateDrafts(entityId?: string): Promise<void> | undefined {
  return inputSession()?.hydrate(entityId);
}

export function managedDraftIsRetired(entityId: string, slot: string): boolean {
  return inputSession()?.isRetired(entityId, slot) ?? false;
}

export function managedDraftIsLive(draft: Draft): boolean {
  return draft.inputToken !== undefined && inputSession()?.isLive(draft.inputToken) === true;
}

export function readManagedDrafts(entityId: string): Draft[] | undefined {
  return inputSession()?.read(entityId).map(draftFromInput);
}

export async function discardDraftSlot(entityId: string, slot: string): Promise<boolean> {
  const managed = inputSession();
  return managed ? managed.finish(entityId, slot) : finishCurrentDraftSlot(entityId, slot);
}

export function markManagedDraftOutcome(
  entityId: string,
  slot: string,
  outcome: 'rejected' | 'acknowledged',
): boolean {
  const session = inputSession();
  if (!session?.find(entityId, slot)) return false;
  session.outcome(entityId, slot, outcome);
  return true;
}

/** Захваченный ключ сохраняет последние слова прежнему владельцу без записи в новый scope. */
export function captureDraftWriter(entityId: string) {
  const capturedKey = key(entityId);
  let writer: string | undefined;
  const access = captureInputAccess();
  const managed = inputSession(access)?.writer(entityId);
  const payload = (doc: BodyDoc, baseRevision: number, now: string, rejected: boolean) =>
    JSON.stringify({ doc, baseRevision, savedAt: now, rejected, slot: newId() } satisfies Draft);
  const write = (doc: BodyDoc, baseRevision: number, now: string, rejected = false): boolean =>
    writeKey(capturedKey, payload(doc, baseRevision, now, rejected), access);
  return Object.assign(write, {
    managed,
    preserve(doc: BodyDoc, baseRevision: number, now: string, rejected: boolean) {
      const slot = newId();
      writer ??= newId();
      const target = `${capturedKey}:${writer}:${slot}`;
      const bytes = JSON.stringify({
        doc,
        baseRevision,
        savedAt: now,
        rejected,
        slot,
        recovery: true,
      } satisfies Draft);
      if (writeKey(target, bytes, access)) return undefined;
      // The retry owns only these exact bytes. It cannot read a later editor or target a new owner.
      return () =>
        !!access &&
        writeKey(target, bytes, {
          ...access,
          isCurrent: access.canPreserve ?? access.isCurrent,
        });
    },
  });
}

export function saveDraft(
  entityId: string,
  doc: BodyDoc,
  baseRevision: number,
  now: string,
): string {
  const slot = newId();
  const draft: Draft = { doc, baseRevision, savedAt: now, rejected: false, slot };
  // Переполненное или отключённое хранилище (приватный режим, квота) не повод ронять набор
  // текста: черновик — страховка, а не главный путь. Одну попытку прибраться `writeKey` делает,
  // дальше молча остаёмся без страховки.
  writeKey(key(entityId), JSON.stringify(draft));
  return slot;
}

/**
 * Срока жизни ЗДЕСЬ нет, и это проверено мутацией, а не решено вкусом: отдельная проверка в
 * читателе неотличима поведением от уборки. `sweepDrafts` прогоняется при каждом открытии
 * записи и раньше любого чтения (useBodySave), то есть просроченного к этому моменту на диске
 * уже нет; а между уборкой и следующим чтением в той же сессии тридцати дней не проходит.
 * Мутант, снимавший проверку отсюда, выживал все прогоны — значит это была мёртвая ветка,
 * а не второй рубеж.
 */
export function readDraft(entityId: string): Draft | null {
  const managed = readManagedDrafts(entityId);
  if (managed) return managed.find((draft) => !draft.recovery) ?? null;
  try {
    const access = captureInputAccess();
    if (!access?.isCurrent()) return null;
    const raw = access.storage.getItem(access.prefix + key(entityId));
    const draft = raw === null ? null : parseDraft(raw);
    return draft?.slot && isDraftSlotFinished(scope, entityId, draft.slot) ? null : draft;
  } catch {
    return null; // и сам доступ к хранилищу может бросить — см. saveDraft
  }
}

export function readRecoveryDraft(entityId: string, exceptToken?: string): Draft | null {
  const managed = readManagedDrafts(entityId);
  if (managed) return managed.find((draft) => draft.recovery && draft.slot !== exceptToken) ?? null;
  try {
    const access = captureInputAccess();
    if (!access?.isCurrent()) return null;
    return (
      listDraftsIn(access.storage, scope, access.prefix, entityId).find(
        ({ draft }) => draft.recovery && (exceptToken === undefined || draft.slot !== exceptToken),
      )?.draft ?? null
    );
  } catch {
    return null;
  }
}

/** Пометить черновик отвергнутым сервером (см. `Draft.rejected`). Нет черновика — нет и дела. */
export function markDraftRejected(entityId: string): void {
  const draft = readDraft(entityId);
  if (draft === null) return;
  // Ветки «уже помечен — не переписывать» здесь НЕТ намеренно: `readDraft` собирает поля в
  // одном и том же порядке, поэтому повторная запись легла бы байт в байт той же строкой.
  // Проверено мутацией (M32): такая ветка неотличима поведением, то есть непроверяема.
  writeKey(key(entityId), JSON.stringify({ ...draft, rejected: true }));
}

export function clearDraft(entityId: string): void {
  try {
    const access = captureInputAccess();
    if (access?.isCurrent()) access.storage.removeItem(access.prefix + key(entityId));
  } catch {
    /* см. saveDraft */
  }
}

function finishedKey(accountId: string, entityId: string, token: string): string {
  return `${FINISHED_PREFIX}${accountId.toLowerCase()}:${entityId.toLowerCase()}:${token}`;
}

export function isDraftSlotFinishedIn(
  storage: InputStorage,
  accountId: string,
  entityId: string,
  token: string,
  prefix = '',
): boolean {
  return storage.getItem(prefix + finishedKey(accountId, entityId, token)) !== null;
}

export function isDraftSlotFinished(accountId: string, entityId: string, token: string): boolean {
  try {
    const access = captureInputAccess();
    return (
      !!access?.isCurrent() &&
      access.storage.getItem(access.prefix + finishedKey(accountId, entityId, token)) !== null
    );
  } catch {
    return false;
  }
}

/**
 * Logical removal of an exact slot. A token-specific tombstone cannot remove a newer
 * localStorage value written by another tab between a compare and a removeItem.
 * The legacy payload is overwritten by the next edit or removed by its existing TTL.
 */
export function finishDraftSlot(accountId: string, entityId: string, token: string): boolean {
  const access = captureInputAccess();
  const managed = inputSession(access);
  if (managed?.scope.accountId === accountId && managed.find(entityId, token)) {
    void managed.finish(entityId, token);
    return true;
  }
  return markLegacyFinished(accountId, entityId, token, access);
}

function markLegacyFinished(
  accountId: string,
  entityId: string,
  token: string,
  access: InputAccess | null,
): boolean {
  try {
    if (!access?.isCurrent()) return false;
    access.storage.setItem(
      access.prefix + finishedKey(accountId, entityId, token),
      String(Date.now()),
    );
    return true;
  } catch {
    return false;
  }
}

export function listDraftsIn(
  storage: InputStorage,
  accountId?: string,
  prefix = '',
  entity?: string,
) {
  const drafts: { accountId: string; entityId: string; draft: Draft }[] = [];
  const managed = new Map<string, number>();
  const start = `${prefix}${KEY_PREFIX}:`;
  for (const key of storage.keys()) {
    if (!key.startsWith(start)) continue;
    const [owner, entityId] = key.slice(start.length).split(':');
    if (
      !owner ||
      !entityId ||
      (accountId !== undefined && owner !== accountId) ||
      (entity !== undefined && entityId !== entity)
    )
      continue;
    try {
      const raw = storage.getItem(key);
      const draft = raw === null ? null : parseDraft(raw);
      if (!draft || expired(draft.savedAt, Date.now())) continue;
      if (
        draft.slot &&
        storage.getItem(prefix + finishedKey(owner, entityId, draft.slot)) !== null
      ) {
        continue;
      }
      const entry = { accountId: owner, entityId, draft };
      const token = draft.inputToken;
      if (token) {
        const identity = JSON.stringify([owner, entityId, token.nonce]);
        const index = managed.get(identity);
        const earlier = index === undefined ? undefined : drafts[index]?.draft.inputToken;
        if (index !== undefined && earlier && sameInputToken(earlier, token)) {
          // A pending head and its ACK key can carry the same exact input.
          if (draft.acknowledged) drafts[index] = entry;
          continue;
        }
        if (index === undefined) managed.set(identity, drafts.length);
      }
      drafts.push(entry);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return drafts;
}

export function countDraftsIn(storage: InputStorage, accountId?: string, prefix = ''): number {
  return listDraftsIn(storage, accountId, prefix).length;
}

export function clearDraftsIn(storage: InputStorage, accountId?: string, prefix = ''): void {
  const suffix = accountId === undefined ? '' : `${accountId}:`;
  const payloads = `${prefix}${KEY_PREFIX}:${suffix}`;
  const finished = `${prefix}${FINISHED_PREFIX}${suffix}`;
  removeStorageKeys(storage, (key) => key.startsWith(payloads) || key.startsWith(finished));
}

export function abandonDraftSlot(entityId: string, token: string): void {
  void discardDraftSlot(entityId, token);
}

export function finishCurrentDraftSlot(entityId: string, token: string): boolean {
  return finishDraftSlot(scope, entityId, token);
}

// The mutation carries the submitted slot without changing its wire input.
const submitted = new WeakMap<object, string>();
export function bindSubmittedDraft(request: object, slot: string | undefined): void {
  if (slot !== undefined) submitted.set(request, slot);
}
export function submittedDraftOf(request: object): string | undefined {
  return submitted.get(request);
}
