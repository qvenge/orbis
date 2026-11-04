import { useRecordLinkController } from '../lib/entity-ref/record-link-controller';

/** @deprecated Use RecordLink for controls or the common controller for imperative adapters. */
export function useOpenRecord(): (id: string) => void {
  return useRecordLinkController().open;
}
