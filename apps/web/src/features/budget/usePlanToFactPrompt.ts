// Хук показа карточки plan→fact (Task B6, 03-budget §2.7): при переводе задачи в done
// проверяет ПО КЛИЕНТСКИМ ДАННЫМ СУЩНОСТИ, что это планируемая покупка
// (orbis/financial.planned === true), и поднимает prompt для PlannedToFactCard.
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
  function onTaskDone(entity: { id: string; aspects: unknown }) {
    const aspects = entity.aspects as Record<string, Record<string, unknown> | undefined>;
    const fin = aspects['orbis/financial'];
    // §2.7 — только planned-покупка; шаблон recurring (orbis/schedule.recurrence) не
    // предлагаем: его инстансы переводит системный конвейер postDue в свой день (§2.8).
    // recurring-инстанс (derived_from) отклонит сервер INVARIANT'ом — relations на
    // клиенте здесь не грузим, сервер — последняя линия (plan-to-fact.ts A8).
    if (fin === undefined || fin.planned !== true) return;
    if (aspects['orbis/schedule']?.recurrence !== undefined) return;
    setPrompt({
      entityId: entity.id,
      amount: typeof fin.amount === 'string' ? fin.amount : '0',
      direction: fin.direction === 'income' ? 'income' : 'expense',
      categoryRef: typeof fin.category_ref === 'string' ? fin.category_ref : null,
    });
  }

  return { prompt, onTaskDone, dismiss: () => setPrompt(null) };
}
