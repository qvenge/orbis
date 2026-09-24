import type { QueryAst } from '@orbis/shared/query';
import { DataBlock } from '../../features/page/blocks/DataBlock';

/**
 * Откуда вызывающий берёт запрос — ДВА пути, и оба сводятся к ТЕКСТУ.
 *
 *  - СТРОКА: первый кадр записи (`EditorShell`) живёт на `entity.body`, документа у него нет.
 *  - БЛОК ДОКУМЕНТА: `{ast, text}` из `body_doc`, где `text` — key-печать привязанного дерева
 *    (`bindQueryBlocks`) либо дословный неразобранный текст.
 *
 * Дерево больше не уходит на сервер: единый механизм данных (спека страниц 1а §6.3) адресует
 * блок ТЕКСТОМ — по нему сервер разбирает запрос реестром владельца, и по нему же ключ кеша, так
 * что первый кадр и редактор делят одни данные. Тип сохранён ради вызывающих, у которых дерево
 * под рукой (NodeView), — оно просто не читается.
 */
export type QueryBlockSource = string | { ast: QueryAst | null; text: string };

/**
 * Прежний виджет смарт-листа — теперь тонкая обёртка над `DataBlock` с прежней сигнатурой.
 * Живёт ради первого кадра и старых вызывающих; новый код зовёт `DataBlock` напрямую.
 */
export function QueryBlock({
  query,
  title,
  onConfigure,
}: {
  query: QueryBlockSource;
  title?: string;
  onConfigure?: () => void;
}) {
  const text = typeof query === 'string' ? query : query.text;
  return (
    <DataBlock
      text={text}
      {...(title !== undefined && { title })}
      {...(onConfigure && { onConfigure })}
    />
  );
}
