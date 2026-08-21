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
import { ProposalCard } from '../chat/cards/ProposalCard';
// Разбор полей аспекта — общим модулем (см. его шапку): у ленты прогона и у блока состояния
// рутины правило одно, и копия разъехалась бы при первой же правке.
import { num, obj, str } from './aspect-read';
import { RoutineQuestionBlock } from './RoutineQuestionBlock';
import { RunDecisionsBlock } from './RunDecisionsBlock';
import { RUN_ASPECT, RUN_OUTCOME_LABELS } from './useTicketRuns';

type Entity = RouterOutputs['entity']['get']['entity'];

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
  // V1.5: правка рутины владельца. «Чужой агент» здесь было бы неправдой — рутину завёл он
  // сам, а «своей рукой» ею назвать нельзя: в этот момент его не было в приложении.
  routine: 'рутина',
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

/**
 * Слот расписания, за который отвечает прогон рутины (`bucket`, V1.2).
 *
 * Плановый бакет — МЕСТНОЕ стенное время владельца без зоны (`2026-08-18T07:00`), и через
 * `formatDate` его гнать нельзя: Intl принял бы эту строку за время машины и сдвинул бы её в
 * зону владельца ВТОРОЙ раз — «07:00» на экране стало бы «10:00». Печатаем как есть, заменив
 * служебное «T» пробелом. Ручной прогон (`manual:<ISO>`) несёт настоящий момент — его
 * форматируем обычным путём, тем же форматтером, что и всё остальное время на экране.
 */
