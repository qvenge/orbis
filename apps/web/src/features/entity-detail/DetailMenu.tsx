import {
  type BodyActionInfo,
  contendersOf,
  HOME_PROPERTY,
  openPlacesOf,
  PAGE_ASPECT,
  placeContendersOf,
  SUPPLY_KEY,
  TEMPLATE_FOR_PROPERTY,
  type TemplateCandidate,
} from '@orbis/shared';
import {
  HOST_SHELL_KEY,
  isHostTemplateRecord,
  SUPPLY_KEY_VALUES,
  type SupplyKeyValue,
} from '@orbis/shared/supply';
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  Code,
  Eye,
  FilePlus2,
  FileText,
  History,
  LayoutTemplate,
  Link2,
  ListMinus,
  ListPlus,
  MapPin,
  PanelsTopLeft,
  RotateCcw,
  Scale,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { ScreenMenuContentProps } from '../../app/frame/ScreenMenu';
import { useNav } from '../../state/navigation';
import { DropdownMenu, type DropdownMenuItem } from '../../ui/DropdownMenu';
import { useToast } from '../../ui/toast-store';
import {
  ADD_TO_NAV,
  canRevert,
  REMOVE_FROM_NAV,
  supplyNoteOf,
  useFrameMenu,
  useNavWrite,
} from '../apps/frame-menu';
import { inNav, withoutSection } from '../apps/nav-edit';
import type { Apps } from '../apps/useApps';
import { ChangeViewDialog } from '../page/ChangeViewDialog';
import { type ChangeViewPlan, changeViewPlan, TEXT_BEFORE_VIEW_CHANGE } from '../page/change-view';
import type { RecordShown } from '../page/RecordView';
import { homeForTemplate, TemplateForDialog } from '../page/TemplateForDialog';
import type { PageTemplates } from '../page/usePageTemplates';
import { type UpdateBatchOperation, useUpdateBatch } from '../page/useUpdateBatch';
import { REVERT, useSupplyAction } from '../supply/useSupply';
import { settleBody } from './body-gate';
import type { BodyGateRef } from './EntityBody';
import { useRevertTextItem } from './RevertTextItem';
import { shownBodyRevision, type WireEntity } from './record-host';

/**
 * Вид экрана для пунктов страниц 1а (спека §8.4): у записи — чем она показана и какие шаблоны ей
 * подходят; у страницы — открыта ли она сейчас записью; в настройке чужого шаблона — сам шаблон.
 */
export type DetailMenuView =
  | {
      kind: 'record';
      /**
       * `null` (или `templateId: null`) — выбор ещё не решён: `RecordView` не извещал или ждёт реестр.
       * Пунктов вида тогда нет, чтобы не звать не тот шаблон.
       */
      shown: RecordShown | null;
      templates: PageTemplates;
      onOpenVia: (templateId: string | 'host') => void;
      onChangeDispute: (contenders: readonly string[]) => void;
      /**
       * «Настроить шаблон „X“» (§8.4, §9.2) — настройка шаблона, которым запись показана; и
       * «Настроить шаблон хоста» (срез 1б §9.2) — настройка записи поставки «Шаблон хоста».
       */
      onConfigureTemplate: (templateId: string) => void;
      /** Места записи (срез 1б §5.4): «Открыть в [приложение]» и «Сменить, где открывать такие записи». */
      places?: PlacesMenu;
    }
  | {
      kind: 'page';
      asRecord: boolean;
      onOpenAsRecord: () => void;
      /** «Настроить» (§9.1) — тело страницы в редакторе. */
      onConfigure: () => void;
      /** «Предпросмотр на записи…» (§9.3) — только у черновика шаблона; у шаблона это его показ. */
      onPreview?: () => void;
    }
  /**
   * В настройке чужого шаблона пункты — про шаблон: запись под ним не видна, и «Архивировать»,
   * «Сделать страницей», «Изменить вид», «Открыть через…» действовали бы на невидимую запись, а не
   * на то, что человек правит (остаток 1а №87). Остаются «Открыть шаблон» и ссылка на него — разделом
   * «Этот экран» одного меню «⋯» рамки (срез 1б §6.4).
   */
  | {
      kind: 'configuring';
      templateTitle: string;
      onOpenTemplate: () => void;
    };

