import type { Components } from 'react-markdown';

// Custom markdown components for dark theme styling
export const markdownComponents: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="mb-2 mt-4 text-lg font-bold text-text" {...props}>{children}</h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mb-2 mt-3 text-base font-semibold text-text" {...props}>{children}</h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mb-1 mt-2 text-sm font-semibold text-text" {...props}>{children}</h3>
  ),
  p: ({ children, ...props }) => (
    <p className="mb-2 text-sm leading-relaxed text-text" {...props}>{children}</p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 text-sm text-text" {...props}>{children}</ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 text-sm text-text" {...props}>{children}</ol>
  ),
  li: ({ children, ...props }) => (
    <li className="text-sm text-text" {...props}>{children}</li>
  ),
  code: ({ children, className, ...props }) => {
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
  pre: ({ children, ...props }) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-surface" {...props}>{children}</pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote className="mb-2 border-l-2 border-primary/40 pl-3 text-sm italic text-text-secondary" {...props}>
      {children}
    </blockquote>
  ),
  a: ({ children, ...props }) => (
    <a className="text-primary underline decoration-primary/30 hover:decoration-primary" {...props}>
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children, ...props }) => (
    <table className="mb-2 w-full text-sm" {...props}>{children}</table>
  ),
  th: ({ children, ...props }) => (
    <th className="border border-border px-2 py-1 text-left text-xs font-medium text-text-secondary" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border border-border px-2 py-1 text-xs text-text" {...props}>{children}</td>
  ),
  del: ({ children, ...props }) => (
    <del className="text-text-muted" {...props}>{children}</del>
  ),
};

// Regex for [[entity:uuid|Display Text]]
const ENTITY_REF_PATTERN = /\[\[entity:([0-9a-f-]{36})\|([^\]]+)\]\]/g;

// Split text into parts: plain text and entity refs
export function splitWithRefs(text: string): Array<{ type: 'text'; value: string } | { type: 'ref'; id: string; display: string }> {
  const parts: Array<{ type: 'text'; value: string } | { type: 'ref'; id: string; display: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pattern = new RegExp(ENTITY_REF_PATTERN.source, 'g');
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'ref', id: match[1], display: match[2] });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts;
}
