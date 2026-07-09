import { newId } from '@orbis/shared';
import { useState } from 'react';
import { EntityRef } from '../../lib/entity-ref/EntityRef';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
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
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Подзадачи ({childIds.length})</p>
      {childIds.length === 0 ? (
        <p className="text-xs text-text-muted">Подзадач нет</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {childIds.map((id) => (
            <li key={id} data-testid="subtask" className="text-sm">
              {/* Открытие подзадачи — push entity в АКТИВНЫЙ таб поверх текущего Detail. */}
              <EntityRef id={id} onOpen={(eid) => push(activeTab, { kind: 'entity', id: eid })} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          aria-label="Новая подзадача"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1"
        />
        <Button variant="ghost" onClick={add} disabled={isPending}>
          {isPending && <Spinner size={14} aria-label="Сохранение" />}+ подзадача
        </Button>
      </div>
    </div>
  );
}
