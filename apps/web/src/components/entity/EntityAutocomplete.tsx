import { useState, useCallback, useEffect } from 'react';
import { trpc } from '../../lib/trpc.ts';

interface EntityAutocompleteProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  cursorPos: number;
  onChange: (value: string) => void;
}

export function EntityAutocomplete({ textareaRef, value, cursorPos, onChange }: EntityAutocompleteProps) {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteQuery, setAutocompleteQuery] = useState('');
  const [autocompletePos, setAutocompletePos] = useState({ top: 0, left: 0 });

  const { data: searchResults } = trpc.entity.list.useQuery(
    { search: autocompleteQuery, archived: false, sortBy: 'updated_at', sortOrder: 'desc', limit: 5 },
    { enabled: showAutocomplete && autocompleteQuery.length > 0 },
  );

  // Check for [[ trigger on cursor/value changes
  const checkForTrigger = useCallback(
    (text: string, pos: number) => {
      const textBefore = text.slice(0, pos);
      const bracketIdx = textBefore.lastIndexOf('[[');
      if (bracketIdx !== -1 && !textBefore.slice(bracketIdx).includes(']]')) {
        const query = textBefore.slice(bracketIdx + 2);
        if (query.length >= 0 && !query.includes('\n')) {
          setAutocompleteQuery(query);
          setShowAutocomplete(true);
          if (textareaRef.current) {
            const ta = textareaRef.current;
            const lineHeight = parseInt(getComputedStyle(ta).lineHeight) || 20;
            const lines = textBefore.split('\n');
            const top = lines.length * lineHeight;
            setAutocompletePos({ top: Math.min(top, ta.clientHeight - 100), left: 16 });
          }
          return;
        }
      }
      setShowAutocomplete(false);
    },
    [textareaRef],
  );

  const insertEntityRef = useCallback(
    (entityId: string, title: string) => {
      const textBefore = value.slice(0, cursorPos);
      const bracketIdx = textBefore.lastIndexOf('[[');
      if (bracketIdx === -1) return;

      const before = value.slice(0, bracketIdx);
      const after = value.slice(cursorPos);
      const ref = `[[entity:${entityId}|${title}]]`;
      const newValue = before + ref + after;

      onChange(newValue);
      setShowAutocomplete(false);

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const newPos = bracketIdx + ref.length;
          textareaRef.current.focus();
          textareaRef.current.selectionStart = newPos;
          textareaRef.current.selectionEnd = newPos;
        }
      });
    },
    [value, cursorPos, onChange, textareaRef],
  );

  // Close autocomplete on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAutocomplete(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return { showAutocomplete, autocompletePos, searchResults, checkForTrigger, insertEntityRef };
}

// Dropdown UI component
export function AutocompleteDropdown({
  show,
  pos,
  results,
  query,
  onSelect,
}: {
  show: boolean;
  pos: { top: number; left: number };
  results: Array<{ id: string; title: string }> | undefined;
  query: string;
  onSelect: (id: string, title: string) => void;
}) {
  if (!show) return null;

  return (
    <div
      className="absolute z-10 w-64 overflow-hidden rounded-lg border border-border-light bg-surface-raised shadow-lg"
      style={{ top: pos.top, left: pos.left }}
    >
      {!results?.length ? (
        <p className="px-3 py-2 text-xs text-text-muted">
          {query ? 'No entities found' : 'Type to search...'}
        </p>
      ) : (
        results.map((entity) => (
          <button
            key={entity.id}
            onClick={() => onSelect(entity.id, entity.title)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors duration-150 hover:bg-surface-hover"
          >
            <span className="truncate">{entity.title}</span>
          </button>
        ))
      )}
    </div>
  );
}
