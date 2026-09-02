// apps/server/src/executor/types.ts
// Точные сигнатуры executor'а (контракт Task 9; на них встают Task 10–15 и весь 1b).
import type { Tx } from '../db/with-identity';

export type ActorKind = 'owner' | 'ai' | 'agent';
// 'ui' — прямое действие владельца в UI (entity.update / relation.*), отличимое в
// журнале от клиентского create ('fast_path'|'quick_capture'), внутреннего чата
// ('chat'), MCP-агента ('mcp') и системного отката ('system').
//
// 'routine' (V1.5) — правка внутреннего исполнителя в прогоне рутины. Отдельный вариант,
// а не 'chat': за чатом стоит владелец, который только что попросил, а за рутиной —
// расписание, и владелец обязан видеть эту разницу в ленте. Не 'system': системный audit
// из ленты спрятан (chat/messages.ts), а правку рутины владелец видит и отменяет.
// Бухгалтерия самого прогона (создание, шаги, исход) идёт с 'system' — она не правка
// графа по существу, а протокол (рулинг Р-7).
export type MutationSource =
  | 'chat'
  | 'fast_path'
  | 'quick_capture'
  | 'mcp'
  | 'ui'
  | 'system'
  | 'routine';

/**
 * ВТОРАЯ ось операции (§А4-4, РП-4) — КАКИМ МЕХАНИЗМОМ она сделана, в отличие от
 * `MutationSource`, который отвечает «каким КАНАЛОМ она пришла».
 *
 * Две оси, а не одна расширенная, потому что у них разные читатели и разная судьба.
 * `source` читают пять мест (`undo.ts`, `journal.ts`, `invariants.ts` дважды,
 * `rollback.ts`), и все они спрашивают про канал: показывать ли действие в ленте, можно ли
 * его откатить «последним», рутина ли это правит граф. Механизм спрашивает другое: вправе ли
 * ЭТА запись трогать вычисляемое и служебное свойство (§А2-5) и от чьего имени поставлена
 * системная роль ребра (§А4-4). Слив их в одну ось, мы получили бы `source: 'verb'` — и
 * лента, и undo, и запрет рутине начали бы гадать, что это значит.
 *
 * `user` — умолчание: прямое действие владельца (тул, UI, MCP, чат). Именно оно НЕ вправе
 * писать `system_writable` и `model_writable: false`.
 */
export type MutationMechanism =
  | 'user'
  | 'hook'
  | 'rule'
  | 'materialize'
  | 'seed'
  | 'action-seed'
  | 'verb'
  | 'import';

export interface ExecuteRequest {
  actorUserId: string; // владелец графа (D11); в MVP актор-владелец = owner
  actorKind: ActorKind;
  source: MutationSource;
  /** Механизм записи (§А4-4); нет → 'user'. По нему смотрят гейты флагов свойств (§А2-5). */
  mechanism?: MutationMechanism;
  threadId?: string; // тред для audit-сообщения; нет → глобальный тред владельца
  operations: Array<{ tool: string; input: unknown }>; // 1 элемент = одиночный вызов
  batchId?: string; // обязателен при operations.length > 1
  clock?: () => Date; // инъекция времени (тесты); default () => new Date()
  /**
   * Грант внешнего агента, от имени которого идёт мутация (С2) — доезжает до записи
   * журнала как actor_grant_id. Нет у владельческих и чатовых путей: за ними стоит сам
   * владелец, а не выданный кому-то доступ.
   */
  actorGrantId?: string;
  /** Прогон агента, в рамках которого сделана мутация (С2) — в журнале как run_id. */
  runId?: string;
  /**
   * Предложение, которое владелец поправил перед принятием (Ш1.5) — в журнале как
   * edited_from. Исполняется при этом ПРАВЛЕНОЕ предложение, и журнал обязан показывать
   * не только чья это работа, но и что она — не дословно то, что предложила рутина.
   */
  editedFrom?: string;
}

export interface ExecuteOk {
  ok: true;
  actionId: string;
  results: unknown[]; // по одному на операцию (wire-формы сущностей/relations)
  idempotentReplay: boolean; // true: повтор — ничего не применялось
}

export interface ExecuteErr {
  ok: false;
  error: { code: string; message: string; details?: unknown }; // структурированная (§9.2)
}

export type ExecuteResult = ExecuteOk | ExecuteErr;

