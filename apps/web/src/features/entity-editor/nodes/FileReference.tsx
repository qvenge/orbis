import { FileRef } from '@orbis/shared/doc';
import { type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { FileContent } from '../../../lib/files/FileContent';

function FileReference({ node }: NodeViewProps) {
  const { fileId, label, display } = node.attrs;
  return (
    <NodeViewWrapper as="span" contentEditable={false} data-file-id={fileId}>
      <FileContent id={fileId} label={label} image={display === 'image'} />
    </NodeViewWrapper>
  );
}
export const FileRefWithView = FileRef.extend({
  addNodeView: () => ReactNodeViewRenderer(FileReference),
});
