import { useEffect, useState } from 'react';
import type { BodySaveState } from './useBodySave';

/**
 * Сколько запрос должен идти, чтобы о нём вообще стоило говорить. Обычное сохранение
 * укладывается в круг быстрее, и надпись успела бы только моргнуть — это шум, а не ответ.
 */
export const SLOW_SAVE_MS = 1000;

/**
 * Состояние сохранения тела — в углу и молча.
 *
 * Успех НЕ празднуем. Постоянный статус в углу — ровно та панель инструментов над каждой
 * заметкой, от которой экран отказывается сознательно; молчание здесь и означает «всё
 * сохранено». Показать есть что ровно в двух случаях: запрос идёт дольше секунды и правка не
 * сохранена.
 *
 * Выдержка живёт ЗДЕСЬ, а не в хуке: `state` обязан отвечать, что происходит на самом деле,
 * иначе Задача 14 (черновик) читала бы «idle» у сохранения в полёте.
 */
export function SaveIndicator({ state }: { state: BodySaveState }) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (state !== 'saving') {
      setSlow(false);
      return;
    }
    const id = window.setTimeout(() => setSlow(true), SLOW_SAVE_MS);
    return () => clearTimeout(id);
  }, [state]);

  // role="status", а не alert: строка живёт в углу и меняется вместе с состоянием — прерывать
  // ею чтение нечем, а «Не сохранено» никуда не денется, пока правка не доедет.
  if (state === 'error') {
    return (
      <span role="status" data-testid="save-indicator" className="text-xs text-danger">
        Не сохранено
      </span>
    );
  }
  if (state === 'saving' && slow) {
    return (
      <span role="status" data-testid="save-indicator" className="text-xs text-text-muted">
        Сохраняем…
      </span>
    );
  }
  return null;
}
