SELECT current_database(), current_user, session_user, inet_server_addr() IS NULL, system_identifier FROM pg_control_system();
SELECT rolname,rolcanlogin,rolsuper,rolinherit,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication
FROM pg_roles WHERE rolname IN ('orbis_app','orbis_change_feed_owner','authenticated','anon','service_role','supabase_admin') ORDER BY 1;
SELECT grantor::regrole::text,roleid::regrole::text,member::regrole::text,admin_option,inherit_option,set_option
FROM pg_auth_members
WHERE roleid::regrole::text IN ('authenticated','orbis_change_feed_owner') OR member::regrole::text IN ('orbis_app','orbis_change_feed_owner')
ORDER BY 1,2,3;
SELECT nspname,nspowner::regrole::text,nspacl FROM pg_namespace WHERE nspname IN ('public','drizzle','cron') ORDER BY 1;
SELECT n.nspname,c.relname,c.relkind,c.relowner::regrole::text,c.relrowsecurity,c.relforcerowsecurity,c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','S','v','m','f') ORDER BY 1,2;
SELECT n.nspname,c.relname,a.attname,a.attacl
FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','drizzle') AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL ORDER BY 1,2,3;
SELECT defaclrole::regrole::text,case when defaclnamespace=0 then '' else defaclnamespace::regnamespace::text end,defaclobjtype,defaclacl
FROM pg_default_acl ORDER BY 1,2,3;
SELECT p.oid::regprocedure::text,p.proowner::regrole::text,p.prosecdef,p.proconfig,p.proacl,md5(pg_get_functiondef(p.oid))
FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace, 'drizzle'::regnamespace) AND p.prokind IN ('f','p')
ORDER BY 1;
SELECT n.nspname, c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1,2,3;
SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
FROM pg_policies WHERE schemaname IN ('public','drizzle') ORDER BY 1,2,3;
SELECT extname,extversion FROM pg_extension ORDER BY 1;
SELECT current_setting('shared_preload_libraries'), current_setting('cron.database_name'), current_setting('cron.timezone');
SELECT to_regclass('cron.job') IS NOT NULL AS cron_present
\gset
\if :cron_present
SELECT jobid,jobname,schedule,database,username,active,md5(command)
FROM cron.job WHERE jobname IN ('orbis_perf_samples_cleanup','orbis_change_feed_cleanup') ORDER BY jobname;
\else
\echo cron catalog absent
\endif
SELECT floor::text FROM public.change_feed_floor WHERE id=1;
SELECT count(*), min(tx_id::text::numeric), max(tx_id::text::numeric) FROM public.change_feed;
SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS current_xmin;
