import { ROLE_SUBITEM, ROLE_TICKET } from '@orbis/shared';
import { Circle } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useOpenRecord } from '../../app/useOpenRecord';
import { EntityRef } from '../../lib/entity-ref/EntityRef';
import type { RouterOutputs } from '../../trpc';
import { useHostReadOnly } from './record-host';

const SubtaskAdd = lazy(() => import('./SubtaskAdd').then((m) => ({ default: m.SubtaskAdd })));

type Relation = NonNullable<RouterOutputs['entity']['get']['relations']>[number];

/**
 * Роли рёбер, которые секция показывает подпунктами (§А4-3). Константы, а не литералы:
 * у web компилятор роль не стережёт (в контракте она `z.string()`), и переименование роли в
 * реестре молча оставило бы секцию пустой — сборка бы не упала. Дом имён один на
 * репозиторий — `@orbis/shared/constants`.
 */
const SUBTASK_ROLES: readonly string[] = [ROLE_SUBITEM, ROLE_TICKET];

// Подзадачи: дети по РОЛИ `subitem` (source=родитель, §А4-3). Создание — одной операцией
// «создать и привязать» (§7.2), источник quick_capture сохраняется.
//
// Связи приходят готовыми в entity.get(include:['relations']) экрана (prop relations) —
// свой relation.listFor секция не заводит: это была ТА ЖЕ выборка вторым сетевым чтением
// на каждое открытие detail (прецедент — Blockers). Поэтому и инвалидация после создания
// идёт по ключу entity.get: своего ключа у секции больше нет.

export function Subtasks({ parentId, relations }: { parentId: string; relations: Relation[] }) {
  /**
   * Отсева служебных сущностей здесь БОЛЬШЕ НЕТ, и это прямая выгода реформы. Раньше прогон
   * исполнителя был таким же ребёнком тикета по схлопнутому `parent`, «служебное ли это»
   * приходилось узнавать из самой ЗАПИСИ (по `orbis/agent-run`), а ради этого секция читала
   * каждого ребёнка отдельным запросом и до его приезда показывала прогон подзадачей.
   * Теперь разница написана на ребре, и список верен с первого кадра.
   *
   * Ролей ДВЕ, а не одна: `ticket` — такая же работа внутри целого, как `subitem`, только
   * у проекта, и до реформы она стояла здесь же (схлопнутый `parent` их не различал).
   * Оставь мы один `subitem` — после бэкфилла 0016 владелец потерял бы тикеты проекта из
   * вида, и вернуть их было бы нечем: писателя роли `ticket` в срезе А нет.
   * `run` в список НЕ входит — ради этого разделение и заводилось; `category-parent` тоже:
   * дерево категорий живёт на своём экране.
   */
  const visibleIds = relations
    .filter((r) => SUBTASK_ROLES.includes(r.role) && r.sourceId === parentId)
    .map((r) => r.targetId);
  const readOnly = useHostReadOnly();
  const openRecord = useOpenRecord();

  return (
    <div className="flex flex-col gap-1">
      <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">
        Подзадачи ({visibleIds.length})
      </p>
      {visibleIds.length > 0 && (
        <ul className="flex flex-col">
          {visibleIds.map((id) => (
            <li
              key={id}
              data-testid="subtask"
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition hover:bg-surface-2/60"
            >
              <Circle size={14} aria-hidden className="shrink-0 text-text-muted/70" />
              {/* Открытие подзадачи — в стопку текущего раздела поверх записи. */}
              <EntityRef id={id} onOpen={openRecord} />
            </li>
          ))}
        </ul>
      )}
      {/* Тихая строка добавления (Notion): плюс + borderless-инпут, Enter добавляет. */}
      {!readOnly && (
        <Suspense fallback={null}>
          <SubtaskAdd parentId={parentId} />
        </Suspense>
      )}
    </div>
  );
}
