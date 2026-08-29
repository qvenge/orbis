// Пачка решений прогона (D42 §7) — место, где владелец разбирает её КАК ЦЕЛОЕ.
//
// Карточки единиц живут и в ленте треда рутины, и этого мало: тред — лента, где вопрос
// прошлой ночи лежит между сообщениями позапрошлой, а пачка на то и пачка, что решают её
// подряд. Здесь единицы стоят рядом, к ним добавлены два жеста над всей пачкой сразу —
// «Принять все» и «Продолжить сейчас», — и сказано то, чего в ленте не скажешь: рутина на
// паузе и ответы прочитает не сейчас.
//
// Компоненты карточек — ТЕ ЖЕ, что в ленте (`QuestionCard`/`DeferredActionCard`), и кэш
// пачки у них общий с этим блоком (`routine.runUnits` по `{runId}`): владелец ходит между
// двумя местами, и одно событие обязано выглядеть в них одинаково.
import { useId, useState } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { useRegistry } from '../../lib/registry/useRegistry';
import { openEntity } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { DeferredActionCard } from '../chat/cards/DeferredActionCard';
import { divergenceRows } from '../chat/cards/proposal-text';
import { QuestionCard } from '../chat/cards/QuestionCard';
import {
  actionFateNote,
  questionFateNote,
  type RunUnitView,
  UNIT_FATE_NOTES,
} from '../chat/cards/unit-text';
import { obj, str } from './aspect-read';

type Entity = RouterOutputs['entity']['get']['entity'];
/** Строка сводки «Принять все»: судьба единицы плюс её адрес (lifecycle.ts DecideAllItem). */
type DecideAllItem = RouterOutputs['routine']['decideAll'][number];

/**
 * Исход единицы в сводке — словом. Record по союзу статусов, а не `Record<string, string>`:
 * новый исход `decideAll` упадёт СБОРКОЙ, а не молча пропадёт из сводки.
 *
 * `rejected` сегодня недостижим («Принять все» зовёт только approve), но выписан: он часть
 * контракта `DecideDeferredResult`, и умолчания у него быть не должно.
 */
const SUMMARY_LABELS: Record<DecideAllItem['status'], string> = {
  applied: 'Применено',
  stale: 'Устарело',
  rejected: 'Отклонено',
  already: 'Уже решено',
};

/** Порядок счётчиков в сводке — от «сработало» к «не потребовалось», а не порядок ответа. */
const SUMMARY_ORDER: DecideAllItem['status'][] = ['applied', 'stale', 'rejected', 'already'];

function countsLine(items: DecideAllItem[]): string {
  return SUMMARY_ORDER.map((status) => ({
    status,
    n: items.filter((i) => i.status === status).length,
  }))
    .filter(({ n }) => n > 0)
    .map(({ status, n }) => `${SUMMARY_LABELS[status]}: ${n}`)
    .join(' · ');
}

/**
 * Единица СЛОВАМИ — для строки-заглушки и для адреса в сводке.
 *
 * Порядок источников — от точного к грубому: вопрос лежит в самой единице; текст действия
 * несёт его карточка (`summary` — та же сводка, что сервер пишет в ленту); последним остаётся
 * имя глагола. Пустой строки на выходе не бывает НИ ПРИ ЧЁМ: единица, о которой нечего
 * сказать, — это единица, исчезнувшая для владельца (Н-3).
 */
function unitText(unit: RunUnitView): string {
  if (unit.question !== undefined) return unit.question;
  const card = unit.card;
  if (card !== undefined && 'summary' in card) return card.summary;
  return unit.tool === undefined ? 'единица без описания' : `действие ${unit.tool}`;
}

/** Судьба единицы словом; открытая — «ждёт решения», а не пустое место. */
function unitFateNote(unit: RunUnitView): string {
  const note = unit.kind === 'question' ? questionFateNote(unit) : actionFateNote(unit);
  return note ?? UNIT_FATE_NOTES.open;
}

/**
 * Единица, у которой не сохранилась карточка (`metadata.cards[0]`): старая запись, чужой
 * производитель, повреждённая метадата. Рисуется СТРОКОЙ, а не пропускается (Н-3): пачка,
 * потерявшая единицу молча, читается как разобранная, а флажок `undecided` на прогоне
 * продолжает говорить обратное — и объяснить это владельцу будет нечем.
 *
 * Кнопок у строки нет намеренно: решать нечего показать — ни полей «было → станет», ни
 * вариантов ответа. Открытое действие при этом заберёт «Принять все» (сервер отбирает
 * открытые сам, по прогону), а вопрос без текста и отвечать не на что.
 */
