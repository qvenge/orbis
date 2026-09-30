// Ленивый вход полевых замеров (спека скорости §3.2; гейт задачи 3, I-1): транспорт пачек и наблюдатели Web Vitals и
// Resource Timing — отдельным чанком, который `main.tsx` грузит `import()`-ом. Во входном чанке, а значит и в эагерном
// замыкании экрана записи, остаются только метки и буфер (`marks.ts`, `collector.ts`). Потерь нет: замеры до загрузки
// копит буфер, наблюдатели подписываются с `buffered: true`. Буфер приходит аргументом (см. докблок `PerfBuffer`).
import type { PerfBuffer } from './collector';
import { startCollector } from './transport';
import { startVitals } from './vitals';

export function startPerf(buffer: PerfBuffer): void {
  startCollector(buffer);
  startVitals(buffer);
}
