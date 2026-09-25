import { contendersOf, PAGE_ASPECT, TEMPLATE_FOR_PROPERTY } from '@orbis/shared';
import {
  Archive,
  ArchiveRestore,
  Code,
  FilePlus2,
  FileText,
  History,
  LayoutTemplate,
  Link2,
  PanelsTopLeft,
  Pin,
  Scale,
  Undo2,
} from 'lucide-react';
import { useState } from 'react';
import { DropdownMenu, type DropdownMenuItem } from '../../ui/DropdownMenu';
import { ChangeViewDialog } from '../page/ChangeViewDialog';
import { type ChangeViewPlan, changeViewPlan, TEXT_BEFORE_VIEW_CHANGE } from '../page/change-view';
import { HOST_TEMPLATE_TEXT } from '../page/host-template';
import type { RecordShown } from '../page/RecordView';
import { TemplateForDialog } from '../page/TemplateForDialog';
import type { PageTemplates } from '../page/usePageTemplates';
import { type UpdateBatchOperation, useUpdateBatch } from '../page/useUpdateBatch';
import { MenuTrigger } from './MenuTrigger';
import type { WireEntity } from './record-host';

/**
 * Вид экрана для пунктов страниц 1а (спека §8.4): у записи — чем она показана и какие шаблоны ей
 * подходят; у страницы — открыта ли она сейчас записью.
 */
export type DetailMenuView =
  | {
      kind: 'record';
      /** `null` — выбор ещё не решён (ждёт реестр): пунктов вида нет, чтобы не звать не тот шаблон. */
      shown: RecordShown | null;
      templates: PageTemplates;
      onOpenVia: (templateId: string | 'host') => void;
      onChangeDispute: (contenders: readonly string[]) => void;
    }
  | { kind: 'page'; asRecord: boolean; onOpenAsRecord: () => void };

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
}

/** Открытый диалог меню: вопрос случая 3 «Изменить вид» или «Сделать шаблоном для…». */
type MenuDialog =
  | { kind: 'change-view'; plan: Extract<ChangeViewPlan, { case: 3 }> }
  | { kind: 'template-for' }
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
  defaultOpen,
}: DetailMenuProps & {
  /** Меню монтируется жестом открытия (`DetailMenuSlot`) — и встаёт уже открытым. */
  defaultOpen: boolean;
}) {
  const runBatch = useUpdateBatch();
  const [dialog, setDialog] = useState<MenuDialog>(null);
  const archiveLabel = archived ? 'Разархивировать' : 'Архивировать';

  /**
   * Правка «вида только этой записи» (§8.4): новое тело и аспект «страница» — одной операцией, а
   * при «Сохранить версией» ей предшествует закрепление ТЕКУЩЕГО тела. Порядок значим: версия
   * снимает текст до замены. `expectedUpdatedAt` — сверка тела (§5.2): текст, правленный мимо
   * экрана после его чтения, не затирается шаблоном молча — пачка отвергается целиком.
   */
  const becomePage = (body: string): UpdateBatchOperation => ({
    tool: 'entity_update',
    input: {
      id: entity.id,
      expectedUpdatedAt: entity.updatedAt,
      body,
      aspects: { attach: [PAGE_ASPECT] },
    },
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
    const titleOf = (id: string) => templates.rows.find((r) => r.id === id)?.title ?? id;
    // «Открыть через „X“» — прочие ИСПРАВНЫЕ подходящие (`openable` — докблок `openableOf`).
    const others = shown.openable.filter((id) => id !== shownId);
    const contenders = contendersOf(
      { aspects: entity.aspects },
      templates.templates,
      new Set(shown.brokenIds),
    );
    const templateText =
      shownId === 'host'
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
          ]),
      ...others.map((id) => ({
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
      onSelect: () =>
        void runBatch(
          [{ tool: 'entity_update', input: { id: entity.id, aspects: { attach: [PAGE_ASPECT] } } }],
          'Запись стала страницей',
        ),
    };
  }

  function changeView(templateText: string) {
    const plan = changeViewPlan(templateText, entity.body);
    // Случай 3 — вопрос владельцу: молча ни убрать текст, ни дописать его нельзя (С1а-8).
    if (plan.case === 3) setDialog({ kind: 'change-view', plan });
    else void runBatch([becomePage(plan.body)], 'Вид записи теперь свой');
  }

  function pageItems(v: Extract<DetailMenuView, { kind: 'page' }>): DropdownMenuItem[] {
    return [
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
        onSelect: () => setDialog({ kind: 'template-for' }),
      },
      // Снимается ТОЛЬКО аспект (РП-22): «Шаблон для» и «Главнее, чем» переживают снятие, и
      // возврат аспекта (Undo, «Сделать страницей») возвращает шаблон каким он был.
      {
        label: 'Перестать быть страницей',
        icon: <Undo2 size={16} aria-hidden />,
        onSelect: () =>
          void runBatch(
            [
              {
                tool: 'entity_update',
                input: { id: entity.id, aspects: { detach: [PAGE_ASPECT] } },
              },
            ],
            'Запись больше не страница',
          ),
      },
    ];
  }

  return (
    <>
      <DropdownMenu defaultOpen={defaultOpen} trigger={<MenuTrigger />} items={items} />
      {dialog?.kind === 'change-view' && (
        <ChangeViewDialog
          onHideAsVersion={() => {
            setDialog(null);
            void runBatch(
              [
                {
                  tool: 'entity_version_pin',
                  input: { entity_id: entity.id, label: TEXT_BEFORE_VIEW_CHANGE },
                },
                becomePage(dialog.plan.hideAsVersion),
              ],
              'Вид записи теперь свой, текст — в версии',
            );
          }}
          onShowBelow={() => {
            setDialog(null);
            void runBatch([becomePage(dialog.plan.showBelow)], 'Вид записи теперь свой');
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'template-for' && (
        <TemplateForDialog
          entityId={entity.id}
          value={entity.props[TEMPLATE_FOR_PROPERTY]}
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