function UnitStub({ unit }: { unit: RunUnitView }) {
  return (
    <p
      data-testid="unit-stub"
      className="flex flex-wrap items-baseline gap-x-2 rounded-control border border-line border-dashed p-3 text-sm"
    >
      <span className="min-w-0 break-words">{unitText(unit)}</span>
      <span className="text-text-muted">— {unitFateNote(unit)}</span>
    </p>
  );
}

/**
 * Блок пачки. Наружу — по сущности прогона, внутрь — уже разобранными полями: у самого блока
 * хуков нет вовсе, поэтому «это не рутинный прогон» решается ДО первого запроса.
 *
 * Пачка бывает только у рутинного прогона: и `orbis_ask`, и отложка на диспатче закрыты
 * гейтом внутреннего раннера (ОЧ.12). У прогона внешнего исполнителя блок не просто пуст —
 * его проба была бы лишней на каждом открытии чужого экрана.
 */
export function RunDecisionsBlock({ entity }: { entity: Entity }) {
  // Значения прогона — плоско в `props` по id свойства (§А1-1).
  const run = entity.props;
  const routineId = str(run['orbis/run_routine']);
  if (routineId === undefined) return null;
  return (
    <RunBatch
      runId={entity.id}
      routineId={routineId}
      // Сверка ЯВНАЯ, а не через разбор аспекта: `aspect-read` boolean не умеет (Р-18), и
      // «поле есть» означало бы «неразобрано» в том числе у `undecided: false`.
      flagged={run['orbis/undecided'] === true}
      // В3: новый прогон гасит всё нерешённое прошлого (ОЧ.8), включая ТЕРМИНАЛЬНЫЙ вопрос,
      // на который ещё не ответили. Условие — то же, что читает лента прогона выше.
      terminalUnanswered={
        str(run['orbis/run_outcome']) === 'checkpoint' &&
        str(obj(run['orbis/run_reply'])?.text) === undefined
      }
    />
  );
}

