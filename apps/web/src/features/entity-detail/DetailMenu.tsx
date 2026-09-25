import { Archive, ArchiveRestore, Code, History, Link2, Pin } from 'lucide-react';
import { DropdownMenu } from '../../ui/DropdownMenu';
import { MenuTrigger } from './MenuTrigger';

/**
 * Меню ⋮ шапки detail (§3.5). Раньше «меню» было двумя icon-кнопками в ряд: пункт
 * «Скопировать ссылку» третьей кнопкой сделал бы шапку панелью инструментов, а на узком
 * экране — очередью иконок поверх заголовка. Теперь это настоящее меню, действия внутри.
 *
 * Модуль ЛЕНИВЫЙ (`DetailMenuSlot`, грузится нажатием): дерево Radix-меню (menu, popper,
 * floating-ui) — ≈7,7 кБ gzip чанка экрана записи, а нужно оно только после жеста. Статический импорт этого файла вернул бы
 * вес в первый кадр каждого открытия записи (сторож — `scripts/check-lazy-chunks.ts`).
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
}

export function DetailMenu({
  onPin,
  onArchive,
  onCopyLink,
  onPinVersion,
  onToggleMarkdown,
  archived,
  defaultOpen,
}: DetailMenuProps & {
  /** Меню монтируется жестом открытия (`DetailMenuSlot`) — и встаёт уже открытым. */
  defaultOpen: boolean;
}) {
  const archiveLabel = archived ? 'Разархивировать' : 'Архивировать';
  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      trigger={<MenuTrigger />}
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
