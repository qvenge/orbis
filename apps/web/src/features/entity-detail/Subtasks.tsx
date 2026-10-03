import { newId, ROLE_SUBITEM, ROLE_TICKET } from '@orbis/shared';
import { Circle, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { useOpenRecord } from '../../app/useOpenRecord';
import { EntityRef } from '../../lib/entity-ref/EntityRef';
import { invalidateGraph } from '../../lib/invalidate';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/toast-store';
import { useHostReadOnly } from './record-host';

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
  const utils = trpc.useUtils();
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
  const [draft, setDraft] = useState('');
  // Предпросмотр шаблона (хост `readOnly`): список и переходы остаются, строки добавления нет.
  const readOnly = useHostReadOnly();
  const { show } = useToast();
  const openRecord = useOpenRecord();
  const create = trpc.entity.create.useMutation({
    // DF п.5: списки читают ДРУГОЙ ключ со своим staleTime (60 с у Повестки, K16) и сами
    // не протухнут — без этого новая подзадача до минуты не видна ни в Browser, ни в
    // Повестке. Detail родителя (сама секция подзадач) перечитывается тем же вызовом:
    // invalidateGraph инвалидирует entity.get целиком (Р17), и точечный ключ родителя в
    // него входит.
    onSuccess: () => invalidateGraph(utils),
  });
  const isPending = create.isPending;
  // Повтор адресует исходную пачку. Новый родитель требует нового id, иначе replay сохранит прежнюю привязку.
  const attemptRef = useRef<{ id: string; text: string; parentId: string } | null>(null);

  async function add() {
    const title = draft.trim();
    if (!title || isPending) return;
    const previous = attemptRef.current;
    const parent = parentId.toLowerCase();
    const id = previous?.text === title && previous.parentId === parent ? previous.id : newId();
    attemptRef.current = { id, text: title, parentId: parent };
    // Ошибку ловим здесь (раньше reject от mutateAsync летел неперехваченным):
    // тост + черновик остаётся в поле — ввод не теряется.
    try {
      await create.mutateAsync({
        // Новая форма (§А1-1): свойства плоско по id, аспекты — списком того, с чем
        // сущность рождается (`detach` у создания невыразим — снимать ещё нечего).
        input: {
          id,
          title,
          tags: [],
          props: { 'orbis/task_status': 'inbox' },
          aspects: ['orbis/task'],
        },
        source: 'quick_capture',
        link: { parentId, role: ROLE_SUBITEM },
      });
      attemptRef.current = null;
      setDraft('');
    } catch {
      show('Не удалось сохранить', 'danger');
    }
  }

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
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          {isPending ? (
            <Spinner size={14} aria-label="Сохранение" />
          ) : (
            <Plus size={14} aria-hidden className="shrink-0 text-text-muted/70" />
          )}
          <input
            aria-label="Новая подзадача"
            value={draft}
            placeholder="Добавить подзадачу…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // isComposing: Enter-подтверждение IME-композиции не должно создавать подзадачу.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add();
            }}
            className="min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm text-text outline-none transition placeholder:text-text-muted focus-visible:bg-surface-2/70"
          />
          {draft.trim() && (
            <Button variant="ghost" size="sm" onClick={add} disabled={isPending}>
              Добавить
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
