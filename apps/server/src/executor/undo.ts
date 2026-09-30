// apps/server/src/executor/undo.ts
// Undo §7.8 при append-only журнале (спека скорости §11.2): отмена НЕ правит запись действия — добавляет
// НОВУЮ строку журнала `type:'undo'` (`undoes` — отменённое, тред — тред отменённого, источник — путь отмены)
// и применяет inverse В ОДНОМ tx с ней. Нового action undo не порождает (undo неотменяем). Применение
// inverse идёт через executor во внутреннем режиме (InternalUndoMode, см. types.ts) — стадии, инварианты и
// RLS общие, конвейер не дублируется; режим недостижим через tRPC/тулы.
import { newId, type UndoContinuation, type UndoResult } from '@orbis/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { Identity } from '../identity';
import { clockTime, ownerTimeZone } from '../query/context';
import { unmarkRefSources } from '../registry/ref';
import { bodyEntitiesOf, bodyRuleFailures, versionLabel } from './body-chain';
import { ExecError } from './errors';
import { execute } from './executor';
import { makeJournalSink } from './journal';
import {
  actionRecordOf,
  findAction,
  findLastUndoable,
  isUndone,
  type JournalEntry,
} from './journal-read';
import { undoableTitle } from './text-session';
import type {
  ActionRecord,
  ExecuteErr,
  ExecuteOk,
  ExecuteRequest,
  ExecutorDeps,
  UndoPath,
} from './types';

/** Боевой синк записи отмены — один инстанс: состояния не хранит. */
const sink = makeJournalSink();

/**
 * То же «последнее неотменённое», но БЕЗ применения (В-8): политике §7.10 нужно посмотреть на обратные
 * операции, чтобы назначить уровень, а применять их до решения владельца она не вправе. Скан — у API
 * журнала (`journal-read.findLastUndoable`), чтобы у правила «последнее ВИДИМОЕ действие владельца» был ОДИН
 * дом и не было второй копии в диспатче. `title` — заголовок записи журнала (`card.title` синка) — единственная
 * человекочитаемая строка о действии; у сеанса правки текста — подпись с отрезком («правка текста «…» 14:02–14:18»,
 * §8.5), иначе владелец не узнал бы, какой именно набор снят.
 */
export async function peekLastUndoable(
  db: Db,
  who: Identity,
  now: Date = new Date(),
): Promise<{ action: ActionRecord; entry: JournalEntry; title: string } | undefined> {
  return withIdentity(db, who, async (tx) => {
    const found = await findLastUndoable(tx, who.graph);
    if (found === undefined) return undefined;
    return {
      action: actionRecordOf(found),
      // Запись журнала целиком — место продолжения отказа §8.6 (`continuationOf`: тред, сеанс, источник, прогон)
      entry: found,
      title: await undoableTitle(tx, who.graph, found, now),
    };
  });
}

/**
 * Применение inverse найденного действия: операции журнала — это тулы executor'а,
 * поэтому просто прогоняем их конвейером во внутреннем режиме. Multi-op inverse
 * (batch-действие) идёт batch-путём с техническим batchId — атомарность §7.8;
 * в журнал он не попадает (internal-режим пишет запись отмены вместо action).
 *
 * Отсюда требование к ФОРМЕ полезной нагрузки, которое ломается молча: `iv.payload`
 * уезжает во вход тула и разбирается fail-closed'ом (`entityUpdateExecInput`), поэтому
 * форма, которой контракт не знает, даёт не «ничего не сделал», а VALIDATION — а по
 * ответу undo это неотличимо от честного отказа. С §А7-4 нагрузка — плоские `props`/
 * `unset`/`aspects:{attach,detach}` (внутренняя форма §А1-1), и exec-надмножество их
 * принимает; менять её здесь, не тронув контракт, нельзя.
 */
