import type { PropertyDefinition } from '@orbis/shared';
import { type DraftValue, parseDraftValue } from '../../../lib/registry/draft-value';
import type { EffectiveRegistry } from '../../../lib/registry/labels';
import { aspectAccess, propertyAccess, roleAccess } from './metadata';
import type { Context, Entity, ValuesPatch } from './types';

type Baseline = { present: boolean; value: unknown };
export type PanelDraft = {
  entityId: string;
  registryVersion: string;
  editor:
    | { kind: 'values' }
    | { kind: 'attach'; aspectId: string }
    | { kind: 'assignment' }
    | { kind: 'relation'; roleId: string; side: 'source' | 'target'; otherId?: string };
  observedContext: Context;
  latestEntity: Entity;
  latestRegistry: EffectiveRegistry;
  editorDefinitionFingerprint: string;
  editorMetadataChanged: boolean;
  editorAccessReason?: string;
  fields: Record<
    string,
    {
      input: DraftValue;
      baseline: Baseline;
      definitionFingerprint: string;
      conflict: boolean;
      metadataChanged: boolean;
      accessReason?: string;
    }
  >;
};
// Preserve JSON values exactly: object order is immaterial, array order and IDs are not.
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
}
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyValue(item)]));
  return value;
}
function baseline(entity: Entity, id: string): Baseline {
  return { present: Object.hasOwn(entity.props, id), value: copyValue(entity.props[id]) };
}
function sameBaseline(a: Baseline, b: Baseline): boolean {
  return a.present === b.present && equal(a.value, b.value);
}
function contextCopy(context: Context): Context {
  return { ...context, disabledExtensions: [...context.disabledExtensions] };
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]),
    );
  return value;
}
function fingerprint(value: unknown): string {
  return JSON.stringify(ordered(value)) ?? 'missing';
}
function definition(registry: EffectiveRegistry, id: string): PropertyDefinition | undefined {
  return registry.properties.find((def) => def.id === id);
}
function propertyFingerprint(def: PropertyDefinition | undefined): string {
  return fingerprint(
    def && {
      type: def.type,
      status: def.status,
      flags: def.flags,
      module: def.module,
      storage: def.storage,
      mergedInto: def.mergedInto,
    },
  );
}
function selectedDefinition(registry: EffectiveRegistry, editor: PanelDraft['editor']) {
  if (editor.kind === 'attach') return registry.aspects.find((def) => def.id === editor.aspectId);
  if (editor.kind === 'relation') return registry.roles.find((def) => def.id === editor.roleId);
  return undefined;
}
function editorFingerprint(registry: EffectiveRegistry, editor: PanelDraft['editor']): string {
  const def = selectedDefinition(registry, editor);
  if (!def) return 'missing';
  // Presentation edits can refresh labels without forcing a new selection.
  const { label: _label, description: _description, rank: _rank, ...semantics } = def;
  return fingerprint(semantics);
}
function editorReason(
  registry: EffectiveRegistry,
  editor: PanelDraft['editor'],
  context: Context,
): string | undefined {
  if (context.readOnly) return 'Только чтение';
  if (context.archived) return 'Запись в архиве';
  if (editor.kind === 'relation') {
    const access = roleAccess(
      registry.roles.find((def) => def.id === editor.roleId),
      context,
    );
    return access.canCreate ? undefined : access.reason;
  }
  if (editor.kind === 'attach' || editor.kind === 'assignment') {
    const id = editor.kind === 'attach' ? editor.aspectId : 'orbis/assignment';
    const access = aspectAccess(
      registry.aspects.find((def) => def.id === id),
      context,
    );
    const allowed = editor.kind === 'assignment' ? access.route === 'assignment' : access.canAttach;
    return allowed ? undefined : (access.reason ?? 'Аспект правится специальным редактором');
  }
  return undefined;
}
function fieldReason(
  def: PropertyDefinition | undefined,
  editor: PanelDraft['editor'],
  input: DraftValue,
  context: Context,
): string | undefined {
  const access = propertyAccess(def, context);
  // These generic flags deliberately do not grant independent assignment writes.
  // Only the shared assignment form can submit its coherent group; the server validates it.
  if (editor.kind === 'assignment') {
    if (access.editor !== 'assignment')
      return access.reason ?? 'Это поле не относится к форме назначения';
    if (input.kind !== 'unset' && def?.status === 'deprecated')
      return 'Свойство устарело; новое значение записать нельзя';
    return undefined;
  }
  if (editor.kind === 'relation') return 'Редактор связи не меняет свойства';
  const allowed = input.kind === 'unset' ? access.canUnset : access.canSet;
  return allowed ? undefined : (access.reason ?? 'Изменение свойства недоступно');
}
const metadataReason =
  'Определение изменилось. Перечитать определение или отменить правку поля; старый ввод не переносится в новый тип';