function bucketLabel(bucket: string, tz?: string): string {
  const MANUAL = 'manual:';
  return bucket.startsWith(MANUAL)
    ? `вручную · ${formatDate(bucket.slice(MANUAL.length), tz)}`
    : `слот ${bucket.replace('T', ' ')}`;
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
  /**
   * Поля прогона РУТИНЫ (V1). Исполнитель у него внутренний и всегда один, поэтому вместо
   * гранта в шапке стоит сама рутина, а вместо одного лишь «начат» — слот расписания, за
   * который прогон отвечает, и номер попытки.
   */
  const routineId = str(run.routine_id);
  const bucket = str(run.bucket);
  const attempt = num(run.attempt);
  const failNote = str(run.fail_note);
  const proposal = obj(run.proposal);
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
   * Прогон в архиве — и это ВСЁ, что тут известно наверняка.
   *
   * Один путь сюда — сам откат. У грантового прогона серия отмен возвращает аспект к состоянию
   * СОЗДАНИЯ (`outcome: running`, шагов нет) и архивирует запись inverse'ом entity_create;
   * у рутинного откат инвертирует только работу прогона, а архив ставит явной операцией —
   * аспект остаётся целым (agent-loop/rollback.ts). В обоих случаях единственный признак
   * случившегося — `archived`. Без него экран показывал бы «идёт»/«готово» с живой кнопкой,
   * то есть врал бы про уже сделанный откат.
   *
   * Но путь не единственный: «Архивировать» есть в меню ⋮ ЛЮБОЙ записи, включая прогон, и
   * архивированный руками прогон приходит сюда с целым аспектом и всеми шагами. Различить их
   * нечем, поэтому и бейдж, и подсказка говорят ровно про архив, а не про откат.
   */
  const inArchive = entity.archived;

  return (
    <section aria-label="Прогон агента" data-testid="run-feed" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
        {/* Исход архивированного прогона ничего не сообщает (см. inArchive) — вместо него
            бейдж о том, что с записью произошло на самом деле. */}
        <Badge>{inArchive ? 'в архиве' : (RUN_OUTCOME_LABELS[outcome] ?? outcome)}</Badge>
        {startedAt !== undefined && <span>начат {formatDate(startedAt, tz)}</span>}
        {finishedAt !== undefined && <span>· закончен {formatDate(finishedAt, tz)}</span>}
        {grantLabel !== undefined && (
          <span>
            {/* Подпись — СВОИМ узлом, а не куском строки «· worker-1»: её пишет тот, кто
                регистрировал доступ, и переносить её надо целиком (break-words). */}
            · <span className="break-words">{grantLabel}</span>
          </span>
        )}
        {/* Кто это делал у рутины — САМА РУТИНА, и названа она заголовком, а не uuid: гранта
            у внутреннего исполнителя нет вовсе (Р-8), и пустое место на его месте читалось бы
            как «исполнитель неизвестен». Ссылкой — оттуда владелец правит расписание и права. */}
        {routineId !== undefined && (
          <span>
            · <EntityRef id={routineId} onOpen={openEntity} />
          </span>
        )}
        {bucket !== undefined && <span>· {bucketLabel(bucket, tz)}</span>}
        {/* Первая попытка — обычный ход дел, и «попытка 1» на каждом прогоне была бы шумом.
            Вторая и третья — новость: рутина уже сбоила, и её перезапускали (V1.10). */}
        {attempt !== undefined && attempt > 1 && <span>· попытка {attempt}</span>}
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

      {/* Вопрос рутины — блоком С ПОЛЕМ ОТВЕТА, а не текстом: у рутины нет тикета, куда
          сервер кладёт вопрос внешнего исполнителя (`waiting_for`), и второго места, где
          владелец мог бы ответить, не существует. У прогона внешнего исполнителя всё
          наоборот: отвечают на тикете (TicketWaitingBlock), а здесь вопрос и ответ —
          история работы, и поле ввода рядом с ними было бы вторым способом ответить. */}
      {question !== undefined && routineId !== undefined ? (
        <RoutineQuestionBlock
          run={{
            id: entity.id,
            question,
            asked_at: str(checkpoint?.asked_at) ?? entity.createdAt,
            ...(replyText !== undefined && {
              reply: { text: replyText, at: str(reply?.at) ?? entity.updatedAt },
            }),
            outcome,
            archived: inArchive,
          }}
        />
      ) : (
        <>
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
        </>
      )}
      {/* Пачка решений (D42 §7) — между терминальным вопросом и предложением, потому что это
          ТРЕТИЙ, отдельный вид ожидания: вопрос закрыл прогон, предложение ждёт одного «да»,
          а пачка — это несколько независимых решений, которые прогон оставил, работая дальше.
          Все три могут висеть на одном прогоне одновременно.
          key по id — по той же причине, что у самой ленты: экран монтируется БЕЗ key
          (router.tsx), переход прогон→прогон меняет лишь проп, — а у блока своё состояние
          (сводка «Принять все», открытое предупреждение), и переезжать оно не должно. */}
      <RunDecisionsBlock key={`batch-${entity.id}`} entity={entity} />
      {/* Предложение рутины (V1.6) — той же карточкой, что и в ленте треда: владелец решает
          его там, где увидел, и оба места обязаны показывать ОДИН статус, а он приезжает с
          сервера. Условие — по полю аспекта: без предложения карточка не стоила бы запроса. */}
      {/* Адрес предложения — из самого аспекта: карточка обязана знать, ЧТО она показывает
          (Б2 «принимаю то, что вижу»). Здесь сверка сходится всегда — и указатель, и вид
          читают одно поле, — но пока аспект в кэше отстаёт от перечитанного предложения,
          карточка честно скажет «заменено» вместо чужих кнопок. `threadId` не передаётся:
          у экрана прогона ленты нет, инвалидировать нечего (рулинг П-5). */}
      {proposal !== undefined && (
        <ProposalCard runId={entity.id} pendingId={str(proposal.pending_id)} />
      )}
      {/* Отчёт прогона-предложения — ТА ЖЕ проза, что и в карточке: `orbis_propose` кладёт
          `explanation` обоими путями (routines/propose.ts), и второй раз она читалась бы как
          второе объяснение. У прогонов без предложения отчёт — единственный носитель итога. */}
      {report !== undefined && proposal === undefined && (
        <TextBlock title="Отчёт" text={report} tz={tz} />
      )}
      {abandonNote !== undefined && (
        <TextBlock title="Почему прогон оборван" text={abandonNote} tz={tz} />
      )}
      {/* Сбой (V1.10) отличается от обрыва причиной: прогон сорвался САМ (провайдер не
          ответил, вышел дедлайн, упал процесс), а не был подметён. Без записки «сбой» в шапке
          остаётся сообщением, на которое нечем ответить. */}
      {failNote !== undefined && (
        <TextBlock title="Почему прогон сорвался" text={failNote} tz={tz} />
      )}

      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={alive || inArchive || rollback.isPending}
          onClick={() => setConfirm(true)}
        >
          Откатить прогон в Orbis
        </Button>
        {inArchive ? (
          // Нейтрально и намеренно: архив бывает и следом отката, и жестом владельца из меню ⋮
          // (см. inArchive). «Прогон откачен» на втором пути было бы неправдой.
          <p className="text-text-muted text-xs">Прогон в архиве — откат недоступен.</p>
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
