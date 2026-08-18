// Экран прогона (С5, С12): что исполнитель делал шаг за шагом, чем это кончилось и как
// откатить сделанное им в Orbis.
//
// Лента — ЕДИНСТВЕННЫЙ вид аспекта `orbis/agent-run` на экране: общая карточка свойств его
// прячет (AspectCards.HIDDEN_ASPECT_CARDS), и правильно делает — поля прогона пишет агент
// своими глаголами, а инпут рядом с ними предлагал бы владельцу править журнал работы.
import { ExternalLink, Globe } from 'lucide-react';
import { useId, useState } from 'react';
import { EntityRef } from '../../lib/entity-ref/EntityRef';
import { formatDate } from '../../lib/format';
import { invalidateGraph } from '../../lib/invalidate';
import { Markdown } from '../../lib/markdown/Markdown';
import { openEntity } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { RUN_ASPECT, RUN_OUTCOME_LABELS } from './useTicketRuns';

type Entity = RouterOutputs['entity']['get']['entity'];

/**
 * Разбор аспекта РУКАМИ, а не зод-схемой из `@orbis/shared`.
 *
 * Аспекты приезжают в wire-форме как `Record<string, unknown>` — тип по id аспекта клиенту
 * не известен, и без разбора это `unknown` в каждом поле. Соблазн взять готовую
 * `agentRunAspectSchema` велик, но она притащила бы zod в чанк `DetailScreen`, где его
 * сегодня нет вовсе (ни один модуль web не импортирует zod напрямую), — то есть заплатила бы
 * весом первого кадра записи за проверку данных, которые сервер уже провалидировал на записи.
 *
 * Отсюда правило разбора: поле неверной формы — как отсутствующее. Прогон рисуется тем, что
 * в нём разобралось; пустая лента честнее, чем красный экран на одном кривом шаге.
 */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Годится ли адрес сессии в `href`. Его пишет ИСПОЛНИТЕЛЬ своим глаголом — то есть это чужой
 * ввод, и в ссылке он превращается в код, который владелец запускает своим кликом:
 * `javascript:` в href исполняется в нашем origin, `data:`/`blob:` открывают страницу, которую
 * браузер считает нашей. Схему поэтому проверяем БЕЛЫМ списком, а не запретом «плохих».
 *
 * Не прошедший проверку адрес не прячется, а печатается ТЕКСТОМ: чаще всего это опечатка
 * агента, и владельцу надо её увидеть, а не гадать, почему ссылки нет.
 */
function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    // Относительный или битый адрес: базы у чужой строки нет, и достраивать её нашей —
    // значит вести владельца по своему же приложению от имени исполнителя.
    return false;
  }
}

/**
 * Откуда пришла ЧУЖАЯ правка, помешавшая откату (`MutationSource`, executor/types.ts). Сырой
 * enum здесь не годится: «ui» ничего не сообщает владельцу, а решать по этой строке ему —
 * своей это было рукой или чужого агента. Незнакомое значение показываем как есть.
 */
const SOURCE_LABELS: Record<string, string> = {
  ui: 'с экрана',
  chat: 'из чата',
  fast_path: 'быстрая запись',
  quick_capture: 'быстрая запись',
  mcp: 'внешний агент',
  system: 'обслуживание круга',
};

interface Step {
  seq: number;
  at: string;
  summary: string;
  external: boolean;
}

/**
 * Шаги — ПО ВОЗРАСТАНИЮ `seq`, а не в порядке массива: `steps` лежит в jsonb, и порядок
 * элементов там гарантирован только тем, кто его писал. `seq` же — номер шага под CAS-счётчиком
 * (verbs.ts runStep), то есть единственный порядок, который для ленты что-то значит.
 */
function readSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  const steps: Step[] = [];
  for (const item of raw) {
    const s = obj(item);
    const seq = num(s?.seq);
    const at = str(s?.at);
    const summary = str(s?.summary);
    if (s === undefined || seq === undefined || at === undefined || summary === undefined) continue;
    steps.push({ seq, at, summary, external: s.external === true });
  }
  return steps.sort((a, b) => a.seq - b.seq);
}

