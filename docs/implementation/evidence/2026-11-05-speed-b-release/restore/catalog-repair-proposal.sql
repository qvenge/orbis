-- Review only. Execute after same-session target identity guard and separate grant.
-- Source schema owner is pg_database_owner. Every restored table owner already matches.
CREATE ROLE orbis_change_feed_owner NOLOGIN NOINHERIT BYPASSRLS;
ALTER SCHEMA public OWNER TO pg_database_owner;
ALTER FUNCTION public.orbis_capture_change_feed() OWNER TO orbis_change_feed_owner;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Exact two source migration registrations, local role supabase_admin.
SELECT cron.schedule('orbis_perf_samples_cleanup', '17 3 * * *',
  $$DELETE FROM public.perf_samples WHERE created_at < now() - interval '30 days'$$);

SELECT cron.schedule('orbis_change_feed_cleanup', '27 3 * * *', $job$
  WITH expired AS (
    DELETE FROM public.change_feed WHERE at < pg_catalog.now() - interval '7 days' RETURNING tx_id
  ), latest AS (
    SELECT tx_id FROM expired ORDER BY tx_id DESC LIMIT 1
  ), advanced AS (
    UPDATE public.change_feed_floor f
      SET floor = ((latest.tx_id::text::numeric + 1)::text)::xid8
      FROM latest WHERE f.id = 1 AND f.floor <= latest.tx_id
      RETURNING f.floor
  )
  SELECT pg_catalog.pg_notify('orbis_changes',
    pg_catalog.jsonb_build_object('txId', pg_catalog.pg_current_xact_id()::text)::text)
    FROM advanced
$job$);
