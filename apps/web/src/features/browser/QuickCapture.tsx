import { newId, ROLE_SUBITEM } from '@orbis/shared';
import { Plus } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { startAction } from '../../perf/marks';
import { trpc } from '../../trpc';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/toast-store';
import { journalRefOf } from '../undo/journal-ref';
import { offerUndoLazy } from '../undo/undo-lazy';

// §3.7 / D-g: текст → title БЕЗ интерпретации. Контекст задаёт связь: `entity` — подзадача записи
// («＋» на записи, спека 1б §6.4, РП-9), `root` — без контекста. Вариант `smart-list` снят (§9.4):
// смарт-листы стали страницами, а «＋» на странице — без контекста.
export type CaptureContext = { kind: 'root' } | { kind: 'entity'; parentId: string };

export function QuickCapture({ context }: { context: CaptureContext }) {
  const [text, setText] = useState('');
  const { show } = useToast();
  const utils = trpc.useUtils();
  const create = trpc.entity.create.useMutation({
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
  // Потерянный ответ повторяется по тому же id (РП-21). Смена контекста — новое намерение:
  // иначе replay прежней пачки вернёт запись, привязанную к другому родителю.
  const attemptRef = useRef<{ id: string; text: string; parentId: string | null } | null>(null);
  const isPending = create.isPending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const title = text.trim();
    if (!title || isPending) return;
    // Отклик «＋» (спека скорости §3.1): видимого до подтверждения нет — оптимистика «＋» в плане Б (§7.1).
    const action = startAction('create');
    const parentId = context.kind === 'entity' ? context.parentId.toLowerCase() : null;
    const previous = attemptRef.current;
    const id = previous?.text === title && previous.parentId === parentId ? previous.id : newId();
    attemptRef.current = { id, text: title, parentId };
    // НОВАЯ форма (§А1-1): статус — плоским свойством, аспект — ЯВНЫМ списком. Старая карта
    // вешала `orbis/task` самим фактом ключа `status`; без списка запись под родителем
    // родилась бы не задачей — без чекбокса и мимо Повестки.
    const subtask = context.kind === 'entity';
    const tags: string[] = [];
    // Ошибка мутации — toast, введённый текст НЕ очищается (ввод не теряется).
    try {
      await create.mutateAsync({
        input: {
          id,
          title,
          tags,
          ...(subtask ? { props: { 'orbis/task_status': 'inbox' }, aspects: ['orbis/task'] } : {}),
        },
        source: 'quick_capture',
        // Одна операция не оставляет созданную запись без связи (§7.2).
        ...(context.kind === 'entity'
          ? { link: { parentId: context.parentId, role: ROLE_SUBITEM } }
          : {}),
      });
      action.confirmed();
      attemptRef.current = null;
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
