import type { ExtensionId, PropertyDefinition } from '@orbis/shared';
import type { RouterInputs, RouterOutputs } from '../../../trpc';

export type Entity = RouterOutputs['entity']['get']['entity'];
export type Relation = NonNullable<RouterOutputs['entity']['get']['relations']>[number];
export type ValuesPatch = { props?: Record<string, unknown>; unset?: string[] };
export type RelationKey = RouterInputs['relation']['delete'];
export type PanelCommand =
  | { kind: 'attach'; entityId: string; aspectId: string; patch: ValuesPatch }
  | { kind: 'detach'; entityId: string; aspectId: string }
  | { kind: 'values'; entityId: string; patch: ValuesPatch }
  | { kind: 'createRelation'; entityId: string; key: RelationKey }
  | { kind: 'deleteRelation'; entityId: string; key: RelationKey };
export type CommandOutcome =
  | { kind: 'confirmed'; actionId?: string; consequences?: boolean }
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown'; message: string };
export type RunPanelCommand = (command: PanelCommand) => Promise<CommandOutcome>;
export type Context = {
  readOnly: boolean;
  archived: boolean;
  disabledExtensions: readonly ExtensionId[];
};
/** canSet/canUnset describe generic patches; assignment uses only its shared form. */
export type FieldAccess = {
  canSet: boolean;
  canUnset: boolean;
  editor: 'generic' | 'assignment' | 'navigation' | 'unavailable';
  reason?: string;
};
export type PropertyRow = {
  id: string;
  def?: PropertyDefinition;
  value: unknown;
  present: boolean;
  carrierIds: string[];
  rank: number;
};
/** Special routes never grant generic attach/detach; server rules remain authoritative. */
export type AspectAccess = {
  canAttach: boolean;
  canDetach: boolean;
  route: 'generic' | 'assignment' | 'page' | 'app' | 'readonly';
  reason?: string;
};
