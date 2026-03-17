interface SuggestionChipsProps {
  suggestions: string[];
  onSelect: (text: string) => void;
}

export function SuggestionChips({ suggestions, onSelect }: SuggestionChipsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {suggestions.map((s) => (
        <button
          key={s}
          onClick={() => onSelect(s)}
          className="rounded-full border border-border-light bg-transparent px-3 py-1 text-xs text-text-secondary transition-colors duration-150 hover:border-primary hover:text-primary"
        >
          {s}
        </button>
      ))}
    </div>
  );
}
