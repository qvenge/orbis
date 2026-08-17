import { CalendarDays, FolderOpen, type LucideIcon, MessageSquare, Wallet } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { AgendaScreen } from '../features/agenda/AgendaScreen';
import { useAgendaOverdue } from '../features/agenda/useAgenda';
import { BrowserScreen } from '../features/browser/BrowserScreen';
import { useBudgetAlertCount, useBudgetTabVisible } from '../features/budget/useBudget';
import { ChatScreen } from '../features/chat/ChatScreen';
import { ChatThread } from '../features/chat/ChatThread';
import { MemoryScreen } from '../features/settings/MemoryScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { type ScreenRef, type Tab, useNav } from '../state/navigation';
import { useRetryBuffer } from '../state/retry';
import { NavBadge } from '../ui/NavBadge';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { ScreenFallback } from './ScreenFallback';
import { ScreenHeader } from './ScreenHeader';

// Ленивые экраны: вкладка Budget, разовый мастер импорта и экран сущности не нужны первому
// кадру — первым кадром всегда открыт корень вкладки (Чат/Обзор/Повестка), а сущность,
// категорию и импорт открывают уже жестом.
// Граница лени стоит ЗДЕСЬ, а не в самих модулях: десятки тестов рендерят эти компоненты
// напрямую через renderWithProviders, и ленивость модуля уронила бы их все.
// ВАЖНО: у этих модулей не должно остаться ни одного статического импортёра — статический
// импорт рядом с динамическим молча схлопывает чанк обратно во входной. (Тесты не в счёт:
// в сборку они не входят. ImportFlow.test.tsx:18 берёт BudgetScreen статически — и это
// нормально. А вот CategoryScreen/TransactionsScreen/RolloverScreen импортируют
// `monthTitle`/`currentMonth`/`Section` из BudgetScreen — все они ленивые сами, так что
// эти рёбра остаются целиком внутри ленивой части графа.)
const BudgetScreen = lazy(() =>
  import('../features/budget/BudgetScreen').then((m) => ({ default: m.BudgetScreen })),
);
const CategoryScreen = lazy(() =>
  import('../features/budget/CategoryScreen').then((m) => ({ default: m.CategoryScreen })),
);
const RolloverScreen = lazy(() =>
  import('../features/budget/RolloverScreen').then((m) => ({ default: m.RolloverScreen })),
);
const TransactionsScreen = lazy(() =>
  import('../features/budget/TransactionsScreen').then((m) => ({ default: m.TransactionsScreen })),
);
const ImportFlow = lazy(() =>
  import('../features/import/ImportFlow').then((m) => ({ default: m.ImportFlow })),
);
// Экран сущности уносит с собой дерево ui/DropdownMenu (radix-menu + popper + arrow +
// floating-ui) — у него ровно один потребитель, меню ⋮ этого экрана.
// А вот сам РЕДАКТОР тела внутри него ленив ещё раз, и это не украшение: `BodyEditor` и
// `MarkdownToggle` тянут схему документа (`doc-*.js`, ~154 кБ gzip), то есть больше, чем весь
// остальной экран вместе взятый. Границы стоят в EditorShell.tsx и DetailScreen.tsx, а их
// целость сторожит scripts/check-lazy-chunks.ts — статический импорт рядом с ленивым
// схлопывает чанк молча.
// Соседний по каталогу NativeRow — исключение: его берёт ещё и CategoryScreen. Ребро остаётся
// целиком внутри ленивой части графа (оба импортёра ленивые), поэтому во входной чанк он не
// возвращается; rolldown кладёт его в общий чанк на двоих.
const DetailScreen = lazy(() =>
  import('../features/entity-detail/DetailScreen').then((m) => ({ default: m.DetailScreen })),
);

// Вкладки ЯДРА (02-core-os §1.1) в порядке спеки: Chat, Browser, Agenda. Agenda —
// не «устанавливаемый view», гейта installedViews у неё нет (в отличие от budget,
// который добавляется ниже по гейту, 03-budget §1.2).
const BASE_TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Чат', icon: MessageSquare },
  { id: 'browser', label: 'Обзор', icon: FolderOpen },
  { id: 'agenda', label: 'Повестка', icon: CalendarDays },
];
export const BUDGET_TAB = { id: 'budget', label: 'Бюджет', icon: Wallet } as const;

// Бейдж висит в правом верхнем углу кнопки вкладки (кнопка — relative).
const BADGE_POS = 'absolute right-4 top-1';

