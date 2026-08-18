import { Tabs as RT } from 'radix-ui';
import { type ReactNode, useState } from 'react';

/**
 * Вкладки. `keepMounted` — свойство КАЖДОЙ вкладки, а не компонента, и это не украшение API.
 *
 * Radix по умолчанию РАЗМОНТИРУЕТ неактивную вкладку (`children: present && children`), и это
 * правильное поведение по умолчанию: экран настроек держит шесть вкладок, и безусловный
 * `forceMount` монтировал бы их все разом, разослав их запросы при каждом входе в настройки
 * (ревью Б8).
 *
 * Но и один флаг на весь компонент оказался слишком грубым — замерено, а не предположено. На
 * detail живой обязана остаться ровно ОДНА вкладка: «Сущность» с редактором, где лежит
 * несохранённый текст и история отмены. Подними флаг на весь компонент — вместе с ней встала бы
 * и «Тред», а `ChatThread` на монтировании заводит `chat.listMessages` (useChatThread.ts), то
 * есть КАЖДОЕ открытие записи платило бы лишним запросом за вкладку, которую никто не открывал.
 * Ровно та беда, от которой флаг и заводился, — только на другом экране.
 *
 * Спрятана «живая» вкладка КЛАССОМ (`data-[state=inactive]:hidden`), а не атрибутом `hidden`:
 * с `forceMount` Radix проставляет `hidden={!present}`, а `present` при нём всегда true. CSS
 * `display:none` заодно убирает её из дерева доступности — три озвученные подряд вкладки были бы
 * хуже размонтирования.
 */
export function Tabs({
  defaultValue,
  tabs,
  onValueChange,
}: {
  defaultValue: string;
  tabs: { value: string; label: string; content: ReactNode; keepMounted?: boolean }[];
  /**
   * Какая вкладка стала активной. Нужен ЖИВЫМ вкладкам: смонтированная неактивная вкладка не
   * отличима изнутри от активной, а её секции вправе не ходить в сеть, пока на них не смотрят
   * (версии тела на detail). Состояние по-прежнему держит компонент — это извещение, а не
   * управление.
   */
  onValueChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  /**
   * Единственный вход смены вкладки — и своего пути (onClick триггера, см. ниже), и радиксова
   * (mousedown, стрелки, фокус). Извещать из одного лишь `RT.Root` было бы НЕВЕРНО: свой
   * onClick меняет состояние мимо Radix, и в этом пути извещения не случилось бы вовсе.
   * Повторный вызов с тем же значением отсекается — оба пути срабатывают на одном жесте мыши.
   */
  const select = (next: string) => {
    if (next === value) return;
    setValue(next);
    onValueChange?.(next);
  };
  return (
    <RT.Root value={value} onValueChange={select} className="flex flex-col">
      <RT.List className="flex gap-1 border-b border-line" aria-label="Вкладки">
        {tabs.map((t) => (
          <RT.Trigger
            key={t.value}
            value={t.value}
            onClick={() => select(t.value)}
            // -mb-px кладёт 2px-подчёркивание триггера поверх 1px-границы ряда табов.
            className="-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm text-text-secondary outline-hidden transition hover:bg-surface-2/60 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=active]:border-accent data-[state=active]:text-text"
          >
            {t.label}
          </RT.Trigger>
        ))}
      </RT.List>
      {tabs.map((t) => (
        <RT.Content
          key={t.value}
          value={t.value}
          // `true | undefined`, а не `boolean`: Radix объявляет проп именно так.
          forceMount={t.keepMounted === true ? true : undefined}
          className={t.keepMounted === true ? 'pt-3 data-[state=inactive]:hidden' : 'pt-3'}
        >
          {t.content}
        </RT.Content>
      ))}
    </RT.Root>
  );
}