const selectionReason = 'Определение изменилось. Выберите аспект или роль повторно';

export function startDraft(
  entity: Entity,
  registry: EffectiveRegistry,
  editor: PanelDraft['editor'],
  context: Context,
): PanelDraft {
  return {
    entityId: entity.id,
    registryVersion: registry.version,
    editor: { ...editor },
    observedContext: contextCopy(context),
    latestEntity: entity,
    latestRegistry: registry,
    editorDefinitionFingerprint: editorFingerprint(registry, editor),
    editorMetadataChanged: false,
    editorAccessReason: editorReason(registry, editor, context),
    fields: {},
  };
}
export function editField(draft: PanelDraft, id: string, input: DraftValue): PanelDraft {
  const previous = draft.fields[id];
  const def = definition(draft.latestRegistry, id);
  const state = previous ?? {
    baseline: baseline(draft.latestEntity, id),
    definitionFingerprint: propertyFingerprint(def),
    conflict: false,
    metadataChanged: false,
  };
  return {
    ...draft,
    fields: {
      ...draft.fields,
      [id]: {
        ...state,
        input,
        accessReason: fieldReason(def, draft.editor, input, draft.observedContext),
      },
    },
  };
}
export function observeDraft(
  draft: PanelDraft,
  entity: Entity,
  registry: EffectiveRegistry,
  context: Context,
): PanelDraft {
  if (entity.id !== draft.entityId) return draft;
  const fields = Object.fromEntries(
    Object.entries(draft.fields).map(([id, state]) => {
      const def = definition(registry, id);
      return [
        id,
        {
          ...state,
          conflict: state.conflict || !sameBaseline(state.baseline, baseline(entity, id)),
          metadataChanged:
            state.metadataChanged || state.definitionFingerprint !== propertyFingerprint(def),
          accessReason: fieldReason(def, draft.editor, state.input, context),
        },
      ];
    }),
  );
  return {
    ...draft,
    fields,
    latestEntity: entity,
    latestRegistry: registry,
    registryVersion: registry.version,
    observedContext: contextCopy(context),
    editorMetadataChanged:
      draft.editorMetadataChanged ||
      draft.editorDefinitionFingerprint !== editorFingerprint(registry, draft.editor),
    editorAccessReason: editorReason(registry, draft.editor, context),
  };
}
/** Returning to untouched state is the explicit reset required before changing controls. */
export function acceptRemote(draft: PanelDraft, id: string): PanelDraft {
  if (!Object.hasOwn(draft.fields, id)) return draft;
  const fields = { ...draft.fields };
  delete fields[id];
  return { ...draft, fields };
}
/** Acknowledges remote value only; it never acknowledges a changed definition. */
export function keepLocal(draft: PanelDraft, id: string): PanelDraft {
  const state = draft.fields[id];
  if (!state) return draft;
  return {
    ...draft,
    fields: {
      ...draft.fields,
      [id]: { ...state, baseline: baseline(draft.latestEntity, id), conflict: false },
    },
  };
}
export function buildPatch(
  draft: PanelDraft,
  registry: EffectiveRegistry,
  context: Context,
): { ok: true; patch: ValuesPatch } | { ok: false; errors: Record<string, string> } {
  const failures: [string, string][] = [];
  const props: [string, unknown][] = [];
  const unset: string[] = [];
  const editorBlock = editorReason(registry, draft.editor, context);
  if (
    draft.editorMetadataChanged ||
    draft.editorDefinitionFingerprint !== editorFingerprint(registry, draft.editor)
  )
    failures.push(['$editor', selectionReason]);
  else if (editorBlock) failures.push(['$editor', editorBlock]);
  for (const [id, state] of Object.entries(draft.fields)) {
    const def = definition(registry, id);
    const reason = state.conflict
      ? 'Значение изменилось. Принять новое или оставить мой ввод'
      : state.metadataChanged || state.definitionFingerprint !== propertyFingerprint(def)
        ? metadataReason
        : fieldReason(def, draft.editor, state.input, context);
    if (reason) {
      failures.push([id, reason]);
      continue;
    }
    // The availability guard above forbids unknown definitions, including explicit clear.
    if (!def) {
      failures.push([id, 'Определение свойства неизвестно']);
      continue;
    }
    const parsed = parseDraftValue(def, state.input);
    if (!parsed.ok) failures.push([id, parsed.message]);
    else if ('unset' in parsed) unset.push(id);
    else props.push([id, parsed.value]);
  }
  if (failures.length) return { ok: false, errors: Object.fromEntries(failures) };
  const patch: ValuesPatch = {};
  if (props.length) patch.props = Object.fromEntries(props);
  if (unset.length) patch.unset = unset;
  return { ok: true, patch };
}