/**
 * Источники, которым отменяемое действие поставило `needs-review` при архивации цели ссылки
 * (§А6-3, рулинг Р-11-1). Читаются из строки журнала `ref_sources_marked`, которую пишет
 * `applyRefEffects`.
 *
 * Форма нагрузки разбирается ЗАЩИТНО: журнал append-only, и в нём лежат записи, сделанные до
 * этого коммита, — у них строки `ref_sources_marked` нет вовсе либо она несёт прежнее поле
 * `marked` (счётчик). Ни то ни другое не должно ронять откат: неизвестная форма означает
 * «снимать нечего», а не исключение.
 */
function markedRefSources(action: Pick<ActionRecord, 'operations'>): string[] {
  const out: string[] = [];
  for (const op of action.operations) {
    if (op.op !== 'ref_sources_marked') continue;
    const sources = (op.payload as { sources?: unknown }).sources;
    if (!Array.isArray(sources)) continue;
    for (const id of sources) if (typeof id === 'string') out.push(id);
  }
  return out;
}

/** Закрепление текущего текста записи версией внутри записи отмены (§7.5 п. 3, §8.6): id версии заведён заранее. */
type UndoPin = UndoResult['pinnedVersions'][number];

/** Подпись страховки сеанса правки текста (В-4): «перед возвратом к ЧЧ:ММ» начала сеанса во времени владельца. */
const SESSION_PIN_PREFIX = 'перед возвратом к ';
/** Подпись закрепления продолжения «Всё равно отменить» (В-4): «перед отменой: <заголовок действия>». */
const FORCE_PIN_PREFIX = 'перед отменой: ';

/**
 * Подготовка отмены до её транзакции: подпись отменяемого и закрепления.
 *
 * Подпись — ОДНА на все пути (`undoableTitle`: у сеанса правки текста — с отрезком «14:02–14:18», у прочих — заголовок
 * записи журнала): её несут ответ отмены (`undone.title`), подпись «отмени последнее» и метка закрепления продолжения,
 * и подтверждение «отменено …; ваш текст — в версии …» читается одинаково с любого входа. Считается до применения —
 * конец сеанса известен, пока колонка тела указывает на него. `title` передаёт вызывающий, уже посчитавший её
 * (`undoLast` — при выборе последнего).
 *
 * Закрепления — ПЕРВЫМИ операциями записи отмены, по одному на запись:
 * - запись сеанса правки текста — ВСЕГДА, любым путём (К-20): у записи сеанса нет «после», и текст, который возврат
 *   сотрёт, сохраняется версией «перед возвратом к ЧЧ:ММ»; отдельным действием нельзя — «отмени последнее» нашло бы его
 *   и удалило страховку;
 * - при продолжении (`force`, Р-15) — каждая запись, провалившая предпроверку правила §8.6 и ещё не закреплённая
 *   (К-30): записи, прошедшие проверку, версий не получают. Предпроверка — отдельной читающей транзакцией и БЕЗ
 *   замков строк (её вывод перепроверяет правило под замком); запись, провалившая проверку только к транзакции отмены,
 *   остановит её правилом (гонка — отказ с новым перечнем).
 */
async function prepareUndo(
  db: Db,
  who: Identity,
  action: JournalEntry,
  force: boolean,
  title: string | undefined,
): Promise<{ title: string; pins: UndoPin[] }> {
  const session = action.textSession && action.entityId !== null;
  if (!session && !force) return { title: title ?? action.title, pins: [] };
  return withIdentity(db, who, async (tx) => {
    const label = title ?? (await undoableTitle(tx, who.graph, action, new Date()));
    const pins: UndoPin[] = [];
    if (session && action.entityId !== null) {
      const start = clockTime(action.createdAt, await ownerTimeZone(tx, who.graph));
      pins.push({
        entityId: action.entityId,
        versionId: newId(),
        label: versionLabel(`${SESSION_PIN_PREFIX}${start}`),
      });
    }
    if (force) {
      const failures = await bodyRuleFailures(tx, who.graph, action, bodyEntitiesOf(action), {
        lock: false,
      });
      for (const f of failures) {
        if (pins.some((p) => p.entityId === f.entityId)) continue;
        pins.push({
          entityId: f.entityId,
          versionId: newId(),
          label: versionLabel(`${FORCE_PIN_PREFIX}${label}`),
        });
      }
    }
    return { title: label, pins };
  });
}

