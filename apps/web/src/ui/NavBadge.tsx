import type { HTMLAttributes } from 'react';

/*
 * Бейдж вкладки навигации (02-core-os §1.5) — один компонент на обе поверхности:
 * нижний таб-бар (мобила) и sidebar (десктоп).
 *
 * Форму НЕ переиспользуем из ui/Badge: там шире паддинг и крупнее шрифт, а
 * перебить их через className нельзя — без tailwind-merge выигрывает не порядок
 * классов в атрибуте, а порядок правил в собранном CSS (px-2 победит px-1.5).
 * Менять API общего Badge ради навигации не стали, поэтому здесь своя — но
 * ЕДИНСТВЕННАЯ — копия классов вместо прежних шести инлайновых.
 */

// Позиционирование в базу НЕ входит: в таб-баре бейдж висит `absolute right-4 top-1`
// поверх кнопки, в sidebar стоит в потоке — это раскладка ВОКРУГ бейджа, дело вызывающего.
const base = 'rounded-full bg-danger px-1.5 text-2xs text-danger-foreground';

// Мягкое проявление. Вариант motion-safe: (а не «перебивание» через animate-none)
// — при prefers-reduced-motion правило просто не действует. Keyframes — свои,
// в styles/globals.css: ставить пакет animate-утилит ради одной анимации не стали.
const motion = 'motion-safe:animate-badge-in';

const MAX = 99;

type Count = number | string | null | undefined;

/**
 * `count` — либо сырое число (усекается до «99+»), либо готовая метка, которую
 * посчитал вызывающий («200+» у Agenda при упоре в потолок, K18): своё усечение
 * бейдж чужому не навязывает. Пусто (null/''/число ≤ 0) — бейджа нет вовсе.
 * `label` — существительное для скринридера: «просроченных», «ждут отправки».
 */
export function NavBadge({
  count,
  label,
  className = '',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { count: Count; label: string }) {
  if (count === null || count === undefined) return null;
  if (typeof count === 'number' ? !(count > 0) : count === '') return null;
  const text = typeof count === 'number' && count > MAX ? `${MAX}+` : String(count);
  return (
    <span className={`${base} ${motion} ${className}`} {...props}>
      {/* Видимое число усечено, скринридер получает точное. Описание живёт ВНУТРИ
          бейджа: доступное имя кнопки вкладки считается из содержимого, поэтому
          вызывающему нечего дублировать и нечего забыть (у кнопок aria-label нет).
          Запятая в начале — разделитель самого имени: между инлайновыми узлами
          пробел не подставляется, без неё выходит слитное «Повестка3». */}
      <span aria-hidden>{text}</span>
      <span className="sr-only">{`, ${count} ${label}`}</span>
    </span>
  );
}
