import { lazy, Suspense, useEffect, useState } from 'react';
import type { DetailMenuProps } from './DetailMenu';
import { MenuTrigger } from './MenuTrigger';

/**
 * Меню ⋮ живёт в своём чанке и грузится само — в простое браузера или по наведению и фокусу
 * на кнопку (рычаг веса РП-11 задачи 14 страниц 1а: чанк экрана записи вырос шаблоном хоста за
 * порог +15 %, а Radix-меню — самый крупный кусок, которому в первом кадре делать нечего).
 */
const DetailMenu = lazy(() => import('./DetailMenu').then((m) => ({ default: m.DetailMenu })));

/** Жесты, которыми Radix открывает меню с клавиатуры (`DropdownMenu.Trigger`). */
const OPEN_KEYS = new Set(['Enter', ' ', 'ArrowDown']);

/**
 * Кнопка меню ⋮, эагерная: видна и нажимаема с первого кадра, а само меню подгружается.
 *
 * `button` — только кнопка; `load` — меню грузится (жеста не было); `open` — жест был до
 * загрузки, и меню встаёт уже открытым (`defaultOpen`): нажатие, пришедшее раньше чанка, не
 * должно пропасть. Пока чанк едет, на месте стоит та же кнопка (`Suspense`), так что подмена
 * заглушки настоящим триггером глазу не видна.
 */
export function DetailMenuSlot(props: DetailMenuProps) {
  const [stage, setStage] = useState<'button' | 'load' | 'open'>('button');
  const preload = () => setStage((s) => (s === 'button' ? 'load' : s));
  useEffect(() => {
    // Простоя в окружении может не быть (Safari, jsdom) — тогда меню ждёт наведения или жеста.
    if (typeof window.requestIdleCallback !== 'function') return;
    const id = window.requestIdleCallback(() => setStage((s) => (s === 'button' ? 'load' : s)));
    return () => window.cancelIdleCallback?.(id);
  }, []);
  const trigger = (
    <MenuTrigger
      onPointerEnter={preload}
      onFocus={preload}
      onClick={() => setStage('open')}
      onKeyDown={(e) => {
        if (!OPEN_KEYS.has(e.key)) return;
        e.preventDefault();
        setStage('open');
      }}
    />
  );
  if (stage === 'button') return trigger;
  return (
    <Suspense fallback={trigger}>
      <DetailMenu {...props} defaultOpen={stage === 'open'} />
    </Suspense>
  );
}
