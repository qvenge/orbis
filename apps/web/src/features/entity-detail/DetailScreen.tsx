import { buildAppPath } from '@orbis/shared';
import { Archive, ArchiveRestore, Code, EllipsisVertical, Link2, Pin } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NotFoundScreen } from '../../app/NotFoundScreen';
import { ScreenHeader } from '../../app/ScreenHeader';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { DropdownMenu } from '../../ui/DropdownMenu';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs } from '../../ui/Tabs';
import { useToast } from '../../ui/toast-store';
import { PlannedToFactCard } from '../budget/PlannedToFactCard';
import { usePlanToFactPrompt } from '../budget/usePlanToFactPrompt';
import { ChatThread } from '../chat/ChatThread';
import { EditorShell } from '../entity-editor/EditorShell';
import { SaveIndicator } from '../entity-editor/SaveIndicator';
import { sameDoc } from '../entity-editor/strip-ids';
import { type BodyDoc, type BodySave, useBodySave } from '../entity-editor/useBodySave';
import { AspectCards } from './AspectCards';
import { Backlinks } from './Backlinks';
import { Blocks } from './Blocks';
import { GoalProgress } from './GoalProgress';
import { NativeRow } from './NativeRow';
import { Subtasks } from './Subtasks';
import { useEntityDetail } from './useEntityDetail';

type Entity = RouterOutputs['entity']['get']['entity'];

const GOAL = 'orbis/goal';

/**
 * Тумблер markdown — ТОЛЬКО ленивым импортом.
 *
 * Он единственный на экране, кто зовёт `@orbis/shared/doc` значениями (`parseBody`,
 * `serializeBody`), а это вся схема документа. Статический импорт утащил бы её в чанк
 * `DetailScreen`, то есть в ПЕРВЫЙ КАДР каждого открытия записи, мимо двухфазного монтирования,
 * ради которого написаны три задачи подряд. Граф чанков строится по МОДУЛЯМ, а не по тому, в
 * каком файле написан импорт: спрятать вес за условием `asMarkdown` нельзя (ревью Б7).
 *
 * ЗАМЕРЕНО пробой, а не выведено: со статическим импортом `DetailScreen-*.js` начинает
 * статически импортировать `doc-*.js` (164.0 кБ gzip), а чанк `MarkdownToggle-*.js` исчезает из
 * dist целиком — и это ровно то, на чём краснеет scripts/check-lazy-chunks.ts.
 */
const MarkdownToggle = lazy(() =>
  import('../entity-editor/MarkdownToggle').then((m) => ({ default: m.MarkdownToggle })),
);

