/**
 * Обвязка тестов навигации 1б: место на экране по модели и адрес записи — чтобы сьюты экранов
 * проверяли «куда открылась запись», не зная устройства стопок (их держит модель shared).
 */
import { type Address, type AppRef, currentEntry } from '@orbis/shared/nav';
import { useNav } from '../state/navigation';

/** Адрес верха активной стопки — что сейчас на экране. */
export function topAddress(): Address {
  return currentEntry(useNav.getState().model).address;
}

/** Адрес записи в приложении (по умолчанию — в хосте). */
export function recordAddress(id: string, app: AppRef = { kind: 'host' }): Address {
  return { kind: 'record', app, id };
}

/**
 * Поставить навигацию так, будто человек открыл записи `ids` одну за другой в разделе «Домой» хоста
 * (пустой список — только домашняя хоста). Для сьютов, которые рисуют экран записи напрямую.
 */
export function navAt(...ids: string[]): void {
  useNav.setState({
    model: {
      activeApp: 'host',
      apps: {
        host: {
          activeSection: 'home',
          stacks: {
            home: [
              { address: { kind: 'home', app: { kind: 'host' } } },
              ...ids.map((id) => ({ address: recordAddress(id) })),
            ],
          },
        },
      },
    },
    overlay: null,
  });
}
