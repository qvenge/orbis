import { useState } from 'react';
import { QueryBlock } from '../../lib/query-blocks/QueryBlock';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Tabs } from '../../ui/Tabs';
import { firstQueryBlock } from '../browser/query';
import { ChatThread } from '../chat/ChatThread';
import { AspectCards } from './AspectCards';
import { NativeRow } from './NativeRow';
import { Subtasks } from './Subtasks';
import { useEntityDetail } from './useEntityDetail';

export function DetailScreen({ entityId }: { entityId: string }) {
  const { get, toggleTask, saveBody, setArchived, conflict } = useEntityDetail(entityId);
  const utils = trpc.useUtils();
  const settings = trpc.user.getSettings.useQuery();
  const updateSettings = trpc.user.updateSettings.useMutation({
    onSuccess: () => void utils.user.getSettings.invalidate(),
  });

  if (get.isLoading || !get.data) {
    return (
      <div role="status" className="p-4 text-sm text-text-muted">
        Загрузка…
      </div>
    );
  }
  const { entity, thread } = get.data;
  const block = firstQueryBlock(entity.body ?? '');

  // Заголовок сущности несёт NativeRow (§3.6 нативный рендер) — отдельного дубля title нет.
  const entityTab = (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-center justify-between">
        {entity.emoji ? (
          <span aria-hidden className="text-xl">
            {entity.emoji}
          </span>
        ) : (
          <span />
        )}
        <DetailMenu
          onPin={() => {
            const pinned = settings.data?.pinnedEntities ?? [];
            updateSettings.mutate({
              pinnedEntities: [...pinned, { id: entity.id, order: pinned.length }],
            });
          }}
          onArchive={() => setArchived(!entity.archived)}
          archived={entity.archived}
        />
      </div>
      <NativeRow entity={entity} onToggleTask={toggleTask} />
      {conflict && (
        <p role="alert" className="text-sm text-danger">
          Изменено в другом месте — обновите.
        </p>
      )}
      <BodyEditor key={entity.updatedAt} initial={entity.body ?? ''} onSave={saveBody} />
      {block && <QueryBlock body={entity.body ?? ''} />}
      <AspectCards entity={entity} />
      <Subtasks parentId={entity.id} />
    </div>
  );

  return (
    <Tabs
      defaultValue="entity"
      tabs={[
        { value: 'entity', label: 'Сущность', content: entityTab },
        {
          value: 'thread',
          label: 'Тред',
          content: thread ? (
            <ChatThread threadId={thread.threadId} />
          ) : (
            <p className="p-3 text-sm text-text-muted">Нет треда</p>
          ),
        },
      ]}
    />
  );
}

function BodyEditor({ initial, onSave }: { initial: string; onSave: (body: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <textarea
      data-testid="body-edit"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== initial && onSave(value)}
      className="min-h-24 rounded-control border border-line bg-surface p-2 text-sm"
    />
  );
}

function DetailMenu({
  onPin,
  onArchive,
  archived,
}: {
  onPin: () => void;
  onArchive: () => void;
  archived: boolean;
}) {
  return (
    <div className="flex gap-1">
      <Button variant="ghost" onClick={onPin}>
        Закрепить
      </Button>
      <Button variant="ghost" onClick={onArchive}>
        {archived ? 'Разархивировать' : 'Архивировать'}
      </Button>
    </div>
  );
}