export function DetailScreen({ entityId }: { entityId: string }) {
  const { get, toggleTask, saveTitle, setArchived, conflict, dismissConflict } =
    useEntityDetail(entityId);
  const utils = trpc.useUtils();
  const settings = trpc.user.getSettings.useQuery();
  const updateSettings = trpc.user.updateSettings.useMutation({
    onSuccess: () => void utils.user.getSettings.invalidate(),
  });
  // §2.7: перевод задачи-покупки в done → карточка «Покупка совершена?» (Task B6).
  // Единственный мутационный путь чекбокса — toggleTask здесь (см. usePlanToFactPrompt).
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
  /**
   * Куда тело рисует свои плашки — узел НАД вкладками (см. `noticeHost` в разметке ниже).
   *
   * Состоянием, а не рефом: портал обязан перерисоваться, когда узел появился, а реф рендера не
   * будит. Один лишний проход на монтировании, до первой отрисовки, — вся цена.
   */
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null);
  const prevIdRef = useRef(entityId);
  if (prevIdRef.current !== entityId) {
    prevIdRef.current = entityId;
    setAsMarkdown(false);
  }
  const { show } = useToast();

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
  // goalProgress есть ТОЛЬКО у сущностей с аспектом orbis/goal (E2): у остальных поля нет
  // вовсе, и расчёт им не стоит ни одного запроса.
  const { entity, thread, relations, backlinks, backlinksTruncated, goalProgress } = get.data;

  // Вкладка «Сущность» — чистый документ: emoji, заголовок, полоса прогресса и тело. Всё
  // остальное, что известно о записи, уехало в «Детали».
  //
  // Полоса прогресса — единственное исключение, и осознанное: у цели прогресс это то, ради чего
  // её открывают, и «50%, 150 000 из 300 000» во второй вкладке ухудшило бы главный экран целей
  // ради чистоты раскладки. Единица достаётся из аспекта ЗДЕСЬ, заново: в AspectCards она
  // бралась из тела цикла по аспектам, а цикла тут нет.
  const goalUnit = (entity.aspects as Record<string, Record<string, unknown> | undefined>)[GOAL]
    ?.unit;
  const entityTab = (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-5 md:px-6">
      {/* Notion-style шапка страницы: крупная emoji-иконка над заголовком. Нет emoji —
          ничего не рендерим (без плейсхолдера); в самой шапке экрана — только title. */}
      <div className="flex flex-col gap-3">
        {entity.emoji && (
          <span aria-hidden className="text-4xl leading-none">
            {entity.emoji}
          </span>
        )}
        <NativeRow
          entity={entity}
          onToggleTask={(done) => {
            toggleTask(done);
            // Данные сущности ДО перевода: planned ещё true — карточка на переходе в done
            if (done) planToFact.onTaskDone(entity);
          }}
          onSaveTitle={saveTitle}
        />
      </div>
      {/* Карточка plan→fact (§2.7) — инлайн под строкой задачи, как в мокапе */}
      {planToFact.prompt !== null && (
        <PlannedToFactCard prompt={planToFact.prompt} onClose={planToFact.dismiss} />
      )}
      {goalProgress !== undefined && (
        <GoalProgress
          progress={goalProgress}
          unit={typeof goalUnit === 'string' ? goalUnit : undefined}
        />
      )}
      {/* Тело — РАЗМОНТИРУЕМОЕ по key. То же правило, что несла прежняя секция тела, и по той
          же причине, только цена ошибки выросла: роутер монтирует DetailScreen БЕЗ key
          (router.tsx), переход entity→entity меняет лишь проп, — а `useBodySave` при смене
          `entityId` под тем же хуком теряет отложенное МОЛЧА. Без размонтирования таймер паузы
          со старым id дописал бы старый документ в новую запись, а `flush()` на размонтировании
          (там же, в хуке) не случился бы вовсе. key по id, НЕ по updatedAt: рефетч после каждого
          сохранения ремоунтил бы редактор, стирая набранное за время запроса. */}
      <EntityBody
        key={entity.id}
        entity={entity}
        asMarkdown={asMarkdown}
        onCloseMarkdown={() => setAsMarkdown(false)}
        screenConflict={conflict}
        noticeHost={noticeHost}
        onRefresh={() => {
          void get.refetch();
          dismissConflict();
        }}
      />
    </div>
  );

  const detailsTab = (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-5 md:px-6">
      <AspectCards entity={entity} />
      {/* Секции 6–8 §3.5: связи уже приехали этим же entity.get — своих запросов графа
          секции не заводят. */}
      <Subtasks parentId={entity.id} relations={relations ?? []} />
      <Blocks entityId={entity.id} relations={relations ?? []} />
      <Backlinks items={backlinks ?? []} truncated={backlinksTruncated === true} />
    </div>
  );

  return (
    <>
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
            // Без документа пункта НЕТ вовсе. Показать его — значит предложить действие,
            // которое молча ничего не делает, а флаг после нажатия остался бы поднятым: приедь
            // документ следующим рефетчем — и тумблер открылся бы сам, без жеста человека.
            // Ветку «документа нет» разбирает EditorShell; здесь у неё видимое следствие.
            onToggleMarkdown={entity.bodyDoc == null ? undefined : () => setAsMarkdown((v) => !v)}
            archived={entity.archived}
          />
        }
      />
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
      {/* Три таба — под шапкой; контент центрирован, шапка — на всю ширину.
          keepMounted у «Сущности» — ради редактора: Radix по умолчанию размонтирует неактивную
          вкладку, и уход на «Детали» уничтожил бы вместе с ней несохранённый текст и всю
          историю Ctrl+Z, а заодно гонял бы двухфазное монтирование заново.
          У «Деталей» — ради сохранения нынешнего поведения: сегодня все её секции живут на
          единственной вкладке и рисуются при каждом открытии записи, так что живыми они
          обходятся ровно в те же запросы, что и до разделения.
          У «Треда» — НЕТ: ChatThread на монтировании заводит chat.listMessages, и держать его
          живым значило бы платить лишним запросом за вкладку, которую не открывали. */}
      <div className="mx-auto w-full max-w-3xl">
        <Tabs
          defaultValue="entity"
          tabs={[
            { value: 'entity', label: 'Сущность', content: entityTab, keepMounted: true },
            { value: 'details', label: 'Детали', content: detailsTab, keepMounted: true },
            {
              value: 'thread',
              label: 'Тред',
              content: thread ? (
                <ChatThread threadId={thread.threadId} />
              ) : (
                <p className="p-3 text-sm text-text-muted">Нет треда</p>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}

/** Форма документа в кэше уже, чем `BodyDoc` (Record против JSONContent) — сводим приведением. */
const asBodyDoc = (stored: Entity['bodyDoc']): BodyDoc | null =>
  stored == null ? null : { v: stored.v, doc: stored.doc as BodyDoc['doc'] };

/**
 * Тело записи: первый кадр + редактор (EditorShell), автосохранение по паузе (useBodySave),
 * баннер неотправленного черновика и — по пункту меню ⋮ — правка тем же телом как markdown.
 *
 * Отдельный компонент, а не кусок разметки экрана, ради ОДНОГО свойства: экран монтирует его с
 * `key={entity.id}`, и вся память о правке (отложенный документ, таймер паузы, предложенный
 * черновик, показанный текст) исчезает вместе с записью, а не переезжает на соседнюю.
 */
function EntityBody({
  entity,
  asMarkdown,
  onCloseMarkdown,
  screenConflict,
  noticeHost,
  onRefresh,
}: {
  entity: Entity;
  asMarkdown: boolean;
  onCloseMarkdown: () => void;
  /** Конфликт правки ЗАГОЛОВКА/чекбокса/архивации — у них своя обвязка (useEntityDetail). */
  screenConflict: boolean;
  /** Узел НАД вкладками, куда уезжают плашки. Null — узла ещё нет (см. ниже). */
  noticeHost: HTMLElement | null;
  onRefresh: () => void;
}) {
  const save = useBodySave(entity.id, entity);
  /**
   * Документ, который редактор обязан показать ПРЯМО СЕЙЧАС, хотя в кэше его ещё нет.
   *
   * Кладут его сюда два жеста: «оставить моё» у баннера черновика и «Применить» тумблера. Ни
   * тот, ни другой не может положиться на оптимистичный патч мутации (useEntityDetail
   * применяет `bodyDoc` к кэшу в onMutate): у тумблера отправка ждёт паузы набора в две
   * секунды, а у «оставить моё» мутации может не быть вовсе — `useBodySave` откладывает её,
   * если прежнее сохранение ещё в полёте. В обе эти щели экран показывал бы прежний текст над
   * документом, который уже уехал (или вот-вот уедет) в базу, — и первое же нажатие клавиши
   * вернуло бы показанное поверх.
   */
  const [localDoc, setLocalDoc] = useState<BodyDoc | null>(null);
  const serverDoc = asBodyDoc(entity.bodyDoc);
  // Кэш догнал — местная копия больше не нужна, и держать её нельзя: она заслоняла бы правку,
  // приехавшую с другого устройства. Сравнение по СМЫСЛУ: свой же сохранённый документ вернётся
  // с сервера без блочных id (strip-ids.ts).
  if (localDoc !== null && serverDoc !== null && sameDoc(localDoc.doc, serverDoc.doc)) {
    setLocalDoc(null);
  }
  const doc = localDoc ?? serverDoc;

  /**
   * Правка ИЗ РЕДАКТОРА кладётся в местную копию, а не снимает её.
   *
   * Прежде здесь стоял `setLocalDoc(null)` с доводом «редактор и так показывает то, что
   * прислал». Довод верен ровно для редактора и не рассматривал ВТОРОГО потребителя `doc` —
   * тумблер markdown. `serverDoc` свежеет только с отправкой мутации, то есть не раньше паузы
   * набора (2 с, на плохой связи дольше), и всё это время `doc` был документом БЕЗ последних
   * набранных символов. Открыть ⋮ → «Править как markdown» внутри этого окна — и в поле нет
   * последних слов; дальше довольно «Применить», чтобы они исчезли и с экрана, и из базы
   * (ревью раунда 3, находка 2).
   *
   * Опасности, которой боялся прежний довод, здесь нет, и это проверено прогоном: местная копия
   * не может вернуться в редактор поверх набранного, потому что кладётся сюда РОВНО ТО, что
   * редактор сам и показывает, — подменять ему нечем (`BodyEditor` сверяет по смыслу и молчит
   * на совпадении).
   */
  function onEditorChange(next: BodyDoc) {
    setLocalDoc(next);
    save.onDocChange(next);
  }

  /** Правка из тумблера — наоборот, ДОЛЖНА сесть в редактор: он её ещё не видел. */
  function onMarkdownChange(next: BodyDoc) {
    setLocalDoc(next);
    save.onDocChange(next);
  }

  // Локальная копия ради сужения типа: внутри колбэка кнопки TS `save.pendingDraft` уже не
  // сужает — поле объекта могло бы смениться между рендером и нажатием.
  const draft = save.pendingDraft;

  /**
   * Всё, что экран ГОВОРИТ о судьбе тела: расхождение версий, неотправленный черновик, состояние
   * сохранения. Рисуется НЕ здесь, а в узле над вкладками (см. `noticeHost` в DetailScreen) —
   * внутри вкладки «Сущность» эти три плашки с «Деталей» и «Треда» не видны вовсе.
   */
  const notices = (
    <div className="flex flex-col gap-2 pt-3 empty:hidden">
      {/* Расхождение версий — ОДИН баннер на оба источника. Правка тела и правка заголовка идут
          через РАЗНЫЕ экземпляры useEntityUpdate (у тела — свой, внутри useBodySave), и после
          переезда тела на автосохранение прежний баннер не зажигался бы от 409 тела вовсе —
          а сервер сверяет версию как раз только у правок тела (executor.ts). Поэтому и кнопка
          гасит оба флага: перечитать запись, оставив на экране прежнюю тревогу, — обман. */}
      {(screenConflict || save.conflict) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-control border border-danger/40 bg-danger/10 px-3 py-2"
        >
          <p className="text-sm text-danger">Изменено в другом месте — обновите.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onRefresh();
              save.dismissConflict();
            }}
          >
            Обновить
          </Button>
        </div>
      )}
      {draft !== null && (
        <DraftBanner
          draft={draft}
          onKeep={() => {
            // Два действия на одну кнопку: показать предложенный документ и отправить его.
            // Порядок между ними безразличен (`draft` — значение ЭТОГО рендера, и
            // `applyPendingDraft` его не меняет), а вот пропусти любое — и экран разойдётся с
            // базой: без первого человек увидит прежний текст над уже отправленной правкой,
            // без второго правка осталась бы только на диске.
            setLocalDoc(draft.doc);
            save.applyPendingDraft();
          }}
          onDiscard={save.discardPendingDraft}
        />
      )}
      {/* Состояние сохранения — в углу и молча: показать есть что ровно в трёх случаях
          (запрос идёт дольше секунды, правка не сохранена, правку отвергли). */}
      <div className="flex justify-end empty:hidden">
        <SaveIndicator state={save.state} />
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {/* Пока узла нет (первый проход рендера — реф ещё не привязан), плашки рисуются НА МЕСТЕ.
          Это запасной путь, а не режим: он отрабатывает один проход до первой отрисовки. Но
          выбран он именно такой — исчезни узел когда-нибудь вовсе, экран скажет о несохранённой
          правке хотя бы на своей вкладке, а не промолчит. */}
      {noticeHost === null ? notices : createPortal(notices, noticeHost)}
      {/* `doc !== null` — страж, а не развилка: без документа пункта меню нет вовсе (см.
          DetailMenu), поднять флаг неоткуда. Стоит он потому, что `doc` здесь МЕСТНЫЙ
          (`localDoc ?? serverDoc`), а тумблер без документа не собрать. */}
      {asMarkdown && doc !== null ? (
        // fallback={null}: чанк тумблера приезжает по явному жесту из меню, и мигать скелетоном
        // на месте тела ради этого не за что — тело уже на экране.
        <Suspense fallback={null}>
          <MarkdownToggle doc={doc} onChange={onMarkdownChange} onClose={onCloseMarkdown} />
        </Suspense>
      ) : (
        <EditorShell doc={doc} markdown={entity.body} onChange={onEditorChange} />
      )}
    </div>
  );
}

