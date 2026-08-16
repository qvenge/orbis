import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';

export type MenuRow = { id: string; label: string; hint?: string };

/**
 * Клавиатура меню наружу — ХЕНДЛЕРОМ, а не слушателем на окне.
 *
 * `true` значит «событие забрало меню»: `suggestion.render().onKeyDown` вернёт его дальше, и
 * ProseMirror погасит событие ровно там, куда оно пришло. Слушатель на окне в capture-фазе
 * (первая редакция) глушил бы стрелки, Enter и Escape во ВСЁМ приложении, пока меню открыто, —
 * и конкурировал бы с самим @tiptap/suggestion за те же клавиши (ревью И18).
 */
export type SlashMenuHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

/**
 * Список с клавиатурной навигацией. Мышь здесь вспомогательна: меню вызывается НАБОРОМ,
 * значит руки уже на клавиатуре, и путь «набрал → стрелка → Enter» обязан работать целиком.
 */
export const SlashMenu = forwardRef<
  SlashMenuHandle,
  {
    rows: MenuRow[];
    onPick: (id: string) => void;
    onClose: () => void;
    /** Координаты каретки в системе ОКНА — отсюда и `position: fixed` ниже. */
    coords: { left: number; top: number };
    /**
     * Поле ввода, из которого меню вызвано (коробка редактора). Фокус остаётся ТАМ, поэтому
     * объявлять открытие списка программе чтения с экрана нужно на нём же — см. эффект ниже.
     */
    owner: HTMLElement | null;
  }
