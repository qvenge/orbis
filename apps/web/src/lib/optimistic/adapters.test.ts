import { describe, expect, it } from 'vitest';
import { entityPatchFields, projectEntityResponse } from './adapters';

const changes = entityPatchFields({
  id: 'x',
  title: 'next',
  emoji: null,
  archived: true,
  tags: ['new'],
  props: { keptNull: null, removed: 1 },
  unset: ['removed'],
  aspects: { attach: ['new'], detach: ['old', 'new'] },
});
const fields = (id: string) => (id === 'x' ? changes : []);
const entity = {
  id: 'x',
  title: 'old',
  emoji: 'x',
  archived: false,
  tags: ['old'],
  props: { removed: 2, kept: 4 },
  aspects: ['old'],
  updatedAt: 'server',
  bodyDoc: { doc: 1 },
  bodyRevision: 4,
};
const shown = {
  ...entity,
  title: 'next',
  emoji: null,
  archived: true,
  tags: ['new'],
  props: { kept: 4, keptNull: null },
  aspects: ['new'],
};
const other = { ...entity, id: 'other' };

describe('response projections', () => {
  it('projects both detail forms and embedded backlink records without altering body or metadata', () => {
    const bare = { entity, bodyAction: { id: 'a' }, registryVersion: 'server' };
    const wrapper = {
      ...bare,
      entity: other,
      backlinks: [
        { entity, viaLabel: 'source' },
        { entity: other, viaLabel: 'other' },
      ],
      thread: { messages: [] },
    };
    expect(
      projectEntityResponse([['entity', 'get'], { input: { id: 'x' } }], bare, fields),
    ).toEqual({ ...bare, entity: shown });
    const projected = projectEntityResponse(
      [['entity', 'get'], { input: { id: 'other', include: ['backlinks', 'bodyDoc'] } }],
      wrapper,
      fields,
    ) as typeof wrapper;
    expect(projected.backlinks[0]).toEqual({ entity: shown, viaLabel: 'source' });
    expect(projected.backlinks[1]).toBe(wrapper.backlinks[1]);
    expect(projected.thread).toBe(wrapper.thread);
    expect(projected.backlinks[0]?.entity.bodyDoc).toBe(entity.bodyDoc);
  });

  it('keeps membership, group data, server-derived fields and untouched rows', () => {
    const raw = { rows: [other, entity], freshness: { graph: true } };
    const groups = {
      kind: 'groups',
      ok: true,
      groups: [{ day: 'day', rows: [{ entity, at: { value: 'time' } }] }],
      closedIds: ['server'],
      more: 3,
      today: 'server',
    };
    const projected = projectEntityResponse([['entity', 'query']], raw, fields) as typeof raw;
    expect(projected).toEqual({ ...raw, rows: [other, shown] });
    expect(projected.rows[0]).toBe(other);
    expect(projected.freshness).toBe(raw.freshness);
    expect(
      projectEntityResponse(['query-block', 'all'], { ...raw, kind: 'rows', ok: true }, fields),
    ).toEqual({ ...projected, kind: 'rows', ok: true });
    expect(projectEntityResponse(['query-block', 'all'], groups, fields)).toEqual({
      ...groups,
      groups: [{ day: 'day', rows: [{ entity: shown, at: { value: 'time' } }] }],
    });
    const aggregate = { kind: 'sum', ok: true, sums: [{ value: '2' }] };
    expect(projectEntityResponse(['query-block'], aggregate, fields)).toBe(aggregate);
  });

  it('keeps partial refs partial and never guesses derived completable', () => {
    const ref = {
      id: 'x',
      title: 'old',
      emoji: 'old',
      archived: false,
      completable: { closed: false },
    };
    const raw = [ref, { ...ref, id: 'other' }];
    const projected = projectEntityResponse([['entity', 'resolveRefs']], raw, fields) as typeof raw;
    expect(projected).toEqual([{ ...ref, title: 'next', emoji: null, archived: true }, raw[1]]);
    expect(projected[0]?.completable).toBe(ref.completable);
    const missing = [raw[1]];
    expect(projectEntityResponse([['entity', 'resolveRefs']], missing, fields)).toBe(missing);
  });
});
