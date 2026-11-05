--
-- PostgreSQL database dump
--

\restrict XxSEySuZUSxK98KjFVBc8LYAKDVwRXJmKwXFjnfBFDLgNFJblceK05fmTf1dhzd

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA drizzle;


ALTER SCHEMA drizzle OWNER TO supabase_admin;

--
-- Name: actor_owns_current_graph(); Type: FUNCTION; Schema: public; Owner: supabase_admin
--

CREATE FUNCTION public.actor_owns_current_graph() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
	RETURN EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL
			AND m.grant_kind = 'owner');
END $$;


ALTER FUNCTION public.actor_owns_current_graph() OWNER TO supabase_admin;

--
-- Name: actor_reads_current_graph(); Type: FUNCTION; Schema: public; Owner: supabase_admin
--

CREATE FUNCTION public.actor_reads_current_graph() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
	RETURN EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL);
END $$;


ALTER FUNCTION public.actor_reads_current_graph() OWNER TO supabase_admin;

--
-- Name: actor_writes_current_graph(); Type: FUNCTION; Schema: public; Owner: supabase_admin
--

CREATE FUNCTION public.actor_writes_current_graph() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
	RETURN EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL
			AND m.grant_kind IN ('owner','operator'));
END $$;


ALTER FUNCTION public.actor_writes_current_graph() OWNER TO supabase_admin;

--
-- Name: current_graph_id(); Type: FUNCTION; Schema: public; Owner: supabase_admin
--

CREATE FUNCTION public.current_graph_id() RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
	RETURN (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph')::uuid;
END $$;


ALTER FUNCTION public.current_graph_id() OWNER TO supabase_admin;

--
-- Name: entities_body_stamp(); Type: FUNCTION; Schema: public; Owner: supabase_admin
--

CREATE FUNCTION public.entities_body_stamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  -- NULLIF: после транзакции с set_config на переиспользованном соединении настройка остаётся определённой с пустым
  -- значением (проверено на Postgres 17 стенда) — пустая строка не значение (§8.1).
  IF TG_OP = 'INSERT' THEN
    NEW.body_revision := 1;
    NEW.body_action_id := NULLIF(pg_catalog.current_setting('orbis.body_action', true), '')::uuid;
    NEW.body_changed_at := pg_catalog.clock_timestamp();
  ELSIF OLD.body IS DISTINCT FROM NEW.body OR OLD.body_doc IS DISTINCT FROM NEW.body_doc THEN
    NEW.body_revision := OLD.body_revision + 1;
    NEW.body_action_id := NULLIF(pg_catalog.current_setting('orbis.body_action', true), '')::uuid;
    NEW.body_changed_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION public.entities_body_stamp() OWNER TO supabase_admin;

--
-- Name: graph_members_keep_owner(); Type: FUNCTION; Schema: public; Owner: supabase_admin
--

CREATE FUNCTION public.graph_members_keep_owner() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
	-- Замок строки графа сериализует параллельные отзывы. FOR NO KEY UPDATE, а не FOR UPDATE:
	-- тот конфликтует с FK-замком (KEY SHARE) каждой записи строк графа.
	PERFORM 1 FROM public.graphs g WHERE g.id = OLD.graph_id FOR NO KEY UPDATE;
	IF NOT FOUND THEN
		RETURN NULL; -- граф снесён вместе с членством: проверять нечего
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = OLD.graph_id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) THEN
		RAISE EXCEPTION 'у графа % не осталось действующего гранта owner (И-1)', OLD.graph_id USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END $$;


ALTER FUNCTION public.graph_members_keep_owner() OWNER TO supabase_admin;

--
-- Name: graphs_require_owner(); Type: FUNCTION; Schema: public; Owner: supabase_admin
--

CREATE FUNCTION public.graphs_require_owner() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = NEW.id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) THEN
		RAISE EXCEPTION 'граф % создан без действующего гранта owner (И-1)', NEW.id USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END $$;


ALTER FUNCTION public.graphs_require_owner() OWNER TO supabase_admin;

--
-- Name: orbis_capture_change_feed(); Type: FUNCTION; Schema: public; Owner: orbis_change_feed_owner
--

CREATE FUNCTION public.orbis_capture_change_feed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
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
END $_$;


ALTER FUNCTION public.orbis_capture_change_feed() OWNER TO orbis_change_feed_owner;

--
-- Name: orbis_feed_entity_graph(uuid, xid8); Type: FUNCTION; Schema: public; Owner: supabase_admin
--

CREATE FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8) RETURNS uuid
    LANGUAGE sql STABLE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT coalesce(
    (SELECT e.graph_id FROM public.entities e WHERE e.id = entity_id),
    (SELECT f.graph_id FROM public.orbis_feed_last_event('entity', entity_id::text, xid) f
      WHERE f.operation = 'delete')
  )
$$;


ALTER FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8) OWNER TO supabase_admin;

--
-- Name: orbis_feed_last_event(text, text, xid8); Type: FUNCTION; Schema: public; Owner: supabase_admin
--

CREATE FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8) RETURNS TABLE(graph_id uuid, operation text, entity_ids uuid[], graph_wide boolean)
    LANGUAGE sql STABLE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT f.graph_id, f.operation, f.entity_ids, f.graph_wide
  FROM public.change_feed f
  WHERE f.tx_id = xid AND f.kind = event_kind AND f.row_key = event_key
    AND f.kind IN ('entity','thread','relation')
  ORDER BY f.id DESC LIMIT 1
$$;


ALTER FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8) OWNER TO supabase_admin;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: supabase_admin
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


ALTER TABLE drizzle.__drizzle_migrations OWNER TO supabase_admin;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: supabase_admin
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNER TO supabase_admin;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: supabase_admin
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: action_definitions; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.action_definitions (
    id text NOT NULL,
    graph_id uuid,
    key text NOT NULL,
    label jsonb NOT NULL,
    description jsonb NOT NULL,
    params jsonb,
    precondition jsonb,
    steps jsonb,
    sensitivity jsonb,
    offered_by jsonb,
    module text,
    batch_cap integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rank integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    over jsonb,
    CONSTRAINT action_definitions_status CHECK ((status = ANY (ARRAY['active'::text, 'deprecated'::text])))
);

ALTER TABLE ONLY public.action_definitions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.action_definitions OWNER TO supabase_admin;

