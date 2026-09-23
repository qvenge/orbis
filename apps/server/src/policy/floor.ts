// apps/server/src/policy/floor.ts
// ПОЛ ПОНИЖЕНИЯ (§С2-1 ревизии 4, В-2/Р-27). Правила владельца `assign_level` могут повышать и
// понижать уровень таблицы §7.10 — но НЕ ниже этих рядов: мутация реестра («молчаливых мутаций
// реестра не существует ни для какого актора»), выдача автономии не владельцем («автономия —
// только рукой владельца»), неизвестный инструмент (fail-closed) и запрет по объекту для фона.
//
// КОНСТАНТА РЯДОМ С `classifyToolCall`, А НЕ ВНУТРИ НЕЁ: таблица §7.10 отвечает на вопрос «какой
// уровень», пол — на другой, «ниже чего нельзя», и слить их значило бы, что правило, не сработавшее
// вовсе, всё равно прошло через сложение. В Б-2 пол зовёт ТОЛЬКО `assignLevelOf` (оценочная область
// фикстур §С8-26); живой конвейер получит его в V2 вместе с правилами данными.
import type { ConfirmationLevel, ToolCallFacts } from './confirmation';

/**
 * Порядок строгости уровней — ЕДИНСТВЕННЫЙ в коде. `Reconfigures` весит своим (`RECONFIGURES_WEIGHT`
 * в `confirmation.ts`): там шкала объектов перенастройки, здесь — шкала уровней подтверждения.
 */
export const LEVEL_ORDER: readonly ConfirmationLevel[] = [
  'execute',
  'preview',
  'explicit-confirmation',
  'forbidden',
];

export function stricter(a: ConfirmationLevel, b: ConfirmationLevel): ConfirmationLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

/**
 * Ниже чего правило опустить не может; `null` — пола нет вовсе.
 *
 * `objectForbidden` — пре-чек фона (`routineDeferForbidden`, `tools/dispatch-common.ts`): он ASYNC
 * и смотрит цели операций, поэтому сюда приезжает готовым ответом, а не считается здесь. Ряды 3
 * (архивация) и 5 (масштаб пачки) в пол НЕ входят намеренно: «семья всегда молча» и «банк
 * записал пачкой» (§Б4-5 №1, №6) без понижения этих рядов невыразимы, а защищают они не
 * устройство системы, а осторожность — её владелец вправе настроить (В-2).
 */
export function floorLevel(
  facts: ToolCallFacts,
  objectForbidden = false,
): ConfirmationLevel | null {
  let floor: ConfirmationLevel | null = null;
  const raise = (level: ConfirmationLevel): void => {
    floor = floor === null ? level : stricter(floor, level);
  };
  if (!facts.known) raise('forbidden'); // ряд 1
  if (facts.reconfigures === 'behavior-delta' || facts.reconfigures === 'system-object') {
    raise('explicit-confirmation'); // ряд 4а
  }
  if (facts.grantsAutonomy && facts.actorKind !== 'owner') raise('explicit-confirmation'); // ряд 6
  if (objectForbidden) raise('forbidden'); // §С2-1 ряд 3
  return floor;
}
