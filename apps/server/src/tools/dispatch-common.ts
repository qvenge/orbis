// apps/server/src/tools/dispatch-common.ts
// ОБЩЕЕ ДНО ДИСПАТЧА: форма ответа, контекст вызова, боевой синк и три помощника.
//
// Дом заведён ради ОДНОЙ вещи — отсутствия цикла по значению между `tools/dispatch.ts` и
// ветками-исполнителями, живущими в своих домах (`actions/run.ts`, §Б6-2). `dispatchTool`
// зовёт `runAction`, и обратный импорт помощников из `dispatch.ts` замкнул бы
// `dispatch ⇄ actions/run` по значению — а `sink` модульная константа, то есть порядок
// инициализации стал бы наблюдаемым (`undefined` у того, кто загрузился первым). Хуки Р-К-67
// закрывают одну дугу (`deferRoutineUnit` приходит параметром), это дно — вторую.
//
// Тела перенесены ДОСЛОВНО: поведение не меняется ни на строку, и мутационная проба этого
// шага — «подменить текст отказа `levelGate`» (обязана покраснеть в `dispatch.test.ts`).
//
// Сюда НЕ переезжает ничего, что знает про конкретный тул: `runMutation`, `runThreadPost`,
// конверты — остаются в `dispatch.ts`. ОДНО ИСКЛЮЧЕНИЕ, и оно названо: объектный пре-чек фона
// (`routineDeferForbidden`, эррата Ф-Б2-18). Он знает не тул, а ФОРМУ операции (цель правки, концы
// связи, цель attach), и его зовут две ветки — `runMutation` и `runAction` (перед отложкой
// действия); оставшись в `dispatch.ts`, он был бы недостижим из `actions/run.ts` без цикла. Правило дна: файл не импортирует ни одного модуля,
// который импортирует его самого (проба — `bun run typecheck` плюс греп этого файла по импорту
// из `./dispatch`; в тексте дна строки импорта нет даже в комментарии — иначе греп лгал бы).
import { inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { EntitlementResolver } from '../entitlements';
import { ExecError } from '../errors';
import { ROUTINE_UNTOUCHABLE_OBJECTS, routineUntouchableError } from '../executor/invariants';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind } from '../executor/types';
import type { Identity } from '../identity';
import type { GrantRef } from '../oauth/grants';
import type { ConfirmationLevel, Reconfigures } from '../policy/confirmation';
import type { Card, RoutineRef } from './registry';

// Боевой синк — один инстанс на модуль (состояния не хранит), как в роутерах 1a.
export const sink = makeChatJournalSink();

export interface ToolCallCtx {
  db: Db;
  /** Пара «актор + текущий граф» (D44) — едет в ExecuteRequest как есть. */
  identity: Identity;
  actorKind: ActorKind; // 'owner' | 'ai' | 'agent'; в ExecuteRequest идёт как есть
  /**
   * Поверхность вызова. 'routine' (V1.5) — внутренний исполнитель в прогоне рутины:
   * не 'chat', потому что за прогоном не стоит владелец, который только что попросил,
   * и правки рутины он обязан отличать в ленте.
   */
  source: 'chat' | 'mcp' | 'routine';
  threadId?: string; // тред диалога — туда лягут audit-сообщения
  explicitCommand: boolean; // вход политики §7.10; в 1b всегда false
  clock?: () => Date;
  /**
   * Резолвер §8 — инжектируемый шов (как ImportDeps.entitlements у роутера импорта и
   * McpDeps.entitlements у MCP-сервера): по умолчанию боевой resolveEntitlement.
   * Без него денайл-путь гейтов внутри диспатча был бы непокрываем тестом.
   */
  entitlements?: EntitlementResolver;
  /**
   * Грант, от имени которого идёт вызов (С2). Есть ТОЛЬКО у MCP: чат и UI — поверхности
   * самого владельца, гранта за ними нет, и отсутствие ключа здесь означает именно это,
   * а не «грант неизвестен». Отсюда идентичность едет в ExecuteRequest.actorGrantId и
   * дальше в запись журнала (§7.8).
   */
  grant?: GrantRef;
  /**
   * Рутина и её прогон, от имени которых идёт вызов (V1.10) — ровно то же место в
   * контексте, что `grant` у внешнего исполнителя: субъект, которому адресован доступ.
   * Есть ТОЛЬКО у `source: 'routine'`; отсутствие ключа при таком source — не «рутина
   * неизвестна», а поломка вызывающего, и гейт ниже трактует это fail-closed.
   */
  routine?: RoutineRef;
  /**
   * Прогон, в рамках которого идёт вызов (V1.5) — вторая половина атрибуции рядом с
   * грантом: source говорит «рутина», это поле — КАКОЙ её прогон. Доезжает до action
   * журнала как run_id, до pending-записи как run_id и до поста в треде. Ключа нет у
   * обычного чата и MCP-вызова вне прогона.
   */
  runId?: string;
}