--
-- Name: action_journal; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.action_journal (
    graph_id uuid NOT NULL,
    id uuid NOT NULL,
    created_at timestamp(3) with time zone DEFAULT now() NOT NULL,
    type text NOT NULL,
    entity_id uuid,
    actor_user_id uuid NOT NULL,
    actor_kind text NOT NULL,
    source text NOT NULL,
    mechanism text NOT NULL,
    actor_grant_id uuid,
    run_id uuid,
    action_id text,
    module text,
    edited_from uuid,
    thread_id uuid,
    title text NOT NULL,
    card_tool text NOT NULL,
    entity_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    operations jsonb NOT NULL,
    inverse jsonb NOT NULL,
    results jsonb,
    text_session boolean DEFAULT false NOT NULL,
    body_before jsonb,
    undoes uuid,
    pinned_version_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    card_in_reply boolean DEFAULT false NOT NULL,
    CONSTRAINT action_journal_undo_shape CHECK (((type = 'undo'::text) = (undoes IS NOT NULL)))
);

ALTER TABLE ONLY public.action_journal FORCE ROW LEVEL SECURITY;


ALTER TABLE public.action_journal OWNER TO supabase_admin;

--
-- Name: action_journal_entities; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.action_journal_entities (
    graph_id uuid NOT NULL,
    action_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    created_at timestamp(3) with time zone NOT NULL
);

ALTER TABLE ONLY public.action_journal_entities FORCE ROW LEVEL SECURITY;


ALTER TABLE public.action_journal_entities OWNER TO supabase_admin;

--
-- Name: agent_grants; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.agent_grants (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    client_id text,
    kind text NOT NULL,
    label text NOT NULL,
    scope text DEFAULT 'full'::text NOT NULL,
    code_hash text,
    code_challenge text,
    code_expires_at timestamp with time zone,
    code_used_at timestamp with time zone,
    redirect_uri text,
    access_hash text,
    access_expires_at timestamp with time zone,
    refresh_hash text,
    refresh_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    prev_refresh_hash text,
    issued_by uuid NOT NULL,
    CONSTRAINT agent_grants_kind CHECK ((kind = ANY (ARRAY['oauth'::text, 'pat'::text])))
);

ALTER TABLE ONLY public.agent_grants FORCE ROW LEVEL SECURITY;


ALTER TABLE public.agent_grants OWNER TO supabase_admin;

