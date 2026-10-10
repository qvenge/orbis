import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { AssignmentFields, assignmentDraftOf, assignmentPatch } from './assignment-form';
import { entity } from './properties-relations/test-fixtures';

describe('shared assignment form', () => {
  it('reads malformed and absent stored values conservatively', () => {
    expect(assignmentDraftOf(entity)).toEqual({ executor: 'human', grantId: '', mayClose: false });
    expect(
      assignmentDraftOf({
        ...entity,
        props: { 'orbis/executor': 'agent', 'orbis/grant': null, 'orbis/may_close': 1 },
      }),
    ).toEqual({ executor: 'agent', grantId: '', mayClose: false });
  });
  it.each([false, true])('agent patch is one coherent attach, mayClose=%s', (mayClose) => {
    expect(
      assignmentPatch(entity.id, { executor: 'agent', grantId: 'grant-id', mayClose }),
    ).toEqual({
      kind: 'attach',
      entityId: entity.id,
      aspectId: 'orbis/assignment',
      patch: {
        props: {
          'orbis/executor': 'agent',
          'orbis/grant': 'grant-id',
          'orbis/may_close': mayClose,
        },
      },
    });
  });
  it('human explicitly unsets both agent fields, without assignee or task', () => {
    expect(
      assignmentPatch(entity.id, { executor: 'human', grantId: 'old', mayClose: true }),
    ).toEqual({
      kind: 'attach',
      entityId: entity.id,
      aspectId: 'orbis/assignment',
      patch: { props: { 'orbis/executor': 'human' }, unset: ['orbis/grant', 'orbis/may_close'] },
    });
  });
  it('queries grants only for agent and writes only controlled draft', async () => {
    function Host() {
      const [draft, onChange] = useState(assignmentDraftOf(entity));
      return <AssignmentFields draft={draft} onChange={onChange} disabled={false} />;
    }
    const result = renderWithProviders(<Host />, (path) => (path === 'oauth.listGrants' ? [] : {}));
    expect(result.calls).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Агент'));
    await waitFor(() =>
      expect(result.calls.filter((c) => c.path === 'oauth.listGrants')).toHaveLength(1),
    );
    fireEvent.click(screen.getByLabelText('Может закрывать сам'));
    expect(screen.getByLabelText('Может закрывать сам')).toBeChecked();
    expect(
      result.calls.some((c) => c.path === 'entity.update' || c.path === 'ai.updateBatch'),
    ).toBe(false);
  });
  it('retains unavailable grant id visibly and disables every field', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <AssignmentFields
        draft={{ executor: 'agent', grantId: 'old-grant', mayClose: true }}
        onChange={onChange}
        disabled
      />,
      (path) => (path === 'oauth.listGrants' ? [] : {}),
    );
    await screen.findByText(/Этот доступ отозван/);
    expect(screen.getByLabelText('Доступ агента')).toHaveValue('old-grant');
    for (const input of screen.getAllByRole('radio')) expect(input).toBeDisabled();
    expect(screen.getByLabelText('Доступ агента')).toBeDisabled();
    expect(screen.getByLabelText('Может закрывать сам')).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
