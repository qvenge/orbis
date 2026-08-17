import type { Editor } from '@tiptap/react';
import { MENTION_CHAR } from './suggestion';

export type SlashItem = {
  id: string;
  label: string;
  hint?: string;
  /**
   * Диапазон запроса (`/заг`) удаляет вызывающая сторона — пункт работает по чистому месту.
   * Разделение не косметическое: удаление и вставка обязаны считаться от ОДНОЙ позиции, а
   * пункт про диапазон не знает вовсе и знать не должен.
   */
  run: (editor: Editor) => void;
};

/**
 * Запрос свежевставленного смарт-листа.
 *
 * Пустой запрос грамматика принимает (проверено пробой: `parseQuery('')` → ok), но виджет с
 * ним показал бы счётчик ВСЕХ сущностей владельца без единого слова о том, что это заготовка.
 * Поэтому запрос осмысленный и явно временный: десяток недавно тронутых записей под
 * заголовком «Новый список» — сразу видно и что блок живой, и что его надо настроить.
 * Аспект НЕ задан намеренно: догадка «это про задачи» была бы навязанной, а снять лишний
 * параметр в форме дороже, чем добавить нужный.
 *
 * Ведущий пробел — как у сидов (`{{query: aspect=…}}`): грамматика его тримит, а проекция
 * получается той же формы, что уже лежит в теле у пяти сидированных списков.
 */
export const NEW_QUERY_BLOCK = ' sortBy=updated_at:desc, limit=10, title=Новый список';

/**
 * Пункты `/`-меню. Всё, кроме двух последних, — команды самой схемы: заводить под них свои
 * обёртки значило бы держать второй список того, что документ и так умеет.
 *
 * «Смарт-лист» закрывает настоящую дыру: сегодня вставить `{{query:…}}` из интерфейса нельзя
 * ВОВСЕ — редактор блока (QueryBlockEditor) открывается только на уже существующем блоке.
 * Поэтому пункт ВСТАВЛЯЕТ блок, а не открывает редактор: настроить свежий блок можно тут же
 * кнопкой «Настроить» на его виджете, и это единственный путь, у которого есть начало.
 *
 * «Ссылка на сущность» набирает `@` вместо того, чтобы заводить свой пикер: механизм поиска
 * и вставки уже есть, и второй его экземпляр разошёлся бы с первым при первой же правке.
 * Отсюда и подсказка «или @» — она описывает ровно то, что пункт делает.
 */
export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'h1',
    label: 'Заголовок 1',
    run: (e) => e.chain().focus().setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'h2',
    label: 'Заголовок 2',
    run: (e) => e.chain().focus().setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'h3',
    label: 'Заголовок 3',
    run: (e) => e.chain().focus().setNode('heading', { level: 3 }).run(),
  },
  { id: 'ul', label: 'Список', run: (e) => e.chain().focus().toggleBulletList().run() },
  {
    id: 'ol',
    label: 'Нумерованный список',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'task',
    label: 'Задача',
    hint: 'чеклист',
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  { id: 'quote', label: 'Цитата', run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: 'Код', run: (e) => e.chain().focus().toggleCodeBlock().run() },
  {
    id: 'table',
    label: 'Таблица',
    run: (e) => e.chain().focus().insertTable({ rows: 2, cols: 2 }).run(),
  },
  { id: 'hr', label: 'Разделитель', run: (e) => e.chain().focus().setHorizontalRule().run() },
  {
    id: 'query',
    label: 'Смарт-лист',
    hint: 'живой список по запросу',
    run: (e) =>
      e
        .chain()
        .focus()
        .insertContent({ type: 'queryBlock', attrs: { query: NEW_QUERY_BLOCK } })
        .run(),
  },
  {
    id: 'ref',
    label: 'Ссылка на сущность',
    hint: `или ${MENTION_CHAR}`,
    run: (e) => e.chain().focus().insertContent(MENTION_CHAR).run(),
  },
];

/**
 * Фильтр по набранному. Ищем и в подписи, и в подсказке: «чеклист» — то слово, которым
 * «Задачу» назовут раньше, чем вспомнят её имя в этом меню.
 */
export function filterSlashItems(query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...SLASH_ITEMS];
  return SLASH_ITEMS.filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(needle));
}
