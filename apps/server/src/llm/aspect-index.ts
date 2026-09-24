// apps/server/src/llm/aspect-index.ts
//
// Индекс аспектов системного канала — чата (`llm/context.ts`) и прогона рутины
// (`routines/context.ts`), срез 1а, спека §10 п. 1–2.
//
// Почему индекс, а не инструкции. Инструкция аспекта (`ai_instructions`) живёт ровно в одном
// месте — описании тула `attach_<аспект>` (§Б7-2 спеки реформы): модель читает её там, где
// навешивает аспект. Прежняя секция «Инструкции активных аспектов» несла тот же текст второй
// копией в каждом вызове (≈ 1 170 токенов, §С8-35 п. 3). Каналу нужна КАРТА — какие аспекты
// есть и что каждый значит, — чтобы модель знала, какой тул звать; поля и правила остаются в
// описании тула.
//
// Источник — ЭФФЕКТИВНЫЙ реестр (`effectiveRegistry`): подпись и описание аспекта владелец
// меняет дельтой, и индекс обязан показать модели его слова, а не строку сида. Сырые строки
// (`loadRegistryRows`) дали бы модели имя, которого владелец на экране уже не видит.
//
// Один сборщик на оба канала: собранный дважды, индекс разъехался бы форматом — и рутина в
// фоне видела бы аспекты иначе, чем чат.
import type { GraphId } from '@orbis/shared';
import {
  AUTHORING_DEFERRED_ASPECTS,
  effectiveLabel,
  isModuleEnabled,
  OWNER_LOCALE,
} from '@orbis/shared';
import type { Tx } from '../db/with-identity';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';

export const ASPECT_INDEX_HEADING = 'Аспекты (поля и правила — в описании тула attach_<аспект>):';
/** РП-26: последняя строка индекса — граница служебных аспектов (id через запятую), без описаний. */
export const SERVICE_BOUNDARY_PREFIX = 'Служебные — не навешивай и не правь сам: ';
/**
 * Хвост строки-границы: КАК служебный аспект читать. Компилятор запросов прячет служебные аспекты
 * из выдачи, пока запрос не назовёт их явно (`query/compile-ast.ts`, §А5-6), — и без этой
 * подсказки модель, искавшая прогоны тикета без `aspect=`, честно ответила бы «прогонов нет».
 */
export const SERVICE_BOUNDARY_SUFFIX = ' (в выдачах их нет — запрашивай явно aspect=<id>)';

/** Чистая часть: строки индекса по снимку и маске. Порядок — rank, затем key. */
export function aspectIndexLines(reg: RegistrySnapshot, disabled: readonly string[]): string[] {
  const lines = [...reg.aspects.values()]
    // Служебный аспект модели не предлагается — ни тулом (`buildToolDefs`), ни строкой индекса.
    .filter((a) => !a.service)
    // РП-1 (срез 1а): аспекты с отложенным авторством агентом — ни строкой индекса, ни в строке-
    // границе (они НЕ служебные: их записи в выдачах есть). Тот же список, что у `buildToolDefs`.
    .filter((a) => !AUTHORING_DEFERRED_ASPECTS.includes(a.id))
    // §Б8-3: аспект выключенного модуля уходит вместе с модулем — та же маска, что у тулов.
    .filter((a) => isModuleEnabled(a.module, disabled))
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key))
    .map(
      (a) =>
        `- ${a.id} — ${effectiveLabel(a.label, OWNER_LOCALE)}: ${effectiveLabel(a.description, OWNER_LOCALE)}`,
    );
  // РП-26: служебный аспект тула не имеет, и обе его границы раньше доходили до модели только текстом
  // инструкции в секции: запрет записи («не навешивай сам») и способ чтения («в основных выдачах не
  // показывается — запрашивай явно через aspect=…»). Индекс держит обе одной строкой-границей — без
  // описания и инструкции: уйди хоть одна, модель либо правила бы прогон, либо не находила бы его.
  const service = [...reg.aspects.values()]
    .filter((a) => a.service && isModuleEnabled(a.module, disabled))
    .sort((a, b) => a.rank - b.rank)
    .map((a) => a.id);
  return service.length === 0
    ? lines
    : [...lines, `${SERVICE_BOUNDARY_PREFIX}${service.join(', ')}${SERVICE_BOUNDARY_SUFFIX}`];
}

/**
 * Секция канала; null — индекс пуст. Зовут llm/context.ts и routines/context.ts.
 *
 * Маска `disabled` приходит от вызывающего, а не читается здесь: чат читает её один раз на
 * сборку для двух секций (проза модулей и индекс). Умолчания `[]` у параметра нет намеренно —
 * оно оставило бы канал без маски молча.
 */
export async function aspectIndexSection(
  tx: Tx,
  graphId: GraphId,
  disabled: readonly string[],
): Promise<string | null> {
  const lines = aspectIndexLines(await effectiveRegistry(tx, graphId), disabled);
  return lines.length === 0 ? null : `${ASPECT_INDEX_HEADING}\n${lines.join('\n')}`;
}
