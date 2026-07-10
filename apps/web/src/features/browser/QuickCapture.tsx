import { newId } from '@orbis/shared';
import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { trpc } from '../../trpc';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/toast-store';

// §3.7 / D-g: текст → title БЕЗ интерпретации. Контекст задаёт теги/связь.
export type CaptureContext =
  | { kind: 'root' }
  | { kind: 'smart-list' }
  | { kind: 'entity'; parentId: string };

export function QuickCapture({ context }: { context: CaptureContext }) {
  const [text, setText] = useState('');
  const { show } = useToast();
  const utils = trpc.useUtils();
  const create = trpc.entity.create.useMutation({
    onSuccess: () => void utils.entity.query.invalidate(),
  });
  const relation = trpc.relation.create.useMutation();
  const isPending = create.isPending || relation.isPending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const title = text.trim();
    if (!title || isPending) return;
    const id = newId();
    const aspects = context.kind === 'root' ? undefined : { 'orbis/task': { status: 'inbox' } };
    const tags: string[] = [];
    // Ошибка мутации — toast, введённый текст НЕ очищается (ввод не теряется).
    try {
      const ent = await create.mutateAsync({
        input: { id, title, tags, ...(aspects ? { aspects } : {}) },
        source: 'quick_capture',
      });
      if (context.kind === 'entity') {
        await relation.mutateAsync({
          source_id: context.parentId,
          target_id: ent.id,
          relation_type: 'parent',
        });
      }
      setText('');
    } catch {
      show('Не удалось сохранить', 'danger');
    }
  }

  const empty = text.trim().length === 0;
  return (
    // Капсула в стиле композера чата: без border-t, кнопка внутри поля.
    <form data-testid="quick-capture-form" onSubmit={submit} className="px-4 pb-4 pt-1">
      <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface py-1 pl-4 pr-1.5 shadow-control transition focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15">
        <input
          aria-label="Быстрая запись"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Быстрая запись — без интерпретации…"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-text outline-none placeholder:text-text-muted"
        />
        <button
          type="submit"
          disabled={isPending || empty}
          aria-label="Добавить"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:bg-surface-2 disabled:text-text-muted"
        >
          {isPending ? (
            <Spinner size={13} aria-label="Сохранение" />
          ) : (
            <Plus size={15} aria-hidden />
          )}
        </button>
      </div>
    </form>
  );
}
