import { Hono } from 'hono';
import { sql } from './db';

const app = new Hono();

// Живость процесса (без БД)
app.get('/health', (c) => c.json({ ok: true, runtime: `bun ${Bun.version}` }));

// Связность API↔DB + замер латентности (co-location должен давать единицы мс)
app.get('/db-check', async (c) => {
  const t0 = performance.now();
  try {
    await sql`select 1`;
    return c.json({ ok: true, dbLatencyMs: Math.round((performance.now() - t0) * 100) / 100 });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// Мини-сабсет RLS-матрицы SPIKE-01 против hosted — прогоняется С хостинга.
// Требует применённого setup-db (роль orbis_app + spike_items + политика) и
// DATABASE_URL с ролью orbis_app. Защищён токеном.
app.get('/spike-check', async (c) => {
  if (c.req.header('x-spike-token') !== process.env.SPIKE_CHECK_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  const results: Record<string, boolean> = {};

  try {
    // identity заполняется + WITH CHECK happy-path
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: a, role: 'authenticated' })}, true)`;
      await tx`insert into spike_items (owner_id, title) values (${a}, 'probe-a')`;
      const uid = await tx`select auth.uid() as uid`;
      results['uid_populated'] = uid[0]?.uid === a;
    });

    // cross-user reject: под B строки A не видны
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: b, role: 'authenticated' })}, true)`;
      const rows = await tx`select 1 from spike_items where owner_id = ${a}`;
      results['cross_user_hidden'] = rows.length === 0;
    });

    // deny-by-default вне транзакции с identity
    const bare = await sql`select 1 from spike_items where owner_id = ${a}`;
    results['deny_by_default'] = bare.length === 0;

    // чистый checkout: uid пуст вне транзакции
    const uidAfter = await sql`select auth.uid() as uid`;
    results['clean_checkout'] = uidAfter[0]?.uid == null;

    // уборка: под A удаляем пробную строку
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: a, role: 'authenticated' })}, true)`;
      await tx`delete from spike_items where owner_id = ${a} and title = 'probe-a'`;
    });

    const pass = Object.values(results).every(Boolean);
    return c.json({ pass, results });
  } catch (e) {
    return c.json({ pass: false, results, error: String(e) }, 500);
  }
});

const port = Number(process.env.PORT ?? 3000);
console.log(`spike-05 listening on :${port}`);

export default { port, fetch: app.fetch };
