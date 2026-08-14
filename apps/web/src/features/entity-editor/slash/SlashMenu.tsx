import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

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
  }
>(function SlashMenu({ rows, onPick, onClose, coords }, ref) {
  const [active, setActive] = useState(0);
  // Ключ строковый, а не сам массив: `rows` пересобирается на каждый рендер, и по его
  // тождеству эффект стрелял бы вхолостую после каждой буквы, включая ту, что список не
  // меняла. Сброс нужен ровно тогда, когда СОСТАВ другой: выбор обязан вернуться на первую
  // строку, иначе Enter после доп-буквы попал бы в пункт, которого на экране уже нет.
  const key = rows.map((r) => r.id).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс завязан на СОСТАВ строк (key), а не на тождество массива
  useEffect(() => setActive(0), [key]);

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
      // Роль есть у самого списка, а фокус остаётся в редакторе: меню вызвано набором, и
      // забрать у текста каретку значило бы сломать сам набор.
      role="listbox"
      aria-label="Вставить"
      data-testid="slash-menu"
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
