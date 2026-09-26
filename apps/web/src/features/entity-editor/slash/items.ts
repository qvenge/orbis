import { RECORD_BLOCK_NAMES, type RecordBlockName } from '@orbis/shared/doc/page-grammar';
import { type BodyKind, kindsAllowing, layoutPlaceAllows } from '@orbis/shared/doc/placement';
import type { QueryAst } from '@orbis/shared/query';
import type { Editor } from '@tiptap/react';
import { RECORD_BLOCK_TITLES } from '../layout-parts';
import { MENTION_CHAR } from './suggestion';

/**
 * Что пункту нужно от меню сверх редактора. Сегодня одно: выбор аспекта для карточки (§5.3) —
 * пункт не может вставить карточку без аспекта: `{{card: }}` при повторном разборе становится
 * текстом, и страховка записи увела бы всё тело в `rawBlock` (`projectionKeepsEverything`).
 * Поэтому пункт сначала спрашивает аспект, а вставляет — по ответу.
 */
export type SlashContext = {
  /** Спросить аспект; `insert` зовётся с КЛЮЧОМ выбранного, отказ — не зовётся вовсе. */
  chooseAspect: (insert: (aspectKey: string) => void) => void;
};

export type SlashItem = {
  id: string;
  label: string;
  hint?: string;
  /**
   * В телах какого рода пункт предлагается (спека страниц 1а §5.5): контейнеры и обвязка — только
   * страницам и шаблонам, `{{body}}` — только шаблону. Заметке их не предлагают: там они не
   * рисуются, а встали бы плашкой.
   */
  kinds: readonly BodyKind[];
  /**
   * Уместен ли пункт при ЭТОМ документе, сверх рода. Нужен одному «Телу записи»: в шаблоне оно
   * показывается один раз (§5.3), и второй `{{body}}` меню не предлагает.
   */
  available?: (doc: SlashDoc) => boolean;
  /**
   * Куда пункт вправе вставлять по месту каретки (спека страниц 1а §5.2): `container` —
   * контейнер, `layout-block` — блок обвязки или карточка; без поля — куда угодно.
   *
   * Грамматика пускает контейнеры и обвязку только на верх тела или в часть контейнера, а
   * контейнеры — не глубже `CONTAINER_LIMITS.depth`. Схема документа шире (`block+` у пункта
   * списка и цитаты), и вставленный туда блок при записи не пережил бы повторного разбора: сверка
   * скелета (`projectionKeepsEverything`) увела бы ВСЁ тело страницы в один `rawBlock`, а у
   * страницы нет ни правки разметкой, ни правки `rawBlock` — чинить было бы нечем.
   */
  place?: 'container' | 'layout-block';
  /**
   * Диапазон запроса (`/заг`) удаляет вызывающая сторона — пункт работает по чистому месту.
   * Разделение не косметическое: удаление и вставка обязаны считаться от ОДНОЙ позиции, а
   * пункт про диапазон не знает вовсе и знать не должен.
   */
  run: (editor: Editor, ctx: SlashContext) => void;
};

/**
 * Документ редактора — ровно то, что меню о нём спрашивает. Структурный тип, а не `Node`
 * ProseMirror: так фильтр проверяется и без живого редактора, а живой `editor.state.doc`
 * подходит под него как есть.
 */
export type SlashDoc = {
  descendants: (
    f: (node: { type: { name: string }; attrs: Record<string, unknown> }) => boolean | undefined,
  ) => void;
};

/**
 * Место каретки — ровно то, что меню о нём спрашивает: цепочка предков текстового блока.
 * Структурный тип, как у `SlashDoc`: живой `selection.$from` ProseMirror подходит под него как есть.
 */
export type SlashCaret = {
  depth: number;
  node: (depth: number) => { type: { name: string } };
};

/**
 * Можно ли вставить сюда блок тела v3. Пункт вставляется ПОСЛЕ текстового блока с кареткой, в его
 * родителя, — поэтому правилу места (`layoutPlaceAllows`, одна копия с правилом стража
 * транзакций) отдаются все предки этого блока (глубины `0 … depth - 1`).
 */