--
-- Name: ai_usage; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.ai_usage (
    graph_id uuid NOT NULL,
    date date NOT NULL,
    model text NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    request_count integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.ai_usage FORCE ROW LEVEL SECURITY;


ALTER TABLE public.ai_usage OWNER TO supabase_admin;

--
-- Name: aspect_definitions; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.aspect_definitions (
    id text NOT NULL,
    graph_id uuid,
    description jsonb NOT NULL,
    ai_instructions text,
    tag_mappings text[] DEFAULT '{}'::text[] NOT NULL,
    aggregations jsonb DEFAULT '{}'::jsonb,
    view_config jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    key text NOT NULL,
    label jsonb NOT NULL,
    properties jsonb DEFAULT '[]'::jsonb NOT NULL,
    implements jsonb DEFAULT '[]'::jsonb NOT NULL,
    module text,
    service boolean DEFAULT false NOT NULL,
    rank integer DEFAULT 0 NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL
);

ALTER TABLE ONLY public.aspect_definitions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.aspect_definitions OWNER TO supabase_admin;

--
-- Name: change_feed; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.change_feed (
    id bigint NOT NULL,
    tx_id xid8 NOT NULL,
    graph_id uuid NOT NULL,
    kind text NOT NULL,
    row_key text NOT NULL,
    entity_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    thread_id uuid,
    operation text NOT NULL,
    scope text NOT NULL,
    at timestamp with time zone NOT NULL,
    graph_wide boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.change_feed FORCE ROW LEVEL SECURITY;


ALTER TABLE public.change_feed OWNER TO supabase_admin;

--
-- Name: change_feed_floor; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.change_feed_floor (
    id smallint NOT NULL,
    floor xid8 NOT NULL,
    CONSTRAINT change_feed_floor_singleton CHECK ((id = 1))
);

ALTER TABLE ONLY public.change_feed_floor FORCE ROW LEVEL SECURITY;


ALTER TABLE public.change_feed_floor OWNER TO supabase_admin;

--
-- Name: change_feed_id_seq; Type: SEQUENCE; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.change_feed ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.change_feed_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.chat_messages (
    id uuid NOT NULL,
    thread_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.chat_messages FORCE ROW LEVEL SECURITY;


ALTER TABLE public.chat_messages OWNER TO supabase_admin;

--
-- Name: chat_threads; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.chat_threads (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    entity_id uuid,
    title text,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.chat_threads FORCE ROW LEVEL SECURITY;


ALTER TABLE public.chat_threads OWNER TO supabase_admin;

--
-- Name: contract_definitions; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.contract_definitions (
    id text NOT NULL,
    graph_id uuid,
    key text NOT NULL,
    label jsonb NOT NULL,
    description jsonb NOT NULL,
    kind text NOT NULL,
    slots jsonb,
    classes jsonb,
    sets jsonb,
    facts jsonb,
    module text,
    rank integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    exclusive_classes boolean DEFAULT false NOT NULL,
    CONSTRAINT contract_definitions_kind CHECK ((kind = ANY (ARRAY['slots'::text, 'facts'::text])))
);

ALTER TABLE ONLY public.contract_definitions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.contract_definitions OWNER TO supabase_admin;

--
-- Name: entities; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.entities (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    title text NOT NULL,
    emoji text,
    body text DEFAULT ''::text NOT NULL,
    body_refs text[] DEFAULT '{}'::text[] NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    body_doc jsonb,
    body_before_doc text,
    props jsonb DEFAULT '{}'::jsonb NOT NULL,
    aspects text[] DEFAULT '{}'::text[] NOT NULL,
    query_refs text[] DEFAULT '{}'::text[] NOT NULL,
    body_revision integer DEFAULT 1 NOT NULL,
    body_action_id uuid,
    body_changed_at timestamp(3) with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.entities FORCE ROW LEVEL SECURITY;


ALTER TABLE public.entities OWNER TO supabase_admin;

--
-- Name: entity_origins; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.entity_origins (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    namespace text NOT NULL,
    external_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.entity_origins FORCE ROW LEVEL SECURITY;


ALTER TABLE public.entity_origins OWNER TO supabase_admin;

--
-- Name: entity_versions; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.entity_versions (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    label text NOT NULL,
    body text NOT NULL,
    body_doc jsonb,
    actor_user_id uuid NOT NULL,
    actor_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.entity_versions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.entity_versions OWNER TO supabase_admin;

--
-- Name: envelope_spent_cache; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.envelope_spent_cache (
    envelope_id uuid NOT NULL,
    graph_id uuid NOT NULL,
    as_of date NOT NULL,
    spent numeric NOT NULL,
    owner_version integer NOT NULL,
    system_version integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.envelope_spent_cache FORCE ROW LEVEL SECURITY;


ALTER TABLE public.envelope_spent_cache OWNER TO supabase_admin;

--
-- Name: graph_members; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.graph_members (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    account_id uuid NOT NULL,
    grant_kind text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    issued_by uuid NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT graph_members_grant_kind CHECK ((grant_kind = ANY (ARRAY['owner'::text, 'operator'::text, 'observer'::text])))
);

ALTER TABLE ONLY public.graph_members FORCE ROW LEVEL SECURITY;


ALTER TABLE public.graph_members OWNER TO supabase_admin;

--
-- Name: graphs; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.graphs (
    id uuid NOT NULL,
    owner_kind text NOT NULL,
    owner_ref uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT graphs_owner_kind CHECK ((owner_kind = ANY (ARRAY['person'::text, 'organization'::text]))),
    CONSTRAINT graphs_personal_identity CHECK ((((owner_kind = 'person'::text) AND (owner_ref IS NOT NULL) AND (id = owner_ref)) OR (owner_kind = 'organization'::text)))
);

ALTER TABLE ONLY public.graphs FORCE ROW LEVEL SECURITY;


ALTER TABLE public.graphs OWNER TO supabase_admin;

--
-- Name: oauth_clients; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.oauth_clients (
    client_id text NOT NULL,
    client_name text NOT NULL,
    redirect_uris text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.oauth_clients FORCE ROW LEVEL SECURITY;


ALTER TABLE public.oauth_clients OWNER TO supabase_admin;

--
-- Name: perf_samples; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.perf_samples (
    id bigint NOT NULL,
    account_id uuid DEFAULT auth.uid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metric text NOT NULL,
    screen text,
    kind text,
    procedure text,
    dur_ms real NOT NULL,
    server_ms real,
    db_ms real,
    device text NOT NULL,
    net text,
    app_version text NOT NULL,
    cached boolean
);

ALTER TABLE ONLY public.perf_samples FORCE ROW LEVEL SECURITY;


ALTER TABLE public.perf_samples OWNER TO supabase_admin;

--
-- Name: perf_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.perf_samples ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.perf_samples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: property_definitions; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.property_definitions (
    id text NOT NULL,
    graph_id uuid,
    key text NOT NULL,
    label jsonb NOT NULL,
    description jsonb NOT NULL,
    type jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    storage text DEFAULT 'props'::text NOT NULL,
    scope jsonb,
    merged_into text,
    module text,
    rank integer NOT NULL,
    flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT property_definitions_status CHECK ((status = ANY (ARRAY['active'::text, 'proposed'::text, 'deprecated'::text]))),
    CONSTRAINT property_definitions_storage CHECK ((storage = ANY (ARRAY['props'::text, 'core'::text])))
);

ALTER TABLE ONLY public.property_definitions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.property_definitions OWNER TO supabase_admin;

--
-- Name: registry_deltas; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.registry_deltas (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    base_version integer NOT NULL,
    delta jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT registry_deltas_target_kind CHECK ((target_kind = ANY (ARRAY['property'::text, 'aspect'::text, 'contract'::text, 'relation_role'::text, 'subscription'::text, 'action'::text])))
);

ALTER TABLE ONLY public.registry_deltas FORCE ROW LEVEL SECURITY;


ALTER TABLE public.registry_deltas OWNER TO supabase_admin;

--
-- Name: registry_system; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.registry_system (
    id smallint NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    seeded_at timestamp with time zone,
    CONSTRAINT registry_system_singleton CHECK ((id = 1))
);

ALTER TABLE ONLY public.registry_system FORCE ROW LEVEL SECURITY;


ALTER TABLE public.registry_system OWNER TO supabase_admin;

--
-- Name: relation_role_definitions; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.relation_role_definitions (
    id text NOT NULL,
    graph_id uuid,
    key text NOT NULL,
    label jsonb NOT NULL,
    description jsonb NOT NULL,
    source_label jsonb NOT NULL,
    target_label jsonb NOT NULL,
    hierarchical boolean DEFAULT false NOT NULL,
    constraints jsonb DEFAULT '{}'::jsonb NOT NULL,
    "symmetric" boolean DEFAULT false NOT NULL,
    module text,
    rank integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL
);

ALTER TABLE ONLY public.relation_role_definitions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.relation_role_definitions OWNER TO supabase_admin;

--
-- Name: relations; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.relations (
    id uuid NOT NULL,
    source_id uuid NOT NULL,
    target_id uuid NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role text NOT NULL,
    CONSTRAINT rel_no_self CHECK ((source_id <> target_id))
);

ALTER TABLE ONLY public.relations FORCE ROW LEVEL SECURITY;


ALTER TABLE public.relations OWNER TO supabase_admin;

--
-- Name: subscription_definitions; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.subscription_definitions (
    id text NOT NULL,
    graph_id uuid,
    surface text NOT NULL,
    definition jsonb NOT NULL,
    module text,
    rank integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.subscription_definitions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.subscription_definitions OWNER TO supabase_admin;

--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: supabase_admin
--

CREATE TABLE public.user_settings (
    graph_id uuid NOT NULL,
    plan text DEFAULT 'dev'::text NOT NULL,
    timezone text DEFAULT 'Europe/Moscow'::text NOT NULL,
    "defaultCurrency" text DEFAULT 'RUB'::text NOT NULL,
    "weekStartDay" text DEFAULT 'monday'::text NOT NULL,
    "tagColors" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "installedViews" text[] DEFAULT '{}'::text[] NOT NULL,
    "pinnedEntities" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "viewPreferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    registry_version integer DEFAULT 0 NOT NULL,
    disabled_modules text[] DEFAULT '{}'::text[] NOT NULL
);

ALTER TABLE ONLY public.user_settings FORCE ROW LEVEL SECURITY;


ALTER TABLE public.user_settings OWNER TO supabase_admin;

--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: supabase_admin
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: supabase_admin
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: action_journal_entities action_journal_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.action_journal_entities
    ADD CONSTRAINT action_journal_entities_pkey PRIMARY KEY (graph_id, action_id, entity_id);


--
-- Name: action_journal action_journal_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.action_journal
    ADD CONSTRAINT action_journal_pkey PRIMARY KEY (graph_id, id);


--
-- Name: agent_grants agent_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_pkey PRIMARY KEY (id);


--
-- Name: ai_usage ai_usage_graph_id_date_model_pk; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_graph_id_date_model_pk PRIMARY KEY (graph_id, date, model);


--
-- Name: change_feed_floor change_feed_floor_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.change_feed_floor
    ADD CONSTRAINT change_feed_floor_pkey PRIMARY KEY (id);


--
-- Name: change_feed change_feed_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.change_feed
    ADD CONSTRAINT change_feed_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_threads chat_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_pkey PRIMARY KEY (id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entity_origins entity_origins_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.entity_origins
    ADD CONSTRAINT entity_origins_pkey PRIMARY KEY (id);


--
-- Name: entity_origins entity_origins_uniq; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.entity_origins
    ADD CONSTRAINT entity_origins_uniq UNIQUE (graph_id, namespace, external_id);


--
-- Name: entity_versions entity_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_pkey PRIMARY KEY (id);


--
-- Name: envelope_spent_cache envelope_spent_cache_envelope_id_as_of_pk; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.envelope_spent_cache
    ADD CONSTRAINT envelope_spent_cache_envelope_id_as_of_pk PRIMARY KEY (envelope_id, as_of);


--
-- Name: graph_members graph_members_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.graph_members
    ADD CONSTRAINT graph_members_pkey PRIMARY KEY (id);


--
-- Name: graphs graphs_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.graphs
    ADD CONSTRAINT graphs_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (client_id);


--
-- Name: perf_samples perf_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.perf_samples
    ADD CONSTRAINT perf_samples_pkey PRIMARY KEY (id);


--
-- Name: registry_deltas registry_deltas_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.registry_deltas
    ADD CONSTRAINT registry_deltas_pkey PRIMARY KEY (id);


--
-- Name: registry_deltas registry_deltas_uniq; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.registry_deltas
    ADD CONSTRAINT registry_deltas_uniq UNIQUE (graph_id, target_kind, target_id);


--
-- Name: registry_system registry_system_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.registry_system
    ADD CONSTRAINT registry_system_pkey PRIMARY KEY (id);


--
-- Name: relations rel_uniq; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT rel_uniq UNIQUE (source_id, target_id, role);


--
-- Name: relations relations_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT relations_pkey PRIMARY KEY (id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (graph_id);


--
-- Name: action_definitions_builtin_key; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX action_definitions_builtin_key ON public.action_definitions USING btree (key) WHERE (graph_id IS NULL);


--
-- Name: action_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX action_definitions_builtin_uniq ON public.action_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: action_definitions_custom_key; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX action_definitions_custom_key ON public.action_definitions USING btree (graph_id, key) WHERE (graph_id IS NOT NULL);


--
-- Name: action_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX action_definitions_custom_uniq ON public.action_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: action_journal_entities_probe; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX action_journal_entities_probe ON public.action_journal_entities USING btree (graph_id, entity_id, created_at DESC);


--
-- Name: action_journal_graph_time; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX action_journal_graph_time ON public.action_journal USING btree (graph_id, created_at DESC, id DESC);


--
-- Name: action_journal_run; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX action_journal_run ON public.action_journal USING btree (graph_id, run_id) WHERE (run_id IS NOT NULL);


--
-- Name: action_journal_thread_time; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX action_journal_thread_time ON public.action_journal USING btree (graph_id, thread_id, created_at DESC, id DESC) WHERE (thread_id IS NOT NULL);


--
-- Name: action_journal_type_time; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX action_journal_type_time ON public.action_journal USING btree (graph_id, type, created_at DESC);


--
-- Name: action_journal_undoes_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX action_journal_undoes_uniq ON public.action_journal USING btree (graph_id, undoes) WHERE (undoes IS NOT NULL);


--
-- Name: agent_grants_access_hash; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX agent_grants_access_hash ON public.agent_grants USING btree (access_hash);


--
-- Name: agent_grants_code_hash; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX agent_grants_code_hash ON public.agent_grants USING btree (code_hash);


--
-- Name: agent_grants_graph; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX agent_grants_graph ON public.agent_grants USING btree (graph_id);


--
-- Name: agent_grants_refresh_hash; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX agent_grants_refresh_hash ON public.agent_grants USING btree (refresh_hash);


--
-- Name: aspect_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX aspect_definitions_builtin_uniq ON public.aspect_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: aspect_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX aspect_definitions_custom_uniq ON public.aspect_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: change_feed_graph_tx_id; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX change_feed_graph_tx_id ON public.change_feed USING btree (graph_id, tx_id, id);


--
-- Name: change_feed_parent_proof; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX change_feed_parent_proof ON public.change_feed USING btree (tx_id, kind, row_key, id DESC) WHERE (kind = ANY (ARRAY['entity'::text, 'thread'::text, 'relation'::text]));


--
-- Name: chat_messages_metadata_gin; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX chat_messages_metadata_gin ON public.chat_messages USING gin (metadata jsonb_path_ops);


--
-- Name: chat_messages_thread_created; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX chat_messages_thread_created ON public.chat_messages USING btree (thread_id, created_at);


--
-- Name: chat_threads_entity_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX chat_threads_entity_uniq ON public.chat_threads USING btree (graph_id, entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: chat_threads_global_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX chat_threads_global_uniq ON public.chat_threads USING btree (graph_id) WHERE (entity_id IS NULL);


--
-- Name: chat_threads_graph; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX chat_threads_graph ON public.chat_threads USING btree (graph_id);


--
-- Name: contract_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX contract_definitions_builtin_uniq ON public.contract_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: contract_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX contract_definitions_custom_uniq ON public.contract_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: entities_aspects_gin; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX entities_aspects_gin ON public.entities USING gin (aspects);


--
-- Name: entities_body_fts; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX entities_body_fts ON public.entities USING gin (to_tsvector('simple'::regconfig, body));


--
-- Name: entities_body_refs_gin; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX entities_body_refs_gin ON public.entities USING gin (body_refs);


--
-- Name: entities_graph_updated; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX entities_graph_updated ON public.entities USING btree (graph_id, updated_at DESC) WHERE (NOT archived);


--
-- Name: entities_props_gin; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX entities_props_gin ON public.entities USING gin (props);


--
-- Name: entities_query_refs_gin; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX entities_query_refs_gin ON public.entities USING gin (query_refs);


--
-- Name: entities_tags_gin; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX entities_tags_gin ON public.entities USING gin (tags);


--
-- Name: entities_title_fts; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX entities_title_fts ON public.entities USING gin (to_tsvector('simple'::regconfig, title));


--
-- Name: entity_versions_entity_created; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX entity_versions_entity_created ON public.entity_versions USING btree (entity_id, created_at DESC NULLS LAST);


--
-- Name: envelope_spent_cache_graph; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX envelope_spent_cache_graph ON public.envelope_spent_cache USING btree (graph_id, as_of);


--
-- Name: graph_members_account; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX graph_members_account ON public.graph_members USING btree (account_id);


--
-- Name: graph_members_active_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX graph_members_active_uniq ON public.graph_members USING btree (graph_id, account_id) WHERE (revoked_at IS NULL);


--
-- Name: perf_samples_account_created; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX perf_samples_account_created ON public.perf_samples USING btree (account_id, created_at);


--
-- Name: property_definitions_builtin_key; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX property_definitions_builtin_key ON public.property_definitions USING btree (key) WHERE (graph_id IS NULL);


--
-- Name: property_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX property_definitions_builtin_uniq ON public.property_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: property_definitions_custom_key; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX property_definitions_custom_key ON public.property_definitions USING btree (graph_id, key) WHERE (graph_id IS NOT NULL);


--
-- Name: property_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX property_definitions_custom_uniq ON public.property_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: relation_role_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX relation_role_definitions_builtin_uniq ON public.relation_role_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: relation_role_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX relation_role_definitions_custom_uniq ON public.relation_role_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: relations_source_role; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX relations_source_role ON public.relations USING btree (source_id, role);


--
-- Name: relations_target_role; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE INDEX relations_target_role ON public.relations USING btree (target_id, role);


--
-- Name: subscription_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX subscription_definitions_builtin_uniq ON public.subscription_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: subscription_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: supabase_admin
--

CREATE UNIQUE INDEX subscription_definitions_custom_uniq ON public.subscription_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: entities entities_body_stamp; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER entities_body_stamp BEFORE INSERT OR UPDATE OF body, body_doc ON public.entities FOR EACH ROW EXECUTE FUNCTION public.entities_body_stamp();


--
-- Name: graph_members graph_members_keep_owner; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE CONSTRAINT TRIGGER graph_members_keep_owner AFTER DELETE OR UPDATE ON public.graph_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.graph_members_keep_owner();


--
-- Name: graphs graphs_require_owner; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE CONSTRAINT TRIGGER graphs_require_owner AFTER INSERT ON public.graphs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.graphs_require_owner();


--
-- Name: action_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.action_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_journal orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.action_journal REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: aspect_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.aspect_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_messages orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.chat_messages REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_threads orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.chat_threads REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: contract_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.contract_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entities orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.entities REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entity_versions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.entity_versions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: property_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.property_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_deltas orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.registry_deltas REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_system orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.registry_system REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relation_role_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.relation_role_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relations orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.relations REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: subscription_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.subscription_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: user_settings orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.user_settings REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.action_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_journal orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.action_journal REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: aspect_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.aspect_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_messages orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.chat_messages REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_threads orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.chat_threads REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: contract_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.contract_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entities orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.entities REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entity_versions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.entity_versions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: property_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.property_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_deltas orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.registry_deltas REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_system orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.registry_system REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relation_role_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.relation_role_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relations orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.relations REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: subscription_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.subscription_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: user_settings orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.user_settings REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.action_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_journal orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.action_journal FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: aspect_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.aspect_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_messages orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.chat_messages FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_threads orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.chat_threads FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: contract_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.contract_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entities orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.entities FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entity_versions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.entity_versions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: property_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.property_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_deltas orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.registry_deltas FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_system orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.registry_system FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relation_role_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.relation_role_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relations orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.relations FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: subscription_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.subscription_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: user_settings orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.user_settings FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.action_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_journal orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.action_journal REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: aspect_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.aspect_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_messages orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.chat_messages REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_threads orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.chat_threads REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: contract_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.contract_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entities orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.entities REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entity_versions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.entity_versions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: property_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.property_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_deltas orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.registry_deltas REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_system orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.registry_system REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relation_role_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.relation_role_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relations orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.relations REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: subscription_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.subscription_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: user_settings orbis_feed_update; Type: TRIGGER; Schema: public; Owner: supabase_admin
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.user_settings REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_definitions action_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.action_definitions
    ADD CONSTRAINT action_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: action_journal_entities action_journal_entities_action_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.action_journal_entities
    ADD CONSTRAINT action_journal_entities_action_fk FOREIGN KEY (graph_id, action_id) REFERENCES public.action_journal(graph_id, id) ON DELETE CASCADE;


--
-- Name: action_journal action_journal_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.action_journal
    ADD CONSTRAINT action_journal_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id) ON DELETE CASCADE;


--
-- Name: action_journal action_journal_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.action_journal
    ADD CONSTRAINT action_journal_thread_id_chat_threads_id_fk FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE SET NULL;


--
-- Name: agent_grants agent_grants_client_id_oauth_clients_client_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: agent_grants agent_grants_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: ai_usage ai_usage_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: aspect_definitions aspect_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.aspect_definitions
    ADD CONSTRAINT aspect_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: chat_messages chat_messages_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_thread_id_chat_threads_id_fk FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id);


--
-- Name: chat_threads chat_threads_entity_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_entity_id_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: chat_threads chat_threads_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: contract_definitions contract_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.contract_definitions
    ADD CONSTRAINT contract_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: entities entities_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: entity_origins entity_origins_entity_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.entity_origins
    ADD CONSTRAINT entity_origins_entity_id_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: entity_origins entity_origins_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.entity_origins
    ADD CONSTRAINT entity_origins_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: entity_versions entity_versions_entity_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_entity_id_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_versions entity_versions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: envelope_spent_cache envelope_spent_cache_envelope_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.envelope_spent_cache
    ADD CONSTRAINT envelope_spent_cache_envelope_id_entities_id_fk FOREIGN KEY (envelope_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: envelope_spent_cache envelope_spent_cache_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.envelope_spent_cache
    ADD CONSTRAINT envelope_spent_cache_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: graph_members graph_members_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.graph_members
    ADD CONSTRAINT graph_members_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: property_definitions property_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.property_definitions
    ADD CONSTRAINT property_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: registry_deltas registry_deltas_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.registry_deltas
    ADD CONSTRAINT registry_deltas_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: relation_role_definitions relation_role_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.relation_role_definitions
    ADD CONSTRAINT relation_role_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: relations relations_source_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT relations_source_id_entities_id_fk FOREIGN KEY (source_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: relations relations_target_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT relations_target_id_entities_id_fk FOREIGN KEY (target_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: subscription_definitions subscription_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.subscription_definitions
    ADD CONSTRAINT subscription_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: user_settings user_settings_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: supabase_admin
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: graph_members account_owns_personal_graph; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY account_owns_personal_graph ON public.graph_members FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT auth.uid() AS uid)) AND (account_id = ( SELECT auth.uid() AS uid)) AND (grant_kind = 'owner'::text) AND (issued_by = ( SELECT auth.uid() AS uid)) AND (revoked_at IS NULL)));


--
-- Name: graph_members account_reads_own_membership; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY account_reads_own_membership ON public.graph_members FOR SELECT TO authenticated USING ((account_id = ( SELECT auth.uid() AS uid)));


--
-- Name: action_definitions; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.action_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: action_journal; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.action_journal ENABLE ROW LEVEL SECURITY;

--
-- Name: action_journal_entities; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.action_journal_entities ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_grants; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.agent_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: aspect_definitions; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.aspect_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: change_feed; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.change_feed ENABLE ROW LEVEL SECURITY;

--
-- Name: change_feed_floor; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.change_feed_floor ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_threads; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_definitions; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.contract_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_grants current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.agent_grants FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_owns_current_graph() AS actor_owns_current_graph)));


--
-- Name: ai_usage current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.ai_usage FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: chat_messages current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.chat_messages FOR DELETE TO authenticated USING ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: chat_threads current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.chat_threads FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entities current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.entities FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entity_origins current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.entity_origins FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entity_versions current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.entity_versions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: envelope_spent_cache current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.envelope_spent_cache FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: registry_deltas current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.registry_deltas FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relations current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.relations FOR DELETE TO authenticated USING ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: user_settings current_graph_delete; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_delete ON public.user_settings FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: action_journal current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.action_journal FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: action_journal_entities current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.action_journal_entities FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: agent_grants current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.agent_grants FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_owns_current_graph() AS actor_owns_current_graph)));


--
-- Name: ai_usage current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.ai_usage FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: chat_messages current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.chat_messages FOR INSERT TO authenticated WITH CHECK ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: chat_threads current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.chat_threads FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND ((entity_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = chat_threads.entity_id) AND (e.graph_id = chat_threads.graph_id)))))));


