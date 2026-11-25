import { lazy, Suspense } from 'react';
import { Skeleton } from '../../ui/Skeleton';

const RichMarkdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));
export const VerifiedFileBody = lazy(() => import('./VerifiedFileBody'));

// One plain paragraph has identical markup with or without the Markdown parser.
// Keep the first frame synchronous for this subset. Any Markdown punctuation,
// indentation, URL or line break goes through the full sanitized GFM renderer.
const plainParagraph = /^\p{L}[\p{L}\p{M}\p{N} ,!?…–—]*\.?$/u;

export function MarkdownSlot(props: { source: string; className?: string }) {
  if (plainParagraph.test(props.source)) {
    return (
      <div className={props.className ? `orbis-markdown ${props.className}` : 'orbis-markdown'}>
        <p>{props.source}</p>
      </div>
    );
  }
  return (
    <Suspense fallback={<Skeleton className="h-5 w-3/4" />}>
      <RichMarkdown {...props} />
    </Suspense>
  );
}