function placeAllows(place: NonNullable<SlashItem['place']>, caret: SlashCaret): boolean {
  const ancestors: string[] = [];
  for (let d = 0; d < caret.depth; d++) ancestors.push(caret.node(d).type.name);
  return layoutPlaceAllows(ancestors, place === 'container');
}

/** Обычные блоки документа — во всех телах; блоки тела v3 — по матрице §5.5, а не своим списком. */
const ALL_KINDS: readonly BodyKind[] = ['note', 'page', 'template'];

/** Есть ли в документе `{{body}}` — второй шаблону не нужен (§5.3). */
function hasBodyBlock(doc: SlashDoc): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'recordBlock' && node.attrs.name === 'body') found = true;
    return undefined;
  });
  return found;
}

/**
 * Часть контейнера из пустого абзаца: схема требует у части хоть один блок (`block+`), а пустой
 * абзац печатается пустой строкой — разбор той же печати вернёт ту же часть.
 */
const emptyPart = (type: 'column' | 'tab', attrs?: { label: string }) => ({
  type,
  ...(attrs && { attrs }),
  content: [{ type: 'paragraph' }],
});

/** Пункт блока обвязки: имя — из списка грамматики, подпись — та же, что у его заглушки. */
function recordBlockItem(name: RecordBlockName): SlashItem {
  return {
    id: `record:${name}`,
    label: RECORD_BLOCK_TITLES[name],
    hint: 'блок записи',
    kinds: kindsAllowing(name === 'body' ? 'body' : 'record'),
    place: 'layout-block',
    ...(name === 'body' && { available: (doc: SlashDoc) => !hasBodyBlock(doc) }),
    run: (e) => e.chain().focus().insertContent({ type: 'recordBlock', attrs: { name } }).run(),
  };
}

/**
 * Запрос свежевставленного блока данных — ДЕРЕВОМ, а не текстом.
 *
 * Литерал, а не `parseQueryAst(текст, реестр)`: `SlashItem.run` получает только редактор, и
 * тащить в него `useFieldCatalog` ради одного пункта значило бы менять сигнатуру всех пунктов.
 * Дерево реестра не требует — в нём лежат id, а не подписи (§А5-7).
 *
 * Пустой запрос грамматика принимает (проверено пробой на КАНОНЕ: `parseQueryAst('')` →
 * `{ok: true, ast: {filter: null}}`), но виджет с ним показал бы счётчик ВСЕХ сущностей
 * владельца без единого слова о том, что это заготовка. Поэтому запрос осмысленный и явно
 * временный: десяток недавно тронутых записей под заголовком «Новый список» — сразу видно и
 * что блок живой, и что его надо настроить. Аспект НЕ задан намеренно: догадка «это про
 * задачи» была бы навязанной, а снять лишний параметр в форме дороже, чем добавить нужный.
 */
export const NEW_QUERY_AST: QueryAst = {
  filter: null,
  sortBy: [{ field: 'orbis/updated_at', dir: 'desc' }],
  limit: 10,
  title: 'Новый список',
};

/**
 * Печатная key-форма того же дерева — второй атрибут ноды (см. `doc/nodes/query-block.ts`).
 *
 * Литералом, а не `printQueryAst(NEW_QUERY_AST, reg, 'key')` по той же причине, что и дерево:
 * реестра у пункта меню нет. Что литерал не разъедется с печатью, сторожит тест
 * (`slash.test.tsx`) — он поднимает фикстурный реестр и сверяет обе строки.
 */
export const NEW_QUERY_BLOCK = 'sortBy=orbis/updated_at:desc, limit=10, title="Новый список"';

/**
 * Пункты `/`-меню. Первые — команды самой схемы: заводить под них свои обёртки значило бы
 * держать второй список того, что документ и так умеет.
 *
 * «Список по запросу» (бывший «Смарт-лист», слово ушло из словаря, спека страниц 1а §7.4)
 * закрывает настоящую дыру: без него вставить `{{query:…}}` из интерфейса нельзя ВОВСЕ —
 * редактор блока (QueryBlockEditor) открывается только на уже существующем блоке. Поэтому пункт
 * ВСТАВЛЯЕТ блок, а не открывает редактор: настроить свежий блок можно тут же кнопкой
 * «Настроить» на его виджете, и это единственный путь, у которого есть начало.
 *
 * «Ссылка на запись» набирает `@` вместо того, чтобы заводить свой пикер: механизм поиска
 * и вставки уже есть, и второй его экземпляр разошёлся бы с первым при первой же правке.
 * Отсюда и подсказка «или @» — она описывает ровно то, что пункт делает.
 *
 * Контейнеры и блоки обвязки (§9.1) — только страницам и шаблонам (`kinds`). Контейнер
 * вставляется с частями из пустых абзацев: схема не пускает колонок меньше двух и вкладок меньше
 * одной, а пустая часть печатается и разбирается обратно той же частью.
 */