/**
 * Wire-форма сущности: core-таймстампы — всегда Date.toISOString() (решение 12 плана).
 *
 * ЧЕГО ЗДЕСЬ БОЛЬШЕ НЕТ и почему (§А1-1, §А1-3, §А9-2):
 *  - `meta` — мешок сущности снят §А1-3: значение без объявления в реестре нельзя ни
 *    подписать, ни проверить, ни найти запросом, и место, куда можно писать мимо реестра,
 *    отменяет саму реформу. Колонки `entities.meta` больше нет и в базе — её сняла
 *    contract-миграция 0017;
 *  - `aspectsMap` — старая карта `{аспект: {поле: значение}}`. Она была ВТОРОЙ записью тех
 *    же значений, которые уже лежат в `props` по id, и разъехаться с ними могла молча.
 *    Проекции не осталось ни одной: колонку `entities.aspects_legacy` сняла та же 0017.
 */
export interface WireEntity {
  id: string;
  ownerId: string;
  title: string;
  emoji: string | null;
  body: string;
  /**
   * Структурная форма тела. Едет ТОЛЬКО по include('bodyDoc') — см. Р6 дизайна: wire-форма
   * несёт body всегда, и второй экземпляр тела в каждом ответе удвоил бы вес любого списка.
   * Отсюда и опциональность ключа: `undefined` = «не запрашивали», а не «документа нет».
   */
  bodyDoc?: { v: number; doc: Record<string, unknown> } | null;
  bodyRefs: string[];
  tags: string[];
  /** НОВАЯ правда значений: плоско по id свойства (§А1-1). */
  props: Record<string, unknown>;
  /** НОВАЯ правда интерпретаций: СПИСОК id аспектов, а не карта. */
  aspects: string[];
  /** Обратные ссылки ссылочных свойств (§А1-1); писатель — задача ссылочных свойств. */
  queryRefs: string[];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

/**
 * Wire-форма строки provenance (01-arch §4.8, 03-budget §3.4.1): результат внутренних
 * операций entity_origin_create / entity_origin_delete. Не сущность и не связь —
 * отдельный тип, а не приведение чужого: в publicном контракте §9.2 origins не значатся.
 */
export interface WireOrigin {
  id: string;
  entityId: string;
  namespace: string;
  externalId: string;
  createdAt: string;
}

/**
 * Wire-форма закреплённой версии тела (С11): результат внутренних операций
 * entity_version_pin / entity_version_delete. Соседствует с WireOrigin по той же причине —
 * это не сущность и не связь, а строка служебной таблицы, которой в публичном контракте
 * §9.2 нет.
 *
 * Тела здесь нет НАМЕРЕННО: список версий рисует подписи и даты, а тащить в него по два
 * тела на строку (markdown + документ) значит грузить экран текстом, который никто не
 * читает. Вместо документа едет признак `hasDoc` — снимок сущности, чьё тело ещё не
 * сконвертировано, хранит только markdown (body_doc IS NULL).
 */
export interface WireEntityVersion {
  id: string;
  entityId: string;
  label: string;
  hasDoc: boolean;
  actorKind: ActorKind;
  createdAt: string;
}

/** Wire-форма связи (§4.2): таймстампы — toISOString, как у сущностей. */
export interface WireRelation {
  id: string;
  sourceId: string;
  targetId: string;
  /** Правда ребра (§А4-3): id роли реестра. */
  role: string;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// JournalSink — ВРЕМЕННЫЙ интерфейс стадий 6–7 (Task 9/10).
// Executor вычисляет inverse-операции (§7.8) и данные карточки и зовёт sink.write(...)
// В ТОМ ЖЕ tx. Боевой синк в chat_messages подключает Task 11, передавая свою
// реализацию в execute(..., { sink }) — БЕЗ правки executor.ts.
// ---------------------------------------------------------------------------

export interface ActionOperation {
  op: string;
  payload: Record<string, unknown>;
}

/** Элемент журнала действий — формат §7.8 + атрибуция актора (D11). */
export interface ActionRecord {
  id: string;
  // origin_created/origin_deleted — provenance импорта (§4.8): не сущность и не связь,
  // поэтому честный собственный вариант. Расширение аддитивно: исчерпывающих switch
  // по этому полю в коде нет (журнал читает только по id/inverse — undo.ts, journal.ts).
  //
  // Сегодня В ЗАПИСЬ они не попадают: единственный вызывающий origin-операций —
  // confirmImport, а он всегда задаёт batchId, и весь импорт журналируется одним
  // action типа 'batch'. Варианты оставлены намеренно: их несут JournalPlan'ы этих
  // операций (executor.ts prepareOriginCreate/prepareOriginDelete), и они станут
  // наблюдаемыми у первого НЕ-batch вызывающего — убирать их значило бы заводить
  // отдельный, более узкий тип для плана той же операции.
  //
  // version_pinned/version_deleted — закрепление версии тела (С11): та же аддитивность.
  // В отличие от origin-вариантов, version_pinned в записи НАБЛЮДАЕМ: version.pin —
  // одиночный (не batch) вызывающий, его action ложится в журнал этим типом, и по нему
  // «отмени последнее» находит закрепление. version_deleted достижим только как inverse.
  //
  // property_created / property_updated / property_merged / aspect_delta_set /
  // aspect_delta_removed — операции РЕЕСТРА (§А10-2, §А2-7, §А3-2). У них `entity_id: null`:
  // меняется устройство системы, а не запись в графе, и подставлять сюда «какую-нибудь»
  // сущность значило бы, что «отмени последнее» покажет владельцу чужой заголовок.
  // Аддитивность та же, что у origin/version: исчерпывающих switch по полю в коде нет.
  type:
    | 'entity_created'
    | 'entity_updated'
    | 'relation_created'
    | 'relation_deleted'
    | 'origin_created'
    | 'origin_deleted'
    | 'version_pinned'
    | 'version_deleted'
    | 'property_created'
    | 'property_updated'
    | 'property_merged'
    | 'aspect_delta_set'
    | 'aspect_delta_removed'
    | 'batch';
  entity_id: string | null;
  actor_user_id: string;
  actor_kind: ActorKind;
  source: MutationSource;
  /**
   * Механизм записи (§А4-4). Пишется ВСЕГДА, а не по наличию (в отличие от `run_id` и
   * `actor_grant_id`): у каждого действия механизм есть, умолчание `user` — такое же
   * значение, как остальные, и «ключа нет» читалось бы как «неизвестно». Разбор журнала по
   * механизму (кто именно тронул служебное свойство) без него был бы догадкой по `source`.
   */
  mechanism: MutationMechanism;
  /**
   * Грант и прогон агента (С2) — вторая половина атрибуции: actor_kind говорит «агент»,
   * эта пара — КАКОЙ агент и в каком прогоне.
   *
   * Опциональны ПО ОТСУТСТВИЮ КЛЮЧА, а не по null, и это не стилистика: действия прогона
   * ищутся контейнмент-пробой `metadata @> {"actions":[{"run_id": …}]}` — единственным
   * предикатом, который берёт jsonb-индекс. Запись `"run_id": null` у каждого действия
   * владельца сделала бы такую пробу ложно-положительной для проб с null и удвоила бы
   * пустыми ключами вес всего журнала. Отсюда и условная сборка в executor.ts.
   */
  actor_grant_id?: string;
  run_id?: string;
  /**
   * Исходное предложение рутины, которое владелец переписал перед «Принять» (Ш1.5): по
   * нему видно, что действие воплощает не дословный план рутины, а правку владельца.
   * Отсутствием ключа, а не null, — по той же причине, что run_id выше.
   */
  edited_from?: string;
  operations: ActionOperation[];
  inverse: ActionOperation[]; // в обратном порядке исполнения (§7.8)
}

/** Данные карточки действия для чата (§7.8); полный рендер — территория Task 11+/UI. */
export interface ActionCard {
  tool: string;
  entity_id: string | null;
  title: string;
}

export interface JournalWrite {
  /**
   * Явный PK audit-сообщения. Batch (§7.8) передаёт детерминированный
   * batchAuditMessageId(ownerId, batchId) — уникальность этого id и делает повтор
   * batch проверяемым. Отсутствует → id выбирает реализация синка.
   */
  id?: string;
  ownerId: string;
  threadId?: string; // нет → глобальный тред владельца (резолвит боевой синк, Task 11)
  action: ActionRecord;
  card: ActionCard;
  /** Результаты операций batch — источник ответа идемпотентного повтора (§7.8). */
  results?: unknown[];
}

/**
 * Конфликт PK audit-сообщения: запись с таким id уже существует (batch применён
 * конкурентом/ранее). Семантика PG 23505: боевой синк (Task 11) обязан замапить
 * unique_violation по PK chat_messages на этот класс — executor по нему откатывает
 * tx и возвращает сохранённый результат (§7.8).
 */
export class AuditIdConflictError extends Error {
  readonly code = '23505';
  readonly auditId: string;

