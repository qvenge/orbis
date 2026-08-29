// Хук показа карточки plan→fact (Task B6, 03-budget §2.7): при переводе задачи в done
// проверяет ПО КЛИЕНТСКИМ ДАННЫМ СУЩНОСТИ, что это планируемая покупка
// (`orbis/planned` === true), и поднимает prompt для PlannedToFactCard.
// Общий для всех точек, где чекбокс задачи переключает статус; сейчас единственный
// мутационный путь toggle — useEntityDetail.toggleTask (DetailScreen §3.6): чекбокс
// NativeRow на CategoryScreen — no-op, EntityRow Browser — индикатор, не контрол.
import { useState } from 'react';

export type PlanToFactPrompt = {
  entityId: string;
  amount: string; // decimal-строка из аспекта — клиент только форматирует
  direction: 'expense' | 'income';
  categoryRef: string | null;
};

export function usePlanToFactPrompt() {
  const [prompt, setPrompt] = useState<PlanToFactPrompt | null>(null);

  /** Звать при переводе задачи в done (по данным сущности ДО перевода). */
  function onTaskDone(entity: { id: string; props: Record<string, unknown> }) {
    const props = entity.props;
    // §2.7 — только planned-покупка; шаблон recurring (`orbis/recurrence`) не предлагаем:
    // его инстансы переводит системный конвейер postDue в свой день (§2.8).
    // recurring-инстанс (derived_from) отклонит сервер INVARIANT'ом — relations на
    // клиенте здесь не грузим, сервер — последняя линия (plan-to-fact.ts A8).
    //
    // Признак «это планируемая покупка» — САМО свойство `orbis/planned`, а не членство в
    // аспекте: значение переживает снятие аспекта (Р9), и спрашивать носителя значило бы
    // терять карточку у записи, у которой значение есть.
    if (props['orbis/planned'] !== true) return;
    if (props['orbis/recurrence'] !== undefined) return;
    const amount = props['orbis/amount'];
    const categoryRef = props['orbis/finance_category'];
    setPrompt({
      entityId: entity.id,
      amount: typeof amount === 'string' ? amount : '0',
      direction: props['orbis/direction'] === 'income' ? 'income' : 'expense',
      categoryRef: typeof categoryRef === 'string' ? categoryRef : null,
    });
  }

  return { prompt, onTaskDone, dismiss: () => setPrompt(null) };
}