/** Расход прогона строкой: печатаем ТОЛЬКО те поля, что агент прислал (все опциональны). */
function usageLine(raw: unknown): string | undefined {
  const usage = obj(raw);
  if (usage === undefined) return undefined;
  const tokens: string[] = [];
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cost = num(usage.cost_usd);
  // Токены — величина техническая, и печатаются они сырым числом намеренно: группировка
  // разрядов (Intl) вставила бы неразрывные пробелы внутрь и без того длинной строки.
  if (input !== undefined) tokens.push(`${input} вход`);
  if (output !== undefined) tokens.push(`${output} выход`);
  const parts: string[] = [];
  if (tokens.length > 0) parts.push(`${tokens.join(' / ')} токенов`);
  if (cost !== undefined) parts.push(`$${cost.toFixed(2)}`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** Блок текста, написанного человеком или агентом: заголовок, время (если есть) и разметка. */
function TextBlock({
  title,
  at,
  text,
  tz,
}: {
  title: string;
  at?: string;
  text: string;
  tz?: string;
}) {
  return (
    <section className="flex flex-col gap-1 rounded-control border border-line bg-surface-2/40 p-3">
      <h4 className="flex flex-wrap items-baseline gap-2 font-medium text-sm">
        {title}
        {at !== undefined && (
          <time dateTime={at} className="font-normal text-text-muted text-xs">
            {formatDate(at, tz)}
          </time>
        )}
      </h4>
      {/* Разметкой, а не сырым текстом: отчёты и вопросы агент пишет markdown'ом — списками,
          кодом и ссылками. Компонент тот же, что у ленты чата и блока ожидания тикета, и
          своего веса в чанк detail не добавляет. `onEntityLink` не украшение: без него ссылка
          `[[entity:…]]` из отчёта агента ПЕРЕЗАГРУЖАЕТ SPA (контракт Markdown.tsx). */}
      <Markdown source={text} className="text-sm" onEntityLink={openEntity} />
    </section>
  );
}

export function RunFeed({ entity }: { entity: Entity }) {
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const cancelId = useId();
  const tz = trpc.user.getSettings.useQuery().data?.timezone;

  const run = entity.aspects[RUN_ASPECT] ?? {};
  const outcome = str(run.outcome) ?? '';
  const grantId = str(run.grant_id);
  const startedAt = str(run.started_at);
  const finishedAt = str(run.finished_at);
  const steps = readSteps(run.steps);
  const checkpoint = obj(run.checkpoint);
  const question = str(checkpoint?.question);
  const reply = obj(run.reply);
  const replyText = str(reply?.text);
  const usage = usageLine(run.usage);
  const sessionUrl = str(run.session_url);
  const report = str(run.report);
  const abandonNote = str(run.abandon_note);

  // Список доступов — ПО УЖЕ ЖИВОМУ ключу кэша (он же у карточки назначения и истории
  // прогонов): свою сеть лента добавляет только там, где грант вообще есть.
  const grants = trpc.oauth.listGrants.useQuery(undefined, { enabled: grantId !== undefined });
  const grant = grants.data?.find((g) => g.id === grantId);
  // Пока подпись едет (или грант отозван и вычищен) — короткий id: сырой uuid во всю ширину
  // строки ничего не сообщает, но и врать «доступ неизвестен» тут не о чем.
  const grantLabel =
    grant?.label ?? (grantId === undefined ? undefined : `${grantId.slice(0, 8)}…`);

  const rollback = trpc.agentRun.rollback.useMutation({
    onSuccess: (result) => {
      setConfirm(false);
      // Конфликт не тронул граф ВОВСЕ (инвариант 7) — перечитывать нечего. `ok` и `partial`
      // двигают и тикет (вернулся в очередь), и сам прогон (архивирован inverse'ом создания),
      // и видно это на соседних экранах — инвалидация та же полная, что у любой правки (Р17).
      if (result.ok || result.reason === 'partial') invalidateGraph(utils);
    },
    // Сеть или отказ процедуры: модалку закрываем, отказ показываем строкой ниже — открытый
    // диалог поверх сообщения об ошибке читался бы как «нажми ещё раз».
    onError: () => setConfirm(false),
  });
  const result = rollback.data;

  /**
   * Откат ЖИВОГО прогона запрещён здесь, на экране, а не сервером — и это осознанный выбор
   * контроллера, а не пробел.
   *
   * Сервер откатит и `running`: механика отката — серия отмен по журналу, и «идёт» ей не
   * мешает. Бессмысленно другое: исполнитель продолжает работать и следующим же глаголом
   * допишет поверх отката (его CAS-счётчик шагов о нём ничего не знает), — владелец получил бы
   * прогон, частично откаченный и тут же переписанный, то есть состояние, которого он не
   * выбирал. Дождаться терминального исхода — своего или от подметания (С6) — можно всегда.
   */
  const alive = outcome === 'running';

  /**
   * Прогон уже откачен. Серия отмен возвращает аспект к состоянию СОЗДАНИЯ (`outcome:
   * running`, шагов нет) и архивирует запись — inverse'ом entity_create. Значит по аспекту
   * откаченный прогон неотличим от только что начатого, и единственный признак случившегося —
   * `archived`. Без него экран вечно показывал бы «идёт» с подсказкой «откатывать нечего»,
   * то есть врал бы про уже сделанный откат.
   */
  const rolledBack = entity.archived;

  return (
    <section aria-label="Прогон агента" data-testid="run-feed" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
        {/* Исход архивированного прогона ничего не сообщает (см. rolledBack) — вместо него
            бейдж о том, что с записью произошло на самом деле. */}
        <Badge>
          {rolledBack ? 'в архиве (откачен)' : (RUN_OUTCOME_LABELS[outcome] ?? outcome)}
        </Badge>
        {startedAt !== undefined && <span>начат {formatDate(startedAt, tz)}</span>}
        {finishedAt !== undefined && <span>· закончен {formatDate(finishedAt, tz)}</span>}
        {grantLabel !== undefined && (
          <span>
            {/* Подпись — СВОИМ узлом, а не куском строки «· worker-1»: её пишет тот, кто
                регистрировал доступ, и переносить её надо целиком (break-words). */}
            · <span className="break-words">{grantLabel}</span>
          </span>
        )}
      </header>

      {usage !== undefined && <p className="text-text-muted text-xs">Расход: {usage}</p>}

      {sessionUrl !== undefined &&
        (isWebUrl(sessionUrl) ? (
          // Ссылка наружу, во владения исполнителя: target + rel обязательны (открытая вкладка
          // не должна получить ссылку на наш window, а реферер — на адрес записи владельца).
          <a
            href={sessionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1 text-accent text-sm hover:underline"
          >
            <ExternalLink size={14} aria-hidden />
            Сессия исполнителя
          </a>
        ) : (
          <p className="text-sm text-text-muted">
            Сессия исполнителя: <span className="break-all">{sessionUrl}</span>
          </p>
        ))}

      <div className="flex flex-col gap-1">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-text-muted">
          Шаги ({steps.length})
        </h3>
        {steps.length === 0 ? (
          <p className="text-sm text-text-muted">Шагов пока нет.</p>
        ) : (
          <ol data-testid="run-steps" className="flex flex-col">
            {steps.map((step) => (
              <li
                key={step.seq}
                className="flex flex-wrap items-baseline gap-2 border-line/60 border-b py-1.5 text-sm last:border-b-0"
              >
                <span className="w-6 shrink-0 text-right text-text-muted tabular-nums">
                  {step.seq}
                </span>
                <time dateTime={step.at} className="text-text-secondary">
                  {formatDate(step.at, tz)}
                </time>
                <span className="min-w-0 flex-1 break-words">{step.summary}</span>
                {/* «Внешнее» — то, что откат Orbis НЕ вернёт (С12): ветка, файлы, сеть. Иконка
                    декоративна (aria-hidden), смысл несёт слово — иначе для скринридера метка
                    просто исчезла бы. */}
                {step.external && (
                  <Badge className="gap-1">
                    <Globe size={12} aria-hidden />
                    внешнее
                  </Badge>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {question !== undefined && (
        <TextBlock
          title="Вопрос исполнителя"
          at={str(checkpoint?.asked_at)}
          text={question}
          tz={tz}
        />
      )}
      {replyText !== undefined && (
        <TextBlock title="Ответ владельца" at={str(reply?.at)} text={replyText} tz={tz} />
      )}
      {report !== undefined && <TextBlock title="Отчёт" text={report} tz={tz} />}
      {abandonNote !== undefined && (
        <TextBlock title="Почему прогон оборван" text={abandonNote} tz={tz} />
      )}

      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={alive || rolledBack || rollback.isPending}
          onClick={() => setConfirm(true)}
        >
          Откатить прогон в Orbis
        </Button>
        {rolledBack ? (
          <p className="text-text-muted text-xs">
            Этот прогон откачен: его действия уже отменены, отменять больше нечего.
          </p>
        ) : (
          alive && (
            <p className="text-text-muted text-xs">
              Прогон ещё идёт: откатывать его нечего — исполнитель допишет поверх отката.
            </p>
          )
        )}
        {rollback.isError && (
          <p role="alert" className="text-danger text-sm">
            {rollback.error.message}
          </p>
        )}
        {result !== undefined && (
          <div
            // Результат приезжает ПОСЛЕ жеста, и фокус в этот момент стоит на кнопке отката:
            // без живой области скринридер не сказал бы о нём ни слова. `status`, а не `alert`:
            // у успеха и у конфликта одна и та же цена внимания, а перебивать чтение нечем.
            role="status"
            data-testid="rollback-result"
            className="flex flex-col gap-2 rounded-control border border-line bg-surface-2/40 p-3 text-sm"
          >
            {result.ok ? (
              <>
                {/* Текст про репозиторий приходит С СЕРВЕРА (agent-loop/rollback.ts): граница
                    «Orbis откачен, git не тронут» — свойство механизма, и второй её копии в
                    UI быть не должно, иначе они разъедутся первой же правкой. */}
                <p>{result.note}</p>
                <p className="text-text-secondary">Откачено действий: {result.undone.length}</p>
              </>
            ) : result.reason === 'conflict' ? (
              <>
                <p>
                  Ничего не откачено: после прогона эти записи трогали помимо него — откат стёр бы
                  чужую работу.
                </p>
                <ul className="flex flex-col gap-1">
                  {result.conflicts.map((c) => (
                    <li
                      key={`${c.actionId}-${c.entityId}`}
                      className="flex flex-wrap items-baseline gap-2 text-text-secondary"
                    >
                      {/* Заголовком, а не uuid: по нему человек решает, чем он готов
                          пожертвовать (или что откатить руками, прежде чем повторить). */}
                      <EntityRef id={c.entityId} />
                      <time dateTime={c.at}>{formatDate(c.at, tz)}</time>
                      <Badge>{SOURCE_LABELS[c.source] ?? c.source}</Badge>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                {/* Частичный откат — САМОЕ важное сообщение из трёх: граф уже смешанный, и
                    молчание о нём читалось бы как «ничего не произошло». */}
                <p>
                  Откачено действий: {result.undone.length}, дальше отказ на действии{' '}
                  <span className="font-mono text-xs">{result.failed.actionId}</span>.
                </p>
                <p className="text-danger">{result.failed.error.message}</p>
              </>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Откатить прогон в Orbis?"
        // Фокус — на «Отмена», а не на первом таб-стопе (крестик) и тем более не на самом
        // откате: жест переписывает граф, и Enter сразу по открытии модалки не должен его
        // совершать (тот же приём, что в VersionsCard). По id, а не по ссылке: `Button` —
        // не forwardRef-компонент.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document.getElementById(cancelId)?.focus();
        }}
      >
        <div className="flex flex-col gap-3 pt-2">
          <p className="text-sm text-text-secondary">
            Действия исполнителя будут отменены по одному, в обратном порядке. Сделанное вне Orbis
            откат не трогает.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button id={cancelId} variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              Отмена
            </Button>
            <Button
              size="sm"
              disabled={rollback.isPending}
              onClick={() => rollback.mutate({ runId: entity.id })}
            >
              Откатить
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
