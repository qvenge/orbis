import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { Input } from '../../ui/Input';
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
      {state.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {state.tags.map((t) => (
            <Chip
              key={t}
              onRemove={() => setState((s) => ({ ...s, tags: s.tags.filter((x) => x !== t) }))}
            >
              {t}
            </Chip>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          aria-label="Добавить тег"
          value={tagDraft}
          placeholder="Тег…"
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tagDraft.trim()) {
              setState((s) => ({ ...s, tags: [...s.tags, tagDraft.trim()] }));
              setTagDraft('');
            }
          }}
          className="h-8 flex-1 px-2 py-1 text-xs"
        />
        <Button variant="outline" size="sm" onClick={() => onApply(buildFilterQuery(state))}>
          Применить
        </Button>
      </div>
    </div>
  );
}
