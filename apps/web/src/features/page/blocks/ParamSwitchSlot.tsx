import type { PageParamDecl } from '@orbis/shared/doc/page-grammar';
import { QUERY_DATE_TOKEN_LABELS } from '@orbis/shared/query';
import { lazy, Suspense } from 'react';
import { useNav } from '../../../state/navigation';
import { Skeleton } from '../../../ui/Skeleton';
import { PARAM_VIEW_PREFIX, usePageParams } from '../params';

/**
 * Точка лени переключателя параметра страницы (спека 1в §5.1, РП-18) — по образцу
 * `browser/RecordsBlockSlot.tsx`: рендерер эагерен в каждом открытии записи, а переключатель нужен
 * редкой странице. Статический импорт схлопнул бы чанк `ParamSwitch` в чанк записи (сторож наличия
 * чанка — `scripts/check-lazy-chunks.ts`). Здесь — только `lazy` и скелетон высотой сегментов.
 *
 * Отказ загрузки чанка не глотается: `lazy` бросает до ближайшей границы (`ChunkErrorBoundary`).
 */
const load = () => import('./ParamSwitch').then((m) => ({ default: m.ParamSwitch }));

let LazyParamSwitch = lazy(load);

/** Забыть загруженный модуль — ТОЛЬКО для тестов (довод — `resetRecordsBlockModuleForTests`). */
export function resetParamSwitchForTests(): void {
  LazyParamSwitch = lazy(load);
}

/**
 * Выбор пишет состояние экрана в историю (`setView`, ключ `param:<имя>`): значение живёт в записи
 * стопки этого экрана, у раздела переживает перезапуск, в тело и в адрес не попадает — «поделиться»
 * даёт страницу с умолчанием. Блоки данных перечитываются сами: значение — часть их ключа.
 */
export function ParamSwitchSlot({ decl }: { decl: PageParamDecl }) {
  const current = usePageParams().values[decl.name] ?? decl.default;
  const pick = (token: string) =>
    useNav.getState().setView({ [PARAM_VIEW_PREFIX + decl.name]: token });
  return (
    // Скелетон высотой сегментов: пока чанк едет, страница не прыгает раскладкой.
    <Suspense fallback={<Skeleton className="h-8 w-48" />}>
      <LazyParamSwitch
        decl={decl}
        labels={decl.options.map((t) => QUERY_DATE_TOKEN_LABELS[t])}
        current={current}
        pick={pick}
      />
    </Suspense>
  );
}
