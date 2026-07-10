import { Search } from 'lucide-react';
import { useState } from 'react';
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

// Тихая строка фильтра (Notion): без рамок и отдельной кнопки — тег применяется
// сразу по Enter, снятие чипа тоже сразу пересобирает запрос.
export function Filters({ onApply }: { onApply: (query: string) => void }) {
  const [state, setState] = useState<FilterState>(EMPTY);
  const [tagDraft, setTagDraft] = useState('');

  function apply(next: FilterState) {
    setState(next);
    onApply(buildFilterQuery(next));
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-1 pt-3">
      <Search size={14} aria-hidden className="shrink-0 text-text-muted" />
      <input
        aria-label="Добавить тег"
        value={tagDraft}
        placeholder="Фильтр по тегу…"
        onChange={(e) => setTagDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: Enter-подтверждение IME не добавляет тег; дубликат тега — no-op.
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && tagDraft.trim()) {
            const tag = tagDraft.trim();
            if (!state.tags.includes(tag)) apply({ ...state, tags: [...state.tags, tag] });
            setTagDraft('');
          }
        }}
        className="min-w-32 flex-1 rounded-md bg-transparent px-1 py-1 text-sm text-text outline-none transition placeholder:text-text-muted focus-visible:bg-surface-2/70"
      />
      {state.tags.map((t) => (
        <Chip key={t} onRemove={() => apply({ ...state, tags: state.tags.filter((x) => x !== t) })}>
          {t}
        </Chip>
      ))}
    </div>
  );
}
