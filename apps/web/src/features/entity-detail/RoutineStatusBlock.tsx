// Состояние рутины (V1.14, приёмка 2 и 10): когда сработает, чем кончился прошлый прогон, на
// что ей выданы права — и два жеста владельца над всем этим: прогнать сейчас и поставить на
// паузу.
//
// Место — вкладка «Сущность», рядом с телом-инструкцией, а не в «Деталях»: рутину открывают
// ради того, что она делает и делает ли вообще. Правка расписания и прав живёт в «Деталях»
// общей карточкой аспекта (В4) — здесь только показ и переключатель паузы, и это не половина
// работы: у поля `at` один смысл («во сколько»), а у паузы — совсем другой («работает ли»), и
// текстовый инпут рядом с кнопкой означал бы, что выключить рутину можно опечаткой.
import type { ReactNode } from 'react';
import { formatDate, plural } from '../../lib/format';
import { invalidateGraph } from '../../lib/invalidate';
import { openEntity } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { str, strArray } from './aspect-read';
import { useEntityUpdate } from './useEntityDetail';
import { RUN_OUTCOME_LABELS, type TicketRun } from './useTicketRuns';

type Entity = RouterOutputs['entity']['get']['entity'];

export const ROUTINE_ASPECT = 'orbis/routine';

/**
 * Дни недели по-русски. Порядок словаря — недельный, и печатаются дни ИМЕННО в нём, а не в
 * порядке массива: в аспекте он произволен (расписание сверяется вхождением, `days.includes`),
 * и «пт, пн» читалось бы как расписание, которого нет. Незнакомый день показываем сырым и
 * последним — догадка тут хуже честного чужого слова.
 */
const DAY_LABELS: Record<string, string> = {
  mo: 'пн',
  tu: 'вт',
  we: 'ср',
  th: 'чт',
  fr: 'пт',
  sa: 'сб',
  su: 'вс',
};
const DAY_ORDER = Object.keys(DAY_LABELS);

function daysLabel(days: string[] | undefined): string {
  // Поля нет — расписание ежедневное (схема аспекта: `days` отсутствует = каждый день).
  if (days === undefined) return 'каждый день';
  const rank = (d: string) => {
    const i = DAY_ORDER.indexOf(d);
    return i === -1 ? DAY_ORDER.length : i;
  };
  return [...days]
    .sort((a, b) => rank(a) - rank(b))
    .map((d) => DAY_LABELS[d] ?? d)
    .join(', ');
}

/**
 * Режим — тем словом, которым он важен владельцу: `propose` спросит его перед каждой правкой,
 * `act` правит граф сам. У `act` список инструментов печатается ЦЕЛИКОМ и рядом: право,
 * названное без объёма («действует»), читалось бы как «действует как угодно», а именно этого
 * оно и НЕ означает — рутине разрешено ровно то, что перечислено (V1.5).
 */
function modeLabel(mode: string | undefined, allowedTools: string[] | undefined): string {
  if (mode === 'propose') return 'предлагает';
  // Незнакомый режим — сырым словом: та же честная деградация, что у исходов прогона.
  if (mode !== 'act') return mode ?? '—';
  // Пустой список у `act` — не «всё можно», а «ничего»: гейт режима пускает ровно перечисленное.
  return `действует: ${allowedTools === undefined ? 'ничего' : allowedTools.join(', ')}`;
}