/**
 * Вход пунктов мест (срез 1б §5.4): P считается здесь, в ленивом меню, а не в экране записи —
 * пунктам нужен весь список шаблонов (места — приложения с подходящим шаблоном), а не шаблоны рамки.
 */
export interface PlacesMenu {
  apps: Apps;
  /** Все шаблоны владельца и приложений (`templatesFromRows`), не только рамки. */
  templates: readonly TemplateCandidate[];
  /** Рамка экрана: «открыть в» ней же пунктом не предлагается. `null` — хост. */
  frameApp: string | null;
  /** «Сменить, где открывать такие записи» — вопрос спора мест с этими спорящими. */
  onChange: (contenders: readonly string[]) => void;
}

/**
 * Раздел «Этот экран» одного меню «⋯» (срез 1б §6.4) на экране записи: пункты записи или страницы,
 * а следом — раздел «Хост» (`hostItems`, их собирает рамка). Кнопка «⋯» — в присутствии хоста;
 * экран отдаёт это содержимое контекстом `ScreenMenuProvider`.
 *
 * Модуль ЛЕНИВЫЙ (`DetailMenuSlot.tsx` → `ui/LazyMenuSlot`, грузится нажатием): кнопку «⋯» рисует
 * эагерный слот рамки, здесь — только всплывающий список, его пункты и диалоги; «открыто» держит
 * слот (`LazyMenuControl`). Дерево Radix-меню (menu, popper, floating-ui) — ≈7,7 кБ gzip, а нужно оно
 * только после жеста. Статический импорт этого файла вернул бы вес в первый кадр каждого открытия
 * записи (сторож — `scripts/check-lazy-chunks.ts`). По той же причине здесь, а не в экране, живут
 * пункты страниц (§8.4), их диалоги и разбор шаблона.
 *
 * «Закрепить» (в сайдбар) ушло: закреплённые стали навигацией оболочки хоста (§9.3), глагол вместо
 * него — «Добавить в навигацию» / «Убрать из навигации» (текущего приложения). «Закрепить версию» —
 * другое понятие (Э-11), остаётся.
 *
 * Между «Этот экран» и «Хост» — раздел «Приложение «A»» (пункты записи-приложения рамки,
 * «Настроить навигацию»; `useFrameMenu`).
 */
export type DetailMenuProps = RecordMenuProps | { pending: true };

/** Диалоги навигации — после жеста, отдельным чанком от меню. */
const AddToNavDialog = lazy(() =>
  import('../apps/AddToNavDialog').then((m) => ({ default: m.AddToNavDialog })),
);
const NewAppDialog = lazy(() =>
  import('../apps/NewAppDialog').then((m) => ({ default: m.NewAppDialog })),
);

/**
 * Меню экрана записи. Запись ещё не приехала (`pending`) — без пунктов записи: «⋯» нажимают и в
 * кадре загрузки, и меню не должно ждать ответа записи, чтобы открыться (Л-1).
 */
export function DetailMenu(props: DetailMenuProps & ScreenMenuContentProps) {
  const frameMenu = useFrameMenu();
  if ('pending' in props) {
    const { pending: _pending, hostItems, ...control } = props;
    return (
      <>
        <DropdownMenu
          {...control}
          sections={[...frameMenu.sections, { label: 'Хост', items: hostItems }]}
        />
        {frameMenu.element}
      </>
    );
  }
  return <RecordMenu {...props} frameMenu={frameMenu} />;
}

interface RecordMenuProps {
  /** Действующий сеанс текущего тела считает сервер, независимо от памяти стрелок. */
  bodyAction: BodyActionInfo | null;
  onArchive: () => void;
  onCopyLink: () => void;
  /** Закрепить ВЕРСИЮ ТЕЛА (С11). */
  onPinVersion: () => void;
  /** Не задан — править как markdown нечего (у записи нет документа), и пункта нет вовсе. */
  onToggleMarkdown?: () => void;
  archived: boolean;
  /** Показываемая запись (ответ `entity.get` экрана) — на неё пишут пункты страниц. */
  entity: WireEntity;
  view: DetailMenuView;
  /** Тело на экране: есть ли неотправленная правка (жесты, переписывающие запись, ждут её). */
  bodyGate: BodyGateRef;
}