--
-- Name: entities current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.entities FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entity_origins current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.entity_origins FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_origins.entity_id) AND (e.graph_id = entity_origins.graph_id))))));


--
-- Name: entity_versions current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.entity_versions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_versions.entity_id) AND (e.graph_id = entity_versions.graph_id))))));


--
-- Name: envelope_spent_cache current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.envelope_spent_cache FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = envelope_spent_cache.envelope_id) AND (e.graph_id = envelope_spent_cache.graph_id))))));


--
-- Name: registry_deltas current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.registry_deltas FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relations current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.relations FOR INSERT TO authenticated WITH CHECK ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: user_settings current_graph_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_insert ON public.user_settings FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: action_journal current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.action_journal FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: action_journal_entities current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.action_journal_entities FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: agent_grants current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.agent_grants FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: ai_usage current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.ai_usage FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: change_feed current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.change_feed FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: change_feed_floor current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.change_feed_floor FOR SELECT TO authenticated USING (( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph));


--
-- Name: chat_messages current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.chat_messages FOR SELECT TO authenticated USING ((( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: chat_threads current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.chat_threads FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: entities current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.entities FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: entity_origins current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.entity_origins FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: entity_versions current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.entity_versions FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: envelope_spent_cache current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.envelope_spent_cache FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: registry_deltas current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.registry_deltas FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: relations current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.relations FOR SELECT TO authenticated USING ((( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: user_settings current_graph_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_select ON public.user_settings FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: agent_grants current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.agent_grants FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_owns_current_graph() AS actor_owns_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_owns_current_graph() AS actor_owns_current_graph)));


--
-- Name: ai_usage current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.ai_usage FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: chat_messages current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.chat_messages FOR UPDATE TO authenticated USING ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))))) WITH CHECK ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: chat_threads current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.chat_threads FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND ((entity_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = chat_threads.entity_id) AND (e.graph_id = chat_threads.graph_id)))))));