export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'h1',
    label: 'Заголовок 1',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'h2',
    label: 'Заголовок 2',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'h3',
    label: 'Заголовок 3',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'ul',
    label: 'Список',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ol',
    label: 'Нумерованный список',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'task',
    label: 'Задача',
    hint: 'чеклист',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'quote',
    label: 'Цитата',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'code',
    label: 'Код',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: 'table',
    label: 'Таблица',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().insertTable({ rows: 2, cols: 2 }).run(),
  },
  {
    id: 'hr',
    label: 'Разделитель',
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    id: 'query',
    label: 'Список по запросу',
    hint: 'блок данных',
    kinds: kindsAllowing('query'),
    run: (e) =>
      e
        .chain()
        .focus()
        .insertContent({
          type: 'queryBlock',
          attrs: { ast: NEW_QUERY_AST, text: NEW_QUERY_BLOCK },
        })
        .run(),
  },
  {
    id: 'ref',
    label: 'Ссылка на запись',
    hint: `или ${MENTION_CHAR}`,
    kinds: ALL_KINDS,
    run: (e) => e.chain().focus().insertContent(MENTION_CHAR).run(),
  },
  {
    id: 'columns',
    label: 'Колонки',
    hint: 'раскладка страницы',
    kinds: kindsAllowing('container'),
    place: 'container',
    run: (e) =>
      e
        .chain()
        .focus()
        .insertContent({ type: 'columns', content: [emptyPart('column'), emptyPart('column')] })
        .run(),
  },
  {
    id: 'tabs',
    label: 'Вкладки',
    hint: 'раскладка страницы',
    kinds: kindsAllowing('container'),
    place: 'container',
    run: (e) =>
      e
        .chain()
        .focus()
        .insertContent({ type: 'tabs', content: [emptyPart('tab', { label: 'Вкладка 1' })] })
        .run(),
  },
  ...RECORD_BLOCK_NAMES.map(recordBlockItem),
  {
    id: 'card',
    label: 'Карточка аспекта',
    hint: 'блок записи',
    kinds: kindsAllowing('card'),
    place: 'layout-block',
    // Вставка — по ответу, в каретку, которую редактор помнит и без фокуса: пока открыт выбор,
    // фокус у него, а `focus()` возвращает редактору его же выделение.
    run: (e, ctx) =>
      ctx.chooseAspect((key) =>
        e
          .chain()
          .focus()
          .insertContent({ type: 'aspectCard', attrs: { aspect: null, text: key } })
          .run(),
      ),
  },
];

/**
 * Пункты меню для тела этого рода, этого документа и этого места каретки, отфильтрованные по
 * набранному. Ищем и в подписи, и в подсказке: «чеклист» — то слово, которым «Задачу» назовут
 * раньше, чем вспомнят её имя в этом меню.
 *
 * Один список на показ И на выбор (`EditorSuggest`): найди выбор пункт по полному списку, Enter
 * по id, которого на экране нет, вставил бы скрытый пункт — контейнер в заметку, второе тело в
 * шаблон, колонки в пункт списка.
 */
export function filterSlashItems(
  query: string,
  kind: BodyKind,
  doc: SlashDoc,
  caret: SlashCaret,
): SlashItem[] {
  const needle = query.trim().toLowerCase();
  return SLASH_ITEMS.filter(
    (i) =>
      i.kinds.includes(kind) &&
      (i.available === undefined || i.available(doc)) &&
      (i.place === undefined || placeAllows(i.place, caret)) &&
      (needle === '' || `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(needle)),
  );
}
