// apps/server/src/policy/sensitivity.ts
// ФАКТЫ ЧУВСТВИТЕЛЬНОСТИ ВЫЗОВА КАК ДАННЫЕ (§С8-23, §Б1-2, рамка Б1.12).
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ДОМ, А НЕ ВЕТКА В `confirmation.ts`. Классификатор §7.10 чист по
// построению — типизированные факты вызова, без БД (докблоки `ownRegistryAddress` и
// `grantsRoutineAutonomy` там же). Словарь фактов — СТРОКА РЕЕСТРА, и читать её умеет только
// тот, у кого на руках снимок; в диспатче он есть (`runMutation`, `pre.reg`).
//
// ЧТО ЗДЕСЬ ПРОИСХОДИТ ПО СУЩЕСТВУ: два факта, которые политика и так знала ТИПАМИ
// (`reconfigures`, `grantsAutonomy`), получают ИМЕНА ИЗ СЛОВАРЯ владельца. Это и есть весь
// объём §С8-23 в Б-1 (Р14): «два существующих факта опубликованы как данные».
//
// ПОТРЕБИТЕЛЬ МНОЖЕСТВА — `assign_level` через контекст `$sensitivity` (§Б3-2а, Е-4), и он
// приезжает в Б-2 вместе с действиями. В Б-1 множество ПУБЛИКУЕТСЯ: едет полем фактов вызова,
// сторожится тестами и — главное — сверяется со словарём на каждом вызове (ниже). Названо
// вслух, чтобы поле не приняли за забытый вход таблицы §7.10: сегодня уровень его не читает,
// и это пиннится тришкой в `confirmation.test.ts`.
//
// ТРЁХ ОСТАЛЬНЫХ ФАКТОВ СЛОВАРЯ (`touches_money`, `external`, `irreversible`) ТИПЫ ВЫЗОВА не
// производят, и это не пропуск: они назначаются ДЕКЛАРАЦИЯМИ действий (`sensitivity` §Б6-1) и
// выводятся из шагов (`stepFactsOf`, `registry/actions.ts`) — и доезжают сюда параметром
// `extra` (Р-К-23), а тулы не-исполнителя — таблицей `TOOL_SENSITIVITY` ниже. `archives` в
// фактах вызова к `irreversible` не сводится — архивация это мягкое удаление, обратимое
// штатным undo (§7.8), — поэтому вход берётся целиком, а отображения у него нет.
import type { ContractId, SensitivityFact } from '@orbis/shared';
import type { RegistrySnapshot } from '../registry/load';
import type { ToolCallFacts } from './confirmation';

/** Адрес словаря; `satisfies` не даёт ему разойтись с сидом контрактов (задача 1). */
const SENSITIVITY_CONTRACT = 'orbis/sensitivity' satisfies ContractId;

/**
 * ФАКТЫ ТУЛОВ НЕ-ИСПОЛНИТЕЛЯ (Р-К-23): тул, который не разложен на операции графа и потому
 * свёрткой не описывается. Пуст до задачи 10, где сюда приезжает `budget_rollover:
 * ['touches_money']`. Пустая таблица названа вслух, потому что её отсутствие читалось бы
 * как «таких тулов не бывает».
 */
export const TOOL_SENSITIVITY: Readonly<Record<string, readonly SensitivityFact[]>> = {};

/**
 * Имена фактов вызова. `extra` — факты, которые знает только вызывающий (§Б6-1: декларация
 * действия ∪ факты его резолвленных шагов, `actions/run.ts`); они ОБЪЕДИНЯЮТСЯ с выведенными
 * из типов, и дубли не задваиваются — правило владельца читает имена, а не счёт.
 */
export function sensitivityFactsOf(
  reg: RegistrySnapshot,
  facts: Pick<ToolCallFacts, 'tool' | 'reconfigures' | 'grantsAutonomy' | 'archives'>,
  extra: readonly SensitivityFact[] = [],
): readonly SensitivityFact[] {
  const produced = new Set<SensitivityFact>();
  // §С2-1 дословно: «Мутация реестра — категория чувствительности „меняет, что видит и делает
  // владелец“ (факт `changes_registry`)». Все три ненулевых ответа — мутация реестра.
  if (facts.reconfigures !== 'none') produced.add('changes_registry');
  if (facts.grantsAutonomy) produced.add('grants_autonomy');
  // §Б6-1: «декларация факты может только ДОБАВЛЯТЬ». Вычитания здесь нет и быть не может.
  // Свой ключ, а не `[tool]`: у `{}` есть `toString`, и имя тула, совпавшее с ключом прототипа,
  // дало бы здесь функцию вместо списка.
  const byTool = Object.hasOwn(TOOL_SENSITIVITY, facts.tool) ? TOOL_SENSITIVITY[facts.tool] : [];
  for (const fact of byTool ?? []) produced.add(fact);
  for (const fact of extra) produced.add(fact);
  return checkedAgainstDictionary(reg, [...produced], facts.tool);
}

/**
 * СЛОВАРЬ — ИСТОЧНИК ИМЁН, А НЕ ДЕКОРАЦИЯ. Факт, которого нет в контракте, — расхождение кода
 * и сида, и молчать о нём нельзя: в Б-2 по этим именам будут писаться правила владельца, и
 * правило про несуществующий факт не сработает НИКОГДА, не сказав ни слова. Отказ — `Error`,
 * а не `ExecError`: это дефект сборки, а не отказ вызову (тот же жанр, что
 * `throw new Error('classifyToolCall: неожиданный уровень …')` в `tools/dispatch.ts`).
 */
function checkedAgainstDictionary(
  reg: RegistrySnapshot,
  produced: readonly SensitivityFact[],
  tool: string,
): readonly SensitivityFact[] {
  const def = reg.contracts.get(SENSITIVITY_CONTRACT);
  if (def === undefined || def.kind !== 'facts') {
    throw new Error(
      `словарь фактов «${SENSITIVITY_CONTRACT}» отсутствует в снимке реестра: сид не прогонялся (bun run db:prepare)`,
    );
  }
  const known = new Set(def.facts.map((f) => f.key));
  for (const fact of produced) {
    if (!known.has(fact)) {
      throw new Error(
        `факт «${fact}» (тул «${tool}») отсутствует в словаре «${SENSITIVITY_CONTRACT}»: код и сид разошлись`,
      );
    }
  }
  return produced;
}
