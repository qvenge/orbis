import { newId } from '@orbis/shared';
import { Circle, Plus } from 'lucide-react';
import { useState } from 'react';
import { EntityRef } from '../../lib/entity-ref/EntityRef';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/toast-store';

// Подзадачи: дети через relation parent (source=родитель). Создание — quick_capture
// entity_create + relation_create, оба под §5.2/журнал сервера.
export function Subtasks({ parentId }: { parentId: string }) {
  const utils = trpc.useUtils();
  const relations = trpc.relation.listFor.useQuery({ entityId: parentId });
  const childIds = (relations.data ?? [])
    .filter((r) => r.relationType === 'parent' && r.sourceId === parentId)
    .map((r) => r.targetId);
  const [draft, setDraft] = useState('');
  const { show } = useToast();
  const push = useNav((s) => s.push);
  const activeTab = useNav((s) => s.activeTab);
  const create = trpc.entity.create.useMutation();
  const relate = trpc.relation.create.useMutation({
    onSuccess: () => void utils.relation.listFor.invalidate({ entityId: parentId }),
  });
  const isPending = create.isPending || relate.isPending;

  async function add() {
    const title = draft.trim();
    if (!title || isPending) return;
    const id = newId();
    // Ошибку ловим здесь (раньше reject от mutateAsync летел неперехваченным):
    // тост + черновик остаётся в поле — ввод не теряется.
    try {
      await create.mutateAsync({
        input: { id, title, tags: [], aspects: { 'orbis/task': { status: 'inbox' } } },
        source: 'quick_capture',
      });
      await relate.mutateAsync({ source_id: parentId, target_id: id, relation_type: 'parent' });
      setDraft('');
    } catch {
      show('Не удалось сохранить', 'danger');
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">
        Подзадачи ({childIds.length})
      </p>
      {childIds.length > 0 && (
        <ul className="flex flex-col">
          {childIds.map((id) => (
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
            if (e.key === 'Enter') void add();
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
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
