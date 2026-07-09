import { Archive, ArchiveRestore, Pin } from 'lucide-react';
import { useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { QueryBlock } from '../../lib/query-blocks/QueryBlock';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs } from '../../ui/Tabs';
import { firstQueryBlock } from '../browser/query';
import { ChatThread } from '../chat/ChatThread';
import { AspectCards } from './AspectCards';
import { NativeRow } from './NativeRow';
import { Subtasks } from './Subtasks';
import { useEntityDetail } from './useEntityDetail';

export function DetailScreen({ entityId }: { entityId: string }) {
  const { get, toggleTask, saveBody, setArchived, conflict, dismissConflict } =
    useEntityDetail(entityId);
  const utils = trpc.useUtils();
  const settings = trpc.user.getSettings.useQuery();
  const updateSettings = trpc.user.updateSettings.useMutation({
    onSuccess: () => void utils.user.getSettings.invalidate(),
  });

  if (get.isLoading || !get.data) {
    return (
      <>
        <ScreenHeader title="…" />
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-24" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </>
    );
  }
  const { entity, thread } = get.data;
  const block = firstQueryBlock(entity.body ?? '');

  // В шапке — только title; emoji сущности — крупная page-иконка (Notion-style) в строке
  // с заголовком/NativeRow. Нет emoji — ничего не рендерим (без плейсхолдера).
  const entityTab = (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-center gap-3">
        {entity.emoji && (
          <span aria-hidden className="text-3xl leading-none">
            {entity.emoji}
          </span>
        )}
        <div className="flex-1">
          <NativeRow entity={entity} onToggleTask={toggleTask} />
        </div>
      </div>
      {conflict && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-control border border-danger/40 bg-danger/10 px-3 py-2"
        >
          <p className="text-sm text-danger">Изменено в другом месте — обновите.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void get.refetch();
              dismissConflict();
            }}
          >
            Обновить
          </Button>
        </div>
      )}
      {/* key по id, НЕ по updatedAt: refetch после каждого save менял key и ремоунтил
          редактор, стирая текст, набранный за время запроса (а при 409 — ещё и уничтожая
          черновик, который §5.2 предлагает «повторить вручную»). */}
      <BodyEditor key={entity.id} initial={entity.body ?? ''} onSave={saveBody} />
      {block && <QueryBlock body={entity.body ?? ''} />}
      <AspectCards entity={entity} />
      <Subtasks parentId={entity.id} />
    </div>
  );

  return (
    <>
      <ScreenHeader
        title={entity.title}
        actions={
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
        }
      />
      {/* Табы «Сущность/Тред» — под шапкой; контент центрирован, шапка — на всю ширину. */}
      <div className="mx-auto w-full max-w-3xl">
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
      </div>
    </>
  );
}

function BodyEditor({ initial, onSave }: { initial: string; onSave: (body: string) => void }) {
  const [value, setValue] = useState(initial);
  const [serverBody, setServerBody] = useState(initial);

  // Серверный body сменился (наш save или чужая правка): подхватываем его, только если
  // черновик не трогали. Иначе текст пользователя остаётся — о конфликте сообщает баннер
  // выше, и правку есть что повторить.
  if (initial !== serverBody) {
    setServerBody(initial);
    if (value === serverBody) setValue(initial);
  }

  return (
    <textarea
      data-testid="body-edit"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== serverBody && onSave(value)}
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
  const archiveLabel = archived ? 'Разархивировать' : 'Архивировать';
  return (
    <div className="flex gap-1">
      <Button size="icon" variant="ghost" aria-label="Закрепить" title="Закрепить" onClick={onPin}>
        <Pin size={16} aria-hidden />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={archiveLabel}
        title={archiveLabel}
        onClick={onArchive}
      >
        {archived ? <ArchiveRestore size={16} aria-hidden /> : <Archive size={16} aria-hidden />}
      </Button>
    </div>
  );
}