function RunBatch({
  runId,
  routineId,
  flagged,
  terminalUnanswered,
}: {
  runId: string;
  routineId: string;
  /** `undecided` на аспекте прогона: у прогона осталось нерешённое (ОЧ.6). */
  flagged: boolean;
  terminalUnanswered: boolean;
}) {
  const utils = trpc.useUtils();
  // Разбор расхождений в сводке пачки подписан теми же словами реестра, что и карточки под
  // ней (§А9-2): владелец читает сводку и карточки подряд.
  const registry = useRegistry();
  const cancelId = useId();
  const [confirm, setConfirm] = useState(false);
  /**
   * Сводка ПОСЛЕДНЕГО нажатия «Принять все» — тем же приёмом, что расхождения одиночной
   * карточки: перечитанная пачка расскажет про судьбы, но не про то, что случилось с ЭТИМ
   * нажатием. Протухшие единицы сервер уже погасил, и в пачке они лежат просто отклонёнными
   * по причине `stale` — расхождения, ради которых сводку и читают, есть только здесь.
   */
  const [summary, setSummary] = useState<DecideAllItem[] | null>(null);

  /**
   * Пачка — ОДНИМ запросом на прогон, тем же ключом, каким её читает каждая карточка
   * (`useRunUnit`): кэш общий, и решение одной карточки обновляет весь блок.
   */
  const units = trpc.routine.runUnits.useQuery({ runId });
  // Та же защита, что у списка прогонов: блок живёт на общем detail-экране, и неожиданная
  // форма ответа не должна ронять всю страницу.
  const list = Array.isArray(units.data) ? units.data : [];
  const loaded = units.data !== undefined;

  /**
   * Блок виден по ЛЮБОМУ из двух признаков, и это не перестраховка.
   *
   * Флажок — то, что знает сам прогон, и он приезжает без сети; но снимает его бухгалтерский
   * патч ОТДЕЛЬНЫМ шагом после решения (лестница §5), и упавший патч оставил бы «неразобрано»
   * на разобранной пачке. Непустая пачка — то, что знает сервер наверняка; но за ней надо
   * съездить. Показывая по любому, блок не исчезает ни в одном из двух рассинхронов.
   */
  const visible = flagged || list.length > 0;

  /**
   * Пауза рутины. Читается ОБЗОРОМ (`nextBucketAt: null` — сработать ей нечем), а не аспектом
   * рутины: сущности рутины на экране прогона нет, есть только её id, и тянуть её целиком
   * ради одного поля дороже, чем взять уже посчитанный обзор — тот же, что рисует экран
   * рутины. Запрос — только у ВИДИМОГО блока: прогону без пачки пауза ничего не сообщает.
   *
   * Пока обзор едет (или не доехал вовсе), рутина считается работающей, и кнопка на месте:
   * `runNow` разрешён и на паузе (рука владельца выше расписания), поэтому «показать лишнюю
   * кнопку» здесь ошибка дешевле, чем «спрятать рабочую».
   */
  const overview = trpc.routine.overview.useQuery({ routineId }, { enabled: visible });
  const paused = overview.data?.nextBucketAt === null;

  const decideAll = trpc.routine.decideAll.useMutation({
    onSuccess: (items) => {
      setSummary(items);
      // Решение двигает граф (применённые правки) и снимает флажок с аспекта прогона —
      // тот же хвост, что у одиночной карточки (`useRunUnit.settled`), кроме ленты треда:
      // на экране прогона её нет вовсе (рулинг П-5).
      invalidateGraph(utils);
      if (items.some((i) => i.status === 'applied')) void utils.budget.invalidate();
      void utils.routine.overview.invalidate();
      void units.refetch();
    },
  });

  const runNow = trpc.routine.runNow.useMutation({
    onSuccess: ({ runId: started }) => {
      setConfirm(false);
      // Поведение то же, что у «Прогнать сейчас» на экране рутины (Решение 9): ответ приходит
      // ДО модели, и за исходом владелец идёт на экран нового прогона.
      invalidateGraph(utils);
      void utils.routine.overview.invalidate();
      openEntity(started);
    },
    // Отказ («прогон уже идёт», исчерпан лимит) показываем строкой, а модалку закрываем:
    // диалог поверх сообщения об ошибке читался бы как «нажми ещё раз».
    onError: () => setConfirm(false),
  });

  if (!visible) return null;

  /** «Принять все» трогает только открытые ДЕЙСТВИЯ (ОЧ.11) — по ним и решается показ. */
  const hasOpenAction = list.some((u) => u.kind === 'action' && u.fate === 'open');
  /** Протухшие строки сводки — с текстом своей единицы: сводку читают именно по ним. */
  const stale = (summary ?? [])
    .filter((i) => i.status === 'stale')
    .map((i) => {
      const unit = list.find((u) => u.pendingId === i.pendingId);
      // Единицы не нашлось — печатаем адрес: пропустить строку значило бы скрыть от владельца
      // то, что часть пачки не применилась.
      return {
        ...i,
        text: unit === undefined ? i.pendingId : unitText(unit),
        // Тело приезжает флагом (РП-10) — разворачиваем той же функцией, что и все прочие
        // места показа: иначе «устарело по телу» стояло бы здесь с пустым списком причин.
        rows: divergenceRows(registry, i),
      };
    });
  const failure = decideAll.isError
    ? decideAll.error.message
    : runNow.isError
      ? runNow.error.message
      : null;

  return (
    <section
      data-testid="run-decisions"
      aria-label="Пачка решений"
      className="flex flex-col gap-3 rounded-control border border-line bg-surface-2/40 p-4"
    >
      <h3 className="text-2xs font-medium uppercase tracking-wide text-text-muted">
        Пачка решений
      </h3>

      {!loaded ? (
        // Отказ чтения — СЛОВАМИ сервера: пачка читается fail-closed (повреждённая запись
        // роняет весь список), и вечное «…» на её месте читалось бы как «ещё грузится».
        <p className="text-sm text-text-muted">{units.isError ? units.error.message : '…'}</p>
      ) : list.length === 0 ? (
        // Флажок стоит, а единиц нет: бухгалтерия отстала от решений (лестница §5). Молчать
        // нельзя — прогон говорит «неразобрано», и пустое место читалось бы как «разобрано».
        <p className="text-sm text-text-muted">
          Единиц пачки нет — флажок снимет следующее решение или прогон.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((unit) =>
            // `threadId` НЕ передаётся: у экрана прогона ленты нет, инвалидировать нечего
            // (рулинг П-5, тот же довод, что у карточки предложения).
            unit.card?.kind === 'question_card' ? (
              <QuestionCard key={unit.pendingId} card={unit.card} />
            ) : unit.card?.kind === 'deferred_action_card' ? (
              <DeferredActionCard key={unit.pendingId} card={unit.card} />
            ) : (
              <UnitStub key={unit.pendingId} unit={unit} />
            ),
          )}
        </div>
      )}

      {summary !== null && (
        <div
          // Сводка приезжает ПО ЖЕСТУ владельца, и фокус в этот момент стоит на кнопке: без
          // живой области скринридер не сказал бы о ней ни слова. `status`, а не `alert`:
          // перебивать чтение нечем — это ответ на нажатие, а не происшествие.
          role="status"
          data-testid="decide-all-summary"
          className="flex flex-col gap-2 rounded-control border border-line bg-surface p-3 text-sm"
        >
          {summary.length === 0 ? (
            // Повтор кнопки даёт ПУСТУЮ сводку, а не N строк «уже решено»: сервер отбирает
            // только открытые единицы (ОЧ.11), и молчание здесь читалось бы как отказ.
            <p>Решать было нечего: открытых действий в пачке не осталось.</p>
          ) : (
            <>
              <p>{countsLine(summary)}</p>
              {stale.map((item) => (
                <div key={item.pendingId} className="flex flex-col gap-1">
                  {/* Устаревшая названа СВОИМ текстом: в сводке из нескольких строк
                      «устарело» без имени единицы не отвечает на вопрос «что именно». */}
                  <p className="text-text-secondary">
                    {item.text} — устарело: состояние изменилось.
                  </p>
                  <ul className="flex flex-col gap-1 text-text-secondary text-xs">
                    {item.rows.map((row) => (
                      <li key={row.key}>{row.text}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {failure !== null && (
        <p role="alert" className="text-danger text-sm">
          {failure}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {hasOpenAction && (
          <Button
            size="sm"
            // Заблокирована и на время ПЕРЕЧИТЫВАНИЯ пачки: между ответом сервера и приездом
            // новых судеб кнопка ещё жива, и второй клик ушёл бы в уже разобранную пачку.
            disabled={decideAll.isPending || units.isFetching}
            onClick={() => decideAll.mutate({ runId })}
          >
            Принять все
          </Button>
        )}
        {/* Кнопка НЕ «Прогнать сейчас» с экрана рутины и не её копия: там жест значит
            «проверить, работает ли рутина», здесь — «прочитай то, что я тебе ответил»
            (ОЧ.7). Одно имя на два смысла обмануло бы владельца ровно в тот момент, когда
            он разбирает пачку. */}
        {!paused && (
          <Button
            size="sm"
            variant="outline"
            disabled={runNow.isPending}
            onClick={() => (terminalUnanswered ? setConfirm(true) : runNow.mutate({ routineId }))}
          >
            Продолжить сейчас
          </Button>
        )}
      </div>

      {paused && (
        <p data-testid="batch-paused" className="text-text-muted text-xs">
          Рутина на паузе — ответы прочитает после возобновления.
        </p>
      )}

      {/* Предупреждение — СВОЕЙ разметкой (В3), а не `window.confirm`: тот блокирует поток
          страницы, не читается скринридером как часть приложения и не воспроизводится в
          тестах вовсе. Образец — подтверждение отката в ленте прогона. */}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Продолжить прогон рутины?"
        // Фокус — на «Отмена», а не на первом таб-стопе: жест необратим (вопрос будет снят),
        // и Enter сразу по открытии модалки не должен его совершать. По id, а не по ссылке:
        // `Button` — не forwardRef-компонент.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document.getElementById(cancelId)?.focus();
        }}
      >
        <div className="flex flex-col gap-3 pt-2">
          <p className="text-sm text-text-secondary">
            Неотвеченный вопрос прогона будет снят: новый прогон гасит всё нерешённое прошлого. Если
            это всё ещё нужно, рутина спросит заново — уже по свежему состоянию.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button id={cancelId} variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              Отмена
            </Button>
            <Button
              size="sm"
              disabled={runNow.isPending}
              onClick={() => runNow.mutate({ routineId })}
            >
              Продолжить
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