/**
 * Исход отмены на сервере: ответ отмены (`UndoResult` — провод `ai.undo`: id записи отмены, что отменено, закреплённые
 * версии) плюс результаты обратных операций для серверных вызывающих (форма `ExecuteOk`: откат прогона, карточка
 * отката, тесты читают восстановленные записи). Результаты закреплений в `results` не входят — по одному на обратную
 * операцию, как до закреплений. Провод `ai.undo` несёт только `UndoResult`.
 */
export type UndoOutcomeServer =
  | ({ ok: true } & UndoResult & { results: unknown[]; idempotentReplay: false })
  | ExecuteErr;

async function applyUndo(
  db: Db,
  who: Identity,
  action: JournalEntry,
  opts: {
    path: UndoPath;
    force: boolean;
    continuation: UndoContinuation;
    beforeStages?: ExecutorDeps['beforeStages'];
    /** Подпись отменяемого, уже посчитанная вызывающим (`undoLast`) — см. `prepareUndo`. */
    title?: string;
  },
): Promise<UndoOutcomeServer> {
  if (action.inverse.length === 0) {
    // Недостижимо для действий executor'а (inverse всегда непуст); страховка формата
    return {
      ok: false,
      error: { code: 'VALIDATION', message: `у действия ${action.id} нет inverse-операций` },
    };
  }
  // id записи отмены — ДО применения (РП-11): на нём стоят ответ и продолжения отмены
  const undoRecordId = newId();
  const { title, pins } = await prepareUndo(db, who, action, opts.force, opts.title);
  // Ревизии тел, которые отмена писала, — снимаются в её транзакции (`onApplied`), чтобы ответ отдал их клиенту
  let bodyRevisions: UndoResult['bodyRevisions'] = [];
  // Закрепления — первыми операциями той же транзакции и той же записи отмены (К-20, К-30): снимок берёт текст ДО
  // обратных операций, а отказ правила или любой операции не оставляет ни одной версии
  const operations = [
    ...pins.map((p) => ({
      tool: 'entity_version_pin',
      input: { id: p.versionId, entity_id: p.entityId, label: p.label },
    })),
    ...action.inverse.map((iv) => ({ tool: iv.op, input: iv.payload })),
  ];
  const req: ExecuteRequest = {
    identity: who,
    actorKind: 'owner', // MVP: undo инициирует владелец графа
    // Исполнение — всегда `system` (инварианты читают `req.source`), путь отмены — поле записи отмены (РП-11)
    source: 'system',
    operations,
    batchId: operations.length > 1 ? newId() : undefined,
  };
  const result = await execute(db, req, {
    sink,
    // Шов сериализации карточки отката (`approvePending`, ключ `undo_of`): замок единицы и
    // перепроверка «не отклонена» — в ТОЙ ЖЕ транзакции, что запись отмены (см. `undoAction`).
    ...(opts.beforeStages !== undefined && { beforeStages: opts.beforeStages }),
    internalUndo: {
      undoRecordId,
      undoing: action,
      path: opts.path,
      force: opts.force,
      pinned: new Set(pins.map((p) => p.entityId)),
      continuation: opts.continuation,
      // Вызывается ПОСЛЕ применения inverse В ТОМ ЖЕ tx, до записи отмены — атомарность undo (§7.8)
      async onApplied(tx) {
        // Перепроверка под замками строк: конкурентный undo того же action мог
        // закоммититься, пока этот tx ждал FOR UPDATE (READ COMMITTED увидит его);
        // отказ откатывает и применённый inverse — двойного отката не бывает
        if (await isUndone(tx, who.graph, action.id)) {
          throw new ExecError('VALIDATION', `действие ${action.id} уже отменено`, {
            actionId: action.id,
            reason: 'already_undone',
          });
        }
        // Снятие пометки `needs-review`, поставленной архивацией цели ссылки (Р-11-1).
        // ЗДЕСЬ, а не в inverse, по двум причинам сразу: inverse исполняется ТУЛАМИ, а «снять
        // тег у списка сущностей» тулом не выражается; и делать это надо ПОСЛЕ применения
        // inverse — цель к этому моменту уже разархивирована, и условие «не осталось ссылок
        // на архивную цель» внутри `unmarkRefSources` считается по восстановленному графу.
        await unmarkRefSources(tx, who.graph, markedRefSources(action));
        // Ревизия тела каждой записи, чей текст отмена писала (данные отмены — ровно записи `bodyEntitiesOf`, R-21): в
        // этой же транзакции — прочитанная позже могла бы оказаться ревизией чужой правки, и редактор, продолжив с неё,
        // затёр бы ту правку без конфликта
        const written = bodyEntitiesOf(action);
        if (written.length > 0) {
          bodyRevisions = (
            await tx
              .select({ entityId: entities.id, bodyRevision: entities.bodyRevision })
              .from(entities)
              .where(and(eq(entities.graphId, who.graph), inArray(entities.id, written)))
          ).sort((a, b) => a.entityId.localeCompare(b.entityId));
        }
      },
    },
  });
  if (!result.ok) return result;
  return {
    ok: true,
    actionId: undoRecordId,
    undone: { id: action.id, title },
    pinnedVersions: pins,
    bodyRevisions,
    results: result.results.slice(pins.length),
    idempotentReplay: false,
  };
}

