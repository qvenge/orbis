import { buildAppPath } from '@orbis/shared';
import { Archive, ArchiveRestore, Code, EllipsisVertical, History, Link2, Pin } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NotFoundScreen } from '../../app/NotFoundScreen';
import { ScreenHeader } from '../../app/ScreenHeader';
import { invalidateGraph } from '../../lib/invalidate';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { DropdownMenu } from '../../ui/DropdownMenu';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs } from '../../ui/Tabs';
import { useToast } from '../../ui/toast-store';
import { usePlanToFactPrompt } from '../budget/usePlanToFactPrompt';
import { AspectCards } from './AspectCards';
import { AssignmentCard } from './AssignmentCard';
import { BodyScreenProvider } from './EntityBody';
import { GoalProgressSlot, PlanToFactSlot } from './own-cards';
import { ProposalOverlay } from './ProposalOverlay';
import { ROUTINE_ASPECT, RoutineStatusBlock } from './RoutineStatusBlock';
import { RunFeed } from './RunFeed';
import { RunsList } from './RunsList';
import {
  BacklinksBlock,
  BlockersBlock,
  BodyBlock,
  SubtasksBlock,
  ThreadBlock,
  TitleBlock,
  VersionsBlock,
} from './record-blocks';
import { RecordHostProvider, recordHostValue, TabPartHost } from './record-host';
import { TicketWaitingBlock } from './TicketWaitingBlock';
import { useEntityDetail } from './useEntityDetail';
import { RUN_ASPECT, useTicketRuns } from './useTicketRuns';
import { PinVersionDialog } from './VersionsCard';

const TASK = 'orbis/task';
const ASSIGNMENT = 'orbis/assignment';
const PROJECT = 'orbis/project';

