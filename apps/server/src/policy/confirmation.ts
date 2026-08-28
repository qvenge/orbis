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
  /**
   * Выдача автономии рутине (V1.10): создание/attach рутины с `mode: 'act'` либо правка
   * её доверенности (`mode`/`allowed_tools`). Право писать в граф без спроса выдаёт только
   * владелец — модели и внешнему агенту оно достаётся через карточку подтверждения.
   */
  grantsAutonomy: boolean;
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
 * | grantsAutonomy && !owner     | explicit-confirmation  | V1.10: право рутины писать в граф выдаёт только владелец |
 * | isBatch                      | preview                | bounded-масштаб: исполнить + информационный diff |
 * | иначе (одиночная мутация)    | execute                | single, обратимо (inverse в журнале §7.8) |
 *
 * actorKind — вход политики §7.10; MVP-таблица ветвится по нему ровно в одном ряду —
 * автономии рутины (V1.10): владельцу подтверждать нечего, он и есть тот, у кого спрашивают.
 * Прочие ряды по актору не ветвятся: ряд archives адресует инициативу модели/агента, а
 * owner-актор до классификатора обычно не доходит (прямые действия владельца идут
 * UI-роутерами мимо dispatch).
 *
 * Ряд автономии стоит ВЫШЕ «isBatch → preview» намеренно: preview исполняет действие и лишь
 * показывает diff, то есть batch из двух операций провёз бы выдачу прав молча.
 */
export function classifyToolCall(facts: ToolCallFacts): ConfirmationLevel {
  if (!facts.known) return 'forbidden';
  if (facts.kind === 'read') return 'execute';
  if (facts.archives && !facts.explicitCommand) return 'explicit-confirmation';
  if (facts.isBatch && facts.batchSize !== undefined && facts.batchSize > 10) {
    return 'explicit-confirmation';
  }
  if (facts.grantsAutonomy && facts.actorKind !== 'owner') return 'explicit-confirmation';
  if (facts.isBatch) return 'preview';
  return 'execute';
}

/**
 * Извлечение фактов формы вызова из (def, input). Контракт (fix round Task 5; §7.10
 * дословно: уровень получает tool-call ПОСЛЕ структурной валидации input'а): dispatch
 * передаёт сюда уже envelope-ВАЛИДИРОВАННЫЙ input (validateMutationEnvelope /
 * validateBatchOperations) — классификация невалидированного payload'а в dispatch не
 * происходит. Ветки на сырой input (не-объект → archives false, невалидный
 * batch-envelope → fallback «не batch») сохранены как защитные и покрыты юнитами:
 * функция не падает на мусоре, а невалидный вызов отклоняет валидация вызывающего.
 * Акторные факты (actorKind, explicitCommand) добавляет вызывающий из ToolCallCtx;
 * known: true — сюда доходит только найденный реестром def, ряд «!known» dispatch
 * строит сам по результату резолва.
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
        // ЛЮБАЯ операция batch, выдающая автономию, поднимает уровень всего вызова:
        // batch исполняется «всё или ничего», подтверждать его тоже приходится целиком
        grantsAutonomy: parsed.data.operations.some((op) =>
          grantsRoutineAutonomy(op.tool, op.input),
        ),
      };
    }
    return { ...base, archives: false, isBatch: false, grantsAutonomy: false };
  }
  return {
    ...base,
    // Архивация — только entity_update (§9.2: archived есть лишь в его envelope);
    // archived в чужом strict-envelope — невалидный input, честный отказ
    // envelope-валидации dispatch (fix round) ещё до классификации
    archives: def.name === 'entity_update' && isRecord(input) && input.archived === true,
    isBatch: false,
    grantsAutonomy: grantsRoutineAutonomy(def.name, input),
  };
}

/**
 * Выдаёт ли одна операция автономию рутине (V1.10): `mode: 'act'` — это доверенность писать
 * в граф без спроса, а `allowed_tools` — её область. Правка ЛЮБОГО из двух полей считается
 * выдачей, включая возврат в `propose`: разоружение рутины владелец обязан видеть так же,
 * как её вооружение, иначе модель тихо снимала бы права, о которых он думает, что они есть.
 * Правка расписания (`at`, `days`) и жизненного цикла (`stage`) доверенности не касается.
 *
 * Имя тула — единственный вход помимо payload'а: у attach-пути (`attach_orbis_routine`)
 * аспект в имени, у create/update доверенность лежит в `props` по СВОЙСТВАМ
 * `orbis/routine_mode` и `orbis/allowed_tools` (§А9-1). Прежде она читалась из старой карты
 * (`aspects['orbis/routine']`), и с переводом контрактов тулов замок остался бы висеть на
 * форме, которой модель больше не пользуется, — то есть перестал бы держать.
 *
 * Свойства адресуются id, а не `key`: у встроенных они совпадают (§А2-1), а подменить
 * встроенное свойство своей строкой с тем же ключом владелец не может — частичный индекс
 * реестра разводит собственные и системные записи по разным namespace'ам. Форма проверяется
 * защитно (input сюда доезжает уже envelope-валидированным, см. докблок factsFromToolCall).
 */