// Нижний tab-bar — только мобила (md:hidden); на десктопе навигация в SidebarNav.
export function TabBar() {
  const activeTab = useNav((s) => s.activeTab);
  const switchTab = useNav((s) => s.switchTab);
  const chatBadge = useRetryBuffer((s) => s.size); // §1.5
  // §1.5: счётчик «Просроченного» — ТОТ ЖЕ хук, что у секции экрана (Task D2):
  // один кэш TanStack на бейдж и вкладку, расходиться нечему.
  const agendaOverdue = useAgendaOverdue();
  const budgetVisible = useBudgetTabVisible();
  const budgetBadge = useBudgetAlertCount(); // §6.1: конверты в тревоге/перерасходе
  const tabs = budgetVisible ? [...BASE_TABS, BUDGET_TAB] : BASE_TABS;

  // Мобила: safe-area снизу; на десктопе скрыт (md:hidden) — навигация в SidebarNav.
  const cls = 'flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden';
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: tablist — корректная роль для таб-бара; nav сохраняем как landmark
    <nav role="tablist" aria-label="Разделы" className={cls}>
      {tabs.map((t) => {
        const active = activeTab === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            // aria-label нет намеренно: доступное имя считается ИЗ СОДЕРЖИМОГО, и
            // тогда бейдж (sr-only-описание внутри NavBadge) попадает в него сам —
            // с aria-label скринридер про число не узнавал бы вовсе.
            data-testid={`tab-${t.id}`}
            onClick={() => switchTab(t.id)}
            className={`relative flex flex-1 cursor-pointer flex-col items-center gap-0.5 py-2 text-xs transition ${
              active ? 'text-accent' : 'text-text-secondary'
            }`}
          >
            {/* Активный таб помечен accent-цветом иконки/подписи (Notion-style) — без
                отдельной плавающей полосы, которая под композером читалась артефактом. */}
            <Icon size={18} aria-hidden />
            {t.label}
            {/* Пустой бейдж NavBadge прячет сам (0/null/''), поэтому здесь только выбор
                вкладки. Позиционирование поверх кнопки — у вызывающего: это раскладка
                таб-бара, в sidebar тот же бейдж стоит в потоке. */}
            {t.id === 'chat' && (
              <NavBadge
                count={chatBadge}
                label="ждут отправки"
                data-testid="chat-badge"
                className={BADGE_POS}
              />
            )}
            {/* badgeLabel: «200+» при упоре в потолок (K18) и null при отказе выборки —
                заниженного числа на бейдже не бывает (решение D2b, прецедент Budget) */}
            {t.id === 'agenda' && (
              <NavBadge
                count={agendaOverdue.badgeLabel}
                label="просроченных"
                data-testid="agenda-badge"
                className={BADGE_POS}
              />
            )}
            {t.id === 'budget' && (
              <NavBadge
                count={budgetBadge}
                label="конвертов в тревоге"
                data-testid="budget-badge"
                className={BADGE_POS}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

// <main> — единственный вертикальный скролл-контейнер уровня приложения: sticky
// ScreenHeader внутри экранов прилипает к его верху (между main и шапкой нет
// overflow-обёрток). Контейнер ширины (max-w-3xl/5xl) живёт в самих экранах,
// НИЖЕ шапки: header на всю ширину, контент центрирован.
export function ActiveScreen() {
  const activeTab = useNav((s) => s.activeTab);
  const stack = useNav((s) => s.stacks[activeTab]);
  const top = stack[stack.length - 1];
  return (
    <main
      data-testid="tab-content"
      data-tab={activeTab}
      data-depth={stack.length}
      className="flex-1 overflow-y-auto"
    >
      {/* Одна граница на всё содержимое <main>. Больше не нужно: экраны сменяют друг
          друга целиком, одновременно виден ровно один, а чанк каждого модуля грузится
          один раз за жизнь вкладки (React.lazy кэширует результат) — фолбэк мелькает
          только на первом заходе. resetKey снимает пойманную ошибку при уходе с экрана:
          провал чанка Budget не должен запирать вкладки, которые грузятся статически. */}
      <ChunkErrorBoundary resetKey={`${activeTab}/${top?.kind ?? 'root'}`}>
        <Suspense fallback={<ScreenFallback />}>{renderScreen(activeTab, top)}</Suspense>
      </ChunkErrorBoundary>
    </main>
  );
}

function renderScreen(activeTab: Tab, top: ScreenRef | undefined) {
  if (!top) {
    if (activeTab === 'chat') return <ChatScreen />;
    if (activeTab === 'browser') return <BrowserScreen />;
    if (activeTab === 'agenda') return <AgendaScreen />;
    if (activeTab === 'budget') return <BudgetScreen />;
  } else if (top.kind === 'entity') {
    return <DetailScreen entityId={top.id} />;
  } else if (top.kind === 'thread') {
    return <ThreadScreen threadId={top.threadId} />;
  } else if (top.kind === 'budget-category') {
    // Экран категории Budget (03-budget §3.2, Task B3); id — id КАТЕГОРИИ (пушит B2).
    return <CategoryScreen categoryId={top.id} />;
  } else if (top.kind === 'budget-transactions') {
    // Экран «Транзакции» (03-budget §3.3, Task B5); вход — шапка Overview.
    return <TransactionsScreen />;
  } else if (top.kind === 'budget-rollover') {
    // Rollover-экран (03-budget §3.5, Task B6); вход — баннер «Новый месяц» и шапка Overview.
    return <RolloverScreen />;
  } else if (top.kind === 'budget-import') {
    // Флоу импорта CSV (03-budget §3.4, Task C4b); вход — шапка Overview и карточка чата.
    return <ImportFlow />;
  } else if (top.kind === 'memory') {
    // Экран «Память AI» (02-core-os §2.7, Task D3b); вход — раздел настроек.
    return <MemoryScreen />;
  } else if (top.kind === 'settings') {
    return <SettingsScreen />;
  }
  // Достижимо только для корня «неизвестного» таба из старого persist 'orbis:nav:v1'
  // (тип Tab шире набора вкладок — сужать его нельзя, иначе сохранённый стек упадёт).
  return <div className="p-4 text-sm text-text-secondary">Экран: {activeTab}</div>;
}

// Экран треда сущности поверх стека: шапка с «Назад» + общий чат-компонент (§2.2).
function ThreadScreen({ threadId }: { threadId: string }) {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Тред" />
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <ChatThread threadId={threadId} />
      </div>
    </div>
  );
}
