import {
  APP_NAV,
  type AspectDefinition,
  isExtensionEnabled,
  type PropertyDefinition,
  type RelationRoleDefinition,
} from '@orbis/shared';
import { controlKindOf, writeModeOf } from '../../../lib/registry/controls';
import type { EffectiveRegistry } from '../../../lib/registry/labels';
import type { AspectAccess, Context, Entity, FieldAccess, PropertyRow } from './types';

const byRankId = (a: { rank: number; id: string }, b: { rank: number; id: string }) =>
  a.rank - b.rank || a.id.localeCompare(b.id);

/** Saved values plus declarations of current aspects; scope remains server authority. */
export function propertyRows(entity: Entity, registry: EffectiveRegistry): PropertyRow[] {
  const definitions = new Map(registry.properties.map((def) => [def.id, def]));
  const aspects = new Map(registry.aspects.map((def) => [def.id, def]));
  const carriers = new Map<string, string[]>();
  for (const aspectId of entity.aspects) {
    for (const { propertyId } of aspects.get(aspectId)?.properties ?? []) {
      const ids = carriers.get(propertyId) ?? [];
      if (!ids.includes(aspectId)) ids.push(aspectId);
      carriers.set(propertyId, ids);
    }
  }
  return [...new Set([...Object.keys(entity.props), ...carriers.keys()])]
    .map((id): PropertyRow => {
      const def = definitions.get(id);
      return {
        id,
        def,
        value: entity.props[id],
        present: Object.hasOwn(entity.props, id),
        carrierIds: carriers.get(id) ?? [],
        rank: def?.rank ?? Number.POSITIVE_INFINITY,
      };
    })
    .sort(byRankId);
}

/** Full props dictionary for new free fields, including proposed definitions without activation. */
export function freePropertyDefinitions(
  entity: Entity,
  registry: EffectiveRegistry,
): PropertyDefinition[] {
  const shown = new Set(propertyRows(entity, registry).map((row) => row.id));
  return registry.properties
    .filter(
      (def) =>
        def.storage === 'props' &&
        def.status !== 'deprecated' &&
        def.mergedInto === null &&
        !shown.has(def.id),
    )
    .sort(byRankId);
}

function contextReason(context: Context): string | undefined {
  if (context.readOnly) return 'Только чтение';
  if (context.archived) return 'Запись в архиве';
  return undefined;
}

const assignmentProperties = new Set([
  'orbis/executor',
  'orbis/grant',
  'orbis/may_close',
  'orbis/assignee',
]);

export function propertyAccess(def: PropertyDefinition | undefined, context: Context): FieldAccess {
  const blocked = (reason: string): FieldAccess => ({
    canSet: false,
    canUnset: false,
    editor: 'unavailable',
    reason,
  });
  const reason = contextReason(context);
  if (reason) return blocked(reason);
  if (!def) return blocked('Определение свойства неизвестно');
  if (!isExtensionEnabled(def.module, context.disabledExtensions))
    return blocked('Расширение выключено');
  const mode = writeModeOf(def);
  if (mode !== 'editable')
    return blocked(
      mode === 'computed' ? 'Значение вычисляется' : 'Свойство пишет специальный механизм',
    );
  if (def.storage !== 'props') return blocked('Поле записи правится отдельно');
  if (def.mergedInto !== null) return blocked(`Свойство объединено с ${def.mergedInto}`);
  // Status never grants an independent clear of the coherent assignment group.
  if (assignmentProperties.has(def.id))
    return {
      canSet: false,
      canUnset: false,
      editor: 'assignment',
      reason: 'Назначение правится общей формой',
    };
  if (def.status === 'deprecated')
    return {
      canSet: false,
      canUnset: true,
      editor: 'unavailable',
      reason: 'Свойство устарело; сохранённое значение можно снять',
    };
  if (def.id === APP_NAV) return { canSet: true, canUnset: true, editor: 'navigation' };
  // The new panel supports these list editors in addition to existing scalar controls.
  const list =
    'cardinality' in def.type &&
    def.type.cardinality === 'many' &&
    ['text', 'number', 'decimal', 'ref'].includes(def.type.kind);
  if (!list && controlKindOf(def) === 'readonly')
    return {
      canSet: false,
      canUnset: true,
      editor: 'unavailable',
      reason: 'Для этого типа нет редактора; значение можно снять',
    };
  return { canSet: true, canUnset: true, editor: 'generic' };
}

export function aspectAccess(def: AspectDefinition | undefined, context: Context): AspectAccess {
  const blocked = (reason: string): AspectAccess => ({
    canAttach: false,
    canDetach: false,
    route: 'readonly',
    reason,
  });
  const reason = contextReason(context);
  if (reason) return blocked(reason);
  if (!def) return blocked('Определение аспекта неизвестно');
  if (!isExtensionEnabled(def.module, context.disabledExtensions))
    return blocked('Расширение выключено');
  if (def.service || def.id === 'orbis/supply') return blocked('Служебный аспект');
  const route =
    def.id === 'orbis/assignment'
      ? 'assignment'
      : def.id === 'orbis/page'
        ? 'page'
        : def.id === 'orbis/app'
          ? 'app'
          : 'generic';
  return { canAttach: route === 'generic', canDetach: route === 'generic', route };
}

export function roleAccess(
  def: RelationRoleDefinition | undefined,
  context: Context,
): { canCreate: boolean; canDelete: boolean; reason?: string } {
  const reason =
    contextReason(context) ??
    (!def
      ? 'Определение роли неизвестно'
      : !isExtensionEnabled(def.module, context.disabledExtensions)
        ? 'Расширение выключено'
        : def.constraints.created_by === 'system'
          ? 'Роль пишет специальный механизм'
          : undefined);
  return reason
    ? { canCreate: false, canDelete: false, reason }
    : { canCreate: true, canDelete: true };
}
