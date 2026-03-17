import { useState, useRef, useCallback, useEffect } from 'react';
import { Eye, Pencil } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { findQueryBlocks } from '@orbis/shared';
import { trpc } from '../../lib/trpc.ts';
import { EntityRefChip } from './EntityRefChip.tsx';
import { QueryBlockRenderer } from './QueryBlockRenderer.tsx';

interface BodyEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoPreview?: boolean;
}

// Regex for [[entity:uuid|Display Text]]
const ENTITY_REF_REGEX = /\[\[entity:([0-9a-f-]{36})\|([^\]]+)\]\]/g;

// Split text into parts: plain text and entity refs
function splitWithRefs(text: string): Array<{ type: 'text'; value: string } | { type: 'ref'; id: string; display: string }> {
  const parts: Array<{ type: 'text'; value: string } | { type: 'ref'; id: string; display: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const regex = new RegExp(ENTITY_REF_REGEX.source, 'g');
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'ref', id: match[1], display: match[2] });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts;
}

export function BodyEditor({ value, onChange, autoPreview }: BodyEditorProps) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [hasAutoSwitched, setHasAutoSwitched] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);

  // Auto-switch to preview when autoPreview becomes true (after entity loads)
  useEffect(() => {
    if (autoPreview && !hasAutoSwitched) {
      setMode('preview');
      setHasAutoSwitched(true);
    }
  }, [autoPreview, hasAutoSwitched]);
  const [autocompleteQuery, setAutocompleteQuery] = useState('');
  const [autocompletePos, setAutocompletePos] = useState({ top: 0, left: 0 });
  const [cursorPos, setCursorPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: searchResults } = trpc.entity.list.useQuery(
    { search: autocompleteQuery, archived: false, sortBy: 'updated_at', sortOrder: 'desc', limit: 5 },
    { enabled: showAutocomplete && autocompleteQuery.length > 0 },
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const pos = e.target.selectionStart;
      onChange(newValue);
      setCursorPos(pos);

      // Check for [[ trigger
      const textBefore = newValue.slice(0, pos);
      const bracketIdx = textBefore.lastIndexOf('[[');
      if (bracketIdx !== -1 && !textBefore.slice(bracketIdx).includes(']]')) {
        const query = textBefore.slice(bracketIdx + 2);
        if (query.length >= 0 && !query.includes('\n')) {
          setAutocompleteQuery(query);
          setShowAutocomplete(true);
          // Position dropdown near cursor
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
    [onChange],
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

      // Focus back and set cursor
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const newPos = bracketIdx + ref.length;
          textareaRef.current.focus();
          textareaRef.current.selectionStart = newPos;
          textareaRef.current.selectionEnd = newPos;
        }
      });
    },
    [value, cursorPos, onChange],
  );

  // Close autocomplete on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAutocomplete(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Render markdown preview with entity refs and query blocks
  const renderPreview = () => {
    // First split by query blocks
    const queryBlocks = findQueryBlocks(value);

    if (queryBlocks.length === 0) {
      return <div className="prose-orbis">{renderMarkdownWithRefs(value)}</div>;
    }

    // Interleave markdown sections with query blocks
    const elements: React.ReactNode[] = [];
    let lastEnd = 0;

    for (let i = 0; i < queryBlocks.length; i++) {
      const qb = queryBlocks[i];
      // Render markdown before this query block
      if (qb.start > lastEnd) {
        const segment = value.slice(lastEnd, qb.start);
        elements.push(<div key={`md-${i}`} className="prose-orbis">{renderMarkdownWithRefs(segment)}</div>);
      }
      // Render query block
      elements.push(<QueryBlockRenderer key={`qb-${i}`} params={qb.params} />);
      lastEnd = qb.end;
    }

    // Render remaining markdown
    if (lastEnd < value.length) {
      const segment = value.slice(lastEnd);
      elements.push(<div key="md-tail" className="prose-orbis">{renderMarkdownWithRefs(segment)}</div>);
    }

    return <>{elements}</>;
  };

  // Helper: render markdown with entity refs
  const renderMarkdownWithRefs = (text: string) => {
    const parts = splitWithRefs(text);
    return parts.map((part, i) => {
      if (part.type === 'ref') {
        return <EntityRefChip key={i} entityId={part.id} displayText={part.display} />;
      }
      return (
        <Markdown key={i} remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {part.value}
        </Markdown>
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

          {/* Autocomplete dropdown */}
          {showAutocomplete && (
            <div
              className="absolute z-10 w-64 overflow-hidden rounded-lg border border-border-light bg-surface-raised shadow-lg"
              style={{ top: autocompletePos.top, left: autocompletePos.left }}
            >
              {!searchResults?.items.length ? (
                <p className="px-3 py-2 text-xs text-text-muted">
                  {autocompleteQuery ? 'No entities found' : 'Type to search...'}
                </p>
              ) : (
                searchResults.items.map((entity) => (
                  <button
                    key={entity.id}
                    onClick={() => insertEntityRef(entity.id, entity.title)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors duration-150 hover:bg-surface-hover"
                  >
                    <span className="truncate">{entity.title}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-[120px] rounded-md border border-border bg-surface-dim px-3 py-2 text-sm text-text">
          {value ? renderPreview() : <p className="text-text-muted">Nothing yet...</p>}
        </div>
      )}
    </div>
  );
}

// Custom markdown components for dark theme styling
const markdownComponents = {
  h1: ({ children, ...props }: React.ComponentPropsWithoutRef<'h1'>) => (
    <h1 className="mb-2 mt-4 text-lg font-bold text-text" {...props}>{children}</h1>
  ),
  h2: ({ children, ...props }: React.ComponentPropsWithoutRef<'h2'>) => (
    <h2 className="mb-2 mt-3 text-base font-semibold text-text" {...props}>{children}</h2>
  ),
  h3: ({ children, ...props }: React.ComponentPropsWithoutRef<'h3'>) => (
    <h3 className="mb-1 mt-2 text-sm font-semibold text-text" {...props}>{children}</h3>
  ),
  p: ({ children, ...props }: React.ComponentPropsWithoutRef<'p'>) => (
    <p className="mb-2 text-sm leading-relaxed text-text" {...props}>{children}</p>
  ),
  ul: ({ children, ...props }: React.ComponentPropsWithoutRef<'ul'>) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 text-sm text-text" {...props}>{children}</ul>
  ),
  ol: ({ children, ...props }: React.ComponentPropsWithoutRef<'ol'>) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 text-sm text-text" {...props}>{children}</ol>
  ),
  li: ({ children, ...props }: React.ComponentPropsWithoutRef<'li'>) => (
    <li className="text-sm text-text" {...props}>{children}</li>
  ),
  code: ({ children, className, ...props }: React.ComponentPropsWithoutRef<'code'>) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return (
        <code className="block overflow-x-auto rounded-md bg-surface p-3 text-xs text-text-secondary" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-surface-hover px-1 py-0.5 text-xs text-primary" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-surface" {...props}>{children}</pre>
  ),
  blockquote: ({ children, ...props }: React.ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote className="mb-2 border-l-2 border-primary/40 pl-3 text-sm italic text-text-secondary" {...props}>
      {children}
    </blockquote>
  ),
  a: ({ children, ...props }: React.ComponentPropsWithoutRef<'a'>) => (
    <a className="text-primary underline decoration-primary/30 hover:decoration-primary" {...props}>
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children, ...props }: React.ComponentPropsWithoutRef<'table'>) => (
    <table className="mb-2 w-full text-sm" {...props}>{children}</table>
  ),
  th: ({ children, ...props }: React.ComponentPropsWithoutRef<'th'>) => (
    <th className="border border-border px-2 py-1 text-left text-xs font-medium text-text-secondary" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.ComponentPropsWithoutRef<'td'>) => (
    <td className="border border-border px-2 py-1 text-xs text-text" {...props}>{children}</td>
  ),
  del: ({ children, ...props }: React.ComponentPropsWithoutRef<'del'>) => (
    <del className="text-text-muted" {...props}>{children}</del>
  ),
};
