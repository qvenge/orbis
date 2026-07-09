import { AppShell } from './app/AppShell';
import { useRetryFlush } from './state/retry';

export function App() {
  // §2.6/§5.3: досыл retry-буфера при старте (онлайн) и переходе offline→online.
  useRetryFlush();
  // §9.4: настройки — сквозной экран; открываются из sidebar (десктоп)
  // и из шапки экрана (мобила), см. SidebarNav / ScreenHeader.
  return <AppShell />;
}
