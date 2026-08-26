// apps/server/src/agent-loop/sweep.ts
// Подметание брошенных прогонов (С6, инвариант 6): прогон, у которого дольше порога нет
// ни одного шага, помечается `abandoned`, а его тикет перестаёт висеть `in_progress`.
//
// У рутинного прогона (V1.12) исход другой — `failed`: за ним стоял НАШ процесс, и его
// остановка — провал попытки бакета, который раннер вправе перезапустить, а не брошенная
// человеком работа, которую владелец пойдёт разбирать руками.
//
// Зовётся ДВУМЯ путями и только ими: `orbis_my_queue` (агент пришёл за работой) и
// экраны проекта/тикета (Задача 13). Отдельного фонового процесса нет намеренно —
// инвариант «тикет не висит in_progress навсегда» не должен зависеть ни от расписания,
// ни от того, что какой-то агент однажды позовёт очередь.
import { newId } from '@orbis/shared';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind } from '../executor/types';
import { listRunUnits } from '../policy/pending';
import { RUN_STALE_AFTER_MS } from './constants';
import { type RunRow, runsOfParent, staleRuns, ticketOfRun } from './queries';

// Боевой синк — один инстанс на модуль (состояния не хранит), как в tools/dispatch.ts.
const sink = makeChatJournalSink();

export interface SweepArgs {
  ownerId: string;
  /** Кто дёрнул подметание: агент (пришёл за очередью) или владелец (открыл экран). */
  actorKind: ActorKind;
  actorGrantId?: string;
  clock?: () => Date;
  staleAfterMs?: number;
}

/**
 * Текст, который читает человек в `waiting_for` тикета и в `abandon_note` прогона.
 * Один на оба поля намеренно: тикет отвечает «что делать дальше», прогон — «что было»,
 * но причина у них общая, и расхождение двух формулировок читалось бы как два события.
 */
function abandonNote(run: RunRow, idleMs: number): string {
  const minutes = idleMinutes(idleMs);
  const last = run.run.steps.at(-1);
  const external = run.run.steps.filter((s) => s.external).length;
  return (
    `Прогон оборван (нет шагов ${minutes} мин). Последний шаг: «${last?.summary ?? '—'}»; ` +
    `шагов с внешним эффектом: ${external}. ` +
    'Проверьте остатки работы (ветки, файлы) и верните тикет в работу.'
  );
}

function idleMinutes(idleMs: number): number {
  return Math.round(idleMs / 60_000);
}

/**
 * Заметка о провале рутинного прогона (V1.12). Короткая и без разбора остатков, в отличие
 * от `abandonNote`: разбирать владельцу нечего — прогон рутины не трогает внешний мир
 * иначе как через executor, а его записи откатываются штатным Undo.
 */
function failNote(idleMs: number): string {
  return (
    `прогон прерван: нет шагов дольше ${idleMinutes(idleMs)} мин ` +
    '(процесс остановлен или завис)'
  );
}

/**
 * Помечает брошенные прогоны и чинит статус их тикетов. Возвращает, сколько прогонов
 * реально подмели, — число едет в ответ `orbis_my_queue`, чтобы агент понимал, почему
 * тикет вдруг снова свободен.
 *
 * Каждый прогон — СВОЙ `execute`-batch, а не один общий: подметание одного прогона не
 * должно откатываться из-за гонки на соседнем (поздний шаг успел лечь между чтением и
 * записью). Предусловия делают операцию идемпотентной по состоянию: CONFLICT здесь —
 * штатный исход «уже не наше дело», а не отказ.
 */
