import { useEffect } from 'react';
import { AppShell } from './app/AppShell';
import { installChunkReload } from './app/chunk-reload';
import { externalEntryPath, installHistorySync, openDeepLink, seedHistory } from './app/history';
import { prefetchScreens } from './app/prefetch';
import { useBudgetTabVisible } from './features/budget/useBudget';
import { useRetryFlush } from './state/retry';

export function App() {
  // §2.6/§5.3: досыл retry-буфера при старте (онлайн) и переходе offline→online.
  useRetryFlush();
  // §9.4: настройки — сквозной экран; открываются из sidebar (десктоп)
  // и из шапки экрана (мобила), см. SidebarNav / ScreenHeader.

  // Навигация ↔ история браузера (D18) и вход снаружи (§1.3). Порядок строк здесь —
  // требование, а не стиль.
  //
  // Адрес и `history.state` снимаются ПЕРВОЙ строкой: `installHistorySync` канонизирует
  // и то и другое (`replaceState` под текущую позицию стора), и прочитанное после
  // установки описывало бы уже нас самих — внешний вход не сработал бы никогда. Снимок
  // берётся отдельной функцией, а не параметром `installHistorySync`: синхронизация
  // отвечает за согласие стора с историей, а не за то, откуда пришёл пользователь.
  //
  // Дальше: стор ставится в стартовую позицию (`openDeepLink`), под неё расставляются
  // записи истории (`seedHistory`), и только потом включается синхронизация. Так у
  // стартовой расстановки ровно один хозяин — подписка стора в ней не участвует и не
  // может дописать лишнего, — а `installHistorySync` следом канонизирует последнюю
  // запись сам в себя.
  //
  // Эффект стоит ЗДЕСЬ, ниже OnboardingGate: до прохождения гейта App не монтируется,
  // адрес при этом никто не переписывает, и ссылка спокойно дожидается монтирования.
  useEffect(() => {
    const entryPath = externalEntryPath();
    if (entryPath !== null) {
      // Вход в приложение (не перезагрузка): записей истории под текущей у нас нет.
      // Внешняя ссылка важнее восстановленного стека (§1.3); неразобранный путь ('/'
      // и любой чужой) openDeepLink отвергает сам, и остаётся позиция из persist (§1.4).
      openDeepLink(entryPath);
      // В обоих случаях историю под стартовой позицией надо расставить самим, иначе
      // «Назад» на восстановленном стеке (или на экране из ссылки) уводит из приложения.
      seedHistory();
    }
    // entryPath === null — перезагрузка или повторный прогон эффекта (StrictMode): записи
    // истории на месте, стор восстановит persist, трогать нечего.
    return installHistorySync();
  }, []);

  // Провал загрузки ленивого чанка → один автоматический перезаход (см. chunk-reload.ts).
  // Здесь же, ниже OnboardingGate: ленивые чанки грузятся только внутри приложения,
  // до гейта грузить нечему.
  useEffect(() => installChunkReload(), []);

  // Фоновая догрузка частых экранов (см. app/prefetch.ts). Вкладка Budget — под гейтом
  // installedViews, поэтому её чанк тянем только тем, у кого она есть; сам гейт уже
  // спрашивают TabBar и SidebarNav, третий подписчик того же запроса сети не добавляет.
  //
  // ОТДЕЛЬНЫЙ эффект, а не общий с installChunkReload: у догрузки есть зависимость
  // (`budgetVisible` доезжает вторым рендером, когда придут настройки), а у слушателя
  // перезахода её нет — общий эффект переустанавливал бы слушатель на ровном месте и
  // ронял бы события в момент переустановки.
  const budgetVisible = useBudgetTabVisible();
  useEffect(() => prefetchScreens({ budget: budgetVisible }), [budgetVisible]);

  return <AppShell />;
}