export type ToolDispatchResult =
  | {
      status: 'ok';
      result: unknown;
      card?: Card;
      /**
       * id action'а журнала §7.8 (undo-адресуемый) — только у мутаций через executor
       * и только когда действие реально журналировалось (идемпотентный replay ничего
       * не журналил — как undoActionId карточки). Потребитель — actions-резюме
       * ai.sendMessage (Task 9) для мгновенного UI-обновления.
       */
      actionId?: string;
    }
  | { status: 'pending_confirmation'; pendingId: string; card: Card } // §7.10 explicit-confirmation (Task 6)
  | { status: 'error'; error: { code: string; message: string; details?: unknown } };

export function errorResult(code: string, message: string, details?: unknown): ToolDispatchResult {
  return { status: 'error', error: { code, message, details } };
}

/**
 * §7.10: маппинг уровня в ранний отказ; null — уровень не отказной: execute/preview
 * исполняются, explicit-confirmation обрабатывает вызывающий (runMutation →
 * createPending, policy/pending). forbidden → FORBIDDEN_LEVEL (403 маппингом errors.ts).
 *
 * КОНТРАКТ PENDING (fix round Task 5 → Task 6): сюда уровень приходит только ПОСЛЕ
 * envelope-валидации input'а (validateMutationEnvelope / validateBatchOperations в
 * runMutation) — pending создаётся из envelope-валидированного payload'а. Полная
 * провалидированность (стадии 2–4 конвейера §9.2: aspects-схемы реестра,
 * expectedUpdatedAt/§5.2, доменные инварианты над текущим состоянием) — обязанность
 * РЕВАЛИДАЦИИ APPROVE (полный конвейер executor'а, см. policy/pending.ts): dry-run
 * при создании не спасал бы от изменения состояния за время ожидания — ревалидация
 * на approve обязательна в любом случае, двойная валидация избыточна.
 */
export function levelGate(
  level: ConfirmationLevel,
  tool: string,
  forbiddenMessage?: string,
): ToolDispatchResult | null {
  if (level === 'forbidden') {
    return errorResult(
      'FORBIDDEN_LEVEL',
      forbiddenMessage ?? `вызов тула «${tool}» запрещён политикой подтверждений (§7.10)`,
      { tool },
    );
  }
  return null;
}

