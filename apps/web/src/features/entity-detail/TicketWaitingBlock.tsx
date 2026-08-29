// Тикет остановился и ждёт человека (С3, С8, С6; приёмка 7–8). Один блок на три исхода
// прогона, потому что жест у них ОДИН: прочитать текст и ответить, вернув работу в круг.
import { useId, useState } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { Markdown } from '../../lib/markdown/Markdown';
import { openEntity } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { useEntityUpdate } from './useEntityDetail';
import type { TicketRun } from './useTicketRuns';

type Entity = RouterOutputs['entity']['get']['entity'];

/**
 * Заголовок — по исходу ПОСЛЕДНЕГО прогона, а не по статусу тикета: `waiting` у всех трёх
 * одинаков, а читать человеку предстоит разное — вопрос, итог работы или остатки оборванного
 * прогона. Один заголовок на три случая означал бы, что экран не знает, зачем позвал.
 */
const HEADINGS: Record<string, string> = {
  checkpoint: 'Вопрос исполнителя',
  finished: 'Готово, проверьте',
  abandoned: 'Прогон оборван — разбор',
};

export function TicketWaitingBlock({
  entity,
  lastRun,
}: {
  entity: Entity;
  lastRun: TicketRun | undefined;
}) {
  const utils = trpc.useUtils();
  const answerId = useId();
  const [answer, setAnswer] = useState('');
  const answerCheckpoint = trpc.agentRun.answerCheckpoint.useMutation({
    onSuccess: () => {
      setAnswer('');
      // Ответ двигает ДВЕ записи — прогон (reply) и тикет (waiting → planned), — и обе видны
      // соседям: тикет стоит в очереди агента и в списках проекта. Инвалидация та же полная,
      // что у любой правки графа (Р17).
      invalidateGraph(utils);
    },
  });
  const { mutation: update } = useEntityUpdate(entity.id);

  // Значения — плоско в `props` по id свойства (§А1-1): и состояние тикета, и исход прогона.
  const status = entity.props['orbis/task_status'];
  const runOutcome = lastRun?.props['orbis/run_outcome'];
  const outcome = typeof runOutcome === 'string' ? runOutcome : undefined;
  /**
   * Условие показа — «тикет ждёт И прогон уже НЕ идёт». Идущий прогон сюда не попадает
   * намеренно: агент перечитывает ответ только на следующем захвате (`claimTask`), а сервер
   * и вовсе откажет — предусловие ответа допускает лишь законченные исходы
   * (routers/agent-run.ts:104-113). Кнопка, которая гарантированно отказывает, хуже её отсутствия.
   */
  if (
    status !== 'waiting' ||
    lastRun === undefined ||
    outcome === undefined ||
    outcome === 'running'
  ) {
    return null;
  }

  // Текст для человека — ОДИН, в `waiting_for` тикета: туда его кладут все три пути сервера
  // (вопрос чекпойнта, отчёт итога, записка подметания). Второго источника у экрана нет
  // намеренно — разъехаться им было бы негде.
  const question = entity.props['orbis/waiting_for'];
  const waitingFor = typeof question === 'string' ? question : '';
  const pending = answerCheckpoint.isPending || update.isPending;
  const failure = answerCheckpoint.isError
    ? answerCheckpoint.error.message
    : update.isError
      ? update.error.message
      : null;

  return (
    <section
      data-testid="ticket-waiting"
      className="flex flex-col gap-3 rounded-control border border-line bg-surface-2/40 p-4"
    >
      <h3 className="font-medium text-sm">{HEADINGS[outcome]}</h3>
      {/* Разметкой, а не сырым текстом: агент пишет отчёты и вопросы markdown'ом — списками,
          кодом и ссылками. Компонент тот же, что у ленты чата и просмотра тела, и своего веса
          в чанк detail не добавляет (EditorShell уже тянет его статически). `onEntityLink` —
          как в EditorShell: без него ссылка `[[entity:…]]` из отчёта агента уходит обычной и
          ПЕРЕЗАГРУЖАЕТ SPA (контракт Markdown.tsx), а не открывает запись поверх стека. */}
      {waitingFor !== '' && (
        <Markdown source={waitingFor} className="text-sm" onEntityLink={openEntity} />
      )}
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
      {/* Отказ ЛЮБОЙ из двух кнопок: закрытие тикета отказывает так же, как ответ (тикет успели
          закрыть из списка, сеть отвалилась), и молчание о нём читалось бы как «сохранено».
          Одна строка на обе: нажимают их по очереди, обе разом в полёте не бывают. */}
      {failure !== null && (
        <p role="alert" className="text-danger text-sm">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          // Пустой ответ сервер отклонит (min(1)) — не отправляем его вовсе.
          disabled={answer.trim() === '' || pending}
          onClick={() =>
            answerCheckpoint.mutate({
              ticketId: entity.id,
              runId: lastRun.id,
              answer: answer.trim(),
            })
          }
        >
          Ответить и вернуть в работу
        </Button>
        {/* Только у `finished`: работа сделана, и владельцу нужен второй исход — закрыть тикет,
            а не возвращать его в круг. У вопроса и у обрыва закрывать нечего. */}
        {outcome === 'finished' && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              update.mutate({
                id: entity.id,
                expectedUpdatedAt: entity.updatedAt,
                props: { 'orbis/task_status': 'done' },
                // Снятие вопроса уезжает СПИСКОМ `unset`, а не `null` в значении (§А1-1):
                // `null` — законное значение json-свойства, и совмещать их одним ключом
                // больше нечем. Конвенция среза прежняя: уходя из waiting, вопрос снимают,
                // иначе он остался бы висеть на закрытом тикете и читался бы как открытый.
                // Сервер делает ровно это на всех СВОИХ выходах из waiting
                // (routers/agent-run.ts:129-131, agent-loop/sweep.ts:111); правка из UI не
                // должна быть исключением. `orbis/completed_at` не шлём: его проставляет сам
                // переход в done (executor/normalize.ts:57-68).
                unset: ['orbis/waiting_for'],
              })
            }
          >
            Закрыть тикет
          </Button>
        )}
      </div>
    </section>
  );
}
