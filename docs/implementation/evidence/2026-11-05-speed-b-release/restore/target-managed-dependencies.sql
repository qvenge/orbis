SELECT nspname,nspowner::regrole::text FROM pg_namespace WHERE nspname IN ('public','auth','extensions','cron','drizzle') ORDER BY 1;
SELECT extname,extnamespace::regnamespace::text,extversion FROM pg_extension ORDER BY 1;
SELECT c.relkind,c.relname,c.relowner::regrole::text FROM pg_class c
WHERE c.relnamespace='public'::regnamespace ORDER BY 1,2;
SELECT p.oid::regprocedure::text,p.proowner::regrole::text FROM pg_proc p
WHERE p.pronamespace='public'::regnamespace ORDER BY 1;
SELECT d.deptype, dep.type, dep.schema, dep.identity, ref.type, ref.schema, ref.identity
FROM pg_depend d
CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) dep
CROSS JOIN LATERAL pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) ref
WHERE (ref.schema='public' OR (ref.type='schema' AND ref.name='public'))
AND dep.schema IS DISTINCT FROM 'public'
ORDER BY 2,3,4,5,6,7;
SELECT proname,proowner::regrole::text,md5(prosrc) FROM pg_proc WHERE pronamespace='auth'::regnamespace AND proname='uid';
SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS current_xmin;