export function DetailScreen({ entityId }: { entityId: string }) {
  const { get, setArchived, conflict, dismissConflict } = useEntityDetail(entityId);
  const utils = trpc.useUtils();
  const settings = trpc.user.getSettings.useQuery();
  const updateSettings = trpc.user.updateSettings.useMutation({
    onSuccess: () => void utils.user.getSettings.invalidate(),
  });
  // §2.7: перевод задачи-покупки в done → карточка «Покупка совершена?» (Task B6).
  // Состояние живёт ЗДЕСЬ, у хоста, а не в заголовке: поднимает его чекбокс `TitleBlock`
  // (record-blocks.tsx — единственный мутационный путь чекбокса), а показывает карточка
  // «план → факт», которую шаблон вправе поставить в другое место дерева (Ф-1а-18).
  const planToFact = usePlanToFactPrompt();
  // §3.5 «Скопировать ссылку». Буфер обмена — не данность: его нет в http-контексте,
  // а разрешение пользователь может и не дать. На отказе показываем саму ссылку
  // (manualLink), чтобы копирование осталось возможным руками, а не превратилось в
  // кнопку, которая молча ничего не делает.
  //
  // Ссылка хранится ВМЕСТЕ с id сущности, которой принадлежит. Роутер монтирует этот
  // экран без key (router.tsx), поэтому переход entity→entity внутри таба — бэклинк,
  // подзадача, блокировка — меняет только проп: инстанс тот же, состояние переживает
  // переход. Голая строка осталась бы висеть под заголовком СОСЕДНЕЙ сущности и
  // предлагала бы скопировать чужой адрес. Сверка id при рендере делает это невозможным
  // по построению, а не «пока не забыли прибраться»: где буфер отказывает (небезопасный
  // контекст), он отказывает каждый раз, и плашка там — не редкий гость.
  const [manualLink, setManualLink] = useState<{ id: string; url: string } | null>(null);
  // Режим «править как markdown» живёт ЗДЕСЬ, а не в теле: включает его пункт меню ⋮, а меню —
  // в шапке, снаружи вкладок. Сбрасывается сменой записи по той же причине, что и manualLink:
  // экран монтируется без key, и режим правки, переехавший на соседнюю запись, открывал бы её
  // сырым текстом без единого жеста человека.
  const [asMarkdown, setAsMarkdown] = useState(false);
  // Диалог «Закрепить версию» (С11): жест приходит из меню ⋮, а меню — в шапке, снаружи
  // вкладок, поэтому и флаг живёт здесь. Монтируется диалог только открытым (см. VersionsCard).
  const [pinVersion, setPinVersion] = useState(false);
  /**
   * Какая вкладка открыта — ЕДИНСТВЕННЫМ местом: `Tabs` ниже управляемый (`value`), своего
   * состояния у него нет.
   *
   * Нужно это списку версий: «Детали» живут смонтированными всегда (keepMounted ниже), и без
   * признака активности их запрос уходил бы на каждом открытии любой записи, включая те, где по
   * вкладкам никто не ходил. Второй копией правды признак быть не может: экран монтируется БЕЗ
   * key (router.tsx), и переход на НЕкэшированную запись показывает скелетон — `Tabs`
   * размонтировался бы и встал заново на «Сущности», а копия здесь осталась бы на «Деталях».
   * Экран показывал бы одно, секция версий думала бы другое и шла бы в сеть (ревью Задачи 16).
   *
   * При смене записи вкладка НЕ сбрасывается — намеренно. Прежний сброс случался только на
   * холодном пути (ремоунт по скелетону) и был побочным следствием, а не замыслом: тот же
   * переход по кэшу вкладку сохранял. Единообразное «остаёмся там, где смотрели» и полезнее —
   * листая подзадачи с «Деталей», человек хочет видеть «Детали» соседней записи.
   */
  const [openTab, setOpenTab] = useState('entity');
  /**
   * Куда тело рисует свои плашки — узел НАД вкладками (см. `noticeHost` в разметке ниже).
   *
   * Состоянием, а не рефом: портал обязан перерисоваться, когда узел появился, а реф рендера не
   * будит. Один лишний проход на монтировании, до первой отрисовки, — вся цена.
   */
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null);
  /**
   * Развёрнут ли слой предложения (Ш1.3) — и, значит, спрятана ли область вкладок.
   *
   * Признак живёт ЗДЕСЬ, потому что класс вешает эта разметка, а не слой: вкладки лежат под
   * ним, а сам слой стоит снаружи них. Слой сообщает только «развёрнут / свёрнут» (см.
   * `onOverlayExpanded`), а какой узел от этого прячется — дело экрана.
   *
   * ПРЯЧЕМ КЛАССОМ, А НЕ СНЯТИЕМ С МОНТИРОВАНИЯ, и это не стиль: `useBodySave` при
   * размонтировании делает `flush()` отложенной правки, то есть отправку в сеть — ровно то,
   * от чего слой и закрывает тело (Р-18). Живое под `display:none` тело правку не начнёт: до
   * него не дотянуться ни кликом, ни табом. `inert` тут не годится по ДРУГОЙ причине: он
   * отнимает ввод, но оставляет всё на экране, — а вторая с виду такая же строка «статус»
   * (см. узел вкладок ниже) путает именно тем, что её ВИДНО.
   */
  const [proposalOpen, setProposalOpen] = useState(false);
  const prevIdRef = useRef(entityId);
  if (prevIdRef.current !== entityId) {
    prevIdRef.current = entityId;
    setAsMarkdown(false);
    // Диалог закрепления — про ТУ запись, из чьего меню его открыли: пережив переход, он
    // закрепил бы соседнюю (экран монтируется без key, router.tsx).
    setPinVersion(false);
    // Слой переезжает на соседнюю запись вместе с экраном (монтируется без key), и его
    // собственное состояние обнуляет `key` ниже. Но признак живёт ЗДЕСЬ, и один кадр между
    // сменой пропа и его извещением тело соседней записи стояло бы спрятанным ни за что.
    setProposalOpen(false);
  }
  const { show } = useToast();
  const push = useNav((s) => s.push);
  const activeTab = useNav((s) => s.activeTab);

  /**
   * ADE-срез 1 (С10). Тикет — задача С НАЗНАЧЕНИЕМ, а не всякая задача: чекпойнт-блок и история
   * прогонов есть только у неё. Карточка назначения — у ЛЮБОЙ задачи (см. `detailsTab`): её и
   * ставит владелец, а до этого тикета ещё нет.
   *
   * Читаем `get.data` ДО ветки скелетона: хуки обязаны идти безусловно, а «данных ещё нет»
   * выражено флагом `enabled` — запрос уйдёт, когда станет известно, о чём спрашивать.
   */
  const loaded = get.data?.entity;
  // Гейты блоков — по СПИСКУ аспектов записи (§А1-1), а не по наличию ключа в карте полей:
  // аспект перестал быть владельцем полей (Р9), и его наличие теперь отдельный факт —
  // навешенный аспект без единого заполненного свойства прежде был неотличим от снятого.
  const isTicket = (loaded?.aspects.includes(TASK) && loaded.aspects.includes(ASSIGNMENT)) === true;
  /**
   * V1.14. Рутина открывается ТЕМ ЖЕ экраном: тело — инструкция исполнителю, «Детали» — карточка
   * аспекта и история прогонов, «Тред» — обсуждение и карточки предложений. Своего экрана у неё
   * нет намеренно — она обычная запись графа, а не отдельная сущность приложения.
   *
   * Прогоны читаются тем же `useTicketRuns` и тем же запросом (`children_of=<рутина>`): прогон
   * рутины — такая же дочерняя запись с аспектом `orbis/agent-run`, и второй выборки для неё
   * заводить незачем.
   */
  const isRoutine = loaded?.aspects.includes(ROUTINE_ASPECT) === true;
  const { runs, lastRun } = useTicketRuns(entityId, isTicket || isRoutine);

  /**
   * Подметание брошенных прогонов (С6) — на открытии тикета или проекта, ОДИН раз.
   *
   * Инвариант 6 («тикет не висит in_progress навсегда») не должен зависеть от того, что
   * какой-то агент однажды придёт за очередью: владелец, открывший экран, чинит это сам, ничего
   * об этом не зная. Отсюда и место — экран, а не фон.
   *
   * Гвард на ref, а не «эффект с пустыми зависимостями»: `<StrictMode>` (main.tsx) прогоняет
   * эффекты монтирования ДВАЖДЫ, и без него каждое открытие стоило бы двух мутаций. Ключ гварда —
   * id записи: экран монтируется БЕЗ key (router.tsx), и переход тикет→тикет внутри вкладки
   * обязан подмести заново.
   */
  // Рутина — третья цель подметания, и по той же причине: плановый прогон срывается ВМЕСТЕ с
  // процессом (деплой Render роняет контейнер посреди цикла) и остаётся `running` навсегда, а
  // сервер до следующего тика планировщика об этом не узнает. Владелец, открывший рутину,
  // чинит это сам, ничего об этом не зная.
  const sweepTarget = isTicket || isRoutine || loaded?.aspects.includes(PROJECT) === true;
  const sweep = trpc.agentRun.sweep.useMutation({
    // Подметание МЕНЯЕТ граф (тикеты возвращаются в planned, прогоны становятся abandoned) —
    // экран обязан показать результат сразу, а не через минуту протухания списков. Но только
    // когда что-то подмели: обычный ответ — `{swept: 0}`, и безусловная инвалидация стоила бы
    // второго entity.get с телом и bodyDoc на КАЖДОМ открытии тикета или проекта.
    onSuccess: (r) => {
      if (r.swept > 0) invalidateGraph(utils);
    },
  });
  const sweptForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sweepTarget || sweptForRef.current === entityId) return;
    sweptForRef.current = entityId;
    sweep.mutate({});
  }, [entityId, sweepTarget, sweep.mutate]);

  async function copyLink() {
    // Форму пути знает ТОЛЬКО buildAppPath (B1): собранная здесь руками строка разъехалась
    // бы с роутером при первой же правке таблицы маршрутов, и ссылки из чужих писем вели
    // бы в никуда. origin делает её абсолютной — ссылку отправляют наружу, а не внутрь SPA.
    const url = `${window.location.origin}${buildAppPath({ kind: 'entity', id: entityId })}`;
    try {
      // Обращение к navigator.clipboard намеренно внутри try: когда API нет вовсе,
      // это TypeError — та же беда для пользователя, что и отклонённое разрешение.
      await navigator.clipboard.writeText(url);
      setManualLink(null);
      show('Ссылка скопирована');
    } catch {
      setManualLink({ id: entityId, url });
    }
  }

  // §1.3: ссылка на удалённую или чужую сущность. Без этой ветки NOT_FOUND давал вечный
  // скелетон: isLoading уже false, а data не приедет никогда. Проверка — ровно по коду:
  // сеть и 500 «не найдено» не означают, и подменять их этим экраном значило бы врать
  // (такие ошибки остаются на прежнем поведении — это отдельный разговор, не §1.3).
  if (get.isError && get.error.data?.code === 'NOT_FOUND') return <NotFoundScreen />;

  if (get.isLoading || !get.data) {
    return (
      <>
        <ScreenHeader title="…" />
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-24" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </>
    );
  }
  const { entity } = get.data;
  /**
   * Хост записи (спека страниц 1а §7.3): части экрана — примитивы обвязки, и данные они берут
   * отсюда, из ответа `entity.get` этого экрана, а не пропами. Раскладка ниже — прежняя; её
   * стережёт структурный снимок задачи 2 (`structure.test.tsx`).
   */
  const host = recordHostValue(get.data, { planToFact, activeTab: openTab, readOnlyBody: false });

  // Вкладка «Сущность» — чистый документ: emoji, заголовок, полоса прогресса и тело. Всё
  // остальное, что известно о записи, уехало в «Детали».
  //
  // Полоса прогресса — единственное исключение, и осознанное: у цели прогресс это то, ради чего
  // её открывают, и «50%, 150 000 из 300 000» во второй вкладке ухудшило бы главный экран целей
  // ради чистоты раскладки.
  const entityTab = (
    <TabPartHost value="entity" open={openTab === 'entity'}>
      <div className="flex flex-col gap-6 px-4 pb-10 pt-5 md:px-6">
        <TitleBlock />
        {/* Карточка plan→fact (§2.7) — инлайн под строкой задачи, как в мокапе */}
        <PlanToFactSlot />
        <GoalProgressSlot />
        {/* Тикет остановился и ждёт человека (С10, приёмка 7–8): вопрос исполнителя, итог работы
            или разбор оборванного прогона — с полем ответа прямо здесь. Место — на «Сущности», а не
            в «Деталях»: это не свойство записи, а то, ради чего её открыли.
            key по id — по той же причине, что у тела: экран монтируется БЕЗ key (router.tsx), и
            набранный, но не отправленный ответ переехал бы на соседний тикет. */}
        {isTicket && (
          <TicketWaitingBlock key={`waiting-${entity.id}`} entity={entity} lastRun={lastRun} />
        )}
        {/* Состояние рутины (V1.14): расписание, режим, следующее срабатывание, итог прошлого
            прогона и два жеста владельца. Место — здесь же, рядом с телом-инструкцией: рутину
            открывают ради того, что она делает и делает ли вообще.
            key по id — по той же причине, что у блока ожидания: экран монтируется БЕЗ key
            (router.tsx), а у блока своё состояние (отказ «прогон уже идёт»), и переезжать на
            соседнюю рутину оно не должно. */}
        {isRoutine && (
          <RoutineStatusBlock key={`routine-${entity.id}`} entity={entity} lastRun={lastRun} />
        )}
        {/* Экран самого прогона (С5, С12): лента шагов, исход и откат. Место — рядом с блоком
            ожидания и по той же причине: у прогона нет «свойств», ради которых его открывают, —
            есть работа, которую он проделал. Условие — по аспекту, а не по `isTicket`: прогон
            это НЕ тикет (аспекта `orbis/task` у него нет), и подметание с историей прогонов ему
            не положены.
            key — по той же причине, что у блока ожидания: лента держит своё состояние (открытое
            подтверждение отката, результат прошлого), и переезжать на соседний прогон оно не
            должно. */}
        {entity.aspects.includes(RUN_ASPECT) && (
          <RunFeed key={`run-${entity.id}`} entity={entity} />
        )}
        {/* Тело (key по id и `this` вокруг него — см. BodyBlock). `this` не передаётся наружу
            тела НАМЕРЕННО: в Browser, закреплённых списках и конструкторе запросов `this`
            вынесенного блока означал бы «та запись, из чьего тела блок скопировали», а не
            «текущий экран», — и блок обязан ответить ошибкой, а не взять чужой id. */}
        <BodyBlock />
      </div>
    </TabPartHost>
  );

  const detailsTab = (
    <TabPartHost value="details" open={openTab === 'details'}>
      <div className="flex flex-col gap-6 px-4 pb-10 pt-5 md:px-6">
        {/* Назначение — у ЛЮБОЙ задачи, а не только у тикета: исполнителя ставит владелец, и
            именно этим жестом задача становится тикетом. И у любой записи, где назначение уже
            ЕСТЬ: сервер orbis/task для него не требует, а общая карточка свойств аспект прячет —
            без этой ветки назначение на заметке было бы невидимо и неснимаемо. */}
        {(entity.aspects.includes(TASK) || entity.aspects.includes(ASSIGNMENT)) && (
          <AssignmentCard entity={entity} />
        )}
        {/* Общие секции аспектов (поля цели, рутины, финансов — здесь; их прогресс и состояние —
            на «Сущности»). Не `RestCards`: тот рисует свои карточки целиком, а сегодняшняя
            раскладка их разносит. */}
        <AspectCards entity={entity} />
        {/* Версии тела (С11, приёмка 12) — рядом со свойствами записи, до секций графа: снимок
            хранит ТОЛЬКО тело, и к подзадачам, блокировкам и бэклинкам он отношения не имеет.
            В сеть — только на открытой вкладке (TabPartHost). */}
        <VersionsBlock />
        {/* Секции 6–8 §3.5: связи уже приехали этим же entity.get — своих запросов графа
            секции не заводят. */}
        <SubtasksBlock />
        {/* История прогонов — своей секцией, а не строками общих связей: у прогона есть исход,
            длина и исполнитель, и читают их таблицей, а не списком заголовков. Открытие — тем же
            push поверх стека активной вкладки, что и у подзадач. */}
        {(isTicket || isRoutine) && (
          <RunsList
            parentId={entity.id}
            runs={runs}
            // У рутины исполнитель внутренний и всегда один — колонка гранта ей не положена (Р-8).
            showGrant={!isRoutine}
            onOpen={(id) => push(activeTab, { kind: 'entity', id })}
          />
        )}
        <BlockersBlock />
        <BacklinksBlock />
      </div>
    </TabPartHost>
  );

  return (
    <RecordHostProvider value={host}>
      <BodyScreenProvider
        value={{
          asMarkdown,
          onCloseMarkdown: () => setAsMarkdown(false),
          screenConflict: conflict,
          noticeHost,
          onRefresh: () => {
            void get.refetch();
            dismissConflict();
          },
        }}
      >
        <ScreenHeader
          title={entity.title}
          actions={
            <DetailMenu
              onPin={() => {
                const pinned = settings.data?.pinnedEntities ?? [];
                updateSettings.mutate({
                  pinnedEntities: [...pinned, { id: entity.id, order: pinned.length }],
                });
              }}
              onArchive={() => setArchived(!entity.archived)}
              onCopyLink={() => void copyLink()}
              onPinVersion={() => setPinVersion(true)}
              // Без документа пункта НЕТ вовсе. Показать его — значит предложить действие,
              // которое молча ничего не делает, а флаг после нажатия остался бы поднятым: приедь
              // документ следующим рефетчем — и тумблер открылся бы сам, без жеста человека.
              // Ветку «документа нет» разбирает EditorShell; здесь у неё видимое следствие.
              onToggleMarkdown={entity.bodyDoc == null ? undefined : () => setAsMarkdown((v) => !v)}
              archived={entity.archived}
            />
          }
        />
        {/* Диалог закрепления версии — ВНЕ табов и по той же причине, что запасная ссылка ниже:
          открывают его из меню, а меню одно на все вкладки. Монтируется только открытым —
          набранная и брошенная подпись не переживает закрытие. */}
        {pinVersion && (
          <PinVersionDialog entityId={entity.id} onClose={() => setPinVersion(false)} />
        )}
        {/* Запасной путь копирования — ВНЕ табов: ссылку просят из меню, а меню одно на все
          табы, и прятать ответ на вкладке «Сущность» значило бы иногда не отвечать вовсе. */}
        {manualLink !== null && manualLink.id === entityId && (
          <ManualLinkNotice url={manualLink.url} onHide={() => setManualLink(null)} />
        )}
        {/* Плашки тела (расхождение версий, неотправленный черновик, состояние сохранения) —
          тоже ВНЕ табов, и по той же причине, что запасная ссылка выше. «Сущность» держится
          живой через display:none (keepMounted), то есть с «Деталей» и «Треда» всё, что лежит
          внутри неё, не видно вовсе, — а это единственный канал, которым экран сообщает, что
          правка НЕ сохранена. Человек, ушедший на «Детали» посмотреть подзадачи, узнавал бы об
          отказе только вернувшись, а чаще не узнавал вовсе (ревью раунда 3, находка 4).

          Рисует их само тело — через портал в этот узел: плашки суть его состояние, и вести их
          сюда лишним слоем состояния значило бы завести второй ответ на вопрос «что с
          сохранением». Портал переносит DOM, оставляя дерево React на месте, — поэтому
          `key={entity.id}` у тела и вся его память о правке работают ровно как прежде. */}
        <div ref={setNoticeHost} className="mx-auto w-full max-w-3xl px-4 md:px-6" />
        {/* Слой предложения рутины (Ш1.3) — СОСЕДНИМ узлом, а не внутри `noticeHost` выше:
          тот узел уже цель портала (плашки тела), и порядок двух порталов в один узел не
          определён. Место то же по смыслу — снаружи вкладок: предложение видно и с «Деталей»,
          и с «Треда», как и всё, что экран говорит о судьбе записи.

          key по id — по той же причине, что у ленты прогона и блока ожидания: экран
          монтируется БЕЗ key (router.tsx), а у слоя своя память (какие плашки развёрнуты,
          буфер правок), и переехать на соседнюю запись она не должна. */}
        <ProposalOverlay
          key={`proposal-${entity.id}`}
          entity={entity}
          onOverlayExpanded={setProposalOpen}
        />
        {/* Три таба — под шапкой; контент центрирован, шапка — на всю ширину.
          keepMounted у «Сущности» — ради редактора: Radix по умолчанию размонтирует неактивную
          вкладку, и уход на «Детали» уничтожил бы вместе с ней несохранённый текст и всю
          историю Ctrl+Z, а заодно гонял бы двухфазное монтирование заново.
          У «Деталей» — ради сохранения нынешнего поведения: сегодня все её секции живут на
          единственной вкладке и рисуются при каждом открытии записи, так что живыми они
          обходятся ровно в те же запросы, что и до разделения.
          У «Треда» — НЕТ: ChatThread на монтировании заводит chat.listMessages, и держать его
          живым значило бы платить лишним запросом за вкладку, которую не открывали. */}
        {/* Развёрнутый слой предложения прячет ВСЕ ТРИ ВКЛАДКИ, а не одно тело записи, и это
          правка по итогам живого смоука Ш1 (наблюдение Н-2, замерено).
          Пока прятали только тело, вкладка «Детали» оставалась полностью кликабельной — а её
          `AspectCards` мутируют граф НЕМЕДЛЕННО и выглядят ТОЧНО ТАК ЖЕ, как строки правки в
          слое (общий FIELD_CLASS — сделано нарочно, чтобы владелец узнавал поле). Две
          одинаковые с виду строки «статус» в одном скролле: одна применится по «Принять»,
          вторая пишет в граф за секунду и без подтверждения. Замер: правка не в той строке
          записала `status: done`, сдвинула `updated_at` и сделала предложение stale — вместе с
          набранными, но не отправленными правками.
          «Детали» — не единственный такой путь, просто самый похожий: жесты рутины
          (RoutineStatusBlock), ответ исполнителю (TicketWaitingBlock), откат прогона (RunFeed) и
          восстановление версии (VersionsCard) мутируют так же немедленно и лежали открытыми
          рядом. Полумера, закрывающая одну «Деталь», оставила бы остальные четыре.
          Развёрнутая плашка содержит всё, ради чего её развернули; свернуть её — один тап.
          ТЕМ ЖЕ механизмом, что прежде прятал тело: класс, а не снятие с монтирования, — см.
          докблок `proposalOpen`. Ради него это и один узел, а не два: спрячь мы вкладки, оставив
          прежний класс на теле, у одного вопроса «видно ли это сейчас» стало бы два ответа. */}
        <div
          data-testid="entity-tabs"
          className={`mx-auto w-full max-w-3xl${proposalOpen ? ' hidden' : ''}`}
        >
          <Tabs
            value={openTab}
            onValueChange={setOpenTab}
            tabs={[
              { value: 'entity', label: 'Сущность', content: entityTab, keepMounted: true },
              { value: 'details', label: 'Детали', content: detailsTab, keepMounted: true },
              {
                value: 'thread',
                label: 'Тред',
                // Тред с key по id и «Нет треда» без него — см. ThreadBlock.
                content: <ThreadBlock />,
              },
            ]}
          />
        </div>
      </BodyScreenProvider>
    </RecordHostProvider>
  );
}

