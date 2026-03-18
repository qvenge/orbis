import { useState, useRef, useCallback, useEffect, lazy, Suspense } from 'react';
import { Eye, Pencil } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { findQueryBlocks } from '@orbis/shared';
import { EntityRefChip } from './EntityRefChip.tsx';
import { QueryBlockRenderer } from './QueryBlockRenderer.tsx';
import { EntityAutocomplete, AutocompleteDropdown } from './EntityAutocomplete.tsx';
import { markdownComponents, splitWithRefs } from './markdown-config.tsx';

const Markdown = lazy(() => import('react-markdown'));

interface BodyEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoPreview?: boolean;
}

const markdownFallback = <div className="h-4 animate-pulse rounded bg-surface-hover" />;

export function BodyEditor({ value, onChange, autoPreview }: BodyEditorProps) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [hasAutoSwitched, setHasAutoSwitched] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-switch to preview when autoPreview becomes true
  useEffect(() => {
    if (autoPreview && !hasAutoSwitched) {
      setMode('preview');
      setHasAutoSwitched(true);
    }
  }, [autoPreview, hasAutoSwitched]);

  const {
    showAutocomplete,
    autocompletePos,
    searchResults,
    checkForTrigger,
    insertEntityRef,
  } = EntityAutocomplete({ textareaRef, value, cursorPos, onChange });

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const pos = e.target.selectionStart;
      onChange(newValue);
      setCursorPos(pos);
      checkForTrigger(newValue, pos);
    },
    [onChange, checkForTrigger],
  );

  // Render markdown preview with entity refs and query blocks
  const renderPreview = () => {
    const queryBlocks = findQueryBlocks(value);

    if (queryBlocks.length === 0) {
      return <div className="prose-orbis">{renderMarkdownWithRefs(value)}</div>;
    }

    const elements: React.ReactNode[] = [];
    let lastEnd = 0;

    for (let i = 0; i < queryBlocks.length; i++) {
      const qb = queryBlocks[i];
      if (qb.start > lastEnd) {
        const segment = value.slice(lastEnd, qb.start);
        elements.push(<div key={`md-${i}`} className="prose-orbis">{renderMarkdownWithRefs(segment)}</div>);
      }
      elements.push(<QueryBlockRenderer key={`qb-${i}`} params={qb.params} />);
      lastEnd = qb.end;
    }

    if (lastEnd < value.length) {
      const segment = value.slice(lastEnd);
      elements.push(<div key="md-tail" className="prose-orbis">{renderMarkdownWithRefs(segment)}</div>);
    }

    return <>{elements}</>;
  };

  const renderMarkdownWithRefs = (text: string) => {
    const parts = splitWithRefs(text);
    return parts.map((part, i) => {
      if (part.type === 'ref') {
        return <EntityRefChip key={i} entityId={part.id} displayText={part.display} />;
      }
      return (
        <Suspense key={i} fallback={markdownFallback}>
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {part.value}
          </Markdown>
        </Suspense>
      );
    });
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs font-medium text-text-muted">Notes</label>
        <button
          onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text-secondary"
        >
          {mode === 'edit' ? (
            <>
              <Eye className="h-3 w-3" /> Preview
            </>
          ) : (
            <>
              <Pencil className="h-3 w-3" /> Edit
            </>
          )}
        </button>
      </div>

      {mode === 'edit' ? (
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            placeholder="Write something... Use [[ to link entities"
            rows={8}
            className="block w-full resize-y rounded-md border border-border bg-surface-dim px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />

          <AutocompleteDropdown
            show={showAutocomplete}
            pos={autocompletePos}
            results={searchResults?.items}
            query={value.slice(0, cursorPos).slice(value.slice(0, cursorPos).lastIndexOf('[[') + 2)}
            onSelect={insertEntityRef}
          />
        </div>
      ) : (
        <div className="min-h-[120px] rounded-md border border-border bg-surface-dim px-3 py-2 text-sm text-text">
          {value ? renderPreview() : <p className="text-text-muted">Nothing yet...</p>}
        </div>
      )}
    </div>
  );
}
