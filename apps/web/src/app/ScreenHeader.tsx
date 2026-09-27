import { HostPresence } from './frame/HostPresence';

/**
 * Шапка экрана — рендерится ВНУТРИ каждого экрана (не в AppShell), поэтому она и есть шов рамки
 * (срез 1б РП-19, Д-15): верхняя строка — присутствие хоста «‹ · иконка · раздел ▾ · ⌂ ⋯», под ней —
 * заголовок экрана (две строки сверху, В-1: навигация видна всегда). Все вызовы шапки получают рамку
 * без правки — и фолбэк загрузки, и кадр ошибки чанка, и «Не найдено».
 *
 * Пунктов «этот экран» шапка не принимает: экран отдаёт их меню «⋯» контекстом
 * (`ScreenMenuProvider`), а не кнопками рядом с заголовком — меню одно (§6.4). sticky работает, пока
 * между <main> (скролл-контейнер) и шапкой нет overflow-обёрток.
 */
export function ScreenHeader({ title }: { title: string }) {
  return (
    <header className="sticky top-0 z-10 shrink-0 border-b border-line/70 bg-surface/90 backdrop-blur">
      <HostPresence />
      <div className="flex h-9 items-center px-4 pb-1">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
      </div>
    </header>
  );
}