/**
 * Запасной путь копирования: буфер отказал — показываем сам адрес, чтобы его можно было
 * взять руками. Живёт ВНЕ табов (ссылку просят из меню, а меню одно на все табы, и
 * прятать ответ на вкладке «Сущность» значило бы иногда не отвечать вовсе).
 */
function ManualLinkNotice({ url, onHide }: { url: string; onHide: () => void }) {
  return (
    <div
      role="alert"
      className="mx-auto mt-3 flex w-full max-w-3xl flex-col gap-2 rounded-control border border-line bg-surface-2 px-3 py-2"
    >
      <p className="text-sm text-text-secondary">
        Буфер обмена недоступен — скопируйте ссылку вручную:
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Ссылка на сущность"
          readOnly
          value={url}
          // Клик по полю выделяет адрес целиком: копировать руками половину UUID —
          // ровно та беда, ради которой этот запасной путь и заведён.
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1"
        />
        <Button variant="outline" size="sm" onClick={onHide}>
          Скрыть
        </Button>
      </div>
    </div>
  );
}

/**
 * Меню ⋮ шапки detail (§3.5). Раньше «меню» было двумя icon-кнопками в ряд: пункт
 * «Скопировать ссылку» третьей кнопкой сделал бы шапку панелью инструментов, а на узком
 * экране — очередью иконок поверх заголовка. Теперь это настоящее меню, действия внутри.
 */
