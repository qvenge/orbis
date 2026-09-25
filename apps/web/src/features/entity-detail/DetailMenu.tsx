import { contendersOf, PAGE_ASPECT, TEMPLATE_FOR_PROPERTY } from '@orbis/shared';
import {
  Archive,
  ArchiveRestore,
  Code,
  Eye,
  FilePlus2,
  FileText,
  History,
  LayoutTemplate,
  Link2,
  PanelsTopLeft,
  Pin,
  Scale,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';
import { useState } from 'react';
import { DropdownMenu, type DropdownMenuItem } from '../../ui/DropdownMenu';
import { useToast } from '../../ui/toast-store';
import { ChangeViewDialog } from '../page/ChangeViewDialog';
import { type ChangeViewPlan, changeViewPlan, TEXT_BEFORE_VIEW_CHANGE } from '../page/change-view';
import { HOST_TEMPLATE_TEXT } from '../page/host-template';
import type { RecordShown } from '../page/RecordView';
import { TemplateForDialog } from '../page/TemplateForDialog';
import type { PageTemplates } from '../page/usePageTemplates';
import { type UpdateBatchOperation, useUpdateBatch } from '../page/useUpdateBatch';
import type { BodyGateRef } from './EntityBody';
import { MenuTrigger } from './MenuTrigger';
import type { WireEntity } from './record-host';

/**
 * Вид экрана для пунктов страниц 1а (спека §8.4): у записи — чем она показана и какие шаблоны ей
 * подходят; у страницы — открыта ли она сейчас записью.
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
      /** «Настроить шаблон „X“» (§8.4, §9.2) — настройка шаблона, которым запись показана. */
      onConfigureTemplate: (templateId: string) => void;
    }
  | {
      kind: 'page';
      asRecord: boolean;
      onOpenAsRecord: () => void;
      /** «Настроить» (§9.1) — тело страницы в редакторе. */
      onConfigure: () => void;
      /** «Предпросмотр на записи…» (§9.3) — только у черновика шаблона; у шаблона это его показ. */
      onPreview?: () => void;
    };

/**
 * Меню ⋮ шапки detail (§3.5). Раньше «меню» было двумя icon-кнопками в ряд: пункт
 * «Скопировать ссылку» третьей кнопкой сделал бы шапку панелью инструментов, а на узком
 * экране — очередью иконок поверх заголовка. Теперь это настоящее меню, действия внутри.
 *
 * Модуль ЛЕНИВЫЙ (`DetailMenuSlot`, грузится нажатием): дерево Radix-меню (menu, popper,
 * floating-ui) — ≈7,7 кБ gzip чанка экрана записи, а нужно оно только после жеста. Статический импорт этого файла вернул бы
 * вес в первый кадр каждого открытия записи (сторож — `scripts/check-lazy-chunks.ts`). По той же
 * причине здесь, а не в экране, живут пункты страниц (§8.4), их диалоги и разбор шаблона.
 */