--
-- Name: entities current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.entities FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entity_origins current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.entity_origins FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_origins.entity_id) AND (e.graph_id = entity_origins.graph_id))))));


--
-- Name: entity_versions current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.entity_versions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_versions.entity_id) AND (e.graph_id = entity_versions.graph_id))))));


--
-- Name: envelope_spent_cache current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.envelope_spent_cache FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = envelope_spent_cache.envelope_id) AND (e.graph_id = envelope_spent_cache.graph_id))))));


--
-- Name: registry_deltas current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.registry_deltas FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relations current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.relations FOR UPDATE TO authenticated USING ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))))) WITH CHECK ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: user_settings current_graph_update; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY current_graph_update ON public.user_settings FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: action_definitions delete_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY delete_own ON public.action_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: aspect_definitions delete_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY delete_own ON public.aspect_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: contract_definitions delete_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY delete_own ON public.contract_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: property_definitions delete_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY delete_own ON public.property_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relation_role_definitions delete_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY delete_own ON public.relation_role_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: subscription_definitions delete_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY delete_own ON public.subscription_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entities; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_origins; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.entity_origins ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_versions; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.entity_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: envelope_spent_cache; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.envelope_spent_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: graph_members; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.graph_members ENABLE ROW LEVEL SECURITY;