>(function SlashMenu({ rows, onPick, onClose, coords, owner }, ref) {
  const [active, setActive] = useState(0);
  const menuId = useId();
  const rowId = (id: string) => `${menuId}-${id}`;
  // Ключ строковый, а не сам массив: `rows` пересобирается на каждый рендер, и по его
  // тождеству эффект стрелял бы вхолостую после каждой буквы, включая ту, что список не
  // меняла. Сброс нужен ровно тогда, когда СОСТАВ другой: выбор обязан вернуться на первую
  // строку, иначе Enter после доп-буквы попал бы в пункт, которого на экране уже нет.
  const key = rows.map((r) => r.id).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс завязан на СОСТАВ строк (key), а не на тождество массива
  useEffect(() => setActive(0), [key]);

  const listRef = useRef<HTMLDivElement | null>(null);
  // Выбранная строка обязана быть ВИДНА. Панель ограничена по высоте и скроллится, а пунктов
  // двенадцать: без этого строки ниже восьмой выбирались бы стрелкой за краем экрана — то
  // есть обещание «набрал → стрелка → Enter» держалось бы только для верхней трети меню.
  // Вызов опциональный: в jsdom `scrollIntoView` не реализован вовсе.
  // biome-ignore lint/correctness/useExhaustiveDependencies: прокручивать надо и на смену состава строк (key)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({
      block: 'nearest',
    });
  }, [active, key]);

  /**
   * Объявление меню ПРОГРАММЕ ЧТЕНИЯ С ЭКРАНА — на поле ввода, а не на самом списке.
   *
   * Фокус намеренно остаётся в редакторе (меню вызвано набором, забрать каретку значило бы
   * сломать сам набор), поэтому `role="listbox"` и `aria-selected` на строках объявляют список
   * НЕКОМУ: программа чтения следует за фокусом. Узнать об открытии и о перемещении выбора она
   * может только из атрибутов на том элементе, где фокус и находится, — это ровно шаблон
   * «editable combobox» из ARIA APG. Клавиатурный путь работал и без этого; не работало
   * ОПОВЕЩЕНИЕ — незрячий не знал ни что список открылся, ни что стрелка что-то подвинула.
   *
   * Атрибуты ставятся и снимаются вручную, потому что элемент рисует ProseMirror, а не React.
   * Затирания не будет: `editorProps.attributes` умеет снимать только те атрибуты, что сам же
   * ставил (prosemirror-view, `updateAttrs` идёт по СВОЕМУ прежнему набору), а наших там нет.
   *
   * Снимается ВСЁ, включая `role`: атрибуты, пережившие закрытие, заставляли бы программу
   * чтения вечно рапортовать об открытом списке, которого на экране нет.
   */
  const activeId = rows[active] === undefined ? null : rowId(rows[active].id);
  useEffect(() => {
    if (owner === null || activeId === null) return;
    owner.setAttribute('role', 'combobox');
    owner.setAttribute('aria-expanded', 'true');
    owner.setAttribute('aria-controls', menuId);
    owner.setAttribute('aria-activedescendant', activeId);
    return () => {
      for (const attr of ['role', 'aria-expanded', 'aria-controls', 'aria-activedescendant'])
        owner.removeAttribute(attr);
    };
  }, [owner, menuId, activeId]);

  useImperativeHandle(
    ref,
    (): SlashMenuHandle => ({
      onKeyDown: (event) => {
        // Пустое меню не забирает НИЧЕГО: оно и не нарисовано (см. ранний выход ниже), а
        // проглоченный им Escape не закрывал бы ничего видимого — и не доехал бы туда, где
        // его ждут (модалка, поле поиска).
        if (rows.length === 0) return false;
        if (event.key === 'ArrowDown') {
          setActive((i) => (i + 1) % rows.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setActive((i) => (i - 1 + rows.length) % rows.length);
          return true;
        }
        if (event.key === 'Enter') {
          const row = rows[active];
          if (row === undefined) return false;
          onPick(row.id);
          return true;
        }
        if (event.key === 'Escape') {
          onClose();
          return true;
        }
        return false;
      },
    }),
    [rows, active, onPick, onClose],
  );

  if (rows.length === 0) return null;
  return (
    // Контейнер — div, а не ul: список интерактивный (role=listbox), и роль на неинтерактивном
    // элементе разметки биом отвергает справедливо — семантика ul/li тут ничего не добавляет,
    // потому что строки и так объявлены как option.
    <div
      ref={listRef}
      // id — адрес для `aria-controls` и корень адресов строк: фокус остаётся в редакторе, и
      // связать поле со списком можно только ссылками по id (см. эффект объявления выше).
      id={menuId}
      // Роль есть у самого списка, а фокус остаётся в редакторе: меню вызвано набором, и
      // забрать у текста каретку значило бы сломать сам набор.
      role="listbox"
      aria-label="Вставить"
      data-testid="slash-menu"
      // Признак для стража «клик снаружи» (SuggestMenu), а не украшение: по нему клик ПО
      // МЕНЮ отличается от ухода из него. Тот же приём, что у `data-query-widget`.
      data-suggest-menu=""
      // fixed, а не absolute: координаты каретки приезжают из `clientRect()` в системе ОКНА,
      // и absolute внутри непозиционированного предка уложил бы меню мимо на всю прокрутку.
      style={{ position: 'fixed', left: coords.left, top: coords.top }}
      // Панель — по конвенции проекта (ui/DropdownMenu.tsx, ui/Dialog.tsx): `bg-surface` +
      // `shadow-pop`. Токена `surface-1` в теме НЕТ — с ним панель вышла бы прозрачной
      // поверх текста (проверено разведкой: строки `surface-1` нет во всём apps/web/src).
      className="z-50 max-h-72 w-64 overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-pop"
    >
      {rows.map((r, i) => (
        <button
          key={r.id}
          // Адрес строки для `aria-activedescendant`: без него «выбор поехал» не объявляется.
          id={rowId(r.id)}
          type="button"
          role="option"
          aria-selected={i === active}
          // mousedown, а не click: click приходит после того, как браузер уже увёл фокус из
          // редактора, и `preventDefault` здесь сохраняет каретку — вставлять иначе некуда.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(r.id);
          }}
          className={`flex w-full items-baseline gap-2 rounded-control px-3 py-1.5 text-left text-sm transition ${
            i === active ? 'bg-surface-2' : ''
          }`}
        >
          <span className="truncate">{r.label}</span>
          {r.hint && <span className="truncate text-text-muted text-xs">{r.hint}</span>}
        </button>
      ))}
    </div>
  );
});