export interface DetailMenuProps {
  onPin: () => void;
  onArchive: () => void;
  onCopyLink: () => void;
  /** Закрепить ВЕРСИЮ ТЕЛА (С11) — не путать с `onPin`, который держит запись в сайдбаре. */
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

/** Тост жеста, отложенного ради неотправленной правки тела (`bodySettled`). */
export const BODY_SAVING = 'Сохраняем текст…';

/**
 * Открытый диалог меню: вопрос случая 3 «Изменить вид» или «Сделать шаблоном для…».
 *
 * Диалог ПОМНИТ, про какую запись и какую её версию его открыли: `entityId`, `updatedAt` и план,
 * построенный из тела этой версии, — снимок на момент жеста, а не живой проп. Меню монтируется без
 * key (`DetailMenuSlot`) и переживает переход на соседнюю запись: читай диалог проп `entity` при
 * нажатии кнопки, он записал бы план одной записи в другую. И сверка `expectedUpdatedAt` обязана
 * идти по той версии, из тела которой построен план: версия, прочитанная позже (рефетч при
 * открытом диалоге), пропустила бы правку мимо экрана, и шаблон затёр бы её молча.
 */
type MenuDialog =
  | {
      kind: 'change-view';
      entityId: string;
      updatedAt: string;
      plan: Extract<ChangeViewPlan, { case: 3 }>;
    }
  | { kind: 'template-for'; entityId: string; value: unknown }
  | null;

export function DetailMenu({
  onPin,
  onArchive,
  onCopyLink,
  onPinVersion,
  onToggleMarkdown,
  archived,
  entity,
  view,
  bodyGate,
  defaultOpen,
}: DetailMenuProps & {
  /** Меню монтируется жестом открытия (`DetailMenuSlot`) — и встаёт уже открытым. */
  defaultOpen: boolean;
}) {
  const runBatch = useUpdateBatch();
  const { show } = useToast();
  const [dialog, setDialog] = useState<MenuDialog>(null);
  // Переход на соседнюю запись закрывает диалог прежней: его снимок — про неё (докблок `MenuDialog`).
  if (dialog !== null && dialog.entityId !== entity.id) setDialog(null);
  const archiveLabel = archived ? 'Разархивировать' : 'Архивировать';

  /**
   * Правка «вида только этой записи» (§8.4): новое тело и аспект «страница» — одной операцией, а
   * при «Сохранить версией» ей предшествует закрепление тела. Порядок значим: версия снимает текст
   * до замены.
   *
   * `expectedUpdatedAt` — версия записи, ИЗ ТЕЛА КОТОРОЙ построен `body` (§5.2): в случаях 1–2 это
   * версия на момент нажатия пункта, в случае 3 — снимок в состоянии диалога, а не проп на момент
   * кнопки. Правка тела мимо экрана после этого чтения даёт серверу другую версию, и пачка
   * отвергается целиком (`STALE_VERSION`) — шаблон не затирает её молча.
   */
  /**
   * Можно ли переписать запись пачкой прямо сейчас (С1а-8 «текст не теряется»; финальное ревью,
   * F-I1). Пока у тела есть неотправленное (пауза набора или сохранение в полёте), план жеста
   * построен из тела В КЭШЕ — без последних слов, — а пачка сдвинула бы версию записи, и досыл
   * набранного ушёл бы со старой меткой в 409, когда хука, чтобы показать конфликт, уже нет.
   * Поэтому жест не исполняется: тело досылается сейчас же, человек видит тост и повторяет жест,
   * когда текст сохранён. Ждать досыла и перестраивать план здесь не станем — повтор дешевле и
   * честнее.
   */
  const bodySettled = (): boolean => {
    const gate = bodyGate.current;
    if (gate === null || !gate.hasUnsent()) return true;
    gate.flush();
    show(BODY_SAVING, 'default');
    return false;
  };

  const becomePage = (id: string, updatedAt: string, body: string): UpdateBatchOperation => ({
    tool: 'entity_update',
    input: { id, expectedUpdatedAt: updatedAt, body, aspects: { attach: [PAGE_ASPECT] } },
  });

  const items: DropdownMenuItem[] = [
    { label: 'Закрепить', icon: <Pin size={16} aria-hidden />, onSelect: onPin },
    {
      label: archiveLabel,
      icon: archived ? <ArchiveRestore size={16} aria-hidden /> : <Archive size={16} aria-hidden />,
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
    ...(view.kind === 'record' ? recordItems(view) : pageItems(view)),
  ];

  function recordItems(v: Extract<DetailMenuView, { kind: 'record' }>): DropdownMenuItem[] {
    const { shown, templates } = v;
    // Выбор не решён — пункты вида ждут его: «Изменить вид» скопировал бы не тот шаблон.
    if (shown === null || shown.templateId === null) return [makePageItem()];
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
    // Пункта нет, пока список не приехал.
    const templateText =
      templates.status !== 'ok'
        ? null
        : shownId === 'host'
          ? HOST_TEMPLATE_TEXT
          : (templates.rows.find((r) => r.id === shownId)?.body ?? null);
    return [
      ...(shownId === 'host'
        ? []
        : [
            {
              label: 'Открыть через шаблон хоста',
              icon: <PanelsTopLeft size={16} aria-hidden />,
              onSelect: () => v.onOpenVia('host'),
            },
            // Шаблон хоста в 1а не правится (§8.1) — пункт только у шаблона владельца.
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
              label: 'Изменить вид только этой записи',
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
      makePageItem(),
    ];
  }

  // «Сделать страницей»: тело становится экраном как есть — путь новых страниц (дашборд из пустой
  // записи). Вид прежним не остаётся; «как раньше» — это «Изменить вид только этой записи».
  function makePageItem(): DropdownMenuItem {
    return {
      label: 'Сделать страницей',
      icon: <FilePlus2 size={16} aria-hidden />,
      onSelect: () => {
        if (!bodySettled()) return;
        void runBatch(
          [{ tool: 'entity_update', input: { id: entity.id, aspects: { attach: [PAGE_ASPECT] } } }],
          'Запись стала страницей',
        );
      },
    };
  }

  function changeView(templateText: string) {
    if (!bodySettled()) return;
    const plan = changeViewPlan(templateText, entity.body);
    // Случай 3 — вопрос владельцу: молча ни убрать текст, ни дописать его нельзя (С1а-8).
    if (plan.case === 3) {
      setDialog({ kind: 'change-view', entityId: entity.id, updatedAt: entity.updatedAt, plan });
    } else {
      void runBatch([becomePage(entity.id, entity.updatedAt, plan.body)], 'Вид записи теперь свой');
    }
  }

  function pageItems(v: Extract<DetailMenuView, { kind: 'page' }>): DropdownMenuItem[] {
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
      {
        label: 'Сделать шаблоном для…',
        icon: <LayoutTemplate size={16} aria-hidden />,
        onSelect: () =>
          setDialog({
            kind: 'template-for',
            entityId: entity.id,
            value: entity.props[TEMPLATE_FOR_PROPERTY],
          }),
      },
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
      {
        label: 'Перестать быть страницей',
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
          );
        },
      },
    ];
  }

  return (
    <>
      <DropdownMenu defaultOpen={defaultOpen} trigger={<MenuTrigger />} items={items} />
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
                becomePage(dialog.entityId, dialog.updatedAt, dialog.plan.hideAsVersion),
              ],
              'Вид записи теперь свой, текст — в версии',
            );
          }}
          onShowBelow={() => {
            setDialog(null);
            if (!bodySettled()) return;
            void runBatch(
              [becomePage(dialog.entityId, dialog.updatedAt, dialog.plan.showBelow)],
              'Вид записи теперь свой',
            );
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'template-for' && dialog.entityId === entity.id && (
        <TemplateForDialog
          entityId={dialog.entityId}
          value={dialog.value}
          onSave={(op) => {
            setDialog(null);
            const clearing = op.tool === 'entity_update' && op.input.unset !== undefined;
            void runBatch([op], clearing ? 'Страница больше не шаблон' : 'Шаблон сохранён');
          }}
          onCancel={() => setDialog(null)}
        />
      )}
    </>
  );
}
