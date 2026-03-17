import { useState } from 'react';
import { Plus } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';

export function QuickCapture() {
  const [title, setTitle] = useState('');
  const utils = trpc.useUtils();

  const createEntity = trpc.entity.create.useMutation({
    onSuccess: () => {
      setTitle('');
      utils.entity.list.invalidate();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    createEntity.mutate({ title: trimmed });
  };

  return (
    <form onSubmit={handleSubmit} className="flex h-14 shrink-0 items-center gap-3 border-t border-border px-4">
      <Plus className="h-4 w-4 shrink-0 text-text-muted" />
      <input
        type="text"
        placeholder="Quick capture... (Enter to create)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={createEntity.isPending}
        className="flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none disabled:opacity-50"
      />
    </form>
  );
}
