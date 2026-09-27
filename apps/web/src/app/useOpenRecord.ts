import { HOST_APP } from '@orbis/shared/nav';
import { useCallback, useContext } from 'react';
import { useNav } from '../state/navigation';
import { FrameAppContext } from './frame/FrameApp';

/**
 * Открыть запись по ссылке из экрана (спека 1б §7.2): ссылка из содержимого несёт приложение рамки,
 * из экрана хоста (чат, карточки чата, поиск, память) — хост; дальше место уточняет правило открытия
 * (задача 20). Единственная точка входа для жестов «открыть запись» в web: приложение ссылки решает
 * рамка, а не место, где нарисована кнопка.
 */
export function useOpenRecord(): (id: string) => void {
  const frame = useContext(FrameAppContext);
  return useCallback(
    (id: string) => {
      const nav = useNav.getState();
      if (frame?.via === 'host-screen') {
        nav.openRecord(id, { app: HOST_APP, from: 'host-screen' });
        return;
      }
      nav.openRecord(id, { app: frame?.app ?? nav.model.activeApp, from: 'content' });
    },
    [frame],
  );
}
