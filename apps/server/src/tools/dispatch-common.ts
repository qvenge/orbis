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
// конверты — остаются в `dispatch.ts`. Правило дна: файл не импортирует ни одного модуля,
// который импортирует его самого (проба — `bun run typecheck` плюс греп этого файла по импорту
// из `./dispatch`; в тексте дна строки импорта нет даже в комментарии — иначе греп лгал бы).
import type { z } from 'zod';
import type { Db } from '../db/client';
import type { EntitlementResolver } from '../entitlements';
import { ExecError } from '../errors';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind } from '../executor/types';
import type { Identity } from '../identity';
import type { GrantRef } from '../oauth/grants';
import type { ConfirmationLevel } from '../policy/confirmation';
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
