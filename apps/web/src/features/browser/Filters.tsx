import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { buildFilterQuery, type FilterState } from './query';

const EMPTY: FilterState = {
  tags: [],
  aspects: [],
  status: null,
  priority: null,
  createdFrom: null,
  createdTo: null,
};

export function Filters({ onApply }: { onApply: (query: string) => void }) {
  const [state, setState] = useState<FilterState>(EMPTY);
  const [tagDraft, setTagDraft] = useState('');
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap gap-1">
        {state.tags.map((t) => (
          <Chip
            key={t}
            onRemove={() => setState((s) => ({ ...s, tags: s.tags.filter((x) => x !== t) }))}
          >
            {t}
          </Chip>
        ))}
        <input
          aria-label="Добавить тег"
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tagDraft.trim()) {
              setState((s) => ({ ...s, tags: [...s.tags, tagDraft.trim()] }));
              setTagDraft('');
            }
          }}
          className="rounded-control border border-line bg-surface px-2 py-1 text-xs"
        />
      </div>
      <Button variant="primary" onClick={() => onApply(buildFilterQuery(state))}>
        Применить
      </Button>
    </div>
  );
}
