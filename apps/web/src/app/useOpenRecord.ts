import { HOST_APP } from '@orbis/shared/nav';
import { useCallback, useContext } from 'react';
import { useNav } from '../state/navigation';
import { FrameAppContext } from './frame/FrameApp';

/**
 * Открыть запись по ссылке из экрана (спека 1б §7.2): ссылка из содержимого несёт приложение рамки,
 * из экрана хоста (чат, карточки чата, поиск, настройки, память) — хост. Дальше место уточняет правило открытия
 * на экране записи (`features/apps/useOpening.ts`): одно место — замена адреса на его рамку,
 * запись-приложение — его домашняя (`openApp`, Р-20), спор мест — вопрос. Здесь правила нет
 * намеренно: аспектов записи по ссылке ещё не знает никто, а решение без них было бы догадкой.
 * Единственная точка входа для жестов «открыть запись» в web: приложение ссылки решает рамка, а не
 * место, где нарисована кнопка.
 */
export function useOpenRecord(): (id: string) => void {
  const frame = useContext(FrameAppContext);
  return useCallback(
    (id: string) => {
      const nav = useNav.getState();
      if (frame?.via === 'host-screen' || frame?.via === 'host-page') {
        // Чат и поиск снимаются переходом; настройки и память остаются под записью (§7.3).
        nav.openRecord(id, {
          app: HOST_APP,
          from: frame.via === 'host-screen' ? 'host-screen' : 'content',
        });
        return;
      }
      nav.openRecord(id, { app: frame?.app ?? nav.model.activeApp, from: 'content' });
    },
    [frame],
  );
}
