import { useId } from 'react';
import { trpc } from '../../trpc';
import type { Entity, PanelCommand } from './properties-relations/types';

export type AssignmentDraft = { executor: 'human' | 'agent'; grantId: string; mayClose: boolean };
export function assignmentDraftOf(entity: Entity): AssignmentDraft {
  return {
    executor: entity.props['orbis/executor'] === 'agent' ? 'agent' : 'human',
    grantId: typeof entity.props['orbis/grant'] === 'string' ? entity.props['orbis/grant'] : '',
    mayClose: entity.props['orbis/may_close'] === true,
  };
}
/** Coherent group: human must remove both agent-only values; assignee stays untouched. */
export function assignmentPatch(
  entityId: string,
  draft: AssignmentDraft,
): Extract<PanelCommand, { kind: 'attach' }> {
  return {
    kind: 'attach',
    entityId,
    aspectId: 'orbis/assignment',
    patch:
      draft.executor === 'agent'
        ? {
            props: {
              'orbis/executor': 'agent',
              'orbis/grant': draft.grantId,
              'orbis/may_close': draft.mayClose,
            },
          }
        : { props: { 'orbis/executor': 'human' }, unset: ['orbis/grant', 'orbis/may_close'] },
  };
}
export function assignmentScopeLabel(scope: string): string {
  return scope === 'worker' ? 'исполнитель' : 'полный доступ';
}
/** Shared key deduplicates card summary and fields; human opens no grant request. */
export function useAssignmentGrants(draft: AssignmentDraft) {
  const grants = trpc.oauth.listGrants.useQuery(undefined, { enabled: draft.executor === 'agent' });
  const live = (grants.data ?? []).filter((g) => g.revokedAt === null);
  const revoked =
    grants.data !== undefined && draft.grantId !== '' && !live.some((g) => g.id === draft.grantId);
  return { grants, live, revoked };
}
export function AssignmentFields({
  draft,
  onChange,
  disabled = false,
}: {
  draft: AssignmentDraft;
  onChange: (next: AssignmentDraft) => void;
  disabled?: boolean;
}) {
  const name = useId();
  const selectId = useId();
  const { grants, live, revoked } = useAssignmentGrants(draft);
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-3 text-sm">
      <legend className="sr-only">Исполнитель</legend>
      <div className="flex flex-wrap gap-4">
        {(['human', 'agent'] as const).map((executor) => (
          <label key={executor} className="flex min-h-11 cursor-pointer items-center gap-2">
            <input
              type="radio"
              name={name}
              className="size-4 accent-accent"
              checked={draft.executor === executor}
              onChange={() => onChange({ ...draft, executor })}
            />
            {executor === 'human' ? 'Человек' : 'Агент'}
          </label>
        ))}
      </div>
      {draft.executor === 'agent' && (
        <>
          <label htmlFor={selectId} className="text-text-secondary">
            Доступ агента
          </label>
          <select
            id={selectId}
            value={draft.grantId}
            onChange={(e) => onChange({ ...draft, grantId: e.target.value })}
            className="min-h-11 rounded-control border border-line bg-surface px-3 py-2"
          >
            <option value="">— выберите доступ —</option>
            {draft.grantId && !live.some((g) => g.id === draft.grantId) && (
              <option value={draft.grantId}>
                {draft.grantId}
                {revoked ? ' · отозван' : ' · проверяется'}
              </option>
            )}
            {live.map((g) => (
              <option
                key={g.id}
                value={g.id}
              >{`${g.label} · ${assignmentScopeLabel(g.scope)}${g.connected ? '' : ' · не подключён'}`}</option>
            ))}
          </select>
          {grants.isError && <p role="status">Не удалось прочитать доступы агента</p>}
          {revoked && (
            <p className="text-danger">
              Этот доступ отозван — выберите живой из списка, иначе сервер откажет.
            </p>
          )}
          <label className="flex min-h-11 cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={draft.mayClose}
              onChange={(e) => onChange({ ...draft, mayClose: e.target.checked })}
            />
            Может закрывать сам
          </label>
        </>
      )}
    </fieldset>
  );
}
