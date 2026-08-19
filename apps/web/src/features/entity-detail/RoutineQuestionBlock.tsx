// Рутина остановилась и ждёт человека (V1.4, V1.14; приёмка 5). Тот же блок, что у тикета
// (TicketWaitingBlock), и обобщён он не ради экономии кода, а потому что жест ОДИН: прочитать
// вопрос и ответить, вернув работу исполнителю.
//
// Различие с тикетом одно, зато существенное: у рутины нет записи, в которую сервер кладёт
// вопрос (`waiting_for` тикета). Вопрос лежит в самом прогоне (`checkpoint.question`), и
// отвечают на него ЗДЕСЬ, на экране прогона, — второго места, где владелец мог бы его
// увидеть, у рутины не существует.
import { useId, useState } from 'react';
import { formatDate } from '../../lib/format';
import { invalidateGraph } from '../../lib/invalidate';
import { Markdown } from '../../lib/markdown/Markdown';
import { openEntity } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';

/**
 * Прогон в объёме вопроса — ровно то, что блоку нужно, и ни поля больше: сущность целиком он
 * не берёт намеренно, иначе тот же блок нельзя было бы показать из списка «Ждут ответа»
 * (V1.14), где сущности прогона нет, а есть её разобранный аспект.
 */
export type RoutineRunQuestion = {
  id: string;
  question: string;
  asked_at: string;
  reply?: { text: string; at: string };
  outcome: string;
  /**
   * Прогон в архиве — след ОТКАТА рутинного прогона (rollback.ts): откат снимает вопрос
   * (`stale`), и подпись обязана назвать причину — «снят новым прогоном» здесь было бы
   * неправдой. Под архивом ответить нельзя ни при каком исходе (сервер: NOT_FOUND).
   */
  archived?: boolean;
};

export function RoutineQuestionBlock({ run }: { run: RoutineRunQuestion }) {
  const utils = trpc.useUtils();
  const answerId = useId();
  // Зона владельца — тем же швом, что у ленты прогона и истории: без неё время печаталось бы
  // в зоне машины, а вопрос, заданный ночью, читается только вместе с «когда».
  const tz = trpc.user.getSettings.useQuery().data?.timezone;
  const [answer, setAnswer] = useState('');
  const answerCheckpoint = trpc.routine.answerCheckpoint.useMutation({
    onSuccess: () => {
      setAnswer('');
      // Ответ двигает сам прогон (reply + outcome answered), а его видно и в истории рутины,
      // и в блоке её состояния. Инвалидация та же полная, что у любой правки графа (Р17).
      invalidateGraph(utils);
    },
  });

  // Отвечать можно РОВНО пока прогон ждёт (V1.4): `answered` уже закрыт ответом, `stale` снят
  // новым прогоном (или откатом), и обе кнопки сервер отклонил бы предусловием; архивный
  // прогон он не находит вовсе. Кнопка, которая гарантированно отказывает, хуже её
  // отсутствия — тот же вывод, что у блока ожидания тикета.
  const archived = run.archived === true;
  const waiting = run.outcome === 'checkpoint' && !archived;

  return (
    <section
      data-testid="routine-question"
      className="flex flex-col gap-3 rounded-control border border-line bg-surface-2/40 p-4"
    >
      <h3 className="flex flex-wrap items-baseline gap-2 font-medium text-sm">
        Вопрос рутины
        <time dateTime={run.asked_at} className="font-normal text-text-muted text-xs">
          {formatDate(run.asked_at, tz)}
        </time>
      </h3>
      {/* Разметкой, а не сырым текстом: вопрос пишет модель, и пишет она markdown'ом —
          списками, кодом и ссылками на записи. `onEntityLink` не украшение: без него ссылка
          `[[entity:…]]` из вопроса ПЕРЕЗАГРУЖАЕТ SPA (контракт Markdown.tsx). */}
      <Markdown source={run.question} className="text-sm" onEntityLink={openEntity} />

      {run.reply !== undefined && (
        <div className="flex flex-col gap-1 border-line/60 border-t pt-3">
          <h4 className="flex flex-wrap items-baseline gap-2 font-medium text-sm">
            Ответ владельца
            <time dateTime={run.reply.at} className="font-normal text-text-muted text-xs">
              {formatDate(run.reply.at, tz)}
            </time>
          </h4>
          <Markdown source={run.reply.text} className="text-sm" onEntityLink={openEntity} />
        </div>
      )}

      {/* Вопрос без ответа остался не потому, что владелец промолчал: рутина спросила заново
          следующим прогоном, и этот сняли (supersedeOpen), — либо прогон откатили, и откат
          снял вопрос сам (rollback.ts). Без этих слов экран показывал бы мёртвый вопрос, на
          который «почему-то нельзя ответить». */}
      {archived && run.reply === undefined ? (
        <p className="text-sm text-text-muted">Вопрос снят: прогон откачен.</p>
      ) : (
        run.outcome === 'stale' && (
          <p className="text-sm text-text-muted">Вопрос снят новым прогоном.</p>
        )
      )}

      {waiting && (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={answerId} className="text-sm text-text-secondary">
              Ответ
            </label>
            <textarea
              id={answerId}
              rows={3}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-text outline-none transition focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </div>
          {answerCheckpoint.isError && (
            <p role="alert" className="text-danger text-sm">
              {answerCheckpoint.error.message}
            </p>
          )}
          <Button
            size="sm"
            className="self-start"
            // Пустой ответ сервер отклонит (min(1)) — не отправляем его вовсе.
            disabled={answer.trim() === '' || answerCheckpoint.isPending}
            onClick={() => answerCheckpoint.mutate({ runId: run.id, answer: answer.trim() })}
          >
            Ответить
          </Button>
        </>
      )}
    </section>
  );
}
