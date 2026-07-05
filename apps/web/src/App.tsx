import { ActiveScreen, TabBar } from './app/router';
import { useNav } from './state/navigation';
import { useRetryFlush } from './state/retry';

export function App() {
  // §2.6/§5.3: досыл retry-буфера при старте (онлайн) и переходе offline→online.
  useRetryFlush();
  return (
    <div className="relative flex h-full flex-col">
      <ActiveScreen />
      <TabBar />
      {/* §9.4: настройки/экспорт — сквозной экран поверх активного таба (не таб). */}
      <button
        type="button"
        data-testid="open-settings"
        aria-label="Настройки"
        onClick={() => {
          const { activeTab, stacks, push } = useNav.getState();
          const stack = stacks[activeTab];
          // Без дублей: не стекуем settings поверх settings.
          if (stack[stack.length - 1]?.kind !== 'settings') push(activeTab, { kind: 'settings' });
        }}
        className="absolute right-2 top-2 z-10 rounded-full bg-surface-2/80 p-2 text-text-secondary shadow-control backdrop-blur hover:text-text"
      >
        <span aria-hidden>⚙️</span>
      </button>
    </div>
  );
}