  constructor(auditId: string) {
    super(`audit-сообщение ${auditId} уже существует (повтор batch, §7.8)`);
    this.name = 'AuditIdConflictError';
    this.auditId = auditId;
  }
}

export interface JournalSink {
  /**
   * Запись стадий 6–7 В ТОМ ЖЕ tx. Контракт: если entry.id задан и запись с таким id
   * уже существует — реализация ОБЯЗАНА бросить AuditIdConflictError (ничего не записав).
   */
  write(tx: Tx, entry: JournalWrite): Promise<void>;
  /** Поиск audit-записи по детерминированному id — идемпотентность batch (§7.8). */
  findByAuditId(tx: Tx, id: string): Promise<JournalWrite | undefined>;
}

/**
 * In-memory реализация для тестов (стадии 6–7 наблюдаемы без chat_messages):
 * честная уникальность по id с той же семантикой, что PK БД (23505 → AuditIdConflictError).
 * ВАЖНО: гонку конкурентных одинаковых batch'ей полноценно закрывает только реальный
 * PK chat_messages (Task 11) — in-memory хранилище не транзакционно.
 */
export class InMemoryJournalSink implements JournalSink {
  readonly entries: JournalWrite[] = [];

  async write(_tx: Tx, entry: JournalWrite): Promise<void> {
    if (entry.id !== undefined && this.entries.some((e) => e.id === entry.id)) {
      throw new AuditIdConflictError(entry.id);
    }
    this.entries.push(entry);
  }

