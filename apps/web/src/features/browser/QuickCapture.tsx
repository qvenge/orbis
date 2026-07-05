import { newId } from '@orbis/shared';
import { type FormEvent, useState } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';

// §3.7 / D-g: текст → title БЕЗ интерпретации. Контекст задаёт теги/связь.
export type CaptureContext =
  | { kind: 'root' }
  | { kind: 'smart-list' }
  | { kind: 'entity'; parentId: string };

export function QuickCapture({ context }: { context: CaptureContext }) {
  const [text, setText] = useState('');
  const utils = trpc.useUtils();
  const create = trpc.entity.create.useMutation({
    onSuccess: () => void utils.entity.query.invalidate(),
  });
  const relation = trpc.relation.create.useMutation();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const title = text.trim();
    if (!title) return;
    const id = newId();
    const aspects = context.kind === 'root' ? undefined : { 'orbis/task': { status: 'inbox' } };
    const tags: string[] = [];
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
  }

  return (
    <form
      data-testid="quick-capture-form"
      onSubmit={submit}
      className="flex gap-2 border-t border-line p-2"
    >
      <Input
        aria-label="Быстрая запись"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Быстрая запись…"
        className="flex-1"
      />
      <Button type="submit" variant="primary">
        Добавить
      </Button>
    </form>
  );
}