const ROUTINE_MODE = 'orbis/routine_mode';
const ROUTINE_ALLOWED_TOOLS = 'orbis/allowed_tools';

export function grantsRoutineAutonomy(tool: string, input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (tool === 'attach_orbis_routine') {
    return isRecord(input.data) && input.data[ROUTINE_MODE] === 'act';
  }
  if (tool !== 'entity_create' && tool !== 'entity_update') return false;
  const props = input.props;
  if (!isRecord(props)) return false;
  // create: правами наделяет только act — рутина в propose всё равно спросит владельца.
  // update: патч дописывает свойства в живую запись, поэтому значим сам ФАКТ правки
  // доверенности, а не значение (act ↔ propose и правка белого списка — одно решение).
  if (tool === 'entity_create') return props[ROUTINE_MODE] === 'act';
  return ROUTINE_MODE in props || ROUTINE_ALLOWED_TOOLS in props;
}

/**
 * Diff карточки preview (§7.10) для entity_update: новые значения — operations[0].payload
 * журнала §7.8 («как исполнено», после нормализаций), прежние — inverse[0].payload;
 * id — не изменение, исключается. Поле, которого прежде не было, честно даёт
 * before: undefined.
 *
 * Свойства раскрываются ПОШТУЧНО, каждое своей строкой. С §А7-4 они приезжают мешком
 * (`props`, `unset`), и обход по верхним ключам показал бы владельцу одну строку «props:
 * {объект} → {объект}» вместо перечня правок — то есть карточка подтверждения перестала бы
 * называть, что именно подтверждают. Снятое свойство — строка с `after: undefined`, ровно
 * так же, как добавленное даёт `before: undefined`.
 *
 * `aspects` строкой и остаётся: это смена интерпретации (`{attach, detach}`), а не значение
 * свойства, и разбирать её на поля было бы враньём про то, что изменилось.
 */
export function entityUpdatePreviewDiff(
  action: Pick<ActionRecord, 'operations' | 'inverse'>,
): Record<string, { before: unknown; after: unknown }> {
  const after = action.operations[0]?.payload ?? {};
  const before = action.inverse[0]?.payload ?? {};
  const afterProps = (after.props ?? {}) as Record<string, unknown>;
  const beforeProps = (before.props ?? {}) as Record<string, unknown>;
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === 'id' || key === 'props' || key === 'unset') continue;
    diff[key] = { before: before[key], after: value };
  }
  for (const [propertyId, value] of Object.entries(afterProps)) {
    diff[propertyId] = { before: beforeProps[propertyId], after: value };
  }
  // Снятое операцией: прежнее значение лежит в inverse — им откат его и возвращает
  for (const propertyId of (after.unset ?? []) as string[]) {
    diff[propertyId] = { before: beforeProps[propertyId], after: undefined };
  }
  return diff;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
