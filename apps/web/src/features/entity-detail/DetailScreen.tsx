import { buildAppPath, PAGE_ASPECT } from '@orbis/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NotFoundScreen } from '../../app/NotFoundScreen';
import { ScreenHeader } from '../../app/ScreenHeader';
import { invalidateGraph } from '../../lib/invalidate';
import { mayLeave } from '../../state/leave-guard';
import { openEntity } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/toast-store';
import { ConfigureView } from '../page/ConfigureView';
import { PageView } from '../page/PageView';
import { type DisputeRequest, type RecordShown, RecordView } from '../page/RecordView';
import { type TabMemory, TabMemoryProvider, TabMemoryScope } from '../page/TabsContainer';
import { TemplatePreview } from '../page/TemplatePreview';
import { usePageTemplates } from '../page/usePageTemplates';
import { DetailMenuSlot } from './DetailMenuSlot';
import { type BodyGate, BodyScreenProvider, bodyKindOf } from './EntityBody';
import { ProposalOverlay } from './ProposalOverlay';
import { ROUTINE_ASPECT } from './RoutineStatusBlock';
import { useEntityDetail } from './useEntityDetail';
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
  /**
   * Список шаблонов владельца — ЗДЕСЬ, до ответа записи, а не в `RecordView` после него (§6.5,
   * РП-11 (2), РП-14): запрос уходит вместе с `entity.get` (в проде — одним HTTP, `httpBatchLink`) и
   * не ждёт его. Результат читают `RecordView` и меню ⋮ тем же ключом — второго запроса нет.
   */
  const templates = usePageTemplates();
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
   * Какие вкладки шаблона открыты — ЕДИНСТВЕННЫМ местом, у экрана (`TabMemoryProvider`), а не у
   * контейнера вкладок.
   *
   * Экран монтируется БЕЗ key (router.tsx), и переход на НЕкэшированную запись показывает
   * скелетон: рендерер со вкладками размонтируется и встаёт заново. Своё состояние контейнера
   * сбросилось бы на «Запись», а человек, листавший подзадачи с «Деталей», хочет видеть «Детали»
   * соседней записи — единообразное «остаёмся там, где смотрели» (ревью Задачи 16 до среза).
   * Поэтому при смене записи память НЕ сбрасывается — намеренно. Ключи — путь контейнера в своём
   * пространстве (`TabMemoryScope`): у записи — шаблона (`template:<id>`, общее для всех записей
   * шаблона), у страницы — самой страницы (`page:<id>`). Вкладка одного текста не открывает
   * вкладку другого.
   */
  const [tabMemory, setTabMemory] = useState<Readonly<Record<string, string>>>({});
  const tabs = useMemo<TabMemory>(
    () => ({
      get: (key) => tabMemory[key],
      set: (key, value) => setTabMemory((m) => ({ ...m, [key]: value })),
    }),
    [tabMemory],
  );
  /**
   * «Открыть через шаблон хоста» / «Открыть через „X“» у записи и «Открыть как запись» у страницы
   * (спека §8.4) — разово, не запоминается: состояние экрана, а не данные записи и не адрес
   * (`ScreenRef`): навигация и история от него не меняются (W7). Сбрасывается сменой записи и сменой
   * её «страничности» (ниже).
   */
  const [openVia, setOpenVia] = useState<{ templateId: string | 'host' } | undefined>(undefined);
  /** «Сменить выбор шаблона для таких записей» (§4.3) — плашка спора по просьбе меню. */
  const [disputeRequest, setDisputeRequest] = useState<DisputeRequest | undefined>(undefined);
  /**
   * Режим экрана (спека страниц 1а §9): «Настроить» — тело страницы или шаблона в редакторе
   * (`targetId` — чьё: сама страница или шаблон, которым показана запись); «Предпросмотр на
   * записи…» — черновик шаблона на выбранной записи. Состоянием экрана, а не адресом (W7), как
   * «Открыть через X»; сбрасывается сменой записи и её «страничности» (ниже): настройка, пережившая
   * переход, правила бы тело чужой записи без единого жеста человека.
   */
  const [mode, setMode] = useState<ScreenMode>(null);
  /** Чем запись показана (извещает `RecordView`) — пункты меню ⋮ строятся по нему. */
  const [recordShown, setRecordShown] = useState<RecordShown | null>(null);
  /**
   * Куда тело рисует свои плашки — узел НАД вкладками (см. `noticeHost` в разметке ниже).
   *
   * Состоянием, а не рефом: портал обязан перерисоваться, когда узел появился, а реф рендера не
   * будит. Один лишний проход на монтировании, до первой отрисовки, — вся цена.
   */
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null);
  /**
   * Смонтированное тело записи (или настройки) — есть ли у него неотправленное и как его дослать.
   * Реф, а не состояние: жест меню читает его в момент нажатия, перерисовки он не заводит.
   */
  const bodyGate = useRef<BodyGate | null>(null);
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
    // «Открыть через X» — про ту запись, из чьего меню его выбрали: переехав, он показал бы
    // соседнюю запись чужим шаблоном без единого жеста человека.
    setOpenVia(undefined);
    setDisputeRequest(undefined);
    setMode(null);
    // Слой переезжает на соседнюю запись вместе с экраном (монтируется без key), и его
    // собственное состояние обнуляет `key` ниже. Но признак живёт ЗДЕСЬ, и один кадр между
    // сменой пропа и его извещением тело соседней записи стояло бы спрятанным ни за что.
    setProposalOpen(false);
  }
  const { show } = useToast();

  /**
   * ADE-срез 1 (С10). Тикет — задача С НАЗНАЧЕНИЕМ, а не всякая задача: у простой задачи прогонов
   * нет, и подметать нечего. Тикет, рутина и проект — цели подметания ниже; сами карточки тикета
   * и рутины (ожидание, история прогонов) — свои карточки аспектов шаблона (`own-cards.tsx`).
   *
   * Читаем `get.data` ДО ветки скелетона: хуки обязаны идти безусловно, а «данных ещё нет»
   * выражено признаком цели ниже — подметание уйдёт, когда станет известно, что подметать.
   */
  const loaded = get.data?.entity;
  /**
   * Запись стала страницей или перестала ею быть (меню ⋮, Undo, агент) — разовый вид прежнего
   * рода больше не про неё. «Открыть через шаблон хоста», переживший «Изменить вид только этой
   * записи», показал бы новую страницу записью; «Открыть как запись» страницы, пережив «Перестать
   * быть страницей», — держал бы запись на шаблоне хоста мимо её своего шаблона.
   */
  const loadedIsPage = loaded === undefined ? undefined : loaded.aspects.includes(PAGE_ASPECT);
  const prevIsPageRef = useRef(loadedIsPage);
  if (loadedIsPage !== undefined && prevIsPageRef.current !== loadedIsPage) {
    if (prevIsPageRef.current !== undefined) {
      setOpenVia(undefined);
      setDisputeRequest(undefined);
      setMode(null);
    }
    prevIsPageRef.current = loadedIsPage;
  }
  // Гейты блоков — по СПИСКУ аспектов записи (§А1-1), а не по наличию ключа в карте полей:
  // аспект перестал быть владельцем полей (Р9), и его наличие теперь отдельный факт —
  // навешенный аспект без единого заполненного свойства прежде был неотличим от снятого.
  const isTicket = (loaded?.aspects.includes(TASK) && loaded.aspects.includes(ASSIGNMENT)) === true;
  /**
   * V1.14. Рутина открывается ТЕМ ЖЕ экраном: тело — инструкция исполнителю, карточка рутины —
   * состояние и история прогонов, «Тред» — обсуждение и карточки предложений. Своего экрана у неё
   * нет намеренно — она обычная запись графа, а не отдельная сущность приложения.
   */
  const isRoutine = loaded?.aspects.includes(ROUTINE_ASPECT) === true;

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

  // `id` — не всегда запись экрана: в настройке чужого шаблона ссылка — на шаблон (№87).
  async function copyLink(id: string = entityId) {
    // Форму пути знает ТОЛЬКО buildAppPath (B1): собранная здесь руками строка разъехалась
    // бы с роутером при первой же правке таблицы маршрутов, и ссылки из чужих писем вели
    // бы в никуда. origin делает её абсолютной — ссылку отправляют наружу, а не внутрь SPA.
    const url = `${window.location.origin}${buildAppPath({ kind: 'entity', id })}`;
    try {
      // Обращение к navigator.clipboard намеренно внутри try: когда API нет вовсе,
      // это TypeError — та же беда для пользователя, что и отклонённое разрешение.
      await navigator.clipboard.writeText(url);
      setManualLink(null);
      show('Ссылка скопирована');
    } catch {
      // Запасная ссылка живёт при ЭКРАНЕ (`manualLink.id === entityId` ниже), а не при цели.
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
  const isPage = entity.aspects.includes(PAGE_ASPECT);
  // «Открыть как запись» (§8.4): страница — через шаблон хоста, с версиями, тредом и обратными
  // ссылками, а тело — настоящим редактором под провайдером ЭТОГО экрана (плашки тела — над
  // вкладками). Инертный провайдер `PageView` здесь не участвует вовсе: `PageView` не рисуется.
  const asRecord = isPage && openVia?.templateId === 'host';
  // Шаблон (страница с «Шаблон для») показывается предпросмотром на записи (§9.3); черновик —
  // только по пункту «Предпросмотр на записи…».
  const isTemplate = isPage && bodyKindOf(entity) === 'template';
  const configure = (targetId: string) => setMode({ kind: 'configure', targetId });
  // Настройка ЧУЖОГО шаблона («Настроить шаблон „X“» с записи): запись под ним не видна, и меню —
  // про шаблон (№87). Своя страница в настройке — та же запись экрана, её пункты законны.
  const configuringId =
    mode?.kind === 'configure' && mode.targetId !== entity.id ? mode.targetId : null;

  return (
    <TabMemoryProvider value={tabs}>
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
          bodyGate,
        }}
      >
        <ScreenHeader
          title={entity.title}
          actions={
            <DetailMenuSlot
              onPin={() => {
                const pinned = settings.data?.pinnedEntities ?? [];
                updateSettings.mutate({
                  pinnedEntities: [...pinned, { id: entity.id, order: pinned.length }],
                });
              }}
              onArchive={() => setArchived(!entity.archived)}
              onCopyLink={() => void copyLink(configuringId ?? entityId)}
              onPinVersion={() => setPinVersion(true)}
              // Без документа пункта НЕТ вовсе. Показать его — значит предложить действие,
              // которое молча ничего не делает, а флаг после нажатия остался бы поднятым: приедь
              // документ следующим рефетчем — и тумблер открылся бы сам, без жеста человека.
              // Ветку «документа нет» разбирает EditorShell; здесь у неё видимое следствие.
              // У страницы — тоже нет: её тело показывает рендерер, а не редактор записи, и
              // режиму разметки включить нечего (правка страницы — настройкой, задачи 15–16).
              onToggleMarkdown={
                entity.bodyDoc == null || isPage ? undefined : () => setAsMarkdown((v) => !v)
              }
              archived={entity.archived}
              entity={entity}
              bodyGate={bodyGate}
              view={
                configuringId !== null
                  ? {
                      kind: 'configuring',
                      templateTitle:
                        // Пустой заголовок — id, как у пунктов «Открыть через „X“» (`titleOf`).
                        templates.rows.find((r) => r.id === configuringId)?.title || configuringId,
                      onOpenTemplate: () => openEntity(configuringId),
                    }
                  : isPage
                    ? {
                        kind: 'page',
                        asRecord,
                        onOpenAsRecord: () => setOpenVia(HOST_VIEW),
                        onConfigure: () => configure(entity.id),
                        // Из настройки своей страницы предпросмотр снимает `ConfigureView` —
                        // это уход с тела, и спрашивается тот же страж, что у «Готово» и «назад»
                        // (№86): иначе отказ досыла на размонтировании молчал бы.
                        ...(!isTemplate && {
                          onPreview: () => {
                            if (mayLeave()) setMode({ kind: 'preview' });
                          },
                        }),
                      }
                    : {
                        kind: 'record',
                        shown: recordShown?.entityId === entity.id ? recordShown : null,
                        templates,
                        onOpenVia: (templateId) =>
                          setOpenVia(templateId === 'host' ? HOST_VIEW : { templateId }),
                        onChangeDispute: (contenders) =>
                          setDisputeRequest((prev) => ({ contenders, n: (prev?.n ?? 0) + 1 })),
                        onConfigureTemplate: configure,
                      }
              }
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
          табы, и прятать ответ на вкладке «Запись» значило бы иногда не отвечать вовсе. */}
        {manualLink !== null && manualLink.id === entityId && (
          <ManualLinkNotice url={manualLink.url} onHide={() => setManualLink(null)} />
        )}
        {/* Плашки тела (расхождение версий, неотправленный черновик, состояние сохранения) —
          тоже ВНЕ табов, и по той же причине, что запасная ссылка выше. «Запись» держится
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
        {/* Развёрнутый слой предложения прячет ВЕСЬ показ записи — заголовок, теги и все вкладки
          шаблона, — а не одно тело записи, и это правка по итогам живого смоука Ш1 (наблюдение
          Н-2, замерено).
          Пока прятали только тело, вкладка «Детали» оставалась полностью кликабельной — а её
          секции аспектов мутируют граф НЕМЕДЛЕННО и выглядят ТОЧНО ТАК ЖЕ, как строки правки в
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
          data-testid="record-area"
          className={`mx-auto w-full max-w-3xl${proposalOpen ? ' hidden' : ''}`}
        >
          {/* Страница — своим телом (спека страниц 1а §4.2 шаг 1); любая другая запись — через
            шаблон по функции выбора (§4.2): свой шаблон владельца или шаблон хоста (§8.1). Оба —
            над тем же ответом `entity.get` этого экрана, второго запроса записи нет (РП-13).
            Шапка, меню, слой предложения и плашки над ними — прежние. Вкладки, их keepMounted
            (тело и «Детали» живы, «Тред» — только открытым) — дело шаблона и рендерера.
            Режим «Настроить» (§9.1) заменяет показ телом в редакторе, шаблон страницы — его
            предпросмотром на записи (§9.3). */}
          {mode?.kind === 'configure' ? (
            <ConfigureView targetId={mode.targetId} onDone={() => setMode(null)} />
          ) : isPage && !asRecord ? (
            // Вкладки страницы — её собственные: пространство памяти по id страницы. Иначе третья
            // вкладка страницы A открывала бы третью вкладку страницы B — это разные тексты.
            <TabMemoryScope scope={`page:${entity.id}`}>
              {isTemplate || mode?.kind === 'preview' ? (
                <TemplatePreview
                  page={get.data}
                  {...(mode?.kind === 'preview' && { onClose: () => setMode(null) })}
                />
              ) : (
                <PageView reply={get.data} />
              )}
            </TabMemoryScope>
          ) : (
            <RecordView
              reply={get.data}
              onShown={setRecordShown}
              onConfigureTemplate={configure}
              {...(openVia !== undefined && { override: openVia })}
              {...(disputeRequest !== undefined && !isPage && { disputeRequest })}
            />
          )}
        </div>
      </BodyScreenProvider>
    </TabMemoryProvider>
  );
}

/** Режим экрана (§9): настройка тела страницы или шаблона, предпросмотр черновика шаблона. */
type ScreenMode = { kind: 'configure'; targetId: string } | { kind: 'preview' } | null;

/** Разовый показ шаблоном хоста — одним объектом: выбор шаблона мемоизирован по нему. */
const HOST_VIEW = { templateId: 'host' } as const;

/**
 * Запасной путь копирования: буфер отказал — показываем сам адрес, чтобы его можно было
 * взять руками. Живёт ВНЕ табов (ссылку просят из меню, а меню одно на все табы, и
 * прятать ответ на вкладке «Запись» значило бы иногда не отвечать вовсе).
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
          aria-label="Ссылка на запись"
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
