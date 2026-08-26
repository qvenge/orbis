import { newId } from '@orbis/shared';
import { Circle, Plus } from 'lucide-react';
import { useState } from 'react';
import { EntityRef } from '../../lib/entity-ref/EntityRef';
import { invalidateGraph } from '../../lib/invalidate';
import { useNav } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/toast-store';

type Relation = NonNullable<RouterOutputs['entity']['get']['relations']>[number];

/** Роли рёбер, которые секция показывает подпунктами (§А4-3). */
const SUBTASK_ROLES: readonly string[] = ['subitem', 'ticket'];

// Подзадачи: дети по РОЛИ `subitem` (source=родитель, §А4-3). Создание — quick_capture
// entity_create + relation_create, оба под §5.2/журнал сервера.
//
// Связи приходят готовыми в entity.get(include:['relations']) экрана (prop relations) —
// свой relation.listFor секция не заводит: это была ТА ЖЕ выборка вторым сетевым чтением
// на каждое открытие detail (прецедент — Blocks). Поэтому и инвалидация после создания
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
  const { show } = useToast();
  const push = useNav((s) => s.push);
  const activeTab = useNav((s) => s.activeTab);
  const create = trpc.entity.create.useMutation();
  const relate = trpc.relation.create.useMutation({
    // DF п.5: списки читают ДРУГОЙ ключ со своим staleTime (60 с у Повестки, K16) и сами
    // не протухнут — без этого новая подзадача до минуты не видна ни в Browser, ни в
    // Повестке. Detail родителя (сама секция подзадач) перечитывается тем же вызовом:
    // invalidateGraph инвалидирует entity.get целиком (Р17), и точечный ключ родителя в
    // него входит.
    onSuccess: () => invalidateGraph(utils),
  });
  const isPending = create.isPending || relate.isPending;

  async function add() {
    const title = draft.trim();
    if (!title || isPending) return;
    const id = newId();
    // Ошибку ловим здесь (раньше reject от mutateAsync летел неперехваченным):
    // тост + черновик остаётся в поле — ввод не теряется.
    let created = false;
    try {
      await create.mutateAsync({
        input: { id, title, tags: [], aspects: { 'orbis/task': { status: 'inbox' } } },
        source: 'quick_capture',
      });
      created = true;
      await relate.mutateAsync({ source_id: parentId, target_id: id, role: 'subitem' });
      setDraft('');
    } catch {
      // Частичный отказ (задача создана, связь — нет) — НЕ «не удалось сохранить»:
      // сущность в графе есть, и молчать о ней нельзя. Инвалидируем граф (свой ключ
      // со staleTime 60 с сам не протухнет) и очищаем черновик — иначе повторный Enter
      // уходит с новым newId() и плодит вторую сироту. Сирота — такая же запись графа,
      // как всякая другая: чужая открытая цель могла её посчитать (Р17), поэтому
      // инвалидация здесь та же полная, а не «только списки».
      if (created) {
        invalidateGraph(utils);
        setDraft('');
        // Куда делась запись — обязательная часть сообщения: связи в списке подзадач нет,
        // тост живёт 4 секунды, и без адреса владелец её просто не найдёт.
        show('Задача создана, но не привязана — найдёте её в списке задач', 'danger');
      } else {
        show('Не удалось сохранить', 'danger');
      }
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
              {/* Открытие подзадачи — push entity в АКТИВНЫЙ таб поверх текущего Detail. */}
              <EntityRef id={id} onOpen={(eid) => push(activeTab, { kind: 'entity', id: eid })} />
            </li>
          ))}
        </ul>
      )}
      {/* Тихая строка добавления (Notion): плюс + borderless-инпут, Enter добавляет. */}
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
    </div>
  );
}
