import { newId, ROLE_SUBITEM } from '@orbis/shared';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/toast-store';
import { journalRefOf } from '../undo/journal-ref';
import { isUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { offerUndoLazy } from '../undo/undo-lazy';

/** Создание приезжает отдельно; список и его EntityRef уже показываются первым кадром. */
export function SubtaskAdd({ parentId }: { parentId: string }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState('');
  const edit = useRef({ parent: parentId.toLowerCase(), sequence: 0 });
  if (edit.current.parent !== parentId.toLowerCase()) {
    edit.current.parent = parentId.toLowerCase();
    edit.current.sequence++;
  }
  const { show } = useToast();
  const create = trpc.entity.create.useMutation({
    meta: { undoStack: 'self' },
    // DF п.5: списки читают ДРУГОЙ ключ со своим staleTime (60 с у Повестки, K16) и сами
    // не протухнут — без этого новая подзадача до минуты не видна ни в Browser, ни в
    // Повестке. Detail родителя (сама секция подзадач) перечитывается тем же вызовом:
    // invalidateGraph инвалидирует entity.get целиком (Р17), и точечный ключ родителя в
    // него входит.
    onSuccess: (data, vars) => {
      invalidateGraph(utils);
      const ref = journalRefOf(data);
      if (ref)
        offerUndoLazy({
          title: `Создано: «${vars.input.title}»`,
          actionId: ref.actionId,
          entityIds: [],
        });
    },
  });
  const isPending = create.isPending;
  // Повтор адресует исходную пачку. Новый родитель требует нового id, иначе replay сохранит прежнюю привязку.
  const attemptRef = useRef<{ id: string; text: string; parentId: string } | null>(null);

  async function add() {
    const epoch = undoEpoch();
    const intent = edit.current.sequence;
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
      if (!isUndoEpoch(epoch)) return;
      if (attemptRef.current?.id === id) attemptRef.current = null;
      if (edit.current.sequence === intent) setDraft('');
    } catch {
      if (!isUndoEpoch(epoch)) return;
      show('Не удалось сохранить', 'danger');
    }
  }

  return (
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
        onChange={(e) => {
          edit.current.sequence++;
          setDraft(e.target.value);
        }}
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
  );
}
