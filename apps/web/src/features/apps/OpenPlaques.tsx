import type { OpenPlaque } from '@orbis/shared';
import { lazy, Suspense } from 'react';
import type { WireEntity } from '../entity-detail/record-host';
import type { Apps } from './useApps';

export interface OpenPlaquesProps {
  /** `key` — у вопроса по просьбе меню: новая просьба — свежий вопрос. */
  plaques: readonly (OpenPlaque & { key?: string })[];
  apps: Apps;
  /** Запись экрана; на домашней приложения (`/a/<ref>`) записи нет. */
  record: WireEntity | null;
}

/**
 * Точка лени плашек правила открытия (срез 1б §5.2; РП-25): решение правила считается на каждом
 * открытии записи, а плашки нужны редкой записи (выключенное или чужое приложение в адресе, спор
 * мест, нет вида). Текст плашек, вопрос спора мест и их запись (`PlaceQuestion`, пачка,
 * `app.setDisabled`) — в чанке `OpenPlaqueList`; здесь — только `lazy`. Статический импорт списка
 * вернул бы его вес в первый кадр каждой записи (сторож — `scripts/check-lazy-chunks.ts`).
 *
 * Плашек нет — нет и узла: экран без плашек раскладкой не меняется. Пока чанк едет — ничего:
 * плашка неблокирующая, запись под ней уже видна.
 */
const OpenPlaqueList = lazy(() =>
  import('./OpenPlaqueList').then((m) => ({ default: m.OpenPlaqueList })),
);

export function OpenPlaques(props: OpenPlaquesProps) {
  if (props.plaques.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <OpenPlaqueList {...props} />
    </Suspense>
  );
}