/**
 * Подписи жестов, пишущих пачку: одна строка — и пункт меню, и заголовок записи журнала, и то, что
 * назовёт «отмени последнее» (`UpdateBatchOptions.action`).
 */
const MAKE_PAGE = 'Сделать страницей';
const CHANGE_VIEW = 'Изменить вид только этой записи';
const STOP_PAGE = 'Перестать быть страницей';
const TEMPLATE_FOR = 'Сделать шаблоном для…';

/**
 * Открытый диалог меню: вопрос случая 3 «Изменить вид» или «Сделать шаблоном для…».
 *
 * Диалог ПОМНИТ, про какую запись и какую ревизию её тела его открыли: `entityId`, `bodyRevision` и
 * план, построенный из тела этой ревизии, — снимок на момент жеста, а не живой проп. Меню монтируется
 * без key (`DetailMenuSlot`) и переживает переход на соседнюю запись: читай диалог проп `entity` при
 * нажатии кнопки, он записал бы план одной записи в другую. И замок текста обязан сверять ту
 * ревизию, из тела которой построен план: ревизия, прочитанная позже (рефетч при открытом диалоге),
 * пропустила бы правку мимо экрана, и шаблон затёр бы её молча.
 */
type MenuDialog =
  | {
      kind: 'change-view';
      entityId: string;
      bodyRevision: number;
      plan: Extract<ChangeViewPlan, { case: 3 }>;
    }
  | { kind: 'template-for'; entityId: string; value: unknown; homeFor: string | null }
  | { kind: 'add-to-nav'; entityId: string }
  | { kind: 'new-app'; entityId: string }
  | null;

