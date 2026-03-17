import { useEffect, useState, useCallback, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { skipToken } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import { TaskAspectCard } from './TaskAspectCard.tsx';
import { FitnessAspectCard } from './FitnessAspectCard.tsx';
import { NutritionAspectCard } from './NutritionAspectCard.tsx';
import { HabitAspectCard } from './HabitAspectCard.tsx';
import { NoteAspectCard } from './NoteAspectCard.tsx';
import { GoalAspectCard } from './GoalAspectCard.tsx';
import { BodyEditor } from './BodyEditor.tsx';
import { RelationsPanel } from './RelationsPanel.tsx';
import { AddAspectButton } from './AddAspectButton.tsx';

export function EntityDetail() {
  const { selectedEntityId, goBack } = useNavigationStore();
  const utils = trpc.useUtils();

  const { data: entity, isLoading } = trpc.entity.get.useQuery(
    selectedEntityId ? { id: selectedEntityId } : skipToken,
  );

  const updateEntity = trpc.entity.update.useMutation({
    onSuccess: () => {
      utils.entity.get.invalidate({ id: selectedEntityId! });
      utils.entity.list.invalidate();
    },
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Sync local state from server data
  useEffect(() => {
    if (entity) {
      setTitle(entity.title);
      setBody(entity.body ?? '');
      setTags(entity.tags.join(', '));
    }
  }, [entity]);

  const debouncedSave = useCallback(
    (updates: Record<string, unknown>) => {
      if (!selectedEntityId) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        updateEntity.mutate({ id: selectedEntityId, ...updates });
      }, 500);
    },
    [selectedEntityId, updateEntity],
  );

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (value.trim()) debouncedSave({ title: value });
  };

  const handleBodyChange = (value: string) => {
    setBody(value);
    debouncedSave({ body: value });
  };

  const handleTagsBlur = () => {
    const newTags = tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (!selectedEntityId) return;
    updateEntity.mutate({ id: selectedEntityId, tags: newTags });
  };

  const handleAspectChange = (aspectId: string, data: Record<string, unknown>) => {
    if (!entity || !selectedEntityId) return;
    const aspects = { ...(entity.aspects as Record<string, unknown>), [aspectId]: data };
    updateEntity.mutate({ id: selectedEntityId, aspects });
  };

  if (isLoading || !entity) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
      </div>
    );
  }

  const aspects = (entity.aspects ?? {}) as Record<string, Record<string, unknown>>;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button
          onClick={goBack}
          className="rounded-md p-1 text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          type="text"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          className="flex-1 bg-transparent text-lg font-semibold text-text focus:outline-none"
        />
      </div>

      <div className="flex-1 space-y-4 p-4">
        {/* Tags */}
        <div>
          <label className="text-xs font-medium text-text-muted">Tags</label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={handleTagsBlur}
            placeholder="tag1, tag2, tag3"
            className="mt-1 block w-full rounded-md border border-border bg-surface-dim px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>

        {/* Aspect cards */}
        {Object.entries(aspects).map(([key, aspectData]) => {
          const change = (d: Record<string, unknown>) => handleAspectChange(key, d);
          switch (key) {
            case 'orbis/task':
              return <TaskAspectCard key={key} data={aspectData} onChange={change} />;
            case 'orbis/fitness':
              return <FitnessAspectCard key={key} data={aspectData} onChange={change} />;
            case 'orbis/nutrition':
              return <NutritionAspectCard key={key} data={aspectData} onChange={change} />;
            case 'orbis/habit':
              return <HabitAspectCard key={key} data={aspectData} onChange={change} />;
            case 'orbis/note':
              return <NoteAspectCard key={key} data={aspectData} onChange={change} />;
            case 'orbis/goal':
              return <GoalAspectCard key={key} data={aspectData} onChange={change} />;
            default:
              return (
                <div key={key} className="rounded-lg border border-border bg-surface-dim p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                    {key.replace('orbis/', '')}
                  </p>
                  <div className="space-y-1">
                    {Object.entries(aspectData).map(([field, value]) => (
                      <div key={field} className="flex justify-between text-sm">
                        <span className="text-text-muted">{field}</span>
                        <span className="text-text">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
          }
        })}

        {/* Add aspect */}
        <AddAspectButton
          currentAspects={Object.keys(aspects)}
          onAspectAdd={(aspectId, defaultData) => handleAspectChange(aspectId, defaultData)}
        />

        {/* Relations */}
        <RelationsPanel entityId={entity.id} />

        {/* Body */}
        <BodyEditor value={body} onChange={handleBodyChange} autoPreview={body.includes('{{query:')} />
      </div>
    </div>
  );
}