function DetailMenu({
  onPin,
  onArchive,
  onCopyLink,
  onPinVersion,
  onToggleMarkdown,
  archived,
}: {
  onPin: () => void;
  onArchive: () => void;
  onCopyLink: () => void;
  /** Закрепить ВЕРСИЮ ТЕЛА (С11) — не путать с `onPin`, который держит запись в сайдбаре. */
  onPinVersion: () => void;
  /** Не задан — править как markdown нечего (у записи нет документа), и пункта нет вовсе. */
  onToggleMarkdown?: () => void;
  archived: boolean;
}) {
  const archiveLabel = archived ? 'Разархивировать' : 'Архивировать';
  return (
    <DropdownMenu
      trigger={
        <Button
          size="icon"
          variant="ghost"
          aria-label="Меню"
          title="Меню"
          data-testid="detail-menu"
        >
          <EllipsisVertical size={16} aria-hidden />
        </Button>
      }
      items={[
        { label: 'Закрепить', icon: <Pin size={16} aria-hidden />, onSelect: onPin },
        {
          label: archiveLabel,
          icon: archived ? (
            <ArchiveRestore size={16} aria-hidden />
          ) : (
            <Archive size={16} aria-hidden />
          ),
          onSelect: onArchive,
        },
        {
          label: 'Скопировать ссылку',
          icon: <Link2 size={16} aria-hidden />,
          onSelect: onCopyLink,
        },
        // Про ТЕЛО, а не про сайдбар — и стоит рядом с «Править как markdown», второй правкой
        // тела, а не рядом с «Закрепить». Иконка тоже другая (History против Pin): два пункта
        // с одной иконкой и почти одной подписью читались бы как один с опечаткой.
        {
          label: 'Закрепить версию',
          icon: <History size={16} aria-hidden />,
          onSelect: onPinVersion,
        },
        // Пункт появляется, только когда есть что править (см. проп): предлагать действие,
        // которое молча ничего не делает, хуже, чем не предлагать его вовсе.
        ...(onToggleMarkdown === undefined
          ? []
          : [
              {
                label: 'Править как markdown',
                icon: <Code size={16} aria-hidden />,
                onSelect: onToggleMarkdown,
              },
            ]),
      ]}
    />
  );
}
