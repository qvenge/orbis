import type { PageParamDecl } from '@orbis/shared/doc/page-grammar';
import { useId } from 'react';

/** Сегментов — до четырёх (§5.1); больше в строку на телефоне не лягут — выпадающий список. */
const SEGMENTS_MAX = 4;

/**
 * Переключатель параметра страницы (спека 1в §5.1) — на месте блока `{{param}}`: заголовок (`title`,
 * без него — имя) и варианты с подписями из словаря токенов (§3.4, РП-17 — второго списка нет). До
 * четырёх вариантов — сегменты, больше — нативный `<select>`.
 *
 * Сегменты — нативные радиокнопки в подписях-сегментах, а не кнопки с ролью: стрелки, один шаг Tab
 * на группу и озвучка выбора — у браузера даром, своей копии клавиатурной логики нет.
 *
 * Значение, подписи и запись выбора приходят от точки лени (`ParamSwitchSlot`): она пишет
 * состояние экрана в историю. Модуль сам не импортирует ни стор навигации, ни провайдер значений, ни
 * словарь токенов — ленивый чанк тянул бы их за собой, и сборщик выносил бы общие модули из входного
 * чанка в отдельные (замер задачи 5: +0,7 КБ и +0,1 КБ gzip замыкания экрана записи).
 */
export function ParamSwitch({
  decl,
  labels,
  current,
  pick,
}: {
  decl: PageParamDecl;
  /** Подписи вариантов по порядку `decl.options` — из словаря токенов (§3.4). */
  labels: readonly string[];
  /** Выбранный вариант — из истории экрана или умолчание (`usePageParams`). */
  current: string;
  pick: (token: string) => void;
}) {
  const title = decl.title ?? decl.name;
  const titleId = useId();
  const group = useId();
  const heading = (
    <span id={titleId} className="text-text-secondary">
      {title}
    </span>
  );

  if (decl.options.length > SEGMENTS_MAX) {
    return (
      <div className="flex items-center gap-2 text-sm">
        {heading}
        <select
          aria-labelledby={titleId}
          value={current}
          onChange={(e) => pick(e.target.value)}
          className="rounded-control border border-line bg-surface px-2 py-1 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {decl.options.map((token, i) => (
            <option key={token} value={token}>
              {labels[i]}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {heading}
      <div
        role="radiogroup"
        aria-labelledby={titleId}
        className="inline-flex gap-1 rounded-control border border-line bg-surface-2 p-0.5"
      >
        {decl.options.map((token, i) => {
          const on = token === current;
          return (
            <label
              key={token}
              className={`cursor-pointer rounded-control px-3 py-1 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40 ${on ? 'bg-surface text-text shadow-sm' : 'text-text-secondary hover:text-text'}`}
            >
              <input
                type="radio"
                name={group}
                value={token}
                checked={on}
                onChange={() => pick(token)}
                className="sr-only"
              />
              {labels[i]}
            </label>
          );
        })}
      </div>
    </div>
  );
}
