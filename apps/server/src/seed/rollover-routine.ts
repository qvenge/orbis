// apps/server/src/seed/rollover-routine.ts
// Рутина модуля Финансы «Перенос остатков» (В-4, Р-29, Р-К-38) — второй дом переноса остатков
// рядом с инструментом `budget_rollover` (§Б6-5 ревизии 4). Правило-носитель параметров (§Б4-3)
// говорит, КАК переносить; эта рутина — КОГДА: автоматизация во времени в ядре одна — рутины и
// планировщик, и отдельного триггера «конец периода» не заводится.
//
// ПОЧЕМУ РЕЖИМ `act`, А НЕ `propose` (Р-К-38, В-П-7 — эррата слова `propose` в В-4, намерение
// сохранено). В `propose` рутине из мутаций доступен РОВНО `orbis_propose` (`tools/registry.ts`,
// `routineToolAllowed`), а тот принимает только правки ГРАФА (`PROPOSAL_ALLOWED_TOOLS`) — перенос в
// предложении невыразим, и посеянная в `propose` рутина не смогла бы ничего. Тот же вывод, что у
// садовника (Р-16-1, докблок `seed/gardener.ts`).
//
// ПРАВ ЭТО НЕ РАСШИРЯЕТ: фон НИКОГДА не исполняет перенос сам (Р-К-39) — вызов `budget_rollover` из
// прогона ложится отложенной единицей D42 при любом уровне таблицы, и конверты заводит «Принять»
// владельца. «Предпросмотр и „да“» из В-4 — это и есть единица с карточкой. Пин — тестом.
//
// СЕВ — ПО ОБРАЗЦУ САДОВНИКА ДОСЛОВНО: проба по PK, `execute` своей транзакцией, `source: 'system'`,
// `mechanism: 'seed'`, без синка (журнал сева — шум, и сев не должен становиться «последним
// действием» для `undo_last`). Доводы каждого пункта — в докблоке `seedGardener`.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { Identity } from '../identity';
import { seedRoutineId } from './gardener';

export const ROLLOVER_ROUTINE_SLUG = 'budget-rollover';
export const ROLLOVER_ROUTINE_TITLE = 'Перенос остатков';
/** Белый список — РОВНО инструмент переноса (В-4): всё остальное рутине здесь не нужно. */
export const ROLLOVER_ROUTINE_ALLOWED_TOOLS = ['budget_rollover'] as const;

/**
 * Свойства рутины (§А1-1 — плоско по id свойства).
 *
 * ДНЯ МЕСЯЦА В РАСПИСАНИИ НЕТ, и это факт реестра, а не упущение сида: `orbis/routine_days` —
 * перечень дней НЕДЕЛИ (`builtin-properties.ts`, варианты mo…su). Поэтому свойство не задаётся вовсе
 * («каждый день» — умолчание аспекта, `builtin-aspects.ts`), а «только первого числа» говорит
 * ТЕЛО, и первым же шагом прогон завершается, если сегодня не первое. Цена названа вслух: двадцать
 * девять коротких прогонов в месяц вместо одного (Р-К-41).
 */
export const ROLLOVER_ROUTINE_PROPS: Readonly<Record<string, unknown>> = {
  'orbis/routine_stage': 'active',
  'orbis/routine_at': '09:00',
  // Р-К-38 (В-П-7): `act` с белым списком из одного тула — в `propose` рутине доступен только
  // `orbis_propose`, а тот принимает лишь правки графа; перенос в предложении невыразим. Прав это не
  // расширяет: фон всегда кладёт отложенную единицу (Р-К-39), сам перенос не исполняет.
  'orbis/routine_mode': 'act',
  'orbis/allowed_tools': [...ROLLOVER_ROUTINE_ALLOWED_TOOLS],
};

/**
 * ИНСТРУКЦИЯ — тело сущности (V1.1: «что делать» у рутины лежит в теле обычным текстом). Отчёт —
 * финальный текст хода (довод садовника: `thread_post` рутине не открыт, а `orbis_ask` — вопрос, а не
 * отчёт).
 */
export const ROLLOVER_ROUTINE_BODY = `Ты переносишь остатки бюджета в новый месяц.

Шаг 0. Календарь.
- Переносить остатки нужно ОДИН раз, в первое число месяца. Если сегодня не первое число — завершайся сразу и ничего не делай: одной строкой «не первое число — перенос не нужен».

Шаг 1. Предпросмотр.
- Возьми предпросмотр переноса на текущий месяц: по каждой категории он даёт остаток прошлого месяца (carryover) и предлагаемый лимит (suggestedLimit).
- Строк нет — переносить нечего, так и напиши. Предпросмотр говорит «первый месяц без истории» — не предлагай суммы, а спроси владельца, с каких лимитов начать.

Шаг 2. Перенос.
- Зови budget_rollover ОДИН раз: month — текущий месяц, rows — строки предпросмотра как есть (categoryId, limit, carryover), batchId — новый id вызова.
- Суммы сам не досчитывай и не округляй: их считает предпросмотр, а расхождение владелец прочтёт как ошибку в деньгах.
- Ответ «pending_confirmation» — НЕ отказ: карточка ушла владельцу, он подтвердит сам. Продолжай и не повторяй вызов.

Отчёт (финальный текст хода): сколько конвертов перенесено, какова суммарная сумма остатка и какие категории остались без переноса и почему.`;

/**
 * Сев рутины — ОТДЕЛЬНОЙ транзакцией, ПОСЛЕ сева мира и садовника (`seedOwner`), проба по PK —
 * досев для владельцев, засиденных до задачи 10 (тот же довод, что у `seedGardener`).
 */
export async function seedRolloverRoutine(
  db: Db,
  who: Identity,
  clock: () => Date = () => new Date(),
): Promise<{ seeded: boolean; id: string }> {
  const id = seedRoutineId(who.graph, ROLLOVER_ROUTINE_SLUG);
  const existing = await withIdentity(db, who, (tx) =>
    tx.execute(sql`SELECT 1 FROM entities WHERE id = ${id}::uuid AND graph_id = ${who.graph}`),
  );
  if (existing.length > 0) return { seeded: false, id };
  const r = await execute(db, {
    identity: who,
    actorKind: 'owner',
    source: 'system',
    mechanism: 'seed',
    operations: [
      {
        tool: 'entity_create',
        input: {
          id,
          title: ROLLOVER_ROUTINE_TITLE,
          emoji: '🔁',
          body: ROLLOVER_ROUTINE_BODY,
          tags: ['routine'],
          aspects: ['orbis/routine'],
          props: { ...ROLLOVER_ROUTINE_PROPS },
        },
      },
    ],
    clock,
  });
  // Отказ НЕ глушится — довод садовника: посеянная наполовину доверенность хуже отсутствующей, а
  // повторный заход досеет рутину пробой по PK выше.
  if (!r.ok) throw new Error(`сев рутины «Перенос остатков»: ${r.error.code} ${r.error.message}`);
  return { seeded: true, id };
}
