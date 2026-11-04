import { ROLE_SUBITEM } from '@orbis/shared';
import { getQueryKey } from '@trpc/react-query';
import { Plus } from 'lucide-react';
import { CreateIntentRows } from '../../lib/optimistic/CreateIntentRows';
import {
  type CreatePlacement,
  useCreateCapture,
  useCreatePlacement,
  useCreateSurface,
} from '../../lib/optimistic/use-create-intent';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { detailGetInput } from './detail-input';

/** Создание приезжает отдельно; список и его EntityRef уже показываются первым кадром. */
export function SubtaskAdd({
  parentId,
  placement,
}: {
  parentId: string;
  placement: Omit<CreatePlacement, 'key'>;
}) {
  const formScope = useCreateSurface('subtask-add');
  const origin = `subtasks:${parentId.toLowerCase()}`;
  const canonical = {
    ...placement,
    key: getQueryKey(trpc.entity.get, detailGetInput(parentId), 'query'),
  };
  useCreatePlacement(origin, canonical);
  const capture = useCreateCapture(origin, canonical, formScope);
  const draft = capture.text;
  const isPending = capture.rows.some((view) => view.status === 'pending');

  function add() {
    const title = draft.trim();
    if (!title || !capture.canSubmit(title)) return;
    capture.submit({
      input: {
        title,
        tags: [],
        props: { 'orbis/task_status': 'inbox' },
        aspects: ['orbis/task'],
      },
      source: 'quick_capture',
      link: { parentId, role: ROLE_SUBITEM },
    });
  }

  return (
    <>
      <CreateIntentRows {...capture} />
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
          onChange={(e) => capture.edit(e.target.value)}
          onKeyDown={(e) => {
            // isComposing: Enter-подтверждение IME-композиции не должно создавать подзадачу.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) add();
          }}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm text-text outline-none transition placeholder:text-text-muted focus-visible:bg-surface-2/70"
        />
        {draft.trim() && (
          <Button
            variant="ghost"
            size="sm"
            onClick={add}
            disabled={!capture.canSubmit(draft.trim())}
          >
            Добавить
          </Button>
        )}
      </div>
    </>
  );
}
