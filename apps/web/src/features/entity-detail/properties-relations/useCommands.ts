import { useCallback, useRef } from 'react';
import { runGraphCommand } from '../../../lib/graph-command';
import { invalidateGraphCommand } from '../../../lib/invalidate';
import { useRegistry } from '../../../lib/registry/useRegistry';
import { useGraphUndo } from '../../../lib/useGraphUndo';
import { trpc } from '../../../trpc';
import { useToast } from '../../../ui/toast-store';
import { useDetailedUpdateBatch } from '../../page/useUpdateBatch';
import { detailGetInput } from '../useEntityDetail';
import type { CommandOutcome, PanelCommand, RunPanelCommand, ValuesPatch } from './types';

/** Stable JSON identity: key ordering is irrelevant; absence and ordered arrays are exact. */
function identity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(identity).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${identity(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function patchMatches(props: Record<string, unknown>, patch: ValuesPatch): boolean {
  return (
    Object.entries(patch.props ?? {}).every(
      ([id, value]) => Object.hasOwn(props, id) && identity(props[id]) === identity(value),
    ) && (patch.unset ?? []).every((id) => !Object.hasOwn(props, id))
  );
}
function empty(patch: ValuesPatch): boolean {
  return Object.keys(patch.props ?? {}).length === 0 && (patch.unset ?? []).length === 0;
}
export function usePanelCommands(): {
  run: RunPanelCommand;
  reconcile: (command: PanelCommand) => Promise<'matches' | 'differs' | 'unavailable'>;
} {
  const utils = trpc.useUtils();
  const registry = useRegistry();
  const batch = useDetailedUpdateBatch();
  const undo = useGraphUndo();
  const { show } = useToast();
  const inFlight = useRef(false);
  // Guards hold only identities of unresolved snapshots for this hook lifetime, not writes.
  // A different gesture can proceed; retry needs a successful reread of its own snapshot.
  const uncertain = useRef(new Set<string>());
  const run = useCallback<RunPanelCommand>(
    async (command) => {
      if (inFlight.current) return { kind: 'rejected', message: 'Сохранение уже выполняется' };
      const snapshot = structuredClone(command);
      const commandId = identity(snapshot);
      if (uncertain.current.has(commandId))
        return {
          kind: 'unknown',
          message: 'Не удалось подтвердить сохранение. Проверьте состояние записи',
        };
      inFlight.current = true;
      try {
        let outcome: CommandOutcome;
        let title: string;
        switch (snapshot.kind) {
          case 'values':
            title = 'Сохранены свойства';
            if (empty(snapshot.patch)) {
              show('Нет изменений');
              return { kind: 'confirmed' };
            }
            outcome = await batch(
              [{ tool: 'entity_update', input: { id: snapshot.entityId, ...snapshot.patch } }],
              { action: title },
            );
            break;
          case 'attach':
            title = `Добавлен аспект „${registry.label(snapshot.aspectId)}“`;
            outcome = await batch(
              [
                {
                  tool: 'entity_update',
                  input: {
                    id: snapshot.entityId,
                    aspects: { attach: [snapshot.aspectId] },
                    ...snapshot.patch,
                  },
                },
              ],
              { action: title },
            );
            break;
          case 'detach':
            title = `Снят аспект „${registry.label(snapshot.aspectId)}“`;
            outcome = await batch(
              [
                {
                  tool: 'entity_update',
                  input: { id: snapshot.entityId, aspects: { detach: [snapshot.aspectId] } },
                },
              ],
              { action: title },
            );
            break;
          case 'createRelation':
            title = `Добавлена связь „${registry.label(snapshot.key.role)}“`;
            outcome = await runGraphCommand(() =>
              utils.client.relation.create.mutate(snapshot.key),
            );
            invalidateGraphCommand(utils);
            break;
          case 'deleteRelation':
            title = `Снята связь „${registry.label(snapshot.key.role)}“`;
            outcome = await runGraphCommand(() =>
              utils.client.relation.delete.mutate(snapshot.key),
            );
            invalidateGraphCommand(utils);
            break;
        }
        if (outcome.kind === 'unknown') uncertain.current.add(commandId);
        if (outcome.kind === 'confirmed') {
          if (outcome.actionId) undo(outcome.actionId, title);
          else show(title);
        }
        return outcome;
      } finally {
        inFlight.current = false;
      }
    },
    [batch, utils, registry, undo, show],
  );
  const reconcile = useCallback(
    async (command: PanelCommand): Promise<'matches' | 'differs' | 'unavailable'> => {
      if (inFlight.current) return 'unavailable';
      const snapshot = structuredClone(command);
      const commandId = identity(snapshot);
      try {
        const input = detailGetInput(snapshot.entityId);
        // A read started before the write cannot prove the current state. Cancel that exact
        // key, mark it stale without a duplicate active refetch, then start a new fetch.
        await utils.entity.get.cancel(input);
        await utils.entity.get.invalidate(input, { refetchType: 'none' });
        const current = await utils.entity.get.fetch(input);
        if (
          !current?.entity ||
          current.entity.id !== snapshot.entityId ||
          !current.entity.props ||
          !Array.isArray(current.entity.aspects)
        )
          return 'unavailable';
        let matches: boolean;
        switch (snapshot.kind) {
          case 'values':
            matches = patchMatches(current.entity.props, snapshot.patch);
            break;
          case 'attach':
            matches =
              current.entity.aspects.includes(snapshot.aspectId) &&
              patchMatches(current.entity.props, snapshot.patch);
            break;
          case 'detach':
            matches = !current.entity.aspects.includes(snapshot.aspectId);
            break;
          case 'createRelation':
          case 'deleteRelation': {
            if (!Array.isArray(current.relations)) return 'unavailable';
            const present = current.relations.some(
              (edge) =>
                edge.sourceId === snapshot.key.source_id &&
                edge.targetId === snapshot.key.target_id &&
                edge.role === snapshot.key.role,
            );
            matches = snapshot.kind === 'createRelation' ? present : !present;
            break;
          }
        }
        uncertain.current.delete(commandId);
        return matches ? 'matches' : 'differs';
      } catch {
        return 'unavailable';
      }
    },
    [utils],
  );
  return { run, reconcile };
}
