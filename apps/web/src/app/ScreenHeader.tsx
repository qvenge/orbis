import { ArrowLeft, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { openSettings, useNav } from '../state/navigation';
import { Button } from '../ui/Button';
import { goBack } from './history';

/**
 * Шапка экрана — рендерится ВНУТРИ каждого экрана (не в AppShell).
 * Глубже корня — кнопка «Назад» (один уровень вниз); на корне — на мобиле
 * icon-кнопка настроек (settings всегда в стеке, поэтому на экране настроек
 * её нет автоматически). sticky работает, пока между <main> (скролл-контейнер)
 * и шапкой нет overflow-обёрток.
 *
 * «Назад» идёт через историю браузера (D18), а не прямым pop по стору: кнопка и
 * системный жест обязаны означать одно и то же, иначе кнопка добавляла бы запись
 * истории и уводила вперёд.
 */
export function ScreenHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  const depth = useNav((s) => s.stacks[s.activeTab].length);

  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-1 border-b border-line/70 bg-surface/90 px-3 backdrop-blur">
      {depth > 0 && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Назад"
          data-testid="nav-back"
          onClick={goBack}
        >
          <ArrowLeft size={18} aria-hidden />
        </Button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
      {actions}
      {depth === 0 && (
        <Button
          size="icon"
          variant="ghost"
          className="md:hidden"
          aria-label="Настройки"
          data-testid="open-settings-mobile"
          onClick={openSettings}
        >
          <Settings size={18} aria-hidden />
        </Button>
      )}
    </header>
  );
}