function RecordMenu({
  bodyAction,
  onArchive,
  onCopyLink,
  onPinVersion,
  onToggleMarkdown,
  archived,
  entity,
  view,
  bodyGate,
  open,
  onOpenChange,
  anchorRef,
  triggerId,
  contentId,
  hostItems,
  frameMenu,
}: RecordMenuProps & ScreenMenuContentProps & { frameMenu: ReturnType<typeof useFrameMenu> }) {
  const revertText = useRevertTextItem(entity.id, bodyAction);
  const runBatch = useUpdateBatch();
  const runSupply = useSupplyAction();
  const writeNav = useNavWrite();
  const { apps, frame } = frameMenu;
  const { show } = useToast();
  const [dialog, setDialog] = useState<MenuDialog>(null);
  // Переход на соседнюю запись закрывает диалог прежней: его снимок — про неё (докблок `MenuDialog`).
  if (dialog !== null && dialog.entityId !== entity.id) setDialog(null);
  const archiveLabel = archived ? 'Разархивировать' : 'Архивировать';
  // Признак записи поставки (§9.1 п. 5) — о записи на экране; в настройке чужого шаблона пункты про
  // шаблон, и признак записи под ним был бы не о том.
  const note = view.kind === 'configuring' ? undefined : supplyNoteOf(entity);

  /**
   * Правка «вида только этой записи» (§8.4): новое тело и аспект «страница» — одной операцией, а
   * при «Сохранить версией» ей предшествует закрепление тела. Порядок значим: версия снимает текст
   * до замены.
   *
   * `expectedBodyRevision` — ревизия тела, ИЗ КОТОРОГО построен `body` (замок текста, спека скорости
   * §8.1): в случаях 1–2 это ревизия на момент нажатия пункта, в случае 3 — снимок в состоянии
   * диалога, а не проп на момент кнопки. Правка тела мимо экрана после этого чтения даёт серверу
   * другую ревизию, и пачка отвергается целиком (`STALE_VERSION`) — шаблон не затирает её молча.
   */
  /**
   * Можно ли переписать запись пачкой прямо сейчас (С1а-8 «текст не теряется»; финальное ревью,
   * F-I1). Пока у тела есть неотправленное (пауза набора или сохранение в полёте), план жеста
   * построен из тела В КЭШЕ — без последних слов, — а пачка сдвинула бы версию записи, и досыл
   * набранного ушёл бы со старой меткой в 409, когда хука, чтобы показать конфликт, уже нет.
   * Поэтому жест не исполняется: тело досылается сейчас же, человек видит тост и повторяет жест,
   * когда текст сохранён. Ждать досыла и перестраивать план здесь не станем — повтор дешевле и
   * честнее. Правило одно с настройкой («Готово», страж ухода) — `settleBody`.
   */
  const bodySettled = (): boolean => settleBody(bodyGate.current, show);

  const becomePage = (id: string, bodyRevision: number, body: string): UpdateBatchOperation => ({
    tool: 'entity_update',
    input: { id, expectedBodyRevision: bodyRevision, body, aspects: { attach: [PAGE_ASPECT] } },
  });

  const copyLinkItem: DropdownMenuItem = {
    label: 'Скопировать ссылку',
    icon: <Link2 size={16} aria-hidden />,
    onSelect: onCopyLink,
  };

  // Настройка чужого шаблона: общие пункты не собираются вовсе — они про невидимую запись.
  const items: DropdownMenuItem[] =
    view.kind === 'configuring'
      ? [
          {
            label: `Открыть шаблон „${view.templateTitle}“`,
            icon: <LayoutTemplate size={16} aria-hidden />,
            onSelect: view.onOpenTemplate,
          },
          copyLinkItem,
        ]
      : commonItems(view);

  function commonItems(v: Exclude<DetailMenuView, { kind: 'configuring' }>): DropdownMenuItem[] {
    return [
      {
        label: archiveLabel,
        icon: archived ? (
          <ArchiveRestore size={16} aria-hidden />
        ) : (
          <Archive size={16} aria-hidden />
        ),
        onSelect: onArchive,
      },
      copyLinkItem,
      // Про ТЕЛО — и стоит рядом с «Править как markdown», второй правкой тела.
      {
        label: 'Закрепить версию',
        icon: <History size={16} aria-hidden />,
        onSelect: onPinVersion,
      },
      ...(revertText === null ? [] : [revertText]),
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
      ...(v.kind === 'record' ? recordItems(v) : pageItems(v)),
      ...navItems(),
      ...revertItems(),
    ];
  }

  /**
   * «Вернуть как было» у страницы поставки и шаблона хоста (срез 1б §9.1 п. 4): содержимое = печать
   * эталона в записи, прежнее тело — в версиях, одно действие с «Отменить». Есть, когда запись
   * изменена и печать эталона в ней лежит (`canRevert`); запись, выведенная из поставки (снят аспект,
   * R-17), — уже не запись поставки, пункта нет. Как и прочие переписывающие жесты, ждёт досыла тела:
   * возврат поверх неотправленного текста потерял бы его мимо версий.
   *
   * Ключ — любой допустимый, и снятый с поставки тоже (1в §6.3: правленая Upcoming 1б): возврат идёт к
   * печати эталона В ЗАПИСИ, эталон кода ему не нужен.
   */
  function revertItems(): DropdownMenuItem[] {
    const key = entity.props[SUPPLY_KEY];
    // Оболочка хоста возвращается только через диалог исчезающих разделов (раздел «Приложение»).
    if (!canRevert(entity) || key === HOST_SHELL_KEY) return [];
    if (!(SUPPLY_KEY_VALUES as readonly unknown[]).includes(key)) return [];
    return [
      {
        label: REVERT,
        icon: <RotateCcw size={16} aria-hidden />,
        onSelect: () => {
          if (!bodySettled()) return;
          void runSupply({ kind: 'revert', key: key as SupplyKeyValue, title: entity.title });
        },
      },
    ];
  }

  /**
   * «Добавить в навигацию» и рядом «Убрать из навигации» (§9.3, R-34). «Добавить» есть у живой записи
   * всегда: в выборе — приложения, где её ещё нет, и «Новое приложение…» (без дублей, диалог).
   * «Убрать» — когда запись стоит в навигации ТЕКУЩЕГО приложения. У архивной записи «Добавить» (и
   * «Новое приложение…» за ним) нет: разделом или домашней её не поставить — сервер ответил бы «цель
   * архивна» (гейт 21, M-2). «Убрать» у неё остаётся — убрать архивный раздел законно.
   * Список приложений не приехал — пунктов нет: спросить «стоит ли» не у кого.
   */
  function navItems(): DropdownMenuItem[] {
    if (apps.status !== 'ok') return [];
    const rec = frame;
    const remove: DropdownMenuItem[] =
      rec !== null && inNav(rec.nav, entity.id)
        ? [
            {
              label: REMOVE_FROM_NAV,
              icon: <ListMinus size={16} aria-hidden />,
              onSelect: () =>
                void writeNav(
                  rec,
                  (nav) => withoutSection(nav, entity.id),
                  `Убрано из навигации «${rec.title}»`,
                  REMOVE_FROM_NAV,
                ),
            },
          ]
        : [];
    if (archived) return remove;
    return [
      {
        label: ADD_TO_NAV,
        icon: <ListPlus size={16} aria-hidden />,
        onSelect: () => setDialog({ kind: 'add-to-nav', entityId: entity.id }),
      },
      ...remove,
    ];
  }

  /**
   * «Открыть в [приложение]» — разово, для каждого места P, кроме своей рамки (переход — новый шаг,
   * «‹» вернёт), и «Сменить, где открывать такие записи» — при споре мест (P ≥ 2) и при сделанном
   * выборе тоже (§5.3, §5.4). Список приложений не приехал — пунктов нет: места не посчитать.
   */
  function placeItems(p: PlacesMenu | undefined): DropdownMenuItem[] {
    if (p === undefined || p.apps.status !== 'ok') return [];
    const input = {
      record: { id: entity.id, aspects: entity.aspects, home: null },
      apps: p.apps.apps,
      hostShellId: p.apps.hostShell?.id ?? null,
      templates: p.templates,
      isBroken: () => null,
    };
    const contenders = placeContendersOf(input);
    return [
      ...openPlacesOf(input)
        .filter((id) => id !== p.frameApp)
        .map((id) => ({
          key: `open-in:${id}`,
          label: `Открыть в «${p.apps.byId.get(id)?.title || id}»`,
          icon: <AppWindow size={16} aria-hidden />,
          onSelect: () => useNav.getState().openRecord(entity.id, { app: id }),
        })),
      ...(contenders === null
        ? []
        : [
            {
              label: 'Сменить, где открывать такие записи',
              icon: <MapPin size={16} aria-hidden />,
              onSelect: () => p.onChange(contenders),
            },
          ]),
    ];
  }

  function recordItems(v: Extract<DetailMenuView, { kind: 'record' }>): DropdownMenuItem[] {
    const { shown, templates } = v;
    // Выбор не решён — пункты вида ждут его: «Изменить вид» скопировал бы не тот шаблон.
    if (shown === null || shown.templateId === null) {
      return [...placeItems(v.places), makePageItem()];
    }
    const shownId = shown.templateId;
    // Пустой заголовок — не подпись: пункт «Открыть через „“» не назвал бы шаблон вовсе.
    const titleOf = (id: string) => templates.rows.find((r) => r.id === id)?.title || id;
    // «Открыть через „X“» — прочие ИСПРАВНЫЕ подходящие (`openable` — докблок `openableOf`).
    const others = shown.openable.filter((id) => id !== shownId);
    const contenders = contendersOf(
      { aspects: entity.aspects },
      templates.templates,
      new Set(shown.brokenIds),
    );
    // Список шаблонов едет или не приехал — выбор показал шаблон хоста ВЫНУЖДЕННО (§6.5, РП-14), и
    // «Изменить вид» навсегда закрепил бы у записи вид хоста, хотя её настоящий шаблон — владельца.
    // Пункта нет, пока список не приехал. Шаблон хоста — текстом, КОТОРЫМ он показан (тело записи
    // поставки или эталон, срез 1б §9.2); записи поставки ещё едут — пункта тоже нет (`hostText`).
    const templateText =
      templates.status !== 'ok'
        ? null
        : shownId === 'host'
          ? shown.hostText
          : (templates.rows.find((r) => r.id === shownId)?.body ?? null);
    const hostRecordId = shown.hostRecordId;
    return [
      ...(shownId === 'host'
        ? // «Настроить шаблон хоста» (срез 1б §9.2) — запись поставки в том же редакторе настройки;
          // записи нет (в архиве, выведена) — настраивать нечего, пункта нет.
          hostRecordId === null
          ? []
          : [
              {
                label: 'Настроить шаблон хоста',
                icon: <SlidersHorizontal size={16} aria-hidden />,
                onSelect: () => v.onConfigureTemplate(hostRecordId),
              },
            ]
        : [
            {
              label: 'Открыть через шаблон хоста',
              icon: <PanelsTopLeft size={16} aria-hidden />,
              onSelect: () => v.onOpenVia('host'),
            },
            // Шаблон владельца; шаблон хоста — своим пунктом выше.
            {
              label: `Настроить шаблон „${titleOf(shownId)}“`,
              icon: <SlidersHorizontal size={16} aria-hidden />,
              onSelect: () => v.onConfigureTemplate(shownId),
            },
          ]),
      ...others.map((id) => ({
        // Ключ — id шаблона: у двух шаблонов может быть одно название.
        key: `open-via:${id}`,
        label: `Открыть через „${titleOf(id)}“`,
        icon: <LayoutTemplate size={16} aria-hidden />,
        onSelect: () => v.onOpenVia(id),
      })),
      ...(templateText === null
        ? []
        : [
            {
              label: CHANGE_VIEW,
              icon: <FileText size={16} aria-hidden />,
              onSelect: () => changeView(templateText),
            },
          ]),
      ...(contenders === null
        ? []
        : [
            {
              label: 'Сменить выбор шаблона для таких записей',
              icon: <Scale size={16} aria-hidden />,
              onSelect: () => v.onChangeDispute(contenders),
            },
          ]),
      ...placeItems(v.places),
      makePageItem(),
    ];
  }

  // «Сделать страницей»: тело становится экраном как есть — путь новых страниц (дашборд из пустой
  // записи). Вид прежним не остаётся; «как раньше» — это «Изменить вид только этой записи».
  function makePageItem(): DropdownMenuItem {
    return {
      label: MAKE_PAGE,
      icon: <FilePlus2 size={16} aria-hidden />,
      onSelect: () => {
        if (!bodySettled()) return;
        void runBatch(
          [{ tool: 'entity_update', input: { id: entity.id, aspects: { attach: [PAGE_ASPECT] } } }],
          'Запись стала страницей',
          { action: MAKE_PAGE },
        );
      },
    };
  }

  function changeView(templateText: string) {
    if (!bodySettled()) return;
    // Экран просит тело всегда (DETAIL_INCLUDE).
    const plan = changeViewPlan(templateText, entity.body ?? '');
    // Случай 3 — вопрос владельцу: молча ни убрать текст, ни дописать его нельзя (С1а-8).
    if (plan.case === 3) {
      setDialog({
        kind: 'change-view',
        entityId: entity.id,
        bodyRevision: shownBodyRevision(entity),
        plan,
      });
    } else {
      void runBatch(
        [becomePage(entity.id, shownBodyRevision(entity), plan.body)],
        'Вид записи теперь свой',
        {
          action: CHANGE_VIEW,
        },
      );
    }
  }

  function pageItems(v: Extract<DetailMenuView, { kind: 'page' }>): DropdownMenuItem[] {
    // Запись «Шаблон хоста» (R-29 (б)): «Шаблон для…» сделал бы её с виду кандидатом, а кандидатом
    // она не станет (её исключает `templatesFromRows`, §9.2), — пункт обещал бы то, чего не будет;
    // «Перестать быть страницей» ломает запись поставки. Выводят её из поставки архивом.
    const hostTemplate = isHostTemplateRecord(entity);
    return [
      {
        label: 'Настроить',
        icon: <SlidersHorizontal size={16} aria-hidden />,
        onSelect: v.onConfigure,
      },
      ...(v.asRecord
        ? []
        : [
            {
              label: 'Открыть как запись',
              icon: <PanelsTopLeft size={16} aria-hidden />,
              onSelect: v.onOpenAsRecord,
            },
          ]),
      ...(hostTemplate
        ? []
        : [
            {
              label: TEMPLATE_FOR,
              icon: <LayoutTemplate size={16} aria-hidden />,
              onSelect: () =>
                setDialog({
                  kind: 'template-for',
                  entityId: entity.id,
                  value: entity.props[TEMPLATE_FOR_PROPERTY],
                  // Шаблон из рамки своего приложения получает его «Дом», если он пуст (§4.3).
                  // Только известного живого приложения: адрес `/a/<не приложение>` дал бы «Дом»,
                  // который сервер отвергнет целью свойства.
                  homeFor: homeForTemplate(
                    frame?.host === false ? frame.id : null,
                    entity.props[HOME_PROPERTY],
                  ),
                }),
            },
          ]),
      ...(v.onPreview === undefined
        ? []
        : [
            {
              label: 'Предпросмотр на записи…',
              icon: <Eye size={16} aria-hidden />,
              onSelect: v.onPreview,
            },
          ]),
      // Снимается ТОЛЬКО аспект (РП-22): «Шаблон для» и «Главнее, чем» переживают снятие, и
      // возврат аспекта (Undo, «Сделать страницей») возвращает шаблон каким он был.
      ...(hostTemplate ? [] : [stopPageItem()]),
    ];
  }

  function stopPageItem(): DropdownMenuItem {
    return {
      label: STOP_PAGE,
      icon: <Undo2 size={16} aria-hidden />,
      onSelect: () => {
        if (!bodySettled()) return;
        void runBatch(
          [
            {
              tool: 'entity_update',
              input: { id: entity.id, aspects: { detach: [PAGE_ASPECT] } },
            },
          ],
          'Запись больше не страница',
          { action: STOP_PAGE },
        );
      },
    };
  }

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        triggerId={triggerId}
        contentId={contentId}
        sections={[
          { label: 'Этот экран', ...(note !== undefined && { note }), items },
          ...frameMenu.sections,
          { label: 'Хост', items: hostItems },
        ]}
      />
      {dialog?.kind === 'change-view' && dialog.entityId === entity.id && (
        <ChangeViewDialog
          reason={dialog.plan.reason}
          // Диалог закрывается и при отложенном жесте: его план — из тела ДО досыла, повтор из
          // меню построит новый.
          onHideAsVersion={() => {
            setDialog(null);
            if (!bodySettled()) return;
            void runBatch(
              [
                {
                  tool: 'entity_version_pin',
                  input: { entity_id: dialog.entityId, label: TEXT_BEFORE_VIEW_CHANGE },
                },
                becomePage(dialog.entityId, dialog.bodyRevision, dialog.plan.hideAsVersion),
              ],
              'Вид записи теперь свой, текст — в версии',
              { action: CHANGE_VIEW },
            );
          }}
          onShowBelow={() => {
            setDialog(null);
            if (!bodySettled()) return;
            void runBatch(
              [becomePage(dialog.entityId, dialog.bodyRevision, dialog.plan.showBelow)],
              'Вид записи теперь свой',
              { action: CHANGE_VIEW },
            );
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'template-for' && dialog.entityId === entity.id && (
        <TemplateForDialog
          entityId={dialog.entityId}
          value={dialog.value}
          homeFor={dialog.homeFor}
          onSave={(op) => {
            setDialog(null);
            const clearing = op.tool === 'entity_update' && op.input.unset !== undefined;
            void runBatch([op], clearing ? 'Страница больше не шаблон' : 'Шаблон сохранён', {
              action: TEMPLATE_FOR,
            });
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'add-to-nav' && dialog.entityId === entity.id && (
        <Suspense fallback={null}>
          <AddToNavDialog
            entityId={dialog.entityId}
            apps={apps}
            current={frame}
            onNewApp={() => setDialog({ kind: 'new-app', entityId: dialog.entityId })}
            onClose={() => setDialog((d) => (d?.kind === 'add-to-nav' ? null : d))}
          />
        </Suspense>
      )}
      {dialog?.kind === 'new-app' && dialog.entityId === entity.id && (
        // Домашняя и единственный раздел нового приложения — эта запись (§9.5).
        <Suspense fallback={null}>
          <NewAppDialog
            homeId={dialog.entityId}
            navIds={[dialog.entityId]}
            onClose={() => setDialog(null)}
          />
        </Suspense>
      )}
      {frameMenu.element}
    </>
  );
}
