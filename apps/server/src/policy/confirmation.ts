// apps/server/src/policy/confirmation.ts
// Политика подтверждений AI-действий §7.10 — детерминированная таблица MVP (решение 4
// плана 1b). Уровень определяет ЭТОТ серверный слой по типизированным фактам вызова —
// не модель и не текст её рассуждений. Правила едины для внутреннего чата и MCP (§9.3):
// классификатор сознательно НЕ смотрит на source — внешний агент не может получить
// более широкие права, обойдя политику другим транспортом. Каждый ряд таблицы и границы
// закреплены юнит-тестами (confirmation.test.ts); подключение — tools/dispatch.ts.
import { batchExecuteInput } from '@orbis/shared';
import type { ActionRecord, ActorKind } from '../executor/types';

/** Уровни подтверждения §7.10 (семантика каждого — таблица PRD 01 §7.10). */
export type ConfirmationLevel = 'execute' | 'preview' | 'explicit-confirmation' | 'forbidden';

/** Типизированные факты tool-call — входы классификации §7.10. */
export interface ToolCallFacts {
  tool: string;
  kind: 'read' | 'mutate';
  known: boolean; // тул есть в реестре (§9.2)
  actorKind: ActorKind;
  explicitCommand: boolean; // §7.10 «явность намерения»; в 1b всегда false (ToolCallCtx)
  archives: boolean; // мутация архивации: archived: true в input (мягкое удаление)
  isBatch: boolean;
  batchSize?: number;
}

/**
 * Классификатор §7.10 — таблица правил MVP, первое совпадение сверху (порядок значим):
 *
 * | Условие                      | Уровень                | Обоснование §7.10 |
 * |------------------------------|------------------------|-------------------|
 * | !known                       | forbidden              | fail-closed: незнакомый вызов не исполняется |
 * | kind === 'read'              | execute                | чтение без внешних эффектов |
 * | archives && !explicitCommand | explicit-confirmation  | архивация = мягкое удаление; инициатива модели/агента без прямой команды — чувствительно |
 * | isBatch && batchSize > 10    | explicit-confirmation  | масштаб приближается к bulk |
 * | isBatch                      | preview                | bounded-масштаб: исполнить + информационный diff |
 * | иначе (одиночная мутация)    | execute                | single, обратимо (inverse в журнале §7.8) |
 *
 * actorKind — вход политики §7.10, но MVP-таблица по нему не ветвится: ряд archives
 * адресует инициативу модели/агента, а owner-актор до классификатора не доходит
 * (прямые действия владельца идут UI-роутерами мимо dispatch).
 */
export function classifyToolCall(facts: ToolCallFacts): ConfirmationLevel {
  if (!facts.known) return 'forbidden';
  if (facts.kind === 'read') return 'execute';
  if (facts.archives && !facts.explicitCommand) return 'explicit-confirmation';
  if (facts.isBatch && facts.batchSize !== undefined && facts.batchSize > 10) {
    return 'explicit-confirmation';
  }
  if (facts.isBatch) return 'preview';
  return 'execute';
}

/**
 * Извлечение фактов формы вызова из (def, input). Работает ДО структурной валидации
 * мутаций (она — стадия 1 executor'а): archives читается прямым свойством, batch-envelope
 * — safeParse с fallback «не batch» (невалидный input всё равно упадёт стадией 1 —
 * классификация исполниться ему не даст). Акторные факты (actorKind, explicitCommand)
 * добавляет вызывающий из ToolCallCtx; known: true — сюда доходит только найденный
 * реестром def, ряд «!known» dispatch строит сам по результату резолва.
 */
export function factsFromToolCall(
  def: { name: string; kind: 'read' | 'mutate' },
  input: unknown,
): Omit<ToolCallFacts, 'actorKind' | 'explicitCommand'> {
  const base = { tool: def.name, kind: def.kind, known: true as const };
  if (def.name === 'batch_execute') {
    const parsed = batchExecuteInput.safeParse(input);
    if (parsed.success) {
      return {
        ...base,
        archives: parsed.data.operations.some((op) => op.input.archived === true),
        isBatch: true,
        batchSize: parsed.data.operations.length,
      };
    }
    return { ...base, archives: false, isBatch: false };
  }
  return {
    ...base,
    // Архивация — только entity_update (§9.2: archived есть лишь в его envelope);
    // archived в чужом strict-envelope — невалидный input, честный отказ стадии 1
    archives: def.name === 'entity_update' && isRecord(input) && input.archived === true,
    isBatch: false,
  };
}

/**
 * Diff карточки preview (§7.10) для entity_update: новые значения — operations[0].payload
 * журнала §7.8 («как исполнено», после нормализаций), прежние — inverse[0].payload;
 * id — не изменение, исключается. Поле, которого прежде не было, честно даёт
 * before: undefined.
 */
export function entityUpdatePreviewDiff(
  action: Pick<ActionRecord, 'operations' | 'inverse'>,
): Record<string, { before: unknown; after: unknown }> {
  const after = action.operations[0]?.payload ?? {};
  const before = action.inverse[0]?.payload ?? {};
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === 'id') continue;
    diff[key] = { before: before[key], after: value };
  }
  return diff;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
