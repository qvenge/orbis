"""Extend the existing phase-only probe with source-local per-block evidence."""
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
if not root.parent.name.startswith("orbis-b13-agenda-profile.") or root.name not in ("before", "candidate"):
    raise SystemExit("Use an isolated agenda profile checkout")
blocks = root / "apps/server/src/routers/entity-blocks.ts"
perf = root / "apps/server/perf/perf.test.ts"

def once(source, old, new):
    if source.count(old) != 1:
        raise ValueError(old)
    return source.replace(old, new, 1)

source = blocks.read_text()
source = once(source, "and, eq, inArray, type SQL", "and, eq, inArray, sql, type SQL")
anchor = "import type { Db } from '../db/client';"
source = once(source, anchor, "import { PgDialect } from 'drizzle-orm/pg-core';\n" + anchor)
source = once(source, "  totals: [] as number[],\n};", """  totals: [] as number[],
  blockSpans: [] as { key: string; kind: Plan['kind']; span: Record<string, number> }[],
  plans: new Map<string, { kind: Plan['kind']; sql: SQL }>(),
};

export async function explainAgendaProbe(db: Db, identity: Identity) {
  const plans = [...agendaProbe.plans.entries()];
  if (plans.length !== 3) throw Error('Expected the three executed Agenda page plans');
  const dialect = new PgDialect();
  return withIdentity(db, identity, async (tx) => {
    const effective = await tx.execute(sql`select current_user as role, session_user as session_role,
      current_setting('jit') as jit, current_setting('plan_cache_mode') as plan_cache_mode,
      current_setting('work_mem') as work_mem`);
    const evidence = [];
    for (const [key, plan] of plans) {
      const statement = dialect.sqlToQuery(plan.sql);
      const explanation = await tx.execute(
        sql`explain (analyze, buffers, settings, timing off, format json) ${plan.sql}`,
      );
      evidence.push({ key, kind: plan.kind, statement, explanation: [...explanation] });
    }
    return { effective: [...effective], evidence };
  });
}
""")
source = once(source, "  const raw = [...(await sp.execute(plan.sql))]", """  const queryStarted = profile ? performance.now() : 0;
  const raw = [...(await sp.execute(plan.sql))]""")
source = once(source, "  if (raw.length <= plan.limit)", """  if (profile) {
    profile.query = performance.now() - queryStarted;
    profile.rawRows = raw.length;
    profile.limit = plan.limit;
  }
  if (raw.length <= plan.limit)""")
source = once(source, "  plan: { sql: SQL; limit: number },\n", "  plan: { sql: SQL; limit: number },\n  profile?: Record<string, number>,\n")
source = once(source, "async function executePlan(sp: Tx, plan: Plan): Promise<BlockSuccess> {", """async function executePlan(
  sp: Tx,
  plan: Plan,
  profile?: Record<string, number>,
): Promise<BlockSuccess> {""")
if source.count("await shownRows(sp, plan)") != 2:
    raise ValueError("Expected row and group branches")
source = source.replace("await shownRows(sp, plan)", "await shownRows(sp, plan, profile)")
source = once(source, """      return {
        ok: true,
        kind: 'rows',
        rows: rows.map(toWireEntityFromSql),
        more,
        closedIds: closedIdsOf(rows),
      };""", """      const start = profile ? performance.now() : 0;
      const wire = rows.map(toWireEntityFromSql);
      const closedIds = closedIdsOf(rows);
      if (profile) profile.wireLayout = performance.now() - start;
      return { ok: true, kind: 'rows', rows: wire, more, closedIds };""")
source = once(source, "      const input: DayGroupInputRow[] =", "      const mapStarted = profile ? performance.now() : 0;\n      const input: DayGroupInputRow[] =")
source = once(source, "      const { groups } = layoutDayGroups", """      const layoutStarted = profile ? performance.now() : 0;
      if (profile) profile.wire = layoutStarted - mapStarted;
      const { groups } = layoutDayGroups""")
source = once(source, "      return { ok: true, kind: 'groups', groups, more, closedIds: closedIdsOf(rows) };", """      const closedIds = closedIdsOf(rows);
      if (profile) profile.layout = performance.now() - layoutStarted;
      return { ok: true, kind: 'groups', groups, more, closedIds };""")
source = once(source, "      const result = await tx.transaction((sp) => executePlan(sp, p.plan));", """      const plan = p.plan;
      let result: BlockSuccess;
      if (agendaProbe.active) {
        const span: Record<string, number> = {};
        const start = performance.now();
        result = await tx.transaction(async (sp) => {
          const entered = performance.now();
          const value = await executePlan(sp, plan, span);
          span.callback = performance.now() - entered;
          return value;
        });
        span.savepointTotal = performance.now() - start;
        span.outsideCallback = span.savepointTotal - span.callback;
        agendaProbe.blockSpans.push({ key: p.key, kind: plan.kind, span });
        agendaProbe.plans.set(p.key, plan);
      } else {
        result = await tx.transaction((sp) => executePlan(sp, plan));
      }""")
perf_source = perf.read_text()
perf_source = once(perf_source, "import { agendaProbe } from '../src/routers/entity-blocks';",
                   "import { agendaProbe, explainAgendaProbe } from '../src/routers/entity-blocks';")
perf_source = once(perf_source, "  await seedPerfFixture(db, user);", """  await seedPerfFixture(db, user);
  const afterSeed = await db.execute(sql`select relname, n_live_tup, n_dead_tup, last_analyze,
      last_autoanalyze, last_autovacuum
    from pg_stat_user_tables
    where relname in ('entities', 'relations', 'change_feed')
    order by relname`);
  console.log('agenda_after_seed_catalog', JSON.stringify([...afterSeed]));""")
perf_source = once(perf_source, "  expect(sizes.every((n) => n > 0)).toBe(true);",
                   "  expect(sizes.every((n) => n > 0)).toBe(true);\n  console.log('agenda_fixture_sizes', JSON.stringify(sizes));")
perf_source = once(perf_source, "  console.log('agenda_profile', JSON.stringify({ spans: agendaProbe.spans, totals: agendaProbe.totals }));", """  console.log('agenda_profile', JSON.stringify({
    spans: agendaProbe.spans, totals: agendaProbe.totals, blockSpans: agendaProbe.blockSpans,
  }));
  console.log('agenda_explain', JSON.stringify(await explainAgendaProbe(db, personal(user))));""")
blocks.write_text(source)
perf.write_text(perf_source)
