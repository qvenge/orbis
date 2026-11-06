CREATE TABLE "change_feed" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "change_feed_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tx_id" "xid8" NOT NULL,
	"graph_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"row_key" text NOT NULL,
	"entity_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"thread_id" uuid,
	"operation" text NOT NULL,
	"scope" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"graph_wide" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_feed_floor" (
	"id" smallint PRIMARY KEY NOT NULL,
	"floor" "xid8" NOT NULL,
	CONSTRAINT "change_feed_floor_singleton" CHECK ("change_feed_floor"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX "change_feed_graph_tx_id" ON "change_feed" USING btree ("graph_id","tx_id","id");
--> statement-breakpoint
CREATE INDEX "change_feed_parent_proof" ON "change_feed" USING btree ("tx_id","kind","row_key","id" DESC)
  WHERE "kind" IN ('entity','thread','relation');
--> statement-breakpoint
-- Схема выше и snapshot сгенерированы Drizzle. Политики, гранты, триггеры и cron — часть
-- административной миграции. У ленты нет FK на граф: его удаление не стирает историю раньше порога.
INSERT INTO public.change_feed_floor (id, floor) VALUES (1, '0'::xid8);
--> statement-breakpoint
ALTER TABLE public.change_feed ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.change_feed FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.change_feed_floor ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.change_feed_floor FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY current_graph_select ON public.change_feed FOR SELECT TO authenticated
  USING (graph_id = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY current_graph_select ON public.change_feed_floor FOR SELECT TO authenticated
  USING ((SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
REVOKE ALL ON public.change_feed, public.change_feed_floor FROM PUBLIC, anon, authenticated, orbis_app, service_role;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE public.change_feed_id_seq FROM PUBLIC, anon, authenticated, orbis_app, service_role;
--> statement-breakpoint
GRANT SELECT ON public.change_feed, public.change_feed_floor TO authenticated;
--> statement-breakpoint
-- PostgreSQL 17: администратору нужны CREATEROLE и BYPASSRLS (или SUPERUSER). Роль общая для
-- кластера, поэтому в другой базе того же кластера допустимо встретить её уже созданной.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'orbis_change_feed_owner') THEN
    CREATE ROLE orbis_change_feed_owner NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_roles r WHERE rolname = 'orbis_change_feed_owner'
      AND rolbypassrls AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
  ) OR pg_catalog.pg_has_role('orbis_app', 'orbis_change_feed_owner', 'MEMBER')
    OR pg_catalog.pg_has_role('authenticated', 'orbis_change_feed_owner', 'MEMBER')
    OR pg_catalog.pg_has_role('anon', 'orbis_change_feed_owner', 'MEMBER')
    OR pg_catalog.pg_has_role('service_role', 'orbis_change_feed_owner', 'MEMBER')
  THEN
    RAISE EXCEPTION 'orbis_change_feed_owner has unexpected attributes or memberships';
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO orbis_change_feed_owner;
--> statement-breakpoint
GRANT SELECT (id, graph_id) ON public.entities TO orbis_change_feed_owner;
--> statement-breakpoint
GRANT SELECT (id, source_id, target_id) ON public.relations TO orbis_change_feed_owner;
--> statement-breakpoint
GRANT SELECT (id, graph_id, entity_id) ON public.chat_threads TO orbis_change_feed_owner;
--> statement-breakpoint
GRANT INSERT ON public.change_feed TO orbis_change_feed_owner;
--> statement-breakpoint
-- RETURNING graph_id, плюс поиск ранее записанных событий в той же TX для журнала.
GRANT SELECT (id, graph_id, tx_id, kind, row_key, operation, entity_ids, graph_wide) ON public.change_feed TO orbis_change_feed_owner;
--> statement-breakpoint
GRANT SELECT (id, floor), UPDATE (floor) ON public.change_feed_floor TO orbis_change_feed_owner;
--> statement-breakpoint
-- Нельзя фильтровать события по ожидаемому графу до LIMIT: это вернуло бы старую сторону
-- переноса вместо последней известной стороны. Живой parent всегда приоритетнее истории.
CREATE FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8)
RETURNS TABLE(graph_id uuid, operation text, entity_ids uuid[], graph_wide boolean)
LANGUAGE sql STABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT f.graph_id, f.operation, f.entity_ids, f.graph_wide
  FROM public.change_feed f
  WHERE f.tx_id = xid AND f.kind = event_kind AND f.row_key = event_key
    AND f.kind IN ('entity','thread','relation')
  ORDER BY f.id DESC LIMIT 1
$$;
--> statement-breakpoint
CREATE FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8)
RETURNS uuid LANGUAGE sql STABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(
    (SELECT e.graph_id FROM public.entities e WHERE e.id = entity_id),
    (SELECT f.graph_id FROM public.orbis_feed_last_event('entity', entity_id::text, xid) f
      WHERE f.operation = 'delete')
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.orbis_feed_last_event(text, text, xid8),
  public.orbis_feed_entity_graph(uuid, xid8) FROM PUBLIC, anon, authenticated, orbis_app, service_role;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.orbis_feed_last_event(text, text, xid8),
  public.orbis_feed_entity_graph(uuid, xid8) TO orbis_change_feed_owner;
--> statement-breakpoint
CREATE FUNCTION public.orbis_capture_change_feed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $capture$
DECLARE
  source_table text := TG_TABLE_NAME;
  event_kind text;
  match_key text := 'o.id = n.id';
  presence_key text := 'id';
  -- Проекция одной стороны изменения: graph, row key, thread, affected, graph-wide.
  project text;
  pair_query text;
  is_body text := 'false';
  changed_graphs uuid[];
  global_reset boolean := TG_OP = 'TRUNCATE';
  xid xid8 := pg_catalog.pg_current_xact_id_if_assigned();
  event_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF NOT global_reset THEN
    CASE source_table
      WHEN 'entities' THEN
        event_kind := 'entity';
        -- Сравниваем полный типизированный record с вычищенным whitelist. Новые колонки по
        -- умолчанию other. Не превращаем всё тело в JSON ради проверки неизменившихся полей.
        is_body := $sql$
          o.id IS NOT NULL AND n.id IS NOT NULL AND
          pg_catalog.jsonb_populate_record(ROW(o.*)::public.entities, cols.mask)
          IS NOT DISTINCT FROM
          pg_catalog.jsonb_populate_record(ROW(n.*)::public.entities, cols.mask)
        $sql$;
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).id::text AS row_key,
            NULL::uuid AS thread_id, pg_catalog.array_prepend((s.row_data).id, refs.entity_ids) AS entity_ids,
            refs.incomplete AS graph_wide
          FROM (VALUES (1)) anchor(n)
          CROSS JOIN LATERAL (
            SELECT CASE WHEN (s.row_data).graph_id = (s.other_side).graph_id THEN (s.other_side).body_refs
              ELSE '{}'::text[] END AS refs
          ) other_side
          CROSS JOIN LATERAL (
            SELECT CASE WHEN (s.row_data).body_refs = other_side.refs THEN '{}'::text[] ELSE ARRAY(
              SELECT pg_catalog.unnest((s.row_data).body_refs)
              EXCEPT SELECT pg_catalog.unnest(other_side.refs)
            ) END AS refs
          ) diff
          CROSS JOIN LATERAL (
            SELECT coalesce(pg_catalog.array_agg(candidate.id) FILTER (WHERE proof.same_graph), '{}'::uuid[]) AS entity_ids,
              coalesce(pg_catalog.bool_or(NOT proof.same_graph), false) AS incomplete
            FROM pg_catalog.unnest(diff.refs) changed(ref)
            CROSS JOIN LATERAL (
              SELECT CASE WHEN pg_catalog.pg_input_is_valid(changed.ref, 'uuid') THEN changed.ref::uuid END AS id
            ) candidate
            CROSS JOIN LATERAL (
              SELECT (candidate.id = (s.row_data).id OR
                public.orbis_feed_entity_graph(candidate.id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
            ) proof
          ) refs
        $sql$;
      WHEN 'relations' THEN
        event_kind := 'relation';
        project := $sql$
          SELECT CASE WHEN proof.source_graph = proof.target_graph THEN proof.source_graph END AS graph_id,
            (s.row_data).id::text AS row_key, NULL::uuid AS thread_id,
            ARRAY[(s.row_data).source_id, (s.row_data).target_id] AS entity_ids, false AS graph_wide
          FROM (VALUES (1)) anchor(n)
          LEFT JOIN public.entities origin ON origin.id = (s.row_data).source_id
          LEFT JOIN public.entities destination ON destination.id = (s.row_data).target_id
          CROSS JOIN LATERAL (
            -- Если оба конца исчезли, применяем общий сброс по матрице источников.
            SELECT CASE WHEN origin.id IS NOT NULL OR destination.id IS NOT NULL THEN
              coalesce(origin.graph_id, public.orbis_feed_entity_graph((s.row_data).source_id, $1)) END AS source_graph,
              CASE WHEN origin.id IS NOT NULL OR destination.id IS NOT NULL THEN
              coalesce(destination.graph_id, public.orbis_feed_entity_graph((s.row_data).target_id, $1)) END AS target_graph
          ) proof
        $sql$;
      WHEN 'entity_versions' THEN
        event_kind := 'version';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).id::text AS row_key,
            NULL::uuid AS thread_id,
            CASE WHEN proof.same_graph THEN ARRAY[(s.row_data).entity_id] ELSE '{}'::uuid[] END AS entity_ids,
            NOT proof.same_graph AS graph_wide
          FROM LATERAL (
            SELECT (public.orbis_feed_entity_graph((s.row_data).entity_id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
          ) proof
        $sql$;
      WHEN 'chat_messages' THEN
        event_kind := 'message';
        project := $sql$
          SELECT thread.graph_id AS graph_id, (s.row_data).id::text AS row_key,
            (s.row_data).thread_id AS thread_id,
            CASE WHEN proof.same_graph THEN ARRAY[thread.entity_id] ELSE '{}'::uuid[] END AS entity_ids,
            thread.entity_id IS NOT NULL AND NOT proof.same_graph AS graph_wide
          FROM (VALUES (1)) anchor(n)
          LEFT JOIN public.chat_threads thread ON thread.id = (s.row_data).thread_id
          CROSS JOIN LATERAL (
            SELECT (public.orbis_feed_entity_graph(thread.entity_id, $1) = thread.graph_id) IS TRUE AS same_graph
          ) proof
        $sql$;
      WHEN 'chat_threads' THEN
        event_kind := 'thread';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).id::text AS row_key,
            (s.row_data).id AS thread_id,
            CASE WHEN proof.same_graph THEN ARRAY[(s.row_data).entity_id] ELSE '{}'::uuid[] END AS entity_ids,
            (s.row_data).entity_id IS NOT NULL AND NOT proof.same_graph AS graph_wide
          FROM LATERAL (
            SELECT (public.orbis_feed_entity_graph((s.row_data).entity_id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
          ) proof
        $sql$;
      WHEN 'action_journal' THEN
        event_kind := 'journal';
        match_key := 'o.id = n.id AND o.graph_id = n.graph_id';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).id::text AS row_key,
            CASE WHEN parent.graph_id = (s.row_data).graph_id THEN (s.row_data).thread_id END AS thread_id,
            pg_catalog.array_append(resolved.entity_ids, CASE WHEN parent.anchor_ok THEN parent.entity_id END) AS entity_ids,
            resolved.incomplete OR ((s.row_data).thread_id IS NOT NULL
              AND (parent.graph_id IS DISTINCT FROM (s.row_data).graph_id OR parent.incomplete
                OR (parent.entity_id IS NOT NULL AND NOT parent.anchor_ok))) AS graph_wide
          FROM (VALUES (1)) anchor(n)
          LEFT JOIN public.chat_threads thread ON thread.id = (s.row_data).thread_id
          LEFT JOIN LATERAL (
            SELECT f.* FROM public.orbis_feed_last_event('thread', (s.row_data).thread_id::text, $1) f
            WHERE thread.id IS NULL AND f.operation = 'delete'
          ) old_thread ON true
          CROSS JOIN LATERAL (
            SELECT p.*, (p.graph_id = (s.row_data).graph_id AND
              public.orbis_feed_entity_graph(p.entity_id, $1) = p.graph_id) IS TRUE AS anchor_ok
            FROM (
              SELECT coalesce(thread.graph_id, old_thread.graph_id) AS graph_id,
                coalesce(thread.entity_id, old_thread.entity_ids[1]) AS entity_id,
                coalesce(old_thread.graph_wide, false) AS incomplete
            ) p
          ) parent
          CROSS JOIN LATERAL (
            SELECT coalesce(pg_catalog.array_agg(affected.id) FILTER (WHERE affected.same_graph), '{}'::uuid[]) AS entity_ids,
              coalesce(pg_catalog.bool_or(affected.same_graph IS NOT TRUE OR affected.id IS NULL), false) AS incomplete
            FROM (
              SELECT DISTINCT id
              FROM pg_catalog.unnest(pg_catalog.array_append((s.row_data).entity_ids, (s.row_data).entity_id)) ids(id)
              WHERE id IS NOT NULL
            ) refs
            LEFT JOIN LATERAL (
              SELECT (public.orbis_feed_entity_graph(refs.id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
            ) entity ON true
            LEFT JOIN public.relations edge ON edge.id = refs.id AND NOT entity.same_graph
            CROSS JOIN LATERAL (
              SELECT (public.orbis_feed_entity_graph(edge.source_id, $1) = (s.row_data).graph_id
                AND public.orbis_feed_entity_graph(edge.target_id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
              OFFSET 0
            ) edge_proof
            LEFT JOIN LATERAL (
              SELECT f.* FROM public.orbis_feed_last_event('relation', refs.id::text, $1) f
              WHERE NOT entity.same_graph AND edge.id IS NULL AND f.operation = 'delete'
            ) old_edge ON true
            LEFT JOIN LATERAL (
              SELECT candidate.id, (public.orbis_feed_entity_graph(candidate.id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
              FROM (
                SELECT refs.id WHERE entity.same_graph
                UNION
                SELECT pg_catalog.unnest(ARRAY[edge.source_id, edge.target_id])
                WHERE edge_proof.same_graph
                UNION
                SELECT pg_catalog.unnest(f.entity_ids)
                FROM public.change_feed f
                WHERE f.kind = 'relation' AND f.tx_id = $1 AND f.row_key = refs.id::text
                  AND f.graph_id = (s.row_data).graph_id
                  AND (old_edge.graph_id = (s.row_data).graph_id OR edge_proof.same_graph)
              ) candidate
            ) affected ON true
          ) resolved
        $sql$;
      WHEN 'user_settings' THEN
        event_kind := 'settings';
        presence_key := 'graph_id';
        match_key := 'o.graph_id = n.graph_id';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).graph_id::text AS row_key,
            NULL::uuid AS thread_id, '{}'::uuid[] AS entity_ids, false AS graph_wide
        $sql$;
      WHEN 'registry_deltas' THEN
        event_kind := 'registry';
        match_key := 'o.graph_id = n.graph_id AND o.target_kind = n.target_kind AND o.target_id = n.target_id';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id,
            'registry_deltas:' || (s.row_data).target_kind || ':' || (s.row_data).target_id AS row_key,
            NULL::uuid AS thread_id, '{}'::uuid[] AS entity_ids, false AS graph_wide
        $sql$;
      WHEN 'registry_system' THEN
        event_kind := 'registry';
        project := $sql$
          SELECT NULL::uuid AS graph_id, (s.row_data).id::text AS row_key,
            NULL::uuid AS thread_id, '{}'::uuid[] AS entity_ids, false AS graph_wide
        $sql$;
      WHEN 'aspect_definitions', 'property_definitions', 'relation_role_definitions',
           'contract_definitions', 'subscription_definitions', 'action_definitions' THEN
        event_kind := 'registry';
        -- Эквивалент graph_id IS NOT DISTINCT FROM, но целиком hashable для FULL JOIN.
        -- Отдельный бит NULL отличает даже гипотетический граф с нулевым UUID.
        match_key := $sql$
          o.id = n.id AND (o.graph_id IS NULL) = (n.graph_id IS NULL)
          AND coalesce(o.graph_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(n.graph_id, '00000000-0000-0000-0000-000000000000'::uuid)
        $sql$;
        project := pg_catalog.format($sql$
          SELECT (s.row_data).graph_id AS graph_id, %L || (s.row_data).id AS row_key,
            NULL::uuid AS thread_id, '{}'::uuid[] AS entity_ids, false AS graph_wide
        $sql$, source_table || ':');
      ELSE
        RAISE EXCEPTION 'unexpected feed source: %', source_table;
    END CASE;

    -- Имена transition relations фиксированы. В SQL подставляются только литералы выше
    -- и идентификатор проверенной таблицы, никогда содержимое записей.
    CASE TG_OP
      WHEN 'INSERT' THEN
        pair_query := pg_catalog.format($sql$
          SELECT NULL::public.%1$I AS old_row, ROW(n.*)::public.%1$I AS new_row,
            false AS has_old, true AS has_new, false AS body
          FROM feed_new n
        $sql$, source_table);
      WHEN 'DELETE' THEN
        pair_query := pg_catalog.format($sql$
          SELECT ROW(o.*)::public.%1$I AS old_row, NULL::public.%1$I AS new_row,
            true AS has_old, false AS has_new, false AS body
          FROM feed_old o
        $sql$, source_table);
      WHEN 'UPDATE' THEN
        pair_query := pg_catalog.format($sql$
          SELECT ROW(o.*)::public.%1$I AS old_row, ROW(n.*)::public.%1$I AS new_row,
            o.%2$I IS NOT NULL AS has_old, n.%2$I IS NOT NULL AS has_new, (%3$s) AS body
          FROM feed_old o FULL JOIN feed_new n ON %4$s
          CROSS JOIN (VALUES ('{"body":null,"body_doc":null,"body_before_doc":null,"body_refs":null,
            "query_refs":null,"body_revision":null,"body_action_id":null,"body_changed_at":null,
            "updated_at":null}'::jsonb)) cols(mask)
          WHERE o IS DISTINCT FROM n
        $sql$, source_table, presence_key, is_body, match_key);
      ELSE
        RAISE EXCEPTION 'unexpected feed trigger operation: %', TG_OP;
    END CASE;

    EXECUTE pg_catalog.format($sql$
      WITH pairs AS (
        SELECT row_number() OVER () AS pair, matched.* FROM (%1$s) matched
      ), sides AS (
        SELECT pair, old_row AS row_data, new_row AS other_side, false AS is_new, body
          FROM pairs WHERE has_old
        UNION ALL
        SELECT pair, new_row, old_row, true, body FROM pairs WHERE has_new
      ), events AS (
        SELECT s.pair, p.graph_id, p.row_key, p.thread_id,
          CASE WHEN pg_catalog.bool_and(s.is_new) THEN 'insert'
               WHEN NOT pg_catalog.bool_or(s.is_new) THEN 'delete' ELSE 'update' END AS operation,
          CASE WHEN pg_catalog.bool_or(s.is_new) AND NOT pg_catalog.bool_and(s.is_new)
                 AND pg_catalog.bool_and(s.body) THEN 'body' ELSE 'other' END AS scope,
          coalesce(pg_catalog.array_agg(DISTINCT affected.id ORDER BY affected.id)
            FILTER (WHERE affected.id IS NOT NULL), '{}'::uuid[]) AS entity_ids,
          pg_catalog.bool_or(p.graph_wide) AS graph_wide
        FROM sides s
        CROSS JOIN LATERAL (%2$s) p
        LEFT JOIN LATERAL pg_catalog.unnest(p.entity_ids) affected(id) ON true
        GROUP BY s.pair, p.graph_id, p.row_key, p.thread_id
      ), inserted AS (
        INSERT INTO public.change_feed (tx_id, graph_id, kind, row_key, entity_ids, thread_id,
            operation, scope, at, graph_wide)
          SELECT $1, graph_id, %3$L, row_key, entity_ids, thread_id, operation, scope, $2, graph_wide
          FROM events WHERE graph_id IS NOT NULL
          -- При переносе одного ключа synthetic DELETE предшествует INSERT. Поэтому latest
          -- DELETE исчезнувшего родителя не спутать со старой стороной переноса.
          ORDER BY pair, operation
          RETURNING graph_id
      )
      SELECT ARRAY(SELECT DISTINCT graph_id FROM inserted),
        EXISTS (SELECT FROM events WHERE graph_id IS NULL)
    $sql$, pair_query, project, event_kind)
    INTO changed_graphs, global_reset USING xid, event_at;

    PERFORM pg_catalog.pg_notify('orbis_changes',
      pg_catalog.jsonb_build_object('graphId', g.id, 'txId', xid::text)::text)
      FROM pg_catalog.unnest(changed_graphs) g(id);
  END IF;

  IF global_reset THEN
    xid := pg_catalog.pg_current_xact_id();
    UPDATE public.change_feed_floor SET floor = greatest(floor, ((xid::text::numeric + 1)::text)::xid8)
      WHERE id = 1 AND floor <= xid;
    PERFORM pg_catalog.pg_notify('orbis_changes', pg_catalog.jsonb_build_object('txId', xid::text)::text);
  END IF;
  RETURN NULL;
END $capture$;
--> statement-breakpoint
DO $$
DECLARE
  producer text;
BEGIN
  FOREACH producer IN ARRAY ARRAY[
    'entities', 'relations', 'entity_versions', 'chat_messages', 'chat_threads', 'action_journal',
    'user_settings', 'aspect_definitions', 'property_definitions', 'relation_role_definitions',
    'contract_definitions', 'subscription_definitions', 'action_definitions', 'registry_deltas', 'registry_system'
  ] LOOP
    EXECUTE pg_catalog.format('CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.%I
      REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed()', producer);
    EXECUTE pg_catalog.format('CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.%I
      REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT
      EXECUTE FUNCTION public.orbis_capture_change_feed()', producer);
    EXECUTE pg_catalog.format('CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.%I
      REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed()', producer);
    EXECUTE pg_catalog.format('CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed()', producer);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.orbis_capture_change_feed() FROM PUBLIC, anon, authenticated, orbis_app, service_role;
--> statement-breakpoint
-- ALTER OWNER требует SET ROLE и CREATE для нового владельца, если мигратор не superuser.
-- Оба нужны только для передачи объекта.
-- Supautils в supabase/postgres:17.6.1.140 падает на CURRENT_USER в GRANT/REVOKE роли
-- (supabase/supautils#205). Передаём то же имя как SQL-идентификатор, не меняя полномочия.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT orbis_change_feed_owner TO %I WITH SET TRUE, INHERIT FALSE', current_user);
END $$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO orbis_change_feed_owner;
--> statement-breakpoint
ALTER FUNCTION public.orbis_capture_change_feed() OWNER TO orbis_change_feed_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM orbis_change_feed_owner;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE SET OPTION FOR orbis_change_feed_owner FROM %I', current_user);
END $$;
--> statement-breakpoint
-- Один statement чистки (под административной ролью pg_cron). DELETE и продвижение floor
-- фиксируются одной транзакцией. Именованный schedule обновляет существующую задачу.
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
