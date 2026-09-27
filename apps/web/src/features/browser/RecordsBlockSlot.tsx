import { lazy, Suspense } from 'react';
import { Skeleton } from '../../ui/Skeleton';

/**
 * Точка лени блока «Записи» (спека 1б §12, Н-9) — одна на оба места показа: узел `{{records}}`
 * рендерера страниц и экран «Обзор» (он живёт до рамки, задача 19).
 *
 * Одна, а не по `lazy()` в каждом месте: «Обзор» стоит в первом кадре приложения, рендерер — в
 * первом кадре экрана записи, и СТАТИЧЕСКИЙ импорт блока в любом из них схлопнул бы чанк
 * `RecordsBlock` в чужой (сторож наличия чанка — `scripts/check-lazy-chunks.ts`). Этот файл —
 * эагерный и лёгкий: только `lazy` и скелетон.
 *
 * Отказ загрузки чанка не глотается: `lazy` бросает ошибку до ближайшей границы — кадра ошибки
 * экрана с перезагрузкой (`ChunkErrorBoundary`), как у ленивых экранов роутера.
 */
const load = () => import('./RecordsBlock').then((m) => ({ default: m.RecordsBlock }));

let LazyRecordsBlock = lazy(load);

/**
 * Забыть загруженный модуль — ТОЛЬКО для тестов: `lazy` помнит удавшуюся загрузку навсегда, и без
 * сброса «модуль не грузится до рендера узла» проверялось бы лишь в первом тесте файла.
 */
export function resetRecordsBlockModuleForTests(): void {
  LazyRecordsBlock = lazy(load);
}

export function RecordsBlockSlot({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <Suspense
      fallback={
        // Скелетон на месте блока, а не пустота: пока чанк едет, страница не прыгает раскладкой.
        <div data-testid="records-loading" className="flex flex-col gap-2 p-3">
          {Array.from({ length: 4 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: статичные placeholder-ряды
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      }
    >
      <LazyRecordsBlock onOpen={onOpen} />
    </Suspense>
  );
}