  async findByAuditId(_tx: Tx, id: string): Promise<JournalWrite | undefined> {
    return this.entries.find((e) => e.id === id);
  }
}

/**
 * ВНУТРЕННИЙ режим executor'а — доступен ТОЛЬКО из undo.ts (Task 11). Не входит в
 * envelope-схемы §9.2 и недостижим через tRPC/тулы: передаётся через ExecutorDeps,
 * которые конструирует исключительно серверный код (в роутеры Task 12 не идёт).
 *
 * Обоснование (§7.8): Undo восстанавливает зафиксированное в журнале прежнее
 * состояние ПОВЕРХ текущего — это осознанный LWW-откат, а не пользовательская
 * правка, поэтому в этом режиме:
 * - body-патчи применяются БЕЗ требования expectedUpdatedAt (§5.2);
 * - доменные нормализации §3.2 не запускаются: они «поправили» бы зафиксированное
 *   состояние и развели бы граф с журналом;
 * - гейт прав записи §А2-5 не спрашивается. С единицей отката «свойство» (§А7-4)
 *   снятие приезжает ЯВНЫМ `unset` — той самой формой, которой гейт отказывает тулу.
 *   Дыры это не открывает: откатывается СВОЁ ЖЕ законно записанное состояние, и
 *   отказ здесь означал бы, что законную запись нельзя отменить;
 * - relation_create принимает meta восстанавливаемой связи;
 * - вместо записи action вызывается writeUndoMessage: undo не порождает нового
 *   action (undo неотменяем).
 *
 * Чего в этом списке БОЛЬШЕ НЕТ: замены аспект-ключа целиком. До §А7-4 inverse нёс
 * прежнее значение всего затронутого ключа, и восстановить его можно было только
 * подменой носителя; теперь он несёт прежние значения ровно тронутых свойств, и разбор
 * входа у отката общий со всеми остальными путями.
 */
export interface InternalUndoMode {
  /** Пишет undo-сообщение {type:'undo', undoes} В ТОМ ЖЕ tx после применения операций. */
  writeUndoMessage(tx: Tx): Promise<void>;
}

/** Зависимости execute; Task 11 передаёт боевой синк здесь. */
export interface ExecutorDeps {
  sink?: JournalSink;
  /** Только из undo.ts — см. InternalUndoMode. */
  internalUndo?: InternalUndoMode;
  /**
   * Вызывается ДО ПЕРВОГО ЧТЕНИЯ СОСТОЯНИЯ в withIdentity-tx execute — до реестра,
   * replay-проверки и стадий 1–7. Не «первым statement'ом tx»: два первых ставит сам
   * `withIdentity` (set_config + SET LOCAL ROLE), и проверяемое требование — порядок
   * относительно ЧТЕНИЙ, а не буквальная позиция (см. док `acquirePendingLock`). Единственный потребитель — сериализация pending-подтверждений §7.10
   * (policy/pending, fix round Task 6): advisory-lock по pendingId + перепроверка
   * «не отклонён» В ТОМ ЖЕ tx, где пишется audit-сообщение, — иначе approve и reject
   * образуют write-skew (оба проходят свои проверки до чужого коммита). Санкционировано
   * координатором как минимальное расширение; других потребителей не заводить без нужды.
   */
  beforeStages?: (tx: Tx) => Promise<void>;
}
