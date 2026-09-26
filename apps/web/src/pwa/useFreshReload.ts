import { useCallback, useRef, useState } from 'react';
import { reloadWithFreshWorker } from './fresh-reload';

/** Подпись кнопки «Обновить», пока ставится новый сервис-воркер. */
export const RELOADING_LABEL = 'Обновляется…';

/**
 * Состояние кнопки «Обновить» (Л-5): `reloadWithFreshWorker` ждёт новый воркер до
 * `SW_UPDATE_TIMEOUT_MS` (8 с), и кнопка без отклика выглядела бы мёртвой — ровно та жалоба, которую
 * чинит Л-5. Пока ждём — `pending` (кнопка заперта, подпись «Обновляется…»), и повторное нажатие
 * вторую цепочку «обновить → ждать → перезагрузить» не запускает.
 *
 * Замок — ref, а не только `disabled`: два нажатия в одном кадре приходят раньше, чем React
 * перерисует кнопку запертой. Снимать его незачем: цепочка кончается перезагрузкой страницы.
 *
 * Отдельным модулем от `fresh-reload.ts`: тесты экранов подменяют `reloadWithFreshWorker` моком
 * модуля, а вызов изнутри того же модуля мок бы не перехватил.
 */
export function useFreshReload(): { pending: boolean; start: () => void } {
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const start = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    void reloadWithFreshWorker();
  }, []);
  return { pending, start };
}