/** Структурная валидация envelope read-тулов и thread_post (мутации валидирует executor). */
export function parseEnvelope<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  tool: string,
): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `невалидный input тула «${tool}»`, {
      tool,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/**
 * Аспект назначения — четвёртый запретный объект рутины рядом с `ROUTINE_UNTOUCHABLE_OBJECTS`:
 * раздавать исполнителю работу — не то же самое, что править рутину, но запрещено рутине по
 * той же причине.
 *
 * Зеркало executor'а здесь НЕПОЛНОЕ, и намеренно (рулинг Р4-1, разбор — в доке пре-чека
 * ниже): стадия 4 (`assertRoutineUntouchable`, `executor/invariants.ts`) запрещает рутине
 * ТРОГАТЬ аспект назначения (`touched`), а пре-чек запрещает трогать сущность, у которой он
 * уже есть. Буква спеки среза (ОЧ.4, §9.1) требует второго; расхождение названо и вынесено
 * владельцу как остаток.
 */
const ASSIGNMENT_ASPECT = 'orbis/assignment';

/** Защитная проверка формы: сюда доезжает envelope-валидированный payload, но пре-чек не падает на мусоре. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Объектный пре-чек рутинной мутации (D42 ОЧ.4, инвариант 1 среза): `null` — откладывать
 * можно, строка — человекочитаемая причина отказа АГЕНТУ, здесь и сейчас.
 *
 * Зачем отдельный рубеж, когда те же запреты держит стадия 4 executor'а: отложенная карточка
 * исполняется не в момент постановки, а когда владелец нажмёт «Принять» — и отказ прилетел бы
 * ЕМУ, хотя виноват не он (тот же довод, что у пре-чека предложения, `routines/propose.ts`).
 * Карточка, которую executor гарантированно убьёт, не должна рождаться.
 *
 * НО ПО НАЗНАЧЕНИЮ ЭТА ВЕТКА СТРОЖЕ EXECUTOR'А, и это решено сознательно (рулинг координатора
 * Р4-1). Стадия 4 ловит назначение только по `touched` (`executor/invariants.ts`) — то есть
 * рутина вправе править СВОЙ назначенный тикет, и «архивировать назначенный тикет» на
 * «Принять» прошло бы. Пре-чек же смотрит на СОСТОЯНИЕ цели и отказывает. Так написана буква
 * спеки среза (ОЧ.4 и §9.1 говорят дважды: «цель в `ROUTINE_UNTOUCHABLE_OBJECTS` ∪
 * `orbis/assignment`»), и для фонового актора выбран fail-closed: отказ виден агенту явно, он
 * о нём доложит, цена узкая, откат — одна строка.
 *
 * Первые ТРИ проверки — не про executor вовсе, а про пачку: «Принять все» одним нажатием
 * сняло бы замок мимоходом, если бы выдача автономии, правка инструкции act-рутины или
 * перенастройка системного объекта реестра (§С2-1 ряд 3, Задача 16) умели откладываться.
 * Такое рутина обязана либо делать в лицо владельцу (чат, где он тут же смотрит на карточку),
 * либо не делать. У третьей проверки есть и вторая половина, которой нет у первых двух: у
 * операций реестра запрета по объекту НА СТАДИИ 4 нет вовсе — `assertRoutineUntouchable`
 * стережёт аспекты ЗАПИСЕЙ, а не строки реестра, — то есть здесь это не зеркало, а
 * единственный рубеж. Тем важнее, что уровень до него доводит: `system-object` поднимает ряд
 * 4a до `explicit-confirmation`, и `level !== 'execute'` выполняется всегда.
 *
 * Порядок проверок значим: у операции может сойтись сразу несколько поводов (правка `mode`
 * ЧУЖОЙ рутины — это и автономия, и запретная цель), и назвать агенту надо самый содержательный
 * из них, иначе он будет чинить не то.
 *
 * Цели читаются одним SELECT по id — тем же способом и в том же месте конвейера, что и
 * пробой носителя (`autonomyChangedByCarrier`, `tools/dispatch.ts`; своей транзакции пре-чек не
 * заводит, RLS — под `withIdentity` актора). Containment тут не нужен: у пре-чека на руках готовые id, а
 * запретных аспектов четыре — читается СПИСОК `aspects[]`, то есть ровно то, чем аспект
 * теперь и является (§А1-1).
 *
 * Пре-чек разбирает ВСЕ формы операции, включая те, до которых таблица §7.10 сегодня его не
 * доводит (связи и attach классифицируются как `execute`, batch рутине закрыт совсем): он —
 * зеркало запрета по объекту, и зеркало, отражающее половину, разошлось бы со стадией 4
 * молча, стоит таблице уровней однажды поменяться. По той же причине функция экспортирована —
 * ровно как `routineGate` (`tools/dispatch.ts`): рубеж, который никто не проверил, — это рубеж,
 * которого нет.
 */
export async function routineDeferForbidden(
  ctx: ToolCallCtx,
  ops: ReadonlyArray<{ tool: string; input: unknown }>,
  facts: { grantsAutonomy: boolean; reconfigures: Reconfigures },
  instructionOf: readonly string[],
): Promise<string | null> {
  if (facts.grantsAutonomy) {
    return 'выдача автономии рутине из фона не откладывается: право писать в граф без спроса даёт только владелец и только глядя на карточку (V1.10)';
  }
  if (instructionOf.length > 0) {
    return `правка инструкции act-рутины из фона не откладывается: «${instructionOf.join('», «')}» (V1.10)`;
  }
  // ТРЕТИЙ ПОВОД — ЗАПРЕТ ПО ОБЪЕКТУ РЕЕСТРА (§С2-1 ряд 3). Встроенное свойство, встроенный
  // аспект, ПРИВЯЗКА встроенного аспекта (`implements`, Б-1) и роли `created_by: system` фон
  // не перенастраивает НИКОГДА — ни сейчас, ни отложенной единицей. Подписки и наборы сюда
  // НЕ попадают: их ряд задаёт тул (`behavior-delta`, Р9), и фон предлагает их владельцу
  // штатной единицей пачки — иначе законный путь садовника §Б5-2 был бы закрыт наглухо.
  // Довод тот же, что у двух поводов выше: «Принять все» одним нажатием сняло бы замок
  // мимоходом, а анти-цель 3 (§С2-3) запрещает рутине «тихо перенастроить, что видит
  // владелец». Свои строки владельца сюда не попадают — их правка откладывается штатно.
  //
  // ВЫХОД У АГЕНТА ЕСТЬ, и отказ его называет: `orbis_ask`/`orbis_checkpoint` открыты рутине
  // В ЛЮБОМ РЕЖИМЕ (`ROUTINE_BASE_TOOLS`, `tools/registry.ts`) — фон говорит владельцу, чего
  // хочет, и тот делает это сам либо подтверждает в чате. Отказ без выхода был бы ловушкой.
  if (facts.reconfigures === 'system-object') {
    return 'перенастройка системного объекта (встроенное свойство, встроенный аспект, привязка встроенного аспекта) из фона не откладывается: устройство системы меняет владелец, а не прогон (§С2-1). Скажите ему об этом — orbis_ask открыт в любом режиме';
  }

  // Цель правки и конец связи — разные множества запретных аспектов, и это не небрежность:
  // executor запрещает связь только по рутине и прогону (`assertRoutineRelationUntouchable`),
  // а назначенный тикет связями обвешивать не мешает. Пре-чек зеркалит его ровно, иначе он
  // отказывал бы в том, что на «Принять» прошло бы.
  const entityTargets: string[] = [];
  const relationEnds: string[] = [];
  for (const op of ops) {
    if (!isRecord(op.input)) continue;
    if (op.tool === 'entity_update') {
      if (typeof op.input.id === 'string') entityTargets.push(op.input.id);
    } else if (op.tool === 'relation_create' || op.tool === 'relation_delete') {
      for (const end of [op.input.source_id, op.input.target_id]) {
        if (typeof end === 'string') relationEnds.push(end);
      }
    } else if (op.tool.startsWith('attach_')) {
      // attach — третий путь появления аспекта на ЖИВОЙ сущности; `entity_create` целей
      // в БД не имеет вовсе, его запретные формы ловит проверка автономии выше и стадия 4
      if (typeof op.input.entity_id === 'string') entityTargets.push(op.input.entity_id);
    }
  }
  const ids = [...new Set([...entityTargets, ...relationEnds])];
  if (ids.length === 0) return null;

  const rows = await withIdentity(ctx.db, ctx.identity, (tx) =>
    tx
      .select({ id: entities.id, aspects: entities.aspects })
      .from(entities)
      .where(inArray(entities.id, ids)),
  );
  const aspectsById = new Map(rows.map((r) => [r.id, r.aspects]));
  // Невидимой цели (её нет или она чужая) пре-чек не касается: NOT_FOUND — честный ответ
  // исполнения, и подменять его отказом по объекту значило бы разглашать, что строка есть.
  const untouchable = (id: string): boolean => {
    const aspects = aspectsById.get(id);
    return aspects !== undefined && ROUTINE_UNTOUCHABLE_OBJECTS.some((a) => aspects.includes(a));
  };

  for (const id of entityTargets) {
    if (untouchable(id) || aspectsById.get(id)?.includes(ASSIGNMENT_ASPECT) === true) {
      return routineUntouchableError().message;
    }
  }
  for (const id of relationEnds) {
    if (untouchable(id)) return routineUntouchableError().message;
  }
  return null;
}