/** Строка «подпись — значение»: одна форма на все четыре поля состояния. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="text-text">{children}</span>
    </div>
  );
}

export function RoutineStatusBlock({
  entity,
  lastRun,
}: {
  entity: Entity;
  lastRun: TicketRun | undefined;
}) {
  const utils = trpc.useUtils();
  const tz = trpc.user.getSettings.useQuery().data?.timezone;

  // Значения рутины — плоско в `props` по id свойства (§А1-1).
  const routine = entity.props;
  const paused = str(routine['orbis/routine_stage']) === 'paused';

  /**
   * Состояние — ОДНИМ запросом (V1.14): следующее срабатывание считается по расписанию,
   * таймзоне владельца и серверным часам, и вычислять его на клиенте значило бы завести
   * второй календарь со своим пониманием перехода на зимнее время.
   */
  const overview = trpc.routine.overview.useQuery({ routineId: entity.id });

  /**
   * Обзор — четвёртый взгляд на тот же граф, и протухает он вместе с ним: ручной прогон меняет
   * в нём «последний прогон», пауза — «следующее срабатывание». `invalidateGraph` о нём не
   * знает (он про entity.query/get/count), поэтому обзор гасится здесь, рядом с обеими
   * мутациями, — иначе после паузы экран продолжал бы обещать срабатывание в 07:00.
   */
  const invalidateOverview = () => {
    void utils.routine.overview.invalidate();
  };

  const runNow = trpc.routine.runNow.useMutation({
    onSuccess: ({ runId }) => {
      // Ответ приходит ДО модели (V1.3): за исходом владелец пойдёт на экран самого прогона,
      // туда и ведём. Инвалидация — до перехода: прогон уже создан, и история рутины без неё
      // осталась бы вчерашней.
      invalidateGraph(utils);
      invalidateOverview();
      openEntity(runId);
    },
  });
  /**
   * Пауза — обычная правка свойства, и идёт она общей обвязкой entity.update: оптимистичный
   * патч, откат при отказе и инвалидация графа уже написаны там (useEntityUpdate).
   *
   * Гашение ОБЗОРА — на уровне мутации (`onSettled` хука), а не в поштучном колбэке `mutate`.
   * Прежде оно висело вторым аргументом `mutate`, и такие колбэки `@tanstack/query-core`
   * зовёт только пока у наблюдателя есть слушатели (`mutationObserver.js:77`): «Возобновить»
   * и немедленный уход с экрана оставляли `overview.nextBucketAt` посчитанным НА ПАУЗЕ, то
   * есть `null`, — и владелец видел «Следующее срабатывание: —» у живой рутины. Окно тут
   * ограничено `staleTime` обзора (30 с) и `refetchOnMount` чинит его сам, но чинит поздно и
   * не всегда: возврат на экран внутри окна показывает ту же неправду.
   */
  const { mutation: update } = useEntityUpdate(entity.id, { onSettled: invalidateOverview });

  const run = lastRun?.props;
  const outcome = str(run?.['orbis/run_outcome']);
  // «Идёт» — по ПОСЛЕДНЕМУ прогону: больше одного running на рутину сервер не заводит (V1.3),
  // поэтому идущий прогон всегда самый свежий.
  const running = outcome === 'running';
  const startedAt = str(run?.['orbis/run_started_at']) ?? lastRun?.createdAt;

  /**
   * Следующее срабатывание. Пауза отвечает на этот вопрос САМА и без сервера: рутина на паузе
   * не сработает вовсе, и обещать ей время значило бы обещать то, чего не будет. Читаем её из
   * аспекта, а не из `nextBucketAt: null`, ради оптимистичного патча — нажатая «Пауза» обязана
   * менять строку сразу, а не после того, как обзор съездит на сервер.
   *
   * Прочерк остаётся на случай, которого сегодня нет (активная рутина без слота в горизонте
   * восьми дней): молчать о нём хуже, чем показать, что расписание ничего не даёт.
   */
  const next = paused
    ? 'на паузе'
    : overview.data === undefined
      ? '…'
      : overview.data.nextBucketAt === null
        ? '—'
        : formatDate(overview.data.nextBucketAt, tz);

  const failure = runNow.isError
    ? runNow.error.message
    : update.isError
      ? update.error.message
      : null;

  return (
    <section
      data-testid="routine-status"
      aria-label="Состояние рутины"
      className="flex flex-col gap-2 rounded-control border border-line bg-surface-2/40 p-4"
    >
      <Row label="Режим">
        {modeLabel(str(routine['orbis/routine_mode']), strArray(routine['orbis/allowed_tools']))}
      </Row>
      <Row label="Расписание">
        {str(routine['orbis/routine_at']) ?? '—'} ·{' '}
        {daysLabel(strArray(routine['orbis/routine_days']))}
      </Row>
      <Row label="Следующее срабатывание">{next}</Row>
      {/* Неразобранная пачка (D42) — рядом со «следующим срабатыванием» и по той же причине:
          обе строки отвечают на вопрос «что с рутиной прямо сейчас». Считает её сервер
          АСПЕКТНЫМ фильтром по прогонам (С8), поэтому цифра — про ПРОГОНЫ с нерешённым, а не
          про единицы: точное число единиц читается на экране самого прогона, туда и ведут
          бейджи истории ниже.
          Нуля здесь не бывает: «Пачка решений: 0 прогонов» на каждой рутине — шум, а не
          сведения. И это единственный читатель поля: посчитанное, но никем не прочитанное
          поле обзора — то, чем уже стали `waiting` и `openProposal` (Р-11). */}
      {overview.data !== undefined && overview.data.undecided > 0 && (
        <Row label="Пачка решений">
          {overview.data.undecided}{' '}
          {plural(overview.data.undecided, 'прогон', 'прогона', 'прогонов')}
        </Row>
      )}
      {outcome !== undefined && lastRun !== undefined && (
        <Row label="Последний прогон">
          {/* Ссылкой на сам прогон: «сбой» без возможности посмотреть, на чём именно, — это
              сообщение, на которое нечем ответить. Открытие — тем же push поверх стека
              активной вкладки, что у истории прогонов и подзадач. */}
          <button
            type="button"
            data-testid="routine-last-run"
            onClick={() => openEntity(lastRun.id)}
            className="cursor-pointer text-accent hover:underline"
          >
            {RUN_OUTCOME_LABELS[outcome] ?? outcome}
            {startedAt !== undefined && ` · ${formatDate(startedAt, tz)}`}
          </button>
        </Row>
      )}
      {/* Отказ ЛЮБОЙ из двух кнопок: «прогон уже идёт» (CONFLICT) и «лимит на сегодня исчерпан»
          (TOO_MANY_REQUESTS) — нормальные ответы сервера, и молчание о них читалось бы как
          «запустилось». Одна строка на обе: нажимают их по очереди, обе разом в полёте не
          бывают. */}
      {failure !== null && (
        <p role="alert" className="text-danger text-sm">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          // Пока прогон идёт, второго сервер всё равно не заведёт (V1.3) — кнопка, которая
          // гарантированно отказывает, хуже её отсутствия. Но исчезать ей нельзя: подпись
          // рядом отвечает на вопрос «почему нельзя».
          disabled={running || runNow.isPending}
          onClick={() => runNow.mutate({ routineId: entity.id })}
        >
          Прогнать сейчас
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() =>
            update.mutate({
              id: entity.id,
              // Патч мержится по КЛЮЧАМ свойств (§А1-1): расписание, режим и права пауза
              // не трогает — возобновлённая рутина обязана вернуться ровно к прежнему
              // расписанию.
              props: { 'orbis/routine_stage': paused ? 'active' : 'paused' },
            })
          }
        >
          {paused ? 'Возобновить' : 'Пауза'}
        </Button>
        {running && <span className="text-sm text-text-muted">идёт прогон</span>}
      </div>
    </section>
  );
}
