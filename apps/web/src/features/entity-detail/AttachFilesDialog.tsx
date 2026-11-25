import { FileFieldControl } from '../../lib/registry/FileFieldControl';
import { Dialog } from '../../ui/Dialog';

export default function AttachFilesDialog({
  entityId,
  value,
  close,
}: {
  entityId: string;
  value: unknown;
  close: () => void;
}) {
  return (
    <Dialog
      open
      title="Вложения"
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <FileFieldControl entityId={entityId} propertyId="orbis/attachments" value={value} many />
    </Dialog>
  );
}
