import { useState } from 'react';
import {
  GitBranch,
  Lock,
  Link2,
  ArrowUpRight,
  Plus,
  X,
  Search,
  AlertTriangle,
} from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { useNavigationStore } from '../../stores/navigation.ts';

interface RelationsPanelProps {
  entityId: string;
}

const RELATION_TYPE_CONFIG: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  parent: { label: 'Parent', icon: GitBranch },
  blocks: { label: 'Blocks', icon: Lock },
  related_to: { label: 'Related', icon: Link2 },
  derived_from: { label: 'Derived from', icon: ArrowUpRight },
};

export function RelationsPanel({ entityId }: RelationsPanelProps) {
  const { openEntity } = useNavigationStore();
  const utils = trpc.useUtils();
  const [showAddForm, setShowAddForm] = useState(false);

  const { data } = trpc.relation.forEntityResolved.useQuery({ entityId });

  const createRelation = trpc.relation.create.useMutation({
    onSuccess: () => {
      utils.relation.forEntityResolved.invalidate({ entityId });
      setShowAddForm(false);
    },
  });

  const deleteRelation = trpc.relation.delete.useMutation({
    onSuccess: () => {
      utils.relation.forEntityResolved.invalidate({ entityId });
    },
  });

  if (!data) return null;

  const { relations, backlinks } = data;

  // Group relations by type and direction
  const parents = relations.filter((r) => r.relation_type === 'parent' && r.direction === 'incoming');
  const children = relations.filter((r) => r.relation_type === 'parent' && r.direction === 'outgoing');
  const blockedBy = relations.filter((r) => r.relation_type === 'blocks' && r.direction === 'incoming');
  const blocks = relations.filter((r) => r.relation_type === 'blocks' && r.direction === 'outgoing');
  const related = relations.filter(
    (r) => r.relation_type === 'related_to' || r.relation_type === 'derived_from',
  );

  const hasAny = relations.length > 0 || backlinks.length > 0;

  if (!hasAny && !showAddForm) {
    return (
      <div>
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1 text-xs text-text-muted transition-colors duration-150 hover:text-text-secondary"
        >
          <Plus className="h-3 w-3" /> Add relation
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-muted">Relations</span>
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text-secondary"
        >
          <Plus className="h-3 w-3" /> Link
        </button>
      </div>

      {/* Relation sections */}
      <RelationSection
        title="Parent"
        items={parents}
        onNavigate={openEntity}
        onDelete={(r) => deleteRelation.mutate({ sourceId: r.source_id, targetId: r.target_id, relationType: r.relation_type as any })}
      />
      <RelationSection
        title="Subtasks"
        items={children}
        onNavigate={openEntity}
        onDelete={(r) => deleteRelation.mutate({ sourceId: r.source_id, targetId: r.target_id, relationType: r.relation_type as any })}
      />
      <RelationSection
        title="Blocked by"
        items={blockedBy}
        onNavigate={openEntity}
        onDelete={(r) => deleteRelation.mutate({ sourceId: r.source_id, targetId: r.target_id, relationType: r.relation_type as any })}
      />
      <RelationSection
        title="Blocks"
        items={blocks}
        onNavigate={openEntity}
        onDelete={(r) => deleteRelation.mutate({ sourceId: r.source_id, targetId: r.target_id, relationType: r.relation_type as any })}
      />
      <RelationSection
        title="Related"
        items={related}
        onNavigate={openEntity}
        onDelete={(r) => deleteRelation.mutate({ sourceId: r.source_id, targetId: r.target_id, relationType: r.relation_type as any })}
      />

      {/* Backlinks */}
      {backlinks.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-text-muted">Backlinks</p>
          <div className="space-y-0.5">
            {backlinks.map((bl) => (
              <button
                key={bl.id}
                onClick={() => openEntity(bl.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text"
              >
                <Link2 className="h-3 w-3 shrink-0 text-text-muted" />
                <span className="truncate">{bl.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Add relation form */}
      {showAddForm && (
        <AddRelationForm
          entityId={entityId}
          onAdd={(targetId, relationType) => {
            createRelation.mutate({ sourceId: entityId, targetId, relationType: relationType as any });
          }}
          onCancel={() => setShowAddForm(false)}
          isLoading={createRelation.isPending}
        />
      )}
    </div>
  );
}

interface ResolvedRelation {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  linked_id: string;
  linked_title: string;
  linked_emoji: string | null;
  direction: 'outgoing' | 'incoming';
}

function RelationSection({
  title,
  items,
  onNavigate,
  onDelete,
}: {
  title: string;
  items: ResolvedRelation[];
  onNavigate: (id: string) => void;
  onDelete: (r: ResolvedRelation) => void;
}) {
  if (items.length === 0) return null;

  const config = RELATION_TYPE_CONFIG[items[0].relation_type] ?? { label: title, icon: Link2 };
  const Icon = config.icon;

  return (
    <div>
      <p className="mb-1 flex items-center gap-1 text-xs text-text-muted">
        <Icon className="h-3 w-3" /> {title}
      </p>
      <div className="space-y-0.5">
        {items.map((r) => (
          <div
            key={r.id}
            className="group flex items-center gap-2 rounded-md px-2 py-1 transition-colors duration-150 hover:bg-surface-hover"
          >
            <button
              onClick={() => onNavigate(r.linked_id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-text-secondary hover:text-text"
            >
              <span className="truncate">{r.linked_title}</span>
            </button>
            <button
              onClick={() => onDelete(r)}
              className="hidden shrink-0 rounded p-0.5 text-text-muted hover:bg-surface-hover hover:text-danger group-hover:block"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddRelationForm({
  entityId,
  onAdd,
  onCancel,
  isLoading,
}: {
  entityId: string;
  onAdd: (targetId: string, relationType: string) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const [relationType, setRelationType] = useState('related_to');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cycleWarning, setCycleWarning] = useState(false);

  const { data: searchResults } = trpc.entity.list.useQuery(
    { search, archived: false, sortBy: 'updated_at', sortOrder: 'desc', limit: 5 },
    { enabled: search.length > 0 },
  );

  const { data: cycleCheck } = trpc.relation.checkCycle.useQuery(
    { sourceId: entityId, targetId: selectedId! },
    { enabled: relationType === 'blocks' && selectedId != null },
  );

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setCycleWarning(false);
  };

  const handleSubmit = () => {
    if (!selectedId) return;
    if (relationType === 'blocks' && cycleCheck?.wouldCreateCycle) {
      setCycleWarning(true);
      return;
    }
    onAdd(selectedId, relationType);
  };

  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3 space-y-2">
      {/* Type selector */}
      <select
        value={relationType}
        onChange={(e) => setRelationType(e.target.value)}
        className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text focus:border-primary focus:outline-none"
      >
        <option value="related_to">Related to</option>
        <option value="parent">Parent of (this is subtask)</option>
        <option value="blocks">Blocks</option>
        <option value="derived_from">Derived from</option>
      </select>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2 top-1.5 h-3 w-3 text-text-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setSelectedId(null); }}
          placeholder="Search entity..."
          className="w-full rounded-md border border-border bg-surface py-1 pl-7 pr-2 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
        />
      </div>

      {/* Results */}
      {search && searchResults?.items && (
        <div className="max-h-32 overflow-y-auto">
          {searchResults.items
            .filter((e) => e.id !== entityId)
            .map((entity) => (
              <button
                key={entity.id}
                onClick={() => handleSelect(entity.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors duration-150 ${
                  selectedId === entity.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="truncate">{entity.title}</span>
              </button>
            ))}
        </div>
      )}

      {/* Cycle warning */}
      {cycleWarning && (
        <div className="flex items-center gap-1 text-xs text-danger">
          <AlertTriangle className="h-3 w-3" /> Would create a circular dependency
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={!selectedId || isLoading}
          className="rounded-md bg-primary px-3 py-1 text-xs text-white transition-colors duration-150 hover:bg-primary/80 disabled:opacity-50"
        >
          {isLoading ? 'Adding...' : 'Add'}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1 text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