/**
 * Неотправленный черновик прошлой сессии. Баннер обязан сказать, ЧТО СЛУЧИТСЯ по каждой кнопке:
 * «оставить моё» не «восстанавливает», а ЗАМЕНЯЕТ текущий текст записи набранным ранее, и
 * человек, не знающий этого, нажимает её как безобидную.
 */
function DraftBanner({
  draft,
  onKeep,
  onDiscard,
}: {
  draft: NonNullable<BodySave['pendingDraft']>;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="draft-banner"
      className="flex flex-col gap-2 rounded-control border border-alert/40 bg-alert/10 px-3 py-2"
    >
      <p className="text-sm text-text">
        {draft.rejected
          ? 'Прошлую правку тела сервер не принял, и она осталась только здесь.'
          : 'Есть неотправленная правка тела: с тех пор запись изменилась в другом месте.'}
      </p>
      <p className="text-sm text-text-secondary">
        «Оставить моё» заменит текущий текст записи этой правкой. «Отбросить» удалит её, и на экране
        останется то, что сейчас в базе.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onKeep}>
          Оставить моё
        </Button>
        <Button variant="outline" size="sm" onClick={onDiscard}>
          Отбросить
        </Button>
      </div>
    </div>
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
  onToggleMarkdown,
  archived,
}: {
  onPin: () => void;
  onArchive: () => void;
  onCopyLink: () => void;
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