export async function sweepStaleRuns(db: Db, args: SweepArgs): Promise<{ swept: number }> {
  const clock = args.clock ?? (() => new Date());
  const staleAfterMs = args.staleAfterMs ?? RUN_STALE_AFTER_MS;
  const now = clock();
  const before = new Date(now.getTime() - staleAfterMs);

  const stale = await withIdentity(db, args.ownerId, (tx) => staleRuns(tx, before));
  let swept = 0;
  for (const run of stale) {
    // Субъект прогона (V1.4) решает и исход, и то, есть ли вообще тикетная половина:
    // родитель рутинного прогона — сама рутина, тикета у него нет по устройству.
    const isRoutineRun = run.run.routine_id !== undefined;
    const ticket = isRoutineRun
      ? null
      : await withIdentity(db, args.ownerId, (tx) => ticketOfRun(tx, run.id));
    // Статус тикета трогает ТОЛЬКО его последний прогон. Двух running-прогонов у тикета
    // хватает одного ручного жеста владельца («верни в planned» при живом прогоне A →
    // захват B), и тогда подметание старого хвоста A выбивало бы из работы тикет, над
    // которым прямо сейчас работает B. Порядок — тот же created_at ASC, что у очереди и
    // экрана истории: «последний» здесь значит то же, что видит человек.
    const isLastRun =
      ticket !== null &&
      (await withIdentity(db, args.ownerId, async (tx) => {
        const runs = await runsOfParent(tx, ticket.id);
        return runs.at(-1)?.id === run.id;
      }));
    const idleMs = now.getTime() - new Date(run.run.last_step_at).getTime();
    const note = isRoutineRun ? failNote(idleMs) : abandonNote(run, idleMs);
    // «Тронул ли внешнее» решает не последний шаг, а весь прогон: агент мог создать
    // ветку первым шагом и упасть на пятом — остатки от этого никуда не делись (С6).
    const hasEffect = run.run.steps.some((s) => s.external);
    // Флажок пачки (D42 ОЧ.6, С1 ревью): смерть процесса не имеет права потерять «у этого
    // прогона осталось нерешённое». Для рутины подметание — не экзотика, а ШТАТНЫЙ конец
    // прогона: «рестарт и сон — основной вид сбоя» (V1.12) на засыпающем инстансе. Не
    // поставив флажок здесь, мы оставили бы владельцу пачку, о которой он не узнает, —
    // карточки в треде лежат, а бейдж и смарт-лист читают только аспект.
    //
    // Сами единицы подметание НЕ трогает: они переживают прогон и ждут решения владельца
    // либо гашения следующим прогоном (ОЧ.8). У ГРАНТОВОГО прогона пробы нет и флажка нет —
    // единиц у него не бывает (`orbis_ask` внешнему исполнителю закрыт гейтом ОЧ.12).
    //
    // Своё `withIdentity` — по образцу `ticketOfRun` выше; владелец тот же, и это контракт
    // `listRunUnits`, а не деталь: под чужой идентичностью судьбы молча не найдутся и
    // решённая пачка прочиталась бы открытой.
    const undecided =
      isRoutineRun &&
      (await withIdentity(db, args.ownerId, async (tx) =>
        (await listRunUnits(tx, args.ownerId, run.id)).some((u) => u.fate === 'open'),
      ));

    const operations: Array<{ tool: string; input: unknown }> = [
      {
        tool: 'entity_update',
        input: {
          id: run.id,
          // CAS: прогон всё ещё running И отметка живости та же, что мы прочитали.
          // Вторая половина — не перестраховка: между выборкой и записью мог лечь
          // шаг, и тогда прогон живой, а не брошенный.
          precondition: [
            { aspect: 'orbis/agent-run', field: 'outcome', in: ['running'] },
            { aspect: 'orbis/agent-run', field: 'last_step_at', in: [run.run.last_step_at] },
          ],
          aspects: {
            'orbis/agent-run': {
              // Заметка ложится в СВОЁ поле исхода: `abandon_note` читается экранами как
              // «работа брошена, разберите остатки», а `fail_note` — как «попытка не
              // удалась»; одно поле на два разных события врало бы обоим.
              ...(isRoutineRun
                ? // Флажок — в ТОТ ЖЕ CAS-патч, что исход: отдельной записью он либо
                  // проиграл бы гонку тому же предусловию, либо лёг бы на прогон, который
                  // подмести не удалось. Пишется только `true` — «нерешённого нет» флажком
                  // не отмечается (снятие — работа процедур решения и гашения, ОЧ.6)
                  { outcome: 'failed', fail_note: note, ...(undecided && { undecided: true }) }
                : { outcome: 'abandoned', abandon_note: note }),
              finished_at: now.toISOString(),
            },
          },
        },
      },
    ];

    // Тикет чинится, только если он ДЕЙСТВИТЕЛЬНО висит в работе: владелец мог вернуть
    // его руками, и переписывать его статус задним числом сервер права не имеет.
    if (
      ticket !== null &&
      isLastRun &&
      ticket.aspectsLegacy['orbis/task']?.status === 'in_progress'
    ) {
      operations.push({
        tool: 'entity_update',
        input: {
          id: ticket.id,
          precondition: [{ aspect: 'orbis/task', field: 'status', in: ['in_progress'] }],
          aspects: {
            'orbis/task': hasEffect
              ? // Эффект был — возврат в planned запрещён (С6): он стёр бы факт, что
                // работа велась, и следующий агент наткнулся бы на чужую ветку
                { status: 'waiting', waiting_for: note }
              : // Эффекта не было — безопасно перезапустить; чужой хвост waiting_for
                // снимаем (null удаляет поле при merge аспекта)
                { status: 'planned', waiting_for: null },
          },
        },
      });
    }

    const r = await execute(
      db,
      {
        actorUserId: args.ownerId,
        actorKind: args.actorKind,
        // Обслуживание инварианта 6, а не решение актора: «отмени последнее» такие
        // записи пропускает (undo.ts findLastUndoable), иначе первое же «отмени»
        // после чтения очереди отменяло бы подметание вместо действия человека.
        // Точечный откат по-прежнему возможен — по run_id (Задача 13).
        source: 'system',
        // Механизм — глагол исполнителя (§А4-4): подметание закрывает прогон и пишет его
        // служебные свойства, а они `system_writable` (§А2-5).
        mechanism: 'verb',
        ...(args.actorGrantId !== undefined && { actorGrantId: args.actorGrantId }),
        runId: run.id,
        batchId: newId(),
        operations,
        clock,
      },
      { sink },
    );
    if (r.ok) {
      swept++;
      continue;
    }
    // Предусловие не выполнено — прогон уже не наш: поздний шаг успел лечь либо
    // конкурентное подметание закрыло его первым. Штатный исход, идём дальше.
    if (r.error.code === 'CONFLICT') continue;
    // Любой другой отказ — дефект, а не состояние графа: проглотить его значило бы
    // превратить «инвариант 6 не держится» в «swept почему-то ноль». Поднимаем
    // доменной ошибкой — вызывающий глагол вернёт её структурным отказом, не 500.
    throw new ExecError(
      r.error.code as ExecErrorCode,
      `подметание прогона не удалось: ${r.error.message}`,
      { run_id: run.id, details: r.error.details },
    );
  }
  return { swept };
}
