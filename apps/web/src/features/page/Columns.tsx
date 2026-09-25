import { Children, type ReactNode } from 'react';

/**
 * Число колонок → класс сетки на широком экране. Строками целиком, а не шаблоном
 * `md:grid-cols-${n}`: Tailwind собирает классы по тексту исходника, и склеенный на лету класс
 * в стили не попал бы — колонки молча встали бы столбиком и на широком экране.
 * Пределы — `CONTAINER_LIMITS.columns` (2–4): иного числа препроход не пропускает.
 */
const GRID_COLS: Readonly<Record<number, string>> = {
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-4',
};

/**
 * Контейнер `{{columns}}` (спека страниц 1а §7.1): на узком экране части идут столбиком, на `md`
 * и шире — сеткой в ряд. На телефоне три колонки по трети ширины не читались бы вовсе.
 *
 * Части приходят уже нарисованными (детьми) — контейнер знает только раскладку, а не узлы
 * тела: иначе он и рендерер импортировали бы друг друга.
 */
export function Columns({ children }: { children: ReactNode }) {
  const parts = Children.toArray(children);
  return (
    <div
      data-testid="page-columns"
      className={`flex flex-col gap-6 md:grid md:gap-4 ${GRID_COLS[parts.length] ?? ''}`}
    >
      {parts.map((part, i) => (
        // min-w-0: без него широкая таблица блока данных распирала бы свою колонку и сетку.
        // biome-ignore lint/suspicious/noArrayIndexKey: колонки не переставляются — порядок и есть их имя
        <div key={i} data-testid="page-column" className="flex min-w-0 flex-col gap-6">
          {part}
        </div>
      ))}
    </div>
  );
}
