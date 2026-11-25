import { type BodyDoc, serializeBody } from '@orbis/shared/doc';
import { type ReactNode, useMemo } from 'react';
import { trpc } from '../../trpc';
import { FileMarkdownContext } from './Markdown';

export type FileBodySource = { entityId?: string; source: string; doc?: BodyDoc | null };
export default function VerifiedFileBody({
  entityId,
  source,
  doc,
  children,
}: FileBodySource & { children: (markdown: string) => ReactNode }) {
  // Template lists carry Markdown only. The canonical document owns file occurrences.
  const query = trpc.entity.get.useQuery(
    { id: entityId ?? '', include: ['body', 'bodyDoc'] },
    { enabled: !!entityId && !doc },
  );
  const saved = query.data?.entity;
  const canonical =
    doc ?? (saved?.body === source && saved.bodyFormatVersion === 4 ? saved.bodyDoc : null);
  const projection = useMemo(() => {
    const references = new Map<string, string>();
    if (!canonical) return { markdown: source, references };
    function annotate(node: BodyDoc['doc']): BodyDoc['doc'] {
      if (node.type === 'fileRef' && typeof node.attrs?.fileId === 'string') {
        const token = crypto.randomUUID();
        references.set(token, node.attrs.fileId);
        return { ...node, attrs: { ...node.attrs, fileId: token } };
      }
      return node.content ? { ...node, content: node.content.map(annotate) } : node;
    }
    const marked = annotate(canonical.doc as BodyDoc['doc']);
    return {
      markdown: references.size ? serializeBody({ v: canonical.v, doc: marked }) : source,
      references,
    };
  }, [canonical, source]);
  return (
    <FileMarkdownContext.Provider value={projection.references}>
      {children(projection.markdown)}
    </FileMarkdownContext.Provider>
  );
}