--
-- Name: graphs; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.graphs ENABLE ROW LEVEL SECURITY;

--
-- Name: graphs member_reads_graph; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY member_reads_graph ON public.graphs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.graph_members m
  WHERE ((m.graph_id = graphs.id) AND (m.account_id = ( SELECT auth.uid() AS uid)) AND (m.revoked_at IS NULL)))));


--
-- Name: oauth_clients; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: perf_samples own_account_insert; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY own_account_insert ON public.perf_samples FOR INSERT TO authenticated WITH CHECK ((account_id = ( SELECT auth.uid() AS uid)));


--
-- Name: perf_samples own_account_select; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY own_account_select ON public.perf_samples FOR SELECT TO authenticated USING ((account_id = ( SELECT auth.uid() AS uid)));


--
-- Name: perf_samples; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.perf_samples ENABLE ROW LEVEL SECURITY;

--
-- Name: graphs person_creates_own_graph; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY person_creates_own_graph ON public.graphs FOR INSERT TO authenticated WITH CHECK (((owner_kind = 'person'::text) AND (id = ( SELECT auth.uid() AS uid)) AND (owner_ref = ( SELECT auth.uid() AS uid))));


--
-- Name: property_definitions; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.property_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: registry_system read_all; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY read_all ON public.registry_system FOR SELECT USING (true);


--
-- Name: action_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY read_builtin_or_own ON public.action_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: aspect_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY read_builtin_or_own ON public.aspect_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: contract_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY read_builtin_or_own ON public.contract_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: property_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY read_builtin_or_own ON public.property_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: relation_role_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY read_builtin_or_own ON public.relation_role_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: subscription_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY read_builtin_or_own ON public.subscription_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: registry_deltas; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.registry_deltas ENABLE ROW LEVEL SECURITY;

--
-- Name: registry_system; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.registry_system ENABLE ROW LEVEL SECURITY;

--
-- Name: relation_role_definitions; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.relation_role_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: relations; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.relations ENABLE ROW LEVEL SECURITY;

--
-- Name: graph_members scheduler_reads_members; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY scheduler_reads_members ON public.graph_members FOR SELECT TO orbis_app USING (true);


--
-- Name: user_settings scheduler_reads_owner_list; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY scheduler_reads_owner_list ON public.user_settings FOR SELECT TO orbis_app USING (true);


--
-- Name: oauth_clients server_manages_clients; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY server_manages_clients ON public.oauth_clients TO orbis_app USING (true) WITH CHECK (true);


