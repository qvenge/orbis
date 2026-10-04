import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import { type GraphId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, ensureGraphs, mintGraph, personal } from '../../test/helpers';
import { rollbackRun } from '../agent-loop/rollback';
import { DEFINITION_TABLES } from '../db/reset-world';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { actionsTouchingAfter, findAction } from '../executor/journal-read';
import type { ExecuteOk } from '../executor/types';
import { undoAction } from '../executor/undo';
import { approvePending } from '../policy/pending';
import { agentLoopHelpers } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import type { MergeInverse } from './ops';

const { db, client } = appDb();
const { db: admin, client: adminClient } = adminDb();
const graphs: GraphId[] = [];
const sink = makeJournalSink();
function recordFixture(g: GraphId) {
  graphs.push(g);
  const dir = process.env.ORBIS_TEST_AUDIT_DIR;
  if (dir) {
    fs.writeFileSync(`${dir}/merge-active-graphs.json`, JSON.stringify(graphs));
    fs.appendFileSync(
      `${dir}/merge-fixtures-${process.env.ORBIS_TEST_AUDIT_ATTEMPT ?? 'standalone'}.jsonl`,
      `${JSON.stringify({ id: g, beforeCreation: true })}\n`,
    );
  }
}
afterAll(async () => {
  try {
    await admin.transaction(async (tx) => {
      for (const g of graphs) {
        await tx.execute(
          sql`DELETE FROM chat_messages m USING chat_threads t WHERE m.thread_id=t.id AND t.graph_id=${g}::uuid`,
        );
        await tx.execute(
          sql`DELETE FROM relations WHERE source_id IN (SELECT id FROM entities WHERE graph_id=${g}::uuid) OR target_id IN (SELECT id FROM entities WHERE graph_id=${g}::uuid)`,
        );
        for (const table of [
          'chat_threads',
          'action_journal_entities',
          'action_journal',
          'entity_versions',
          'entity_origins',
          'registry_deltas',
          ...DEFINITION_TABLES,
          'entities',
          'user_settings',
          'graph_members',
        ])
          await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE graph_id=${g}::uuid`);
        await tx.execute(sql`DELETE FROM graphs WHERE id=${g}::uuid`);
      }
    });
    const remaining = await admin.execute(
      sql`SELECT count(*)::int AS n FROM graphs WHERE id IN (${sql.join(
        graphs.map((g) => sql`${g}::uuid`),
        sql`, `,
      )})`,
    );
    expect(remaining[0]?.n).toBe(0);
    console.log(
      JSON.stringify({
        fixtureCleanup: graphs.length,
        ids: graphs,
        remainingGraphs: remaining[0]?.n,
      }),
    );
  } finally {
    await client.end();
    await adminClient.end();
  }
});
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
async function run(g: GraphId, tool: string, input: unknown): Promise<ExecuteOk> {
  const r = await execute(
    db,
    { identity: personal(g), actorKind: 'owner', source: 'ui', operations: [{ tool, input }] },
    { sink },
  );
  if (!r.ok) throw new Error(r.error.message);
  return r;
}
async function properties(g: GraphId) {
  const source = await run(g, 'property_create', {
    key: 'user/old',
    label: { ru: 'Old' },
    description: { ru: 'Old' },
    type: { kind: 'number' },
    status: 'active',
  });
  const into = await run(g, 'property_create', {
    key: 'user/new',
    label: { ru: 'New' },
    description: { ru: 'New' },
    type: { kind: 'number' },
    status: 'active',
  });
  return {
    source: String((source.results[0] as { property: string }).property),
    into: String((into.results[0] as { property: string }).property),
  };
}
async function row(g: GraphId, id: string) {
  return must(
    (
      await withIdentity(db, personal(g), (tx) =>
        tx.execute(
          sql`SELECT props,body,body_doc,body_refs,query_refs,body_revision,body_action_id,updated_at FROM entities WHERE id=${id}::uuid`,
        ),
      )
    )[0],
  );
}
for (const foreign of [false, true])
  test(`approved routine props-only merge rollback foreign=${foreign}`, async () => {
    const g = mintGraph(newId());
    recordFixture(g);
    await ensureGraphs([g]);
    const { source, into } = await properties(g);
    const holder = newId();
    await run(g, 'entity_create', {
      id: holder,
      title: 'holder',
      tags: [],
      props: { [source]: 10 },
    });
    const h = agentLoopHelpers(db);
    const routineId = await h.seedRoutine(g, {
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['property_merge'] },
    });
    const { runId } = await h.seedRoutineRun(g, { routineId });
    const deferred = await dispatchTool(
      h.routineCtx(g, 'act', ['property_merge'], {
        routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['property_merge']) },
      }),
      'property_merge',
      { source, into },
    );
    expect(deferred.status).toBe('pending_confirmation');
    if (deferred.status !== 'pending_confirmation') throw new Error(JSON.stringify(deferred));
    const approved = await approvePending(db, {
      identity: personal(g),
      pendingId: deferred.pendingId,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error(approved.error.message);
    expect((await row(g, holder)).props).toEqual({ [into]: 10 });
    const late = foreign
      ? await run(g, 'entity_update', { id: holder, props: { [into]: 99 } })
      : null;
    const out = await rollbackRun(db, { identity: personal(g), runId });
    expect(out.ok).toBe(!foreign);
    if (foreign) {
      if (out.ok || out.reason !== 'conflict') throw new Error(JSON.stringify(out));
      expect(out.conflicts.map((c) => [c.entityId, c.actionId])).toContainEqual([
        holder,
        must(late ?? undefined).actionId,
      ]);
      expect((await row(g, holder)).props).toEqual({ [into]: 99 });
      const undos = await admin.execute(
        sql`SELECT id FROM action_journal WHERE graph_id=${g}::uuid AND type='undo'`,
      );
      expect(undos).toHaveLength(0);
      const direct = await undoAction(db, { identity: personal(g), actionId: approved.actionId });
      expect(direct.ok).toBe(true);
      expect((await row(g, holder)).props).toEqual({ [source]: 10 });
    } else expect((await row(g, holder)).props).toEqual({ [source]: 10 });
  });

for (const mode of [
  'stale',
  'json-order',
  'changed',
  'legacy-null',
  'consistent',
  'late-typing',
] as const)
  test(`merge holder write ownership ${mode}`, async () => {
    const g = mintGraph(newId());
    recordFixture(g);
    await ensureGraphs([g]);
    const { source, into } = await properties(g);
    const holder = newId();
    const changed = mode === 'changed' || mode === 'legacy-null';
    await run(g, 'entity_create', {
      id: holder,
      title: 'holder',
      tags: [],
      body: changed ? '{{query:user/old=5}}' : 'unchanged',
    });
    if (mode !== 'consistent')
      await admin.execute(
        sql`UPDATE entities SET query_refs=ARRAY[${source}],body_refs=ARRAY[${newId()}],updated_at='2020-01-01'::timestamptz WHERE id=${holder}::uuid`,
      );
    if (mode === 'legacy-null')
      await admin.execute(sql`UPDATE entities SET body_doc=NULL WHERE id=${holder}::uuid`);
    if (mode === 'json-order')
      await admin.execute(
        sql`UPDATE entities SET body_doc=jsonb_build_object('doc',body_doc->'doc','v',body_doc->'v') WHERE id=${holder}::uuid`,
      );
    const before = await row(g, holder);
    const merged = await run(g, 'property_merge', { source, into });
    const journal = await admin.execute(
      sql`SELECT inverse,body_before FROM action_journal WHERE graph_id=${g}::uuid AND id=${merged.actionId}::uuid`,
    );
    const inverse = must(
      (journal[0]?.inverse as Array<{ payload: { bodies: unknown[] } }>)[0],
    ).payload;
    expect(inverse.bodies).toHaveLength(changed ? 1 : 0);
    const after = await row(g, holder);
    if (changed) {
      expect(Number(after.body_revision)).toBe(Number(before.body_revision) + 1);
      expect(after.query_refs).toEqual([into]);
      expect(after.body_refs).toEqual([]);
    } else {
      expect(after).toEqual(before);
      expect(journal[0]?.body_before).toEqual({});
    }
    if (mode === 'late-typing') {
      await run(g, 'entity_update', {
        id: holder,
        body: 'foreign typing',
        expectedBodyRevision: Number(after.body_revision),
      });
      expect((await undoAction(db, { identity: personal(g), actionId: merged.actionId })).ok).toBe(
        true,
      );
      expect((await row(g, holder)).body).toBe('foreign typing');
    } else {
      expect((await undoAction(db, { identity: personal(g), actionId: merged.actionId })).ok).toBe(
        true,
      );
      const undone = await row(g, holder);
      for (const key of ['body', 'body_doc', 'body_refs', 'query_refs'])
        expect(undone[key]).toEqual(before[key]);
    }
  });

for (const mode of [
  'edit',
  'remove',
  'legacy-edit',
  'legacy-unrelated',
  'legacy-none',
  'legacy-foreign',
  'unrelated',
  'none',
  'malformed-target',
] as const)
  test(`merge delta rollback target ${mode}`, async () => {
    const g = mintGraph(newId());
    recordFixture(g);
    await ensureGraphs([g]);
    const { source, into } = await properties(g);
    await run(g, 'rule_set', {
      target: { aspect: 'orbis/task' },
      rule: {
        id: 'merged_default',
        template: 'default',
        params: { property: source, value: { const: 5 } },
      },
    });
    const h = agentLoopHelpers(db);
    const routineId = await h.seedRoutine(g, {
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['property_merge'] },
    });
    const { runId } = await h.seedRoutineRun(g, { routineId });
    const pending = await dispatchTool(
      h.routineCtx(g, 'act', ['property_merge'], {
        routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['property_merge']) },
      }),
      'property_merge',
      { source, into },
    );
    if (pending.status !== 'pending_confirmation') throw new Error(JSON.stringify(pending));
    const approved = await approvePending(db, {
      identity: personal(g),
      pendingId: pending.pendingId,
    });
    if (!approved.ok) throw new Error(approved.error.message);
    const [j] = await admin.execute(
      sql`SELECT inverse FROM action_journal WHERE graph_id=${g}::uuid AND id=${approved.actionId}::uuid`,
    );
    const original = must(j).inverse as Array<{
      op: string;
      payload: { deltas: Array<{ id: string; target?: unknown; delta: unknown }> };
    }>;
    expect(original[0]?.payload.deltas).toHaveLength(1);
    if (!mode.startsWith('legacy'))
      expect(original[0]?.payload.deltas[0]?.target).toEqual({ kind: 'aspect', id: 'orbis/task' });
    if (mode.startsWith('legacy') || mode === 'malformed-target') {
      const old = structuredClone(original);
      const delta = must(must(old[0]).payload.deltas[0]);
      if (mode.startsWith('legacy')) delete delta.target;
      else delta.target = { kind: 'imaginary', id: 'orbis/task' };
      await admin.execute(
        sql`UPDATE action_journal SET inverse=${JSON.stringify(old)}::jsonb WHERE graph_id=${g}::uuid AND id=${approved.actionId}::uuid`,
      );
    }
    const unrelated = mode === 'unrelated' || mode === 'legacy-unrelated';
    let late =
      mode === 'none' ||
      mode === 'legacy-none' ||
      mode === 'legacy-foreign' ||
      mode === 'malformed-target'
        ? null
        : mode === 'remove'
          ? await run(g, 'rule_remove', {
              target: { aspect: 'orbis/task' },
              rule: 'merged_default',
            })
          : await run(g, 'aspect_delta_set', {
              aspect: unrelated ? 'orbis/financial' : 'orbis/task',
              delta: { icon: 'late owner' },
            });
    if (mode === 'remove')
      expect(
        await admin.execute(
          sql`SELECT id FROM registry_deltas WHERE graph_id=${g}::uuid AND target_id='orbis/task'`,
        ),
      ).toHaveLength(0);
    if (mode === 'legacy-foreign') {
      const other = await run(g, 'property_create', {
          key: 'user/other',
          label: { ru: 'Other' },
          description: { ru: 'Other' },
          type: { kind: 'number' },
          status: 'active',
        }),
        last = await run(g, 'property_create', {
          key: 'user/last',
          label: { ru: 'Last' },
          description: { ru: 'Last' },
          type: { kind: 'number' },
          status: 'active',
        });
      const z = String((other.results[0] as { property: string }).property),
        q = String((last.results[0] as { property: string }).property);
      await run(g, 'rule_set', {
        target: { aspect: 'orbis/financial' },
        rule: {
          id: 'other_default',
          template: 'default',
          params: { property: z, value: { const: 7 } },
        },
      });
      late = await run(g, 'property_merge', { source: z, into: q });
    }
    const out = await rollbackRun(db, { identity: personal(g), runId });
    if (mode === 'none' || mode === 'legacy-none' || mode === 'unrelated')
      expect(out.ok).toBe(true);
    else if (mode === 'malformed-target') {
      expect(out.ok).toBe(false);
      if (out.ok || out.reason !== 'partial') throw new Error(JSON.stringify(out));
      expect(out.undone).toEqual([]);
    } else {
      expect(out.ok).toBe(false);
      if (out.ok || out.reason !== 'conflict') throw new Error(JSON.stringify(out));
      expect(out.conflicts.some((c) => c.actionId === late?.actionId)).toBe(true);
      expect(out.conflicts.some((c) => c.entityId.startsWith('rollback:'))).toBe(false);
      expect(new Set(out.conflicts.map((c) => `${c.entityId}/${c.actionId}`)).size).toBe(
        out.conflicts.length,
      );
      if (mode === 'edit' || mode === 'remove')
        expect(out.conflicts.map((c) => c.entityId)).toEqual(['orbis/task']);
      if (mode.startsWith('legacy'))
        expect(out.conflicts.map((c) => c.entityId)).toContain(original[0]?.payload.deltas[0]?.id);
      expect(
        await admin.execute(
          sql`SELECT id FROM action_journal WHERE graph_id=${g}::uuid AND type='undo'`,
        ),
      ).toHaveLength(0);
    }
  });
test('foreign nested merge shares a props-only holder with disjoint property names', async () => {
  const g = mintGraph(newId());
  recordFixture(g);
  await ensureGraphs([g]);
  const { source, into } = await properties(g);
  const other = await run(g, 'property_create', {
    key: 'user/other',
    label: { ru: 'Other' },
    description: { ru: 'Other' },
    type: { kind: 'number' },
    status: 'active',
  });
  const last = await run(g, 'property_create', {
    key: 'user/last',
    label: { ru: 'Last' },
    description: { ru: 'Last' },
    type: { kind: 'number' },
    status: 'active',
  });
  const z = String((other.results[0] as { property: string }).property),
    q = String((last.results[0] as { property: string }).property),
    holder = newId();
  await run(g, 'entity_create', {
    id: holder,
    title: 'holder',
    tags: [],
    props: { [source]: 10, [z]: 7 },
  });
  const h = agentLoopHelpers(db);
  const routineId = await h.seedRoutine(g, {
    routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['property_merge'] },
  });
  const { runId } = await h.seedRoutineRun(g, { routineId });
  const pending = await dispatchTool(
    h.routineCtx(g, 'act', ['property_merge'], {
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['property_merge']) },
    }),
    'property_merge',
    { source, into },
  );
  if (pending.status !== 'pending_confirmation') throw new Error(JSON.stringify(pending));
  const approved = await approvePending(db, {
    identity: personal(g),
    pendingId: pending.pendingId,
  });
  if (!approved.ok) throw new Error(approved.error.message);
  const late = await run(g, 'property_merge', { source: z, into: q });
  const out = await rollbackRun(db, { identity: personal(g), runId });
  expect(out.ok).toBe(false);
  if (out.ok || out.reason !== 'conflict') throw new Error(JSON.stringify(out));
  expect(out.conflicts.map((c) => [c.entityId, c.actionId])).toContainEqual([
    holder,
    late.actionId,
  ]);
  expect((await row(g, holder)).props).toEqual({ [into]: 10, [q]: 7 });
});

test('rollback reader covers every named inverse holder and keeps the generic reader and arbitrary values unchanged', async () => {
  const g = mintGraph(newId());
  recordFixture(g);
  await ensureGraphs([g]);
  const { source, into } = await properties(g);
  const first = await run(g, 'entity_create', { id: newId(), title: 'cursor', tags: [] });
  const ids = {
    value: newId(),
    progress: newId(),
    body: newId(),
    mirror: newId(),
    delta: newId(),
    embedded: newId(),
  };
  const inverse: MergeInverse = {
    source,
    into,
    sourceRow: { status: 'active', mergedInto: null },
    values: [{ entityId: ids.value, source: ids.embedded, hadInto: false, into: null }],
    compacted: ['user/compacted'],
    registry: [{ id: 'user/registry', scope: null, type: { kind: 'number' } }],
    progress: [{ entityId: ids.progress, value: ids.embedded }],
    bodies: [{ entityId: ids.body, body: ids.embedded, bodyDoc: null }],
    deltas: [
      {
        id: ids.delta,
        delta: { icon: ids.embedded },
        target: { kind: 'aspect', id: 'orbis/task' },
      },
    ],
    mirrors: [ids.mirror],
    binds: [{ id: 'user/bind', implements: [] }],
    rules: [{ carrier: 'aspect', id: 'user/rules', rules: [] }],
  };
  const id = newId();
  await withIdentity(db, personal(g), (tx) =>
    sink.write(tx, {
      graphId: g,
      action: {
        id,
        type: 'property_merged',
        entity_id: null,
        actor_user_id: personal(g).actor,
        actor_kind: 'owner',
        source: 'ui',
        mechanism: 'user',
        operations: [{ op: 'property_merge', payload: { source, into } }],
        inverse: [
          { op: 'property_merge_undo', payload: inverse as unknown as Record<string, unknown> },
        ],
      },
      card: { tool: 'property_merge', entity_id: null, title: 'typed holders' },
    }),
  );
  await withIdentity(db, personal(g), async (tx) => {
    const cursor = must(await findAction(tx, g, first.actionId));
    const after = { at: cursor.createdAt, key: cursor.id };
    for (const key of [
      ids.value,
      ids.progress,
      ids.body,
      ids.mirror,
      ids.delta,
      'user/compacted',
      'user/registry',
      'user/bind',
      'user/rules',
      'rollback:delta:aspect:orbis/task',
    ])
      expect(
        (await actionsTouchingAfter(tx, g, after, [key], 'rollback')).map((e) => e.id),
      ).toEqual([id]);
    expect(await actionsTouchingAfter(tx, g, after, [ids.value])).toEqual([]);
    expect(await actionsTouchingAfter(tx, g, after, [ids.embedded], 'rollback')).toEqual([]);
    const saved = must(await findAction(tx, g, id));
    expect(saved.entityIds).toEqual([]);
    expect(saved.touchedKeys).not.toContain(ids.value);
  });
});

for (const mode of [
  'edit',
  'remove',
  'legacy-edit',
  'legacy-unrelated',
  'legacy-none',
  'unrelated',
  'none',
  'malformed-key',
  'legacy-foreign',
] as const)
  test(`own property rule key alias ${mode}`, async () => {
    const g = mintGraph(newId());
    recordFixture(g);
    await ensureGraphs([g]);
    const { source, into } = await properties(g);
    const created = await run(g, 'property_create', {
      key: 'user/carrier',
      label: { ru: 'Carrier' },
      description: { ru: 'Carrier' },
      type: { kind: 'number' },
      status: 'active',
    });
    const carrier = String((created.results[0] as { property: string }).property);
    expect(carrier).not.toBe('user/carrier');
    await run(g, 'rule_set', {
      target: { property: 'user/carrier' },
      rule: {
        id: 'merge_default',
        template: 'default',
        params: { property: source, value: { const: 5 } },
      },
    });
    const h = agentLoopHelpers(db);
    const routineId = await h.seedRoutine(g, {
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['property_merge'] },
    });
    const { runId } = await h.seedRoutineRun(g, { routineId });
    const pending = await dispatchTool(
      h.routineCtx(g, 'act', ['property_merge'], {
        routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['property_merge']) },
      }),
      'property_merge',
      { source, into },
    );
    if (pending.status !== 'pending_confirmation') throw new Error(JSON.stringify(pending));
    const approved = await approvePending(db, {
      identity: personal(g),
      pendingId: pending.pendingId,
    });
    if (!approved.ok) throw new Error(approved.error.message);
    const [journal] = await admin.execute(
      sql`SELECT inverse FROM action_journal WHERE graph_id=${g}::uuid AND id=${approved.actionId}::uuid`,
    );
    const inverse = must(journal).inverse as Array<{ payload: MergeInverse }>;
    const holder = must(must(inverse[0]).payload.rules?.find((r) => r.id === carrier));
    expect(holder.key).toBe('user/carrier');
    if (mode.startsWith('legacy') || mode === 'malformed-key') {
      if (mode.startsWith('legacy')) delete holder.key;
      else holder.key = '';
      await admin.execute(
        sql`UPDATE action_journal SET inverse=${JSON.stringify(inverse)}::jsonb WHERE graph_id=${g}::uuid AND id=${approved.actionId}::uuid`,
      );
    }
    let late: ExecuteOk | null = null;
    if (mode === 'edit' || mode === 'legacy-edit')
      late = await run(g, 'rule_set', {
        target: { property: 'user/carrier' },
        rule: {
          id: 'merge_default',
          template: 'default',
          params: { property: into, value: { const: 99 } },
        },
      });
    if (mode === 'remove')
      late = await run(g, 'rule_remove', {
        target: { property: 'user/carrier' },
        rule: 'merge_default',
      });
    if (mode === 'unrelated' || mode === 'legacy-unrelated' || mode === 'legacy-foreign') {
      const other = await run(g, 'property_create', {
        key: 'user/other_carrier',
        label: { ru: 'Other' },
        description: { ru: 'Other' },
        type: { kind: 'number' },
        status: 'active',
      });
      const otherId = String((other.results[0] as { property: string }).property);
      const mergeSource =
        mode === 'legacy-foreign'
          ? String(
              (
                (
                  await run(g, 'property_create', {
                    key: 'user/aux',
                    label: { ru: 'Aux' },
                    description: { ru: 'Aux' },
                    type: { kind: 'number' },
                    status: 'active',
                  })
                ).results[0] as { property: string }
              ).property,
            )
          : otherId;
      late = await run(g, 'rule_set', {
        target: { property: 'user/other_carrier' },
        rule: {
          id: 'other_default',
          template: 'default',
          params: { property: mergeSource, value: { const: 7 } },
        },
      });
      if (mode === 'legacy-foreign') {
        const last = await run(g, 'property_create', {
          key: 'user/last',
          label: { ru: 'Last' },
          description: { ru: 'Last' },
          type: { kind: 'number' },
          status: 'active',
        });
        const q = String((last.results[0] as { property: string }).property);
        late = await run(g, 'property_merge', { source: mergeSource, into: q });
      }
    }
    const out = await rollbackRun(db, { identity: personal(g), runId });
    const [current] = await admin.execute(
      sql`SELECT rules FROM property_definitions WHERE graph_id=${g}::uuid AND id=${carrier}`,
    );
    if (mode === 'none' || mode === 'legacy-none' || mode === 'unrelated') {
      expect(out.ok).toBe(true);
      expect(must(current).rules).toEqual([
        {
          id: 'merge_default',
          enabled: true,
          undo: 'check',
          template: 'default',
          params: { property: source, value: { const: 5 } },
        },
      ]);
    } else if (mode === 'malformed-key') {
      expect(out.ok).toBe(false);
      if (out.ok || out.reason !== 'partial') throw new Error(JSON.stringify(out));
      expect(out.undone).toEqual([]);
    } else {
      expect(out.ok).toBe(false);
      if (out.ok || out.reason !== 'conflict') throw new Error(JSON.stringify(out));
      expect(out.conflicts.map((c) => [c.entityId, c.actionId])).toContainEqual([
        carrier,
        late?.actionId,
      ]);
      expect(out.conflicts.some((c) => c.entityId.startsWith('rollback:'))).toBe(false);
      expect(new Set(out.conflicts.map((c) => `${c.entityId}/${c.actionId}`)).size).toBe(
        out.conflicts.length,
      );
      expect(
        await admin.execute(
          sql`SELECT id FROM action_journal WHERE graph_id=${g}::uuid AND type='undo'`,
        ),
      ).toHaveLength(0);
      if (mode === 'edit' || mode === 'legacy-edit')
        expect(must(current).rules).toEqual([
          {
            id: 'merge_default',
            enabled: true,
            undo: 'check',
            template: 'default',
            params: { property: into, value: { const: 99 } },
          },
        ]);
      if (mode === 'remove') expect(must(current).rules).toEqual([]);
    }
  });