/**
 * Отмена конкретного действия по id из журнала (§7.8).
 *
 * `path` — путь отмены, поле `source` записи отмены (РП-11): `ui` (умолчание) — кнопка владельца и откат прогона
 * с экрана прогона (К-45); `chat` — «отмени последнее» моделью и карточка отката `undo_of`; `system` — прод-операции
 * (`migrate-1v --undo`).
 *
 * `force` — продолжение «Всё равно отменить» (§8.6, Р-15): текущий текст каждой записи, провалившей правило, закрепляется
 * версией первой операцией той же записи отмены. `continuation` — место продолжения, которое отказ правила называет
 * клиенту (`UNDO_TEXT_CHANGED`); умолчание — `none`: у вызывающего продолжения нет.
 *
 * `beforeStages` — ровно тот же шов, что у `approvePending` для пачки (`ExecutorDeps`): карточка
 * отката (`undo_of`, В-8) исполняется здесь, а не `execute` payload'а, и без шва её «Принять» и
 * «Отклонить» не делили бы замок единицы — владелец мог получить в ленте «отменено» и «отклонено»
 * разом (фикс-раунд 1 задачи 8, I-3). Других потребителей у параметра нет.
 */
export async function undoAction(
  db: Db,
  args: {
    identity: Identity;
    actionId: string;
    path?: UndoPath;
    force?: boolean;
    continuation?: UndoContinuation;
  },
  deps: { beforeStages?: ExecutorDeps['beforeStages'] } = {},
): Promise<UndoOutcomeServer> {
  try {
    const found = await withIdentity(db, args.identity, async (tx) => {
      // Чтение action отдельным tx от применения безопасно: журнал append-only,
      // metadata неизменяема (§4.6); статус «отменено» перепроверяется в tx применения
      const found = await findAction(tx, args.identity.graph, args.actionId);
      if (!found) {
        // RLS скоупит журнал владельцем: чужое и несуществующее неразличимы
        throw new ExecError('NOT_FOUND', `действие ${args.actionId} не найдено в журнале`, {
          actionId: args.actionId,
        });
      }
      if (await isUndone(tx, args.identity.graph, args.actionId)) {
        throw new ExecError('VALIDATION', `действие ${args.actionId} уже отменено`, {
          actionId: args.actionId,
          reason: 'already_undone',
        });
      }
      return found;
    });
    return await applyUndo(db, args.identity, found, {
      path: args.path ?? 'ui',
      force: args.force ?? false,
      continuation: args.continuation ?? { kind: 'none' },
      ...(deps.beforeStages !== undefined && { beforeStages: deps.beforeStages }),
    });
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}

/**
 * Что именно отменило «отмени последнее» — для того, кто НЕ выбирал действие сам: чат-модели
 * (тул `undo_last`, tools/dispatch.ts) нужно назвать владельцу откаченное, а `actionId` без
 * подписи ей ничего не говорит. `title` — заголовок записи журнала («Создана сущность
 * «…»»; у сеанса правки текста — подпись с отрезком, §8.5), `type`/`entityId` — из самой записи журнала.
 */
export interface UndoneAction {
  actionId: string;
  type: ActionRecord['type'];
  entityId: string | null;
  title: string;
}

/**
 * Исход «отмени последнее»: форма `ExecuteOk` с id ОТМЕНЁННОГО действия, плюс `undone` при успехе и закреплённые
 * версии (страховка сеанса правки текста, §7.5 п. 3). Отказ «отменять нечего» — NOT_FOUND с `details.reason:
 * 'nothing_to_undo'`: чату он нужен как ШТАТНЫЙ ответ («нечего отменять»), а не как ошибка, и отличать его по тексту
 * сообщения было бы хрупко.
 */
export type UndoLastResult =
  | (ExecuteOk & { undone: UndoneAction; pinnedVersions: UndoResult['pinnedVersions'] })
  | ExecuteErr;

/**
 * «Отмени последнее» (§7.8): inverse первого неотменённого действия с конца журнала. Путь — `ui` (умолчание):
 * единственный вызывающий — `ai.undoLast` кнопки владельца; «отмени последнее» словами в чате идёт политикой
 * (`tools/dispatch.ts`: `peekLastUndoable` + `undoAction` с путём `chat` и местом `continuationOf` — Р-17, К-46).
 * Своего продолжения правила §8.6 у «отмени последнее» нет (`force` не принимается); `continuation` — место, которое
 * назовёт отказ. У кнопки владельца это `here`: продолжение — `ai.undo({actionId: details.action.id, force: true})` с
 * того же экрана (отказ называет отменявшееся действие, и точечная отмена с продолжением доступна там же; Fable M-2
 * задачи 10).
 */
export async function undoLast(
  db: Db,
  args: { identity: Identity; path?: UndoPath; continuation?: UndoContinuation },
): Promise<UndoLastResult> {
  try {
    // Подпись — до отмены: конец сеанса правки текста известен, пока колонка тела указывает на сеанс (§8.5)
    const peeked = await withIdentity(db, args.identity, async (tx) => {
      const entry = await findLastUndoable(tx, args.identity.graph);
      if (entry === undefined) return undefined;
      return { entry, title: await undoableTitle(tx, args.identity.graph, entry, new Date()) };
    });
    if (!peeked) {
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: 'неотменённых действий в журнале нет',
          details: { reason: 'nothing_to_undo' },
        },
      };
    }
    const result = await applyUndo(db, args.identity, peeked.entry, {
      path: args.path ?? 'ui',
      force: false,
      continuation: args.continuation ?? { kind: 'none' },
      title: peeked.title,
    });
    if (!result.ok) return result;
    // `findLastUndoable` записей отмены не отдаёт (К-22) — запись журнала здесь всегда действие
    const record = actionRecordOf(peeked.entry);
    return {
      ok: true,
      // Вызывающему «отмени последнее» полезен id ОТМЕНЁННОГО действия: он его не выбирал
      actionId: record.id,
      results: result.results,
      idempotentReplay: false,
      pinnedVersions: result.pinnedVersions,
      undone: {
        actionId: record.id,
        type: record.type,
        entityId: record.entity_id,
        title: peeked.title,
      },
    };
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}
