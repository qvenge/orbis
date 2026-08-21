// apps/server/src/routines/ask.ts
// `orbis_ask` (D42 ОЧ.5, ОЧ.9, ОЧ.10, ОЧ.12) — НЕтерминальный вопрос владельцу из прогона
// рутины: карточка ложится в тред рутины, модель получает `pending_id` и РАБОТАЕТ ДАЛЬШЕ.
//
// Зачем отдельный тул, когда чекпойнт уже есть: чекпойнт ТЕРМИНАЛЕН — один вопрос стоит
// прогону всей оставшейся работы. Это и была боль среза. Терминальный путь остаётся для
// «без ответа дальше бессмысленно», и выбор между ними делает модель; объясняет ей разницу
// промпт, а сервер лишь честно исполняет оба (`TERMINAL_TOOLS` этот тул не знает).
//
// Почему модуль, а не глагол `agent-loop/verbs.ts` (рулинг Р-1 плана): ветка глаголов в
// диспатче требует уровня `execute` и на любом другом отвечает VALIDATION «инвариант 4» —
// то есть pending, которым вопрос и является, там запрещён по построению. Образец —
// `routines/propose.ts` (`runPropose`), но БЕЗ закрытия прогона.
//
// ПОРЯДОК ШАГОВ ЗНАЧИМ и повторяет ветку отложки (`tools/dispatch.ts`, deferRoutineUnit):
// проба существования по PK → есть запись, значит это РЕТРАЙ (капом он не отвергается) →
// иначе счёт открытых единиц → кап → запись. Наивный порядок «кап → запись» отверг бы
// повтор ДЕСЯТОГО вопроса: модель, переспросившая после сетевого чиха, получила бы «пачка
// полна» на том, что уже стоит в пачке, и стала бы чинить не то.
import { type AskInput, type AskResult, pendingMessageId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { ensureEntityThread } from '../chat/threads';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { askDedupeKey, createPending, listRunUnits } from '../policy/pending';
import type { ToolCallCtx, ToolDispatchResult } from '../tools/dispatch';
import { MAX_RUN_UNITS } from './constants';

function err(code: string, message: string, details?: unknown): ToolDispatchResult {
  return { status: 'error', error: { code, message, details } };
}

/**
 * Вопрос владельцу из прогона: положить pending-единицу рода `question` в тред рутины и
 * вернуть модели её id. Прогон при этом НЕ закрывается — его исход подведёт раннер.
 *
 * Ключ идемпотентности выводится из СОДЕРЖИМОГО (`askDedupeKey`, ОЧ.9), а не приходит от
 * модели: у входа `orbis_ask` нет поля `id` намеренно — повтор того же вопроса обязан
 * сойтись в ту же карточку, а не в карточку с новым выдуманным ключом.
 *
 * ВСЁ — В ОДНОЙ ТРАНЗАКЦИИ ВЛАДЕЛЬЦА, и это контракт, а не удобство: `listRunUnits`
 * требует `withIdentity` ТОГО ЖЕ владельца (иначе судьбы молча читаются как `open`, и кап
 * считал бы уже решённое), а проба и запись обязаны видеть одну и ту же ленту.
 */
export async function runAsk(ctx: ToolCallCtx, input: AskInput): Promise<ToolDispatchResult> {
  // 1. Второй рубеж поверх гейта режима (routineGate): контекст без рутины означает
  // поломку вызывающего, а не «рутина неизвестна» — вопрос некуда положить.
  const routine = ctx.routine;
  if (ctx.source !== 'routine' || routine === undefined) {
    return err(
      'VALIDATION',
      'orbis_ask доступен только внутреннему исполнителю рутины (D42 ОЧ.12)',
      {
        tool: 'orbis_ask',
        source: ctx.source,
      },
    );
  }
  // Ровно один субъект (V1.5, симметрично сборке subject в dispatch.ts): грант приходит с
  // MCP, рутина — из фонового прогона, и оба ключа сразу означают контекст, собранный не
  // тем, кто шлёт вызов. Молчаливо предпочесть один из них значило бы приписать вопрос
  // не тому исполнителю.
  if (ctx.grant !== undefined) {
    return err('VALIDATION', 'контекст вызова собран неверно: и грант, и рутина (V1.5)', {
      tool: 'orbis_ask',
    });
  }
  // Прогон в вопросе и прогон в контексте — это один прогон. Разойтись они могут только
  // если модель сочинила `run_id`: тогда вопрос был бы дедуплицирован и посчитан капом по
  // ЧУЖОМУ прогону, а ответ на него приехал бы в историю не той работы.
  if (input.run_id !== routine.runId) {
    return err('VALIDATION', 'вопрос адресован не тому прогону, из которого сделан вызов', {
      tool: 'orbis_ask',
      run_id: input.run_id,
    });
  }

  const dedupeKey = askDedupeKey(routine.runId, input.question, input.options);
  const pendingId = pendingMessageId(ctx.actorUserId, dedupeKey);

  return await withIdentity(ctx.db, ctx.actorUserId, async (tx): Promise<ToolDispatchResult> => {
    // 2. Проба существования по PK (образец — `routines/propose.ts`): `createPending`
    // идемпотентен, но «завёл» и «нашёл» он не различает, а ответ модели различать обязан:
    // без признака `replayed` она не отличила бы «спросил» от «уже спрашивал».
    const found = await tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.id, pendingId));
    if (found.length > 0) {
      return ok(routine.runId, pendingId, true);
    }

    // 3. Кап единиц на прогон (ОЧ.10) — по ОТКРЫТЫМ и по ОБОИМ родам сразу: карточек в
    // пачке владельца столько, сколько прогон наспрашивал И наоткладывал. Отказ
    // структурный, чтобы модель скорректировалась (§9.9), — тем же текстом и тем же
    // `reason`, что у отложки: для модели это один и тот же потолок.
    const open = (await listRunUnits(tx, ctx.actorUserId, routine.runId)).filter(
      (u) => u.fate === 'open',
    );
    if (open.length >= MAX_RUN_UNITS) {
      return err('VALIDATION', 'пачка полна — заверши прогон', {
        reason: 'run_units_cap',
        limit: MAX_RUN_UNITS,
      });
    }

    // 4. Запись — в тред РУТИНЫ (V1.6): вопрос это событие рутины, и читается он там же,
    // где вся её остальная переписка с владельцем, а не в треде вызова.
    const threadId = await ensureEntityThread(tx, ctx.actorUserId, routine.id);
    await createPending(tx, {
      threadId,
      actor: { userId: ctx.actorUserId, kind: 'ai', source: 'routine', runId: routine.runId },
      kind: 'question',
      question: input.question,
      ...(input.options !== undefined && { options: input.options }),
      // Уровень остаётся `explicit-confirmation`: pending порождает только он (§7.10), и
      // гейт уровня вопросом не ослабляется — носитель у единицы тот же, что у действия.
      level: 'explicit-confirmation',
      dedupeKey,
      clock: ctx.clock,
      // Карточка и текст ленты — СВОИ, и это не украшение (Ф-2b отчёта Задачи 2): умолчания
      // `createPending` для вопроса негодны. `confirmation_card` предложила бы владельцу
      // «Принять»/«Отклонить», на которые гейт рода отвечает структурным отказом (на вопрос
      // отвечают, а не принимают его), а «Требуется подтверждение: …» назвало бы событие
      // тем, чем оно не является.
      card: {
        kind: 'question_card',
        pendingId,
        runId: routine.runId,
        routineId: routine.id,
        question: input.question,
        ...(input.options !== undefined && { options: input.options }),
      },
      content: `Вопрос владельцу: «${input.question}»`,
    });
    return ok(routine.runId, pendingId, false);
  });
}

/** Ответ модели — snake_case (`AskResult`): его читает LLM, а не наш код. */
function ok(runId: string, pendingId: string, replayed: boolean): ToolDispatchResult {
  return {
    status: 'ok',
    result: { run_id: runId, pending_id: pendingId, replayed } satisfies AskResult,
  };
}