--
-- Name: agent_grants server_manages_grants; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY server_manages_grants ON public.agent_grants TO orbis_app USING (true) WITH CHECK (true);


--
-- Name: subscription_definitions; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.subscription_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: action_definitions update_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY update_own ON public.action_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: aspect_definitions update_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY update_own ON public.aspect_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: contract_definitions update_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY update_own ON public.contract_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: property_definitions update_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY update_own ON public.property_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relation_role_definitions update_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY update_own ON public.relation_role_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: subscription_definitions update_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY update_own ON public.subscription_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: user_settings; Type: ROW SECURITY; Schema: public; Owner: supabase_admin
--

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: action_definitions write_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY write_own ON public.action_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: aspect_definitions write_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY write_own ON public.aspect_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: contract_definitions write_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY write_own ON public.contract_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: property_definitions write_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY write_own ON public.property_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relation_role_definitions write_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY write_own ON public.relation_role_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: subscription_definitions write_own; Type: POLICY; Schema: public; Owner: supabase_admin
--

CREATE POLICY write_own ON public.subscription_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO orbis_change_feed_owner;


--
-- Name: FUNCTION actor_owns_current_graph(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.actor_owns_current_graph() TO postgres;
GRANT ALL ON FUNCTION public.actor_owns_current_graph() TO anon;
GRANT ALL ON FUNCTION public.actor_owns_current_graph() TO authenticated;
GRANT ALL ON FUNCTION public.actor_owns_current_graph() TO service_role;


--
-- Name: FUNCTION actor_reads_current_graph(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.actor_reads_current_graph() TO postgres;
GRANT ALL ON FUNCTION public.actor_reads_current_graph() TO anon;
GRANT ALL ON FUNCTION public.actor_reads_current_graph() TO authenticated;
GRANT ALL ON FUNCTION public.actor_reads_current_graph() TO service_role;


--
-- Name: FUNCTION actor_writes_current_graph(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.actor_writes_current_graph() TO postgres;
GRANT ALL ON FUNCTION public.actor_writes_current_graph() TO anon;
GRANT ALL ON FUNCTION public.actor_writes_current_graph() TO authenticated;
GRANT ALL ON FUNCTION public.actor_writes_current_graph() TO service_role;


--
-- Name: FUNCTION current_graph_id(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.current_graph_id() TO postgres;
GRANT ALL ON FUNCTION public.current_graph_id() TO anon;
GRANT ALL ON FUNCTION public.current_graph_id() TO authenticated;
GRANT ALL ON FUNCTION public.current_graph_id() TO service_role;


--
-- Name: FUNCTION entities_body_stamp(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.entities_body_stamp() TO postgres;
GRANT ALL ON FUNCTION public.entities_body_stamp() TO anon;
GRANT ALL ON FUNCTION public.entities_body_stamp() TO authenticated;
GRANT ALL ON FUNCTION public.entities_body_stamp() TO service_role;


--
-- Name: FUNCTION graph_members_keep_owner(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.graph_members_keep_owner() TO postgres;
GRANT ALL ON FUNCTION public.graph_members_keep_owner() TO anon;
GRANT ALL ON FUNCTION public.graph_members_keep_owner() TO authenticated;
GRANT ALL ON FUNCTION public.graph_members_keep_owner() TO service_role;


--
-- Name: FUNCTION graphs_require_owner(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.graphs_require_owner() TO postgres;
GRANT ALL ON FUNCTION public.graphs_require_owner() TO anon;
GRANT ALL ON FUNCTION public.graphs_require_owner() TO authenticated;
GRANT ALL ON FUNCTION public.graphs_require_owner() TO service_role;


--
-- Name: FUNCTION orbis_capture_change_feed(); Type: ACL; Schema: public; Owner: orbis_change_feed_owner
--

REVOKE ALL ON FUNCTION public.orbis_capture_change_feed() FROM PUBLIC;
GRANT ALL ON FUNCTION public.orbis_capture_change_feed() TO postgres;


--
-- Name: FUNCTION orbis_feed_entity_graph(entity_id uuid, xid xid8); Type: ACL; Schema: public; Owner: supabase_admin
--

REVOKE ALL ON FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8) TO postgres;
GRANT ALL ON FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8) TO orbis_change_feed_owner;


--
-- Name: FUNCTION orbis_feed_last_event(event_kind text, event_key text, xid xid8); Type: ACL; Schema: public; Owner: supabase_admin
--

REVOKE ALL ON FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8) TO postgres;
GRANT ALL ON FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8) TO orbis_change_feed_owner;


--
-- Name: TABLE action_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.action_definitions TO postgres;
GRANT ALL ON TABLE public.action_definitions TO anon;
GRANT ALL ON TABLE public.action_definitions TO authenticated;
GRANT ALL ON TABLE public.action_definitions TO service_role;


--
-- Name: TABLE action_journal; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.action_journal TO postgres;
GRANT ALL ON TABLE public.action_journal TO service_role;
GRANT SELECT,INSERT ON TABLE public.action_journal TO authenticated;


--
-- Name: TABLE action_journal_entities; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.action_journal_entities TO postgres;
GRANT ALL ON TABLE public.action_journal_entities TO service_role;
GRANT SELECT,INSERT ON TABLE public.action_journal_entities TO authenticated;


--
-- Name: TABLE agent_grants; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.agent_grants TO postgres;
GRANT ALL ON TABLE public.agent_grants TO anon;
GRANT ALL ON TABLE public.agent_grants TO authenticated;
GRANT ALL ON TABLE public.agent_grants TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_grants TO orbis_app;


--
-- Name: TABLE ai_usage; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.ai_usage TO postgres;
GRANT ALL ON TABLE public.ai_usage TO anon;
GRANT ALL ON TABLE public.ai_usage TO authenticated;
GRANT ALL ON TABLE public.ai_usage TO service_role;


--
-- Name: TABLE aspect_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.aspect_definitions TO postgres;
GRANT ALL ON TABLE public.aspect_definitions TO anon;
GRANT ALL ON TABLE public.aspect_definitions TO authenticated;
GRANT ALL ON TABLE public.aspect_definitions TO service_role;


--
-- Name: TABLE change_feed; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.change_feed TO postgres;
GRANT SELECT ON TABLE public.change_feed TO authenticated;
GRANT INSERT ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.tx_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(tx_id) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.graph_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(graph_id) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.kind; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(kind) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.row_key; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(row_key) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.entity_ids; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(entity_ids) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.operation; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(operation) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.graph_wide; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(graph_wide) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: TABLE change_feed_floor; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.change_feed_floor TO postgres;
GRANT SELECT ON TABLE public.change_feed_floor TO authenticated;


--
-- Name: COLUMN change_feed_floor.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.change_feed_floor TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed_floor.floor; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(floor),UPDATE(floor) ON TABLE public.change_feed_floor TO orbis_change_feed_owner;


--
-- Name: SEQUENCE change_feed_id_seq; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON SEQUENCE public.change_feed_id_seq TO postgres;


--
-- Name: TABLE chat_messages; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.chat_messages TO postgres;
GRANT ALL ON TABLE public.chat_messages TO anon;
GRANT ALL ON TABLE public.chat_messages TO authenticated;
GRANT ALL ON TABLE public.chat_messages TO service_role;


--
-- Name: TABLE chat_threads; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.chat_threads TO postgres;
GRANT ALL ON TABLE public.chat_threads TO anon;
GRANT ALL ON TABLE public.chat_threads TO authenticated;
GRANT ALL ON TABLE public.chat_threads TO service_role;


--
-- Name: COLUMN chat_threads.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.chat_threads TO orbis_change_feed_owner;


--
-- Name: COLUMN chat_threads.graph_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(graph_id) ON TABLE public.chat_threads TO orbis_change_feed_owner;


--
-- Name: COLUMN chat_threads.entity_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(entity_id) ON TABLE public.chat_threads TO orbis_change_feed_owner;


--
-- Name: TABLE contract_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.contract_definitions TO postgres;
GRANT ALL ON TABLE public.contract_definitions TO anon;
GRANT ALL ON TABLE public.contract_definitions TO authenticated;
GRANT ALL ON TABLE public.contract_definitions TO service_role;


--
-- Name: TABLE entities; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.entities TO postgres;
GRANT ALL ON TABLE public.entities TO anon;
GRANT ALL ON TABLE public.entities TO authenticated;
GRANT ALL ON TABLE public.entities TO service_role;


--
-- Name: COLUMN entities.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.entities TO orbis_change_feed_owner;


--
-- Name: COLUMN entities.graph_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(graph_id) ON TABLE public.entities TO orbis_change_feed_owner;


--
-- Name: TABLE entity_origins; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.entity_origins TO postgres;
GRANT ALL ON TABLE public.entity_origins TO anon;
GRANT ALL ON TABLE public.entity_origins TO authenticated;
GRANT ALL ON TABLE public.entity_origins TO service_role;


--
-- Name: TABLE entity_versions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.entity_versions TO postgres;
GRANT ALL ON TABLE public.entity_versions TO anon;
GRANT ALL ON TABLE public.entity_versions TO authenticated;
GRANT ALL ON TABLE public.entity_versions TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.entity_versions TO orbis_app;


--
-- Name: TABLE envelope_spent_cache; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.envelope_spent_cache TO postgres;
GRANT ALL ON TABLE public.envelope_spent_cache TO anon;
GRANT ALL ON TABLE public.envelope_spent_cache TO authenticated;
GRANT ALL ON TABLE public.envelope_spent_cache TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.envelope_spent_cache TO orbis_app;


--
-- Name: TABLE graph_members; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.graph_members TO postgres;
GRANT ALL ON TABLE public.graph_members TO service_role;
GRANT SELECT,INSERT ON TABLE public.graph_members TO authenticated;
GRANT SELECT ON TABLE public.graph_members TO orbis_app;


--
-- Name: TABLE graphs; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.graphs TO postgres;
GRANT ALL ON TABLE public.graphs TO service_role;
GRANT SELECT,INSERT ON TABLE public.graphs TO authenticated;


--
-- Name: TABLE oauth_clients; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.oauth_clients TO postgres;
GRANT ALL ON TABLE public.oauth_clients TO anon;
GRANT ALL ON TABLE public.oauth_clients TO authenticated;
GRANT ALL ON TABLE public.oauth_clients TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.oauth_clients TO orbis_app;


--
-- Name: TABLE perf_samples; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.perf_samples TO postgres;
GRANT ALL ON TABLE public.perf_samples TO service_role;
GRANT SELECT,INSERT ON TABLE public.perf_samples TO authenticated;


--
-- Name: SEQUENCE perf_samples_id_seq; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON SEQUENCE public.perf_samples_id_seq TO postgres;
GRANT ALL ON SEQUENCE public.perf_samples_id_seq TO anon;
GRANT ALL ON SEQUENCE public.perf_samples_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.perf_samples_id_seq TO service_role;


--
-- Name: TABLE property_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.property_definitions TO postgres;
GRANT ALL ON TABLE public.property_definitions TO anon;
GRANT ALL ON TABLE public.property_definitions TO authenticated;
GRANT ALL ON TABLE public.property_definitions TO service_role;


--
-- Name: TABLE registry_deltas; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.registry_deltas TO postgres;
GRANT ALL ON TABLE public.registry_deltas TO anon;
GRANT ALL ON TABLE public.registry_deltas TO authenticated;
GRANT ALL ON TABLE public.registry_deltas TO service_role;


--
-- Name: TABLE registry_system; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.registry_system TO postgres;
GRANT ALL ON TABLE public.registry_system TO anon;
GRANT ALL ON TABLE public.registry_system TO authenticated;
GRANT ALL ON TABLE public.registry_system TO service_role;


--
-- Name: TABLE relation_role_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.relation_role_definitions TO postgres;
GRANT ALL ON TABLE public.relation_role_definitions TO anon;
GRANT ALL ON TABLE public.relation_role_definitions TO authenticated;
GRANT ALL ON TABLE public.relation_role_definitions TO service_role;


--
-- Name: TABLE relations; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.relations TO postgres;
GRANT ALL ON TABLE public.relations TO anon;
GRANT ALL ON TABLE public.relations TO authenticated;
GRANT ALL ON TABLE public.relations TO service_role;


--
-- Name: COLUMN relations.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.relations TO orbis_change_feed_owner;


--
-- Name: COLUMN relations.source_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(source_id) ON TABLE public.relations TO orbis_change_feed_owner;


--
-- Name: COLUMN relations.target_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(target_id) ON TABLE public.relations TO orbis_change_feed_owner;


--
-- Name: TABLE subscription_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.subscription_definitions TO postgres;
GRANT ALL ON TABLE public.subscription_definitions TO anon;
GRANT ALL ON TABLE public.subscription_definitions TO authenticated;
GRANT ALL ON TABLE public.subscription_definitions TO service_role;


--
-- Name: TABLE user_settings; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.user_settings TO postgres;
GRANT ALL ON TABLE public.user_settings TO anon;
GRANT ALL ON TABLE public.user_settings TO authenticated;
GRANT ALL ON TABLE public.user_settings TO service_role;
GRANT SELECT ON TABLE public.user_settings TO orbis_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict XxSEySuZUSxK98KjFVBc8LYAKDVwRXJmKwXFjnfBFDLgNFJblceK05fmTf1dhzd

