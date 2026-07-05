import { newId } from '@orbis/shared';
import { useState } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';

// Подзадачи: дети через relation parent (source=родитель). Создание — quick_capture
// entity_create + relation_create, оба под §5.2/журнал сервера.
export function Subtasks({ parentId }: { parentId: string }) {
  const utils = trpc.useUtils();
  const relations = trpc.relation.listFor.useQuery({ entityId: parentId });
  const childIds = (relations.data ?? [])
    .filter((r) => r.relationType === 'parent' && r.sourceId === parentId)
    .map((r) => r.targetId);
  const [draft, setDraft] = useState('');
  const create = trpc.entity.create.useMutation();
  const relate = trpc.relation.create.useMutation({
    onSuccess: () => void utils.relation.listFor.invalidate({ entityId: parentId }),
  });

  async function add() {
    const title = draft.trim();
    if (!title) return;
    const id = newId();
    await create.mutateAsync({
      input: { id, title, tags: [], aspects: { 'orbis/task': { status: 'inbox' } } },
      source: 'quick_capture',
    });
    await relate.mutateAsync({ source_id: parentId, target_id: id, relation_type: 'parent' });
    setDraft('');
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Подзадачи ({childIds.length})</p>
      <ul className="flex flex-col gap-1">
        {childIds.map((id) => (
          <li key={id} data-testid="subtask" className="text-sm">
            {id}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          aria-label="Новая подзадача"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1"
        />
        <Button variant="ghost" onClick={add}>
          + подзадача
        </Button>
      </div>
    </div>
  );
}
